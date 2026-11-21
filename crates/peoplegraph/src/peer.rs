//! Peer questions over a trusted tailnet: a member's agent asks another member's agent
//! three fixed questions about a person. Answers are computed by the answering owner's
//! own agent, under that owner's policy, and every request is logged locally.
use crate::{Response, config, elapsed_ms, fail, ok, people_client, url_encode};
use clap::{Args, Subcommand, ValueEnum};
use ring::hmac;
use ring::rand::{SecureRandom, SystemRandom};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::cell::RefCell;
use std::collections::HashSet;
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpListener, TcpStream};
use std::path::PathBuf;
use std::process::Command as ProcessCommand;
use std::time::{Duration, Instant};

const MINUTE: u64 = 60;
const DAY: u64 = 86_400;
const TICKET_TTL: u64 = 72 * 3_600;
const PER_MINUTE: usize = 60;
const PER_SUBJECT_DAY: usize = 3;
const MAX_BODY: usize = 4_096;
const MAX_TEXT: usize = 200;

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug, ValueEnum)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Gate {
    Auto,
    Approve,
    Never,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct Policy {
    pub open: Gate,
    pub personal: Gate,
    pub reason_to_meet: Gate,
}

impl Default for Policy {
    fn default() -> Self {
        Self {
            open: Gate::Auto,
            personal: Gate::Approve,
            reason_to_meet: Gate::Approve,
        }
    }
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(deny_unknown_fields)]
pub(crate) struct PeerRef {
    pub login: String,
    pub url: String,
}

// Intentionally not Debug: the pepper is a group secret.
#[derive(Serialize, Deserialize, Clone)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct PeerConfig {
    pub version: u8,
    pub group: String,
    pub pepper: String,
    pub allow: Vec<String>,
    pub peers: Vec<PeerRef>,
    pub do_not_answer_about: Vec<String>,
    pub policy: Policy,
}

const INVALID: config::Error = (
    "peer_config_invalid",
    "Peer configuration is invalid; repair peers.json or run peoplegraph peer init.",
);

impl PeerConfig {
    pub(crate) fn new(group: &str, pepper: String) -> Self {
        Self {
            version: 1,
            group: group.to_owned(),
            pepper,
            allow: vec![],
            peers: vec![],
            do_not_answer_about: vec![],
            policy: Policy::default(),
        }
    }

    fn valid(&self) -> bool {
        let text = |value: &str| !value.trim().is_empty() && value.len() <= MAX_TEXT;
        self.version == 1
            && text(&self.group)
            && self.pepper.len() >= 32
            && self.allow.iter().all(|login| text(login))
            && self
                .peers
                .iter()
                .all(|peer| text(&peer.login) && text(&peer.url))
            && self.do_not_answer_about.iter().all(|r| is_ref(r))
            // Personal signals and reasons to meet always need the owner.
            && self.policy.personal != Gate::Auto
            && self.policy.reason_to_meet != Gate::Auto
    }

    /// The configuration without its secret, for display.
    pub(crate) fn public(&self) -> Value {
        json!({
            "group": self.group,
            "allow": self.allow,
            "peers": self.peers.iter().map(|p| json!({"login":p.login,"url":p.url})).collect::<Vec<_>>(),
            "optedOut": !self.do_not_answer_about.is_empty(),
            "policy": {"open":self.policy.open,"personal":self.policy.personal,"reasonToMeet":self.policy.reason_to_meet,"sensitive":"never"},
        })
    }
}

fn dir() -> Result<PathBuf, config::Error> {
    config::config_path()?
        .parent()
        .map(PathBuf::from)
        .ok_or(INVALID)
}

pub(crate) fn load_config() -> Result<Option<PeerConfig>, config::Error> {
    let Some(bytes) = config::read_private(&dir()?.join("peers.json"))? else {
        return Ok(None);
    };
    let config: PeerConfig = serde_json::from_slice(&bytes).map_err(|_| INVALID)?;
    if config.valid() {
        Ok(Some(config))
    } else {
        Err(INVALID)
    }
}

pub(crate) fn save_config(config: &PeerConfig) -> Result<(), config::Error> {
    if !config.valid() {
        return Err(INVALID);
    }
    let bytes = serde_json::to_vec_pretty(config).map_err(|_| INVALID)?;
    config::write_private(&dir()?.join("peers.json"), &bytes)
}

/// Hex of `n` random bytes from the system CSPRNG.
pub(crate) fn random_hex(n: usize) -> Result<String, config::Error> {
    let mut bytes = vec![0_u8; n];
    SystemRandom::new()
        .fill(&mut bytes)
        .map_err(|_| ("peer_random_failed", "Cannot read system randomness."))?;
    Ok(hex(&bytes))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn is_ref(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// A person reference shared inside the group: HMAC-SHA256(pepper, normalised email), hex.
pub(crate) fn person_ref(pepper: &str, email: &str) -> String {
    let key = hmac::Key::new(hmac::HMAC_SHA256, pepper.as_bytes());
    hex(hmac::sign(&key, email.trim().to_lowercase().as_bytes()).as_ref())
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Eq, Debug)]
#[serde(rename_all = "snake_case")]
pub(crate) enum TicketStatus {
    Pending,
    Approved,
    Denied,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Ticket {
    pub id: String,
    pub caller: String,
    pub kind: String,
    pub person: Option<String>,
    pub person_id: Option<String>,
    pub topic: Option<String>,
    pub created: u64,
    pub status: TicketStatus,
    pub answer: Option<Value>,
}

#[derive(Serialize, Deserialize, Clone)]
struct Recent {
    caller: String,
    subject: Option<String>,
    at: u64,
}

#[derive(Serialize, Deserialize, Default)]
pub(crate) struct PeerState {
    pub tickets: Vec<Ticket>,
    recent: Vec<Recent>,
}

pub(crate) fn load_state() -> Result<PeerState, config::Error> {
    Ok(
        match config::read_private(&dir()?.join("peer-state.json"))? {
            Some(bytes) => serde_json::from_slice(&bytes).map_err(|_| INVALID)?,
            None => PeerState::default(),
        },
    )
}

pub(crate) fn save_state(state: &mut PeerState, now: u64) -> Result<(), config::Error> {
    state.prune(now);
    let bytes = serde_json::to_vec(state).map_err(|_| INVALID)?;
    config::write_private(&dir()?.join("peer-state.json"), &bytes)
}

impl PeerState {
    fn prune(&mut self, now: u64) {
        self.recent.retain(|r| r.at + DAY > now);
        // Expired tickets linger one day so their askers learn "expired", not "unknown".
        self.tickets.retain(|t| t.created + TICKET_TTL + DAY > now);
    }

    pub(crate) fn pending(&self, now: u64) -> Vec<&Ticket> {
        self.tickets
            .iter()
            .filter(|t| t.status == TicketStatus::Pending && t.created + TICKET_TTL > now)
            .collect()
    }
}

/// Append one line to the owner-only audit log.
pub(crate) fn append_audit(entry: &Value) -> Result<(), config::Error> {
    const FAILED: config::Error = ("peer_audit_failed", "Cannot write the peer audit log.");
    let path = dir()?.join("peer-audit.jsonl");
    if let Ok(metadata) = fs::symlink_metadata(&path) {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if !metadata.is_file() || metadata.permissions().mode() & 0o077 != 0 {
                return Err(FAILED);
            }
        }
    }
    let mut options = OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&path).map_err(|_| FAILED)?;
    writeln!(file, "{entry}").map_err(|_| FAILED)
}

/// Read the audit log, newest last, from `since` (unix seconds) on.
pub(crate) fn read_audit(since: u64) -> Result<Vec<Value>, config::Error> {
    let path = dir()?.join("peer-audit.jsonl");
    let text = match fs::read_to_string(&path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
        Err(_) => return Err(("peer_audit_failed", "Cannot read the peer audit log.")),
    };
    Ok(text
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .filter(|entry| entry["at"].as_u64().is_some_and(|at| at >= since))
        .collect())
}

/// `(personId, emails)` for each of the owner's own contacts.
pub(crate) type Directory = Vec<(String, Vec<String>)>;
/// A peer's HTTP status and JSON body; `Err` when it could not be reached.
type PeerReply = Result<(u16, Value), ()>;

/// The owner's own People data, behind a trait so the handler is testable without a network.
pub(crate) trait Source {
    fn directory(&self) -> Result<Directory, String>;
    /// The hosted coarse answer (`knows` or `catch_up`) for one person.
    fn answer(&self, person_id: &str, kind: &str) -> Result<Value, String>;
}

pub(crate) struct Context<'a> {
    pub config: &'a PeerConfig,
    pub source: &'a dyn Source,
    /// Person references any group member asked not to be answered about.
    pub opted_out: &'a HashSet<String>,
}

pub(crate) struct Reply {
    pub status: u16,
    pub body: Value,
    pub audit: Value,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Query {
    #[serde(rename = "type")]
    kind: String,
    person: Option<String>,
    topic: Option<String>,
    #[allow(dead_code)]
    request_id: Option<String>,
}

fn resolve(ctx: &Context, person: &str) -> Result<Option<String>, String> {
    Ok(ctx
        .source
        .directory()?
        .into_iter()
        .find(|(_, emails)| {
            emails
                .iter()
                .any(|email| person_ref(&ctx.config.pepper, email) == person)
        })
        .map(|(id, _)| id))
}

/// Signals a peer may see without approval, and whether any others need the owner first.
/// Sensitive signals are dropped whatever the source returns.
fn partition(signals: &Value, policy: &Policy, approved: bool) -> (Vec<Value>, bool) {
    let mut shown = vec![];
    let mut held = false;
    for signal in signals.as_array().into_iter().flatten() {
        let gate = match signal["tier"].as_str() {
            Some("open") => policy.open,
            Some("personal") => policy.personal,
            _ => continue,
        };
        match (gate, approved) {
            (Gate::Never, _) => {}
            (Gate::Auto, _) | (Gate::Approve, true) => shown.push(json!({
                "category": signal["category"],
                "summary": signal["summary"],
                "observedMonth": signal["observedMonth"],
                "expiresAt": signal["expiresAt"],
            })),
            (Gate::Approve, false) => held = true,
        }
    }
    (shown, held)
}

fn new_ticket(
    state: &mut PeerState,
    caller: &str,
    kind: &str,
    person: Option<&str>,
    person_id: Option<String>,
    topic: Option<String>,
    now: u64,
) -> Result<String, config::Error> {
    let id = random_hex(16)?;
    state.tickets.push(Ticket {
        id: id.clone(),
        caller: caller.to_owned(),
        kind: kind.to_owned(),
        person: person.map(str::to_owned),
        person_id,
        topic,
        created: now,
        status: TicketStatus::Pending,
        answer: None,
    });
    Ok(id)
}

/// Answer one authenticated peer request. `caller` comes from the tailnet, never from the request.
pub(crate) fn handle(
    ctx: &Context,
    state: &mut PeerState,
    caller: &str,
    method: &str,
    path: &str,
    body: &[u8],
    now: u64,
) -> Reply {
    let mut audit = json!({"at":now,"caller":caller,"type":Value::Null,"person":Value::Null,"outcome":"","categories":[]});
    let (status, body, outcome) = respond(ctx, state, caller, method, path, body, now, &mut audit);
    audit["outcome"] = json!(outcome);
    Reply {
        status,
        body,
        audit,
    }
}

type Out = (u16, Value, &'static str);

fn reply(status: u16, body: Value, outcome: &'static str) -> Out {
    (status, body, outcome)
}

fn error(code: &str) -> Value {
    json!({"error":code})
}

fn unavailable() -> Out {
    reply(
        503,
        error("peer_source_unavailable"),
        "peer_source_unavailable",
    )
}

#[allow(clippy::too_many_arguments)]
fn respond(
    ctx: &Context,
    state: &mut PeerState,
    caller: &str,
    method: &str,
    path: &str,
    body: &[u8],
    now: u64,
    audit: &mut Value,
) -> Out {
    if !ctx.config.allow.iter().any(|login| login == caller) {
        return reply(403, error("peer_not_allowed"), "peer_not_allowed");
    }
    state.prune(now);
    if state
        .recent
        .iter()
        .filter(|r| r.caller == caller && r.at + MINUTE > now)
        .count()
        >= PER_MINUTE
    {
        return reply(429, error("peer_rate_limited"), "peer_rate_limited");
    }
    if method == "GET" && path == "/peer/v1/opt-outs" {
        state.recent.push(Recent {
            caller: caller.to_owned(),
            subject: None,
            at: now,
        });
        return reply(
            200,
            json!({"refs":ctx.config.do_not_answer_about}),
            "answered",
        );
    }
    if method == "GET"
        && let Some(id) = path.strip_prefix("/peer/v1/tickets/")
    {
        let Some(ticket) = state
            .tickets
            .iter()
            .find(|t| t.id == id && t.caller == caller)
        else {
            return reply(404, error("not_found"), "not_found");
        };
        if ticket.created + TICKET_TTL <= now {
            return reply(410, error("ticket_expired"), "ticket_expired");
        }
        return match ticket.status {
            TicketStatus::Pending => reply(
                202,
                json!({"ticket":ticket.id,"status":"pending"}),
                "ticket_pending",
            ),
            TicketStatus::Denied => reply(
                200,
                json!({"ticket":ticket.id,"status":"denied"}),
                "ticket_denied",
            ),
            TicketStatus::Approved => reply(
                200,
                json!({"ticket":ticket.id,"status":"approved","answer":ticket.answer}),
                "ticket_answered",
            ),
        };
    }
    if method != "POST" || path != "/peer/v1/query" {
        return reply(404, error("not_found"), "not_found");
    }
    if body.len() > MAX_BODY {
        return reply(400, error("invalid_request"), "invalid_request");
    }
    let Ok(query) = serde_json::from_slice::<Query>(body) else {
        return reply(400, error("invalid_request"), "invalid_request");
    };
    audit["type"] = json!(query.kind);
    let subject = query.person.clone();
    if let Some(person) = &subject {
        audit["person"] = json!(person);
        if state
            .recent
            .iter()
            .filter(|r| r.caller == caller && r.subject.as_deref() == Some(person))
            .count()
            >= PER_SUBJECT_DAY
        {
            return reply(429, error("peer_rate_limited"), "peer_rate_limited");
        }
    }
    state.recent.push(Recent {
        caller: caller.to_owned(),
        subject: subject.clone(),
        at: now,
    });
    match query.kind.as_str() {
        "knows" | "catch_up" => {
            let Some(person) = subject.as_deref().filter(|p| is_ref(p)) else {
                return reply(400, error("invalid_request"), "invalid_request");
            };
            if query.topic.is_some() {
                return reply(400, error("invalid_request"), "invalid_request");
            }
            if ctx.opted_out.contains(person)
                || ctx.config.do_not_answer_about.iter().any(|r| r == person)
            {
                return reply(403, error("subject_opted_out"), "subject_opted_out");
            }
            let person_id = match resolve(ctx, person) {
                Ok(id) => id,
                Err(_) => return unavailable(),
            };
            if query.kind == "knows" {
                if ctx.config.policy.open == Gate::Never {
                    return reply(403, error("policy_declined"), "policy_declined");
                }
                let Some(id) = person_id else {
                    return reply(200, json!({"known":false}), "answered");
                };
                return match ctx.source.answer(&id, "knows") {
                    Ok(answer) if answer["known"] == true => reply(
                        200,
                        json!({"known":true,"band":answer["band"],"lastContactMonth":answer["lastContactMonth"]}),
                        "answered",
                    ),
                    Ok(_) => reply(200, json!({"known":false}), "answered"),
                    Err(_) => unavailable(),
                };
            }
            let Some(id) = person_id else {
                return reply(200, json!({"signals":[]}), "answered");
            };
            let answer = match ctx.source.answer(&id, "catch_up") {
                Ok(answer) => answer,
                Err(_) => return unavailable(),
            };
            let (shown, held) = partition(&answer["signals"], &ctx.config.policy, false);
            audit["categories"] = json!(
                shown
                    .iter()
                    .map(|s| s["category"].clone())
                    .collect::<Vec<_>>()
            );
            if !held {
                return reply(200, json!({"signals":shown}), "answered");
            }
            match new_ticket(state, caller, "catch_up", Some(person), Some(id), None, now) {
                Ok(ticket) => reply(202, json!({"ticket":ticket,"signals":shown}), "ticket"),
                Err(_) => unavailable(),
            }
        }
        "reason_to_meet" => {
            let Some(topic) = query
                .topic
                .as_deref()
                .map(str::trim)
                .filter(|t| !t.is_empty() && t.chars().count() <= MAX_TEXT)
            else {
                return reply(400, error("invalid_request"), "invalid_request");
            };
            if query.person.is_some() {
                return reply(400, error("invalid_request"), "invalid_request");
            }
            if ctx.config.policy.reason_to_meet == Gate::Never {
                return reply(403, error("policy_declined"), "policy_declined");
            }
            match new_ticket(
                state,
                caller,
                "reason_to_meet",
                None,
                None,
                Some(topic.to_owned()),
                now,
            ) {
                Ok(ticket) => reply(202, json!({"ticket":ticket}), "ticket"),
                Err(_) => unavailable(),
            }
        }
        _ => reply(400, error("invalid_request"), "invalid_request"),
    }
}

/// The owner approves one pending ticket; catch-up answers are recomputed now, under policy.
pub(crate) fn approve(
    config: &PeerConfig,
    source: &dyn Source,
    state: &mut PeerState,
    id: &str,
    reason: Option<&str>,
    now: u64,
) -> Result<Value, config::Error> {
    let ticket = state
        .tickets
        .iter_mut()
        .find(|t| t.id == id && t.status == TicketStatus::Pending && t.created + TICKET_TTL > now)
        .ok_or(("not_found", "No pending ticket has that id."))?;
    let answer = if ticket.kind == "reason_to_meet" {
        let reason = reason
            .map(str::trim)
            .filter(|r| !r.is_empty() && r.chars().count() <= MAX_TEXT)
            .ok_or((
                "invalid_request",
                "Give a reason of 1–200 characters with --reason.",
            ))?;
        json!({"topic":ticket.topic,"reason":reason})
    } else {
        let person_id = ticket.person_id.as_deref().ok_or(INVALID)?;
        let answer = source.answer(person_id, "catch_up").map_err(|_| {
            (
                "peer_source_unavailable",
                "Cannot reach People to answer this ticket.",
            )
        })?;
        json!({"signals":partition(&answer["signals"], &config.policy, true).0})
    };
    ticket.status = TicketStatus::Approved;
    ticket.answer = Some(answer.clone());
    Ok(json!({"ticket":id,"status":"approved","answer":answer}))
}

pub(crate) fn deny(state: &mut PeerState, id: &str, now: u64) -> Result<Value, config::Error> {
    let ticket = state
        .tickets
        .iter_mut()
        .find(|t| t.id == id && t.status == TicketStatus::Pending && t.created + TICKET_TTL > now)
        .ok_or(("not_found", "No pending ticket has that id."))?;
    ticket.status = TicketStatus::Denied;
    Ok(json!({"ticket":id,"status":"denied"}))
}

// ---------- Command line, server and asker ----------

#[derive(Args, Debug, Clone)]
pub(crate) struct PeerArgs {
    /// Hosted People origin used to answer questions; alternatively set PEOPLEGRAPH_WEB_URL.
    #[arg(long, global = true)]
    url: Option<String>,
    #[command(subcommand)]
    command: PeerCommand,
}

#[derive(Subcommand, Debug, Clone)]
enum PeerCommand {
    /// Start a peer group and its shared secret; share the secret out of band for `peer join`.
    Init {
        #[arg(long)]
        group: String,
    },
    /// Join a peer group; reads the group secret from standard input.
    Join {
        #[arg(long)]
        group: String,
        #[arg(long, required = true)]
        pepper_stdin: bool,
    },
    /// Let a tailnet login ask you questions.
    Allow { login: String },
    /// Stop answering a tailnet login.
    Disallow { login: String },
    /// Add a peer you can ask, at its `peer serve` address.
    Add {
        login: String,
        #[arg(long)]
        address: String,
    },
    /// Stop asking a peer.
    Remove { login: String },
    /// Ask group members not to answer questions about you (by your email addresses).
    OptOut {
        #[arg(value_parser = ["on", "off"])]
        state: String,
        #[arg(long = "email")]
        emails: Vec<String>,
    },
    /// What you answer automatically, after approval, or never. Sensitive signals are never shared.
    Policy {
        #[arg(long)]
        open: Option<Gate>,
        #[arg(long)]
        personal: Option<Gate>,
        #[arg(long)]
        reason_to_meet: Option<Gate>,
    },
    /// Show the group, allow list, peers and policy (never the secret).
    Status,
    /// Answer peer questions on this node's Tailscale address.
    Serve {
        #[arg(long, default_value_t = 8790)]
        port: u16,
        /// Debug builds only: bind a loopback address with a fixed caller for tests.
        #[arg(long, hide = true)]
        test_bind: Option<String>,
    },
    /// Questions waiting for your approval.
    Pending,
    /// Answer one pending question; reasons to meet need --reason.
    Approve {
        ticket: String,
        #[arg(long)]
        reason: Option<String>,
    },
    /// Decline one pending question.
    Deny { ticket: String },
    /// Every question peers asked you, newest last.
    Log {
        /// YYYY-MM-DD
        #[arg(long)]
        since: Option<String>,
    },
    /// Ask every configured peer one question. Only on the owner's request, never in the background.
    Ask {
        #[command(subcommand)]
        question: PeerQuestion,
    },
}

#[derive(Subcommand, Debug, Clone)]
enum PeerQuestion {
    /// Does each peer know this person, and how well?
    Knows { email: String },
    /// What each peer may share about this person's life lately.
    CatchUp { email: String },
    /// Would a peer like to meet about a topic? Always needs their approval.
    ReasonToMeet {
        #[arg(long)]
        topic: String,
    },
    /// Fetch the answer to an earlier ticket.
    Status {
        #[arg(long)]
        peer: String,
        ticket: String,
    },
}

const NOT_CONFIGURED: config::Error = (
    "peer_not_configured",
    "No peer group is configured; run peoplegraph peer init or peer join first.",
);
const INVALID_REQUEST: config::Error = ("invalid_request", "Check the command's arguments.");

fn unix_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn configured() -> Result<PeerConfig, config::Error> {
    load_config()?.ok_or(NOT_CONFIGURED)
}

fn login(value: &str) -> Result<String, config::Error> {
    let value = value.trim();
    if value.is_empty() || value.len() > MAX_TEXT || value.chars().any(char::is_whitespace) {
        return Err(INVALID_REQUEST);
    }
    Ok(value.to_owned())
}

pub(crate) fn run(args: &PeerArgs, start: Instant) -> Response {
    match execute(args, unix_now()) {
        Ok(data) => ok("peer", data, json!({"ms":elapsed_ms(start)})),
        Err((kind, message)) => fail("peer", kind, message.to_owned(), start),
    }
}

fn execute(args: &PeerArgs, now: u64) -> Result<Value, config::Error> {
    let start_group = |group: &str, pepper: String| {
        if load_config()?.is_some() {
            return Err((
                "peer_already_configured",
                "A peer group is already configured; edit peers.json to leave it first.",
            ));
        }
        let config = PeerConfig::new(group.trim(), pepper);
        save_config(&config)?;
        Ok(config.public())
    };
    match &args.command {
        PeerCommand::Init { group } => start_group(group, random_hex(32)?),
        PeerCommand::Join { group, .. } => {
            let mut secret = String::new();
            std::io::stdin()
                .take(1_024)
                .read_to_string(&mut secret)
                .map_err(|_| INVALID_REQUEST)?;
            let secret = secret.trim();
            if secret.len() < 32 || secret.chars().any(char::is_whitespace) {
                return Err((
                    "invalid_request",
                    "Pipe the group secret from peer init on standard input.",
                ));
            }
            start_group(group, secret.to_owned())
        }
        PeerCommand::Serve { port, test_bind } => serve(args, *port, test_bind.as_deref()),
        PeerCommand::Ask { question } => ask(&configured()?, question),
        PeerCommand::Pending => {
            configured()?;
            let state = load_state()?;
            Ok(json!({"tickets":state.pending(now).iter().map(|t| json!({
                "id": t.id, "caller": t.caller, "type": t.kind, "personId": t.person_id,
                "topic": t.topic, "expiresAt": t.created + TICKET_TTL,
            })).collect::<Vec<_>>()}))
        }
        PeerCommand::Approve { ticket, reason } => {
            let config = configured()?;
            let mut state = load_state()?;
            let kind = state
                .tickets
                .iter()
                .find(|t| &t.id == ticket)
                .map(|t| t.kind.clone())
                .unwrap_or_default();
            let answer = if kind == "catch_up" {
                let source = Hosted::new(people_client::configure(args.url.as_deref())?);
                approve(&config, &source, &mut state, ticket, reason.as_deref(), now)?
            } else {
                approve(
                    &config,
                    &Offline,
                    &mut state,
                    ticket,
                    reason.as_deref(),
                    now,
                )?
            };
            save_state(&mut state, now)?;
            Ok(answer)
        }
        PeerCommand::Deny { ticket } => {
            configured()?;
            let mut state = load_state()?;
            let answer = deny(&mut state, ticket, now)?;
            save_state(&mut state, now)?;
            Ok(answer)
        }
        PeerCommand::Log { since } => {
            configured()?;
            let since = match since {
                Some(date) => {
                    date_to_unix(date).ok_or(("invalid_request", "Give --since as YYYY-MM-DD."))?
                }
                None => 0,
            };
            Ok(json!({"entries":read_audit(since)?}))
        }
        command => {
            let mut config = configured()?;
            match command {
                PeerCommand::Allow { login: value } => {
                    let value = login(value)?;
                    if !config.allow.contains(&value) {
                        config.allow.push(value);
                    }
                }
                PeerCommand::Disallow { login: value } => {
                    config.allow.retain(|l| l != value.trim());
                }
                PeerCommand::Add {
                    login: value,
                    address,
                } => {
                    let value = login(value)?;
                    let address = address.trim().trim_end_matches('/');
                    if !(address.starts_with("http://") || address.starts_with("https://"))
                        || address.len() > MAX_TEXT
                    {
                        return Err((
                            "invalid_request",
                            "Give the peer's address as http://<tailscale-ip>:8790.",
                        ));
                    }
                    config.peers.retain(|p| p.login != value);
                    config.peers.push(PeerRef {
                        login: value,
                        url: address.to_owned(),
                    });
                }
                PeerCommand::Remove { login: value } => {
                    config.peers.retain(|p| p.login != value.trim());
                }
                PeerCommand::OptOut { state, emails } => {
                    if state == "on" {
                        if emails.is_empty() || emails.iter().any(|e| !e.contains('@')) {
                            return Err((
                                "invalid_request",
                                "Give each of your addresses with --email.",
                            ));
                        }
                        config.do_not_answer_about = emails
                            .iter()
                            .map(|e| person_ref(&config.pepper, e))
                            .collect();
                    } else {
                        config.do_not_answer_about.clear();
                    }
                }
                PeerCommand::Policy {
                    open,
                    personal,
                    reason_to_meet,
                } => {
                    if *personal == Some(Gate::Auto) || *reason_to_meet == Some(Gate::Auto) {
                        return Err((
                            "invalid_request",
                            "Personal signals and reasons to meet always need your approval; use approve or never.",
                        ));
                    }
                    config.policy.open = open.unwrap_or(config.policy.open);
                    config.policy.personal = personal.unwrap_or(config.policy.personal);
                    config.policy.reason_to_meet =
                        reason_to_meet.unwrap_or(config.policy.reason_to_meet);
                }
                _ => {}
            }
            save_config(&config)?;
            Ok(config.public())
        }
    }
}

/// Days since 1970-01-01 for a civil date (Howard Hinnant's algorithm), as unix seconds.
fn date_to_unix(date: &str) -> Option<u64> {
    let mut parts = date.split('-');
    let (y, m, d): (i64, i64, i64) = (
        parts.next()?.parse().ok()?,
        parts.next()?.parse().ok()?,
        parts.next()?.parse().ok()?,
    );
    if parts.next().is_some() || !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return None;
    }
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    u64::try_from((era * 146_097 + doe - 719_468) * DAY as i64).ok()
}

/// The owner's hosted People data, read with the owner's own credential.
struct Hosted {
    client: people_client::Client,
    directory: RefCell<Option<(Instant, Directory)>>,
}

impl Hosted {
    fn new(client: people_client::Client) -> Self {
        Self {
            client,
            directory: RefCell::new(None),
        }
    }

    fn get(&self, path: &str) -> Result<Value, String> {
        self.client
            .request_json(
                "POST",
                "/api/people-agent/request",
                Some(json!({"method":"GET","path":path})),
            )
            .map_err(|error| error.message)
    }
}

impl Source for Hosted {
    fn directory(&self) -> Result<Directory, String> {
        if let Some((at, people)) = self.directory.borrow().as_ref()
            && at.elapsed() < Duration::from_secs(600)
        {
            return Ok(people.clone());
        }
        let value = self.get("/api/people/peer-directory")?;
        let people: Directory = value["people"]
            .as_array()
            .ok_or("People returned no directory")?
            .iter()
            .filter_map(|p| {
                let id = p["personId"].as_str()?.to_owned();
                let emails = p["emails"]
                    .as_array()?
                    .iter()
                    .filter_map(|e| e.as_str().map(str::to_owned))
                    .collect();
                Some((id, emails))
            })
            .collect();
        *self.directory.borrow_mut() = Some((Instant::now(), people.clone()));
        Ok(people)
    }

    fn answer(&self, person_id: &str, kind: &str) -> Result<Value, String> {
        self.get(&format!(
            "/api/people/peer-answer?personId={}&type={kind}",
            url_encode(person_id)
        ))
    }
}

/// Used when answering needs no People data (reasons to meet).
struct Offline;

impl Source for Offline {
    fn directory(&self) -> Result<Directory, String> {
        Err("offline".into())
    }
    fn answer(&self, _: &str, _: &str) -> Result<Value, String> {
        Err("offline".into())
    }
}

const NO_TAILSCALE: config::Error = (
    "tailscale_unavailable",
    "peer serve needs Tailscale running on this machine with an IPv4 tailnet address.",
);

/// This node's tailnet IPv4 address (100.64.0.0/10).
fn tailscale_ip() -> Result<IpAddr, config::Error> {
    let output = ProcessCommand::new("tailscale")
        .args(["ip", "-4"])
        .output()
        .map_err(|_| NO_TAILSCALE)?;
    let text = String::from_utf8_lossy(&output.stdout);
    let ip: Ipv4Addr = text
        .lines()
        .next()
        .and_then(|line| line.trim().parse().ok())
        .ok_or(NO_TAILSCALE)?;
    let [a, b, ..] = ip.octets();
    if !output.status.success() || a != 100 || b & 0xc0 != 64 {
        return Err(NO_TAILSCALE);
    }
    Ok(IpAddr::V4(ip))
}

/// The tailnet user behind a connection, from Tailscale itself; tagged nodes have no user.
fn whois(remote: SocketAddr) -> Option<String> {
    let output = ProcessCommand::new("tailscale")
        .args(["whois", "--json", &remote.to_string()])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let value: Value = serde_json::from_slice(&output.stdout).ok()?;
    if value["Node"]["Tags"]
        .as_array()
        .is_some_and(|tags| !tags.is_empty())
    {
        return None;
    }
    value["UserProfile"]["LoginName"]
        .as_str()
        .filter(|login| !login.is_empty() && *login != "tagged-devices")
        .map(str::to_owned)
}

fn serve(args: &PeerArgs, port: u16, test_bind: Option<&str>) -> Result<Value, config::Error> {
    let config = configured()?;
    let ip = match test_bind {
        Some(bind) if cfg!(debug_assertions) => bind
            .parse::<IpAddr>()
            .ok()
            .filter(IpAddr::is_loopback)
            .ok_or(INVALID_REQUEST)?,
        Some(_) => return Err(INVALID_REQUEST),
        None => tailscale_ip()?,
    };
    // Tests fix the caller; this never applies to a tailnet address.
    let test_caller = test_bind
        .and_then(|_| std::env::var("PEOPLEGRAPH_PEER_TEST_IDENTITY").ok())
        .filter(|_| cfg!(debug_assertions));
    let source = Hosted::new(people_client::configure(args.url.as_deref())?);
    let listener = TcpListener::bind((ip, port)).map_err(|_| {
        (
            "bind_failed",
            "Cannot listen on the Tailscale address and port.",
        )
    })?;
    let local = listener.local_addr().map_err(|_| INVALID_REQUEST)?;
    let mut stdout = std::io::stdout();
    let _ = writeln!(
        stdout,
        "{}",
        json!({"ok":true,"command":"peer","data":{"listening":local.to_string(),"group":config.group}})
    );
    let _ = stdout.flush();
    let mut opted = fetch_opt_outs(&config);
    let mut fetched = Instant::now();
    for stream in listener.incoming() {
        let Ok(mut stream) = stream else { continue };
        if fetched.elapsed() > Duration::from_secs(600) {
            if let Ok(config) = configured() {
                opted = fetch_opt_outs(&config);
            }
            fetched = Instant::now();
        }
        let caller = match &test_caller {
            Some(login) => Some(login.clone()),
            None => stream.peer_addr().ok().and_then(whois),
        };
        serve_one(&mut stream, caller.as_deref(), &source, &opted);
    }
    Ok(json!({"stopped":true}))
}

fn serve_one(
    stream: &mut TcpStream,
    caller: Option<&str>,
    source: &Hosted,
    opted: &HashSet<String>,
) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let now = unix_now();
    let Some((method, path, body)) = read_request(stream) else {
        return write_reply(stream, 400, &error("invalid_request"));
    };
    let Some(caller) = caller else {
        let _ = append_audit(
            &json!({"at":now,"caller":Value::Null,"type":Value::Null,"person":Value::Null,"outcome":"peer_not_allowed","categories":[]}),
        );
        return write_reply(stream, 403, &error("peer_not_allowed"));
    };
    // Re-read each time so allow-list and policy changes apply without a restart.
    let (Ok(config), Ok(mut state)) = (configured(), load_state()) else {
        return write_reply(stream, 503, &error("peer_unavailable"));
    };
    let ctx = Context {
        config: &config,
        source,
        opted_out: opted,
    };
    let reply = handle(&ctx, &mut state, caller, &method, &path, &body, now);
    let _ = save_state(&mut state, now);
    let _ = append_audit(&reply.audit);
    write_reply(stream, reply.status, &reply.body);
}

/// One HTTP/1.1 request with at most 16 KB of headers and a 4 KB body.
fn read_request(stream: &mut TcpStream) -> Option<(String, String, Vec<u8>)> {
    let mut data = Vec::new();
    let mut chunk = [0_u8; 4_096];
    let head = loop {
        let size = stream.read(&mut chunk).ok()?;
        if size == 0 {
            return None;
        }
        data.extend_from_slice(&chunk[..size]);
        if let Some(offset) = data.windows(4).position(|b| b == b"\r\n\r\n") {
            break offset;
        }
        if data.len() > 16_384 {
            return None;
        }
    };
    let headers = std::str::from_utf8(&data[..head]).ok()?;
    let mut lines = headers.lines();
    let mut first = lines.next()?.split_whitespace();
    let (method, path) = (first.next()?.to_owned(), first.next()?.to_owned());
    let length = lines
        .filter_map(|line| line.split_once(':'))
        .find(|(name, _)| name.trim().eq_ignore_ascii_case("content-length"))
        .map(|(_, value)| value.trim().parse::<usize>().ok())
        .unwrap_or(Some(0))?;
    if length > MAX_BODY {
        return None;
    }
    let mut body = data[head + 4..].to_vec();
    while body.len() < length {
        let size = stream.read(&mut chunk).ok()?;
        if size == 0 {
            return None;
        }
        body.extend_from_slice(&chunk[..size]);
    }
    body.truncate(length);
    Some((method, path, body))
}

fn write_reply(stream: &mut TcpStream, status: u16, body: &Value) {
    let reason = match status {
        200 => "OK",
        202 => "Accepted",
        400 => "Bad Request",
        403 => "Forbidden",
        404 => "Not Found",
        410 => "Gone",
        429 => "Too Many Requests",
        _ => "Service Unavailable",
    };
    let body = body.to_string();
    let _ = write!(
        stream,
        "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nCache-Control: no-store\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
}

/// One request to a peer; `Err` means the peer could not be reached or did not answer HTTP.
fn peer_http(method: &str, url: &str, body: Option<&Value>, timeout: Duration) -> PeerReply {
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .http_status_as_error(false)
        .max_redirects(0)
        .timeout_global(Some(timeout))
        .build()
        .into();
    let request = ureq::http::Request::builder().method(method).uri(url);
    let response = match body {
        Some(body) => agent.run(
            request
                .header("content-type", "application/json")
                .body(body.to_string())
                .map_err(|_| ())?,
        ),
        None => agent.run(request.body(()).map_err(|_| ())?),
    };
    let mut response = response.map_err(|_| ())?;
    let status = response.status().as_u16();
    let text = response
        .body_mut()
        .with_config()
        .limit(64 * 1_024)
        .read_to_string()
        .map_err(|_| ())?;
    Ok((status, serde_json::from_str(&text).unwrap_or(Value::Null)))
}

/// Every group member's published opt-outs; unreachable peers contribute nothing.
fn fetch_opt_outs(config: &PeerConfig) -> HashSet<String> {
    config
        .peers
        .iter()
        .filter_map(|peer| {
            peer_http(
                "GET",
                &format!("{}/peer/v1/opt-outs", peer.url),
                None,
                Duration::from_secs(5),
            )
            .ok()
        })
        .flat_map(|(_, body)| {
            body["refs"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|r| r.as_str().filter(|r| is_ref(r)).map(str::to_owned))
                .collect::<Vec<_>>()
        })
        .collect()
}

/// Ask every configured peer in parallel; answers are attributed, unreachable peers become gaps.
fn ask(config: &PeerConfig, question: &PeerQuestion) -> Result<Value, config::Error> {
    let email = |email: &str| {
        if email.contains('@') && email.len() <= 320 {
            Ok(person_ref(&config.pepper, email))
        } else {
            Err(("invalid_request", "Ask about a person by email address."))
        }
    };
    let body = match question {
        PeerQuestion::Status { peer, ticket } => {
            let peer = config
                .peers
                .iter()
                .find(|p| &p.login == peer)
                .ok_or(("not_found", "No configured peer has that login."))?;
            if ticket.len() != 32 || !ticket.bytes().all(|b| b.is_ascii_hexdigit()) {
                return Err(INVALID_REQUEST);
            }
            let (status, answer) = peer_http(
                "GET",
                &format!("{}/peer/v1/tickets/{ticket}", peer.url),
                None,
                Duration::from_secs(10),
            )
            .map_err(|_| ("peer_unreachable", "That peer did not answer."))?;
            return Ok(json!({"peer":peer.login,"status":status,"answer":answer}));
        }
        PeerQuestion::Knows { email: value } => {
            json!({"type":"knows","person":email(value)?,"requestId":random_hex(8)?})
        }
        PeerQuestion::CatchUp { email: value } => {
            json!({"type":"catch_up","person":email(value)?,"requestId":random_hex(8)?})
        }
        PeerQuestion::ReasonToMeet { topic } => {
            let topic = topic.trim();
            if topic.is_empty() || topic.chars().count() > MAX_TEXT {
                return Err(("invalid_request", "Give a topic of 1–200 characters."));
            }
            json!({"type":"reason_to_meet","topic":topic,"requestId":random_hex(8)?})
        }
    };
    if config.peers.is_empty() {
        return Err((
            "peer_none",
            "No peers are configured; add one with peoplegraph peer add.",
        ));
    }
    let replies: Vec<(String, PeerReply)> = std::thread::scope(|scope| {
        let handles: Vec<_> = config
            .peers
            .iter()
            .map(|peer| {
                let body = &body;
                scope.spawn(move || {
                    peer_http(
                        "POST",
                        &format!("{}/peer/v1/query", peer.url),
                        Some(body),
                        Duration::from_secs(10),
                    )
                })
            })
            .collect();
        config
            .peers
            .iter()
            .zip(handles)
            .map(|(peer, handle)| (peer.login.clone(), handle.join().unwrap_or(Err(()))))
            .collect()
    });
    let mut results = vec![];
    let mut gaps = vec![];
    for (peer, reply) in replies {
        match reply {
            Ok((status, answer)) => {
                results.push(json!({"peer":peer,"status":status,"answer":answer}))
            }
            Err(()) => gaps.push(json!({"peer":peer,"reason":"unreachable"})),
        }
    }
    Ok(json!({"question":body["type"],"results":results,"gaps":gaps}))
}

/// Gaps from one fan-out: unreachable peers, answers waiting for approval, and refusals.
fn fan_out_gaps(result: &Value) -> Vec<String> {
    let mut gaps: Vec<String> = result["gaps"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|gap| format!("Peer {} unreachable", gap["peer"].as_str().unwrap_or("?")))
        .collect();
    for reply in result["results"].as_array().into_iter().flatten() {
        let peer = reply["peer"].as_str().unwrap_or("?");
        match (reply["status"].as_u64(), reply["answer"]["ticket"].as_str()) {
            (Some(200), _) => {}
            (Some(202), Some(ticket)) => gaps.push(format!(
                "Peer {peer} shares more after their approval: peoplegraph peer ask status --peer {peer} {ticket}"
            )),
            _ => gaps.push(format!(
                "Peer {peer} did not answer: {}",
                reply["answer"]["error"].as_str().unwrap_or("error")
            )),
        }
    }
    gaps
}

fn push_gaps(data: &mut Value, gaps: Vec<String>) {
    if !data["gaps"].is_array() {
        data["gaps"] = json!([]);
    }
    if let Some(list) = data["gaps"].as_array_mut() {
        list.extend(gaps.into_iter().map(Value::String));
    }
}

/// `brief --peers`: peers' catch-up answers join the hosted brief as attributed `why` entries.
pub(crate) fn brief_with_peers(mut response: Response, person: &str) -> Response {
    let Some(data) = response.data.as_mut().filter(|_| response.ok) else {
        return response;
    };
    let mut gaps = vec![];
    if !person.contains('@') {
        gaps.push("Peers are asked by email address; run brief <email> --peers.".to_owned());
    } else {
        match configured().and_then(|config| {
            ask(
                &config,
                &PeerQuestion::CatchUp {
                    email: person.to_owned(),
                },
            )
        }) {
            Ok(result) => {
                let entries: Vec<Value> = result["results"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter(|r| matches!(r["status"].as_u64(), Some(200 | 202)))
                    .flat_map(|r| {
                        let attribution = format!("peer:{}", r["peer"].as_str().unwrap_or("?"));
                        r["answer"]["signals"]
                            .as_array()
                            .into_iter()
                            .flatten()
                            .map(move |s| {
                                json!({
                                    "kind": "life", "category": s["category"], "summary": s["summary"],
                                    "source": "peer", "observedAt": s["observedMonth"],
                                    "attribution": attribution, "use": "rank",
                                })
                            })
                            .collect::<Vec<_>>()
                    })
                    .collect();
                if !data["why"].is_array() {
                    data["why"] = json!([]);
                }
                if let Some(why) = data["why"].as_array_mut() {
                    why.extend(entries);
                }
                gaps.extend(fan_out_gaps(&result));
            }
            Err((_, message)) => gaps.push(message.to_owned()),
        }
    }
    push_gaps(data, gaps);
    response
}

/// Hosted `ask` classified a peer question: the CLI asks the group (knows + catch-up) for the person.
pub(crate) fn ask_with_peers(mut response: Response) -> Response {
    let Some(data) = response
        .data
        .as_mut()
        .filter(|data| response.ok && data["interpretation"]["intent"] == "network_ask")
    else {
        return response;
    };
    let person = data["interpretation"]["params"]["person"]
        .as_str()
        .unwrap_or("")
        .to_owned();
    data["gaps"] = json!([]);
    let mut gaps = vec![];
    if !person.contains('@') {
        gaps.push("Peers are asked by email address; ask again with their email.".to_owned());
    } else {
        match configured() {
            Ok(config) => {
                let mut results = json!({});
                for (key, question) in [
                    (
                        "knows",
                        PeerQuestion::Knows {
                            email: person.clone(),
                        },
                    ),
                    (
                        "catchUp",
                        PeerQuestion::CatchUp {
                            email: person.clone(),
                        },
                    ),
                ] {
                    match ask(&config, &question) {
                        Ok(result) => {
                            for gap in fan_out_gaps(&result) {
                                if !gaps.contains(&gap) {
                                    gaps.push(gap);
                                }
                            }
                            results[key] = result;
                        }
                        Err((_, message)) => gaps.push(message.to_owned()),
                    }
                }
                data["peerResults"] = results;
            }
            Err((_, message)) => gaps.push(message.to_owned()),
        }
    }
    push_gaps(data, gaps);
    response
}

#[cfg(test)]
mod tests {
    use super::*;

    const PEPPER: &str = "0123456789abcdef0123456789abcdef";
    const NOW: u64 = 1_800_000_000;

    struct Fake {
        signals: Value,
    }

    impl Source for Fake {
        fn directory(&self) -> Result<Directory, String> {
            Ok(vec![
                ("p-ada".into(), vec!["ada@example.test".into()]),
                ("p-bo".into(), vec!["bo@example.test".into()]),
            ])
        }
        fn answer(&self, person_id: &str, kind: &str) -> Result<Value, String> {
            Ok(match (person_id, kind) {
                (_, "knows") => json!({"known":true,"band":"some","lastContactMonth":"2026-10"}),
                ("p-ada", _) => json!({"signals":self.signals}),
                _ => json!({"signals":[]}),
            })
        }
    }

    fn signals() -> Value {
        json!([
            {"category":"travel","tier":"open","summary":"Back from Japan","observedMonth":"2026-10","expiresAt":"2026-12-01T00:00:00.000Z"},
            {"category":"milestone","tier":"personal","summary":"Got married","observedMonth":"2026-09","expiresAt":"2027-03-01T00:00:00.000Z"},
            {"category":"health","tier":"sensitive","summary":"Recovering from surgery","observedMonth":"2026-10","expiresAt":"2027-01-01T00:00:00.000Z"},
        ])
    }

    fn config() -> PeerConfig {
        let mut config = PeerConfig::new("betaworks", PEPPER.into());
        config.allow = vec!["sam@example.test".into()];
        config
    }

    fn query(
        config: &PeerConfig,
        state: &mut PeerState,
        source: &Fake,
        caller: &str,
        body: Value,
        now: u64,
    ) -> Reply {
        let opted = HashSet::new();
        let ctx = Context {
            config,
            source,
            opted_out: &opted,
        };
        handle(
            &ctx,
            state,
            caller,
            "POST",
            "/peer/v1/query",
            body.to_string().as_bytes(),
            now,
        )
    }

    fn ada() -> String {
        person_ref(PEPPER, " Ada@Example.test ")
    }

    #[test]
    fn person_ref_is_hmac_sha256_of_the_normalised_email() {
        assert_eq!(
            person_ref("Jefe", "what do ya want for nothing?"),
            "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"
        );
        assert_eq!(ada(), person_ref(PEPPER, "ada@example.test"));
    }

    #[test]
    fn callers_outside_the_allow_list_are_refused() {
        let source = Fake { signals: signals() };
        let reply = query(
            &config(),
            &mut PeerState::default(),
            &source,
            "eve@example.test",
            json!({"type":"knows","person":ada()}),
            NOW,
        );
        assert_eq!(reply.status, 403);
        assert_eq!(reply.body, json!({"error":"peer_not_allowed"}));
    }

    #[test]
    fn knows_is_coarse_and_unknown_people_are_not_known() {
        let source = Fake { signals: signals() };
        let (config, mut state) = (config(), PeerState::default());
        let known = query(
            &config,
            &mut state,
            &source,
            "sam@example.test",
            json!({"type":"knows","person":ada()}),
            NOW,
        );
        assert_eq!(
            known.body,
            json!({"known":true,"band":"some","lastContactMonth":"2026-10"})
        );
        let unknown = query(
            &config,
            &mut state,
            &source,
            "sam@example.test",
            json!({"type":"knows","person":person_ref(PEPPER,"zed@example.test")}),
            NOW,
        );
        assert_eq!(unknown.body, json!({"known":false}));
    }

    #[test]
    fn catch_up_shows_open_holds_personal_and_never_sensitive() {
        let source = Fake { signals: signals() };
        let (config, mut state) = (config(), PeerState::default());
        let reply = query(
            &config,
            &mut state,
            &source,
            "sam@example.test",
            json!({"type":"catch_up","person":ada()}),
            NOW,
        );
        assert_eq!(reply.status, 202);
        assert_eq!(reply.body["signals"].as_array().unwrap().len(), 1);
        assert_eq!(reply.body["signals"][0]["summary"], "Back from Japan");
        assert!(!reply.body.to_string().contains("married"));
        assert!(!reply.body.to_string().contains("surgery"));
        let ticket = reply.body["ticket"].as_str().unwrap().to_owned();
        let opted = HashSet::new();
        let ctx = Context {
            config: &config,
            source: &source,
            opted_out: &opted,
        };
        let path = format!("/peer/v1/tickets/{ticket}");
        let pending = handle(&ctx, &mut state, "sam@example.test", "GET", &path, b"", NOW);
        assert_eq!(pending.status, 202);
        assert!(!pending.body.to_string().contains("married"));
        // Another caller cannot read Sam's ticket.
        assert_eq!(
            handle(&ctx, &mut state, "eve@example.test", "GET", &path, b"", NOW).status,
            403
        );
        approve(&config, &source, &mut state, &ticket, None, NOW + 10).unwrap();
        let answered = handle(
            &ctx,
            &mut state,
            "sam@example.test",
            "GET",
            &path,
            b"",
            NOW + 20,
        );
        assert_eq!(answered.status, 200);
        let text = answered.body.to_string();
        assert!(text.contains("married") && text.contains("Japan"));
        assert!(!text.contains("surgery"));
        let expired = handle(
            &ctx,
            &mut state,
            "sam@example.test",
            "GET",
            &path,
            b"",
            NOW + TICKET_TTL,
        );
        assert_eq!(expired.status, 410);
    }

    #[test]
    fn expired_tickets_are_gone_not_answered() {
        let source = Fake { signals: signals() };
        let (config, mut state) = (config(), PeerState::default());
        let reply = query(
            &config,
            &mut state,
            &source,
            "sam@example.test",
            json!({"type":"catch_up","person":ada()}),
            NOW,
        );
        let ticket = reply.body["ticket"].as_str().unwrap().to_owned();
        assert_eq!(
            approve(
                &config,
                &source,
                &mut state,
                &ticket,
                None,
                NOW + TICKET_TTL
            )
            .unwrap_err()
            .0,
            "not_found"
        );
    }

    #[test]
    fn a_misbehaving_source_still_cannot_leak_sensitive_signals() {
        let source = Fake { signals: signals() };
        let mut config = config();
        config.policy.open = Gate::Auto;
        let mut state = PeerState::default();
        let reply = query(
            &config,
            &mut state,
            &source,
            "sam@example.test",
            json!({"type":"catch_up","person":ada()}),
            NOW,
        );
        let ticket = reply.body["ticket"].as_str().unwrap().to_owned();
        let approved = approve(&config, &source, &mut state, &ticket, None, NOW).unwrap();
        assert!(!approved.to_string().contains("surgery"));
        assert!(!approved.to_string().contains("sensitive"));
    }

    #[test]
    fn unknown_and_known_but_quiet_people_look_the_same() {
        let source = Fake { signals: signals() };
        let (config, mut state) = (config(), PeerState::default());
        let unknown = query(
            &config,
            &mut state,
            &source,
            "sam@example.test",
            json!({"type":"catch_up","person":person_ref(PEPPER,"zed@example.test")}),
            NOW,
        );
        let quiet = query(
            &config,
            &mut state,
            &source,
            "sam@example.test",
            json!({"type":"catch_up","person":person_ref(PEPPER,"bo@example.test")}),
            NOW,
        );
        assert_eq!((unknown.status, quiet.status), (200, 200));
        assert_eq!(unknown.body.to_string(), quiet.body.to_string());
        assert_eq!(unknown.body.to_string(), r#"{"signals":[]}"#);
    }

    #[test]
    fn opted_out_subjects_are_refused() {
        let source = Fake { signals: signals() };
        let mut config = config();
        config.do_not_answer_about = vec![ada()];
        let reply = query(
            &config,
            &mut PeerState::default(),
            &source,
            "sam@example.test",
            json!({"type":"knows","person":ada()}),
            NOW,
        );
        assert_eq!(reply.status, 403);
        assert_eq!(reply.body, json!({"error":"subject_opted_out"}));
        let mut published = HashSet::new();
        published.insert(ada());
        let ctx = Context {
            config: &self::config(),
            source: &source,
            opted_out: &published,
        };
        let body = json!({"type":"catch_up","person":ada()}).to_string();
        let from_peer = handle(
            &ctx,
            &mut PeerState::default(),
            "sam@example.test",
            "POST",
            "/peer/v1/query",
            body.as_bytes(),
            NOW,
        );
        assert_eq!(from_peer.status, 403);
    }

    #[test]
    fn per_subject_and_per_minute_limits_apply() {
        let source = Fake { signals: json!([]) };
        let (config, mut state) = (config(), PeerState::default());
        for i in 0..3 {
            let reply = query(
                &config,
                &mut state,
                &source,
                "sam@example.test",
                json!({"type":"knows","person":ada()}),
                NOW + i,
            );
            assert_eq!(reply.status, 200);
        }
        let fourth = query(
            &config,
            &mut state,
            &source,
            "sam@example.test",
            json!({"type":"knows","person":ada()}),
            NOW + 5,
        );
        assert_eq!(fourth.status, 429);
        let mut state = PeerState::default();
        for i in 0..60 {
            let person = person_ref(PEPPER, &format!("p{i}@example.test"));
            let reply = query(
                &config,
                &mut state,
                &source,
                "sam@example.test",
                json!({"type":"knows","person":person}),
                NOW,
            );
            assert_eq!(reply.status, 200, "request {i}");
        }
        let limited = query(
            &config,
            &mut state,
            &source,
            "sam@example.test",
            json!({"type":"knows","person":ada()}),
            NOW + 1,
        );
        assert_eq!(limited.status, 429);
    }

    #[test]
    fn audit_entries_never_carry_summaries_or_topics() {
        let source = Fake { signals: signals() };
        let (config, mut state) = (config(), PeerState::default());
        let catch_up = query(
            &config,
            &mut state,
            &source,
            "sam@example.test",
            json!({"type":"catch_up","person":ada()}),
            NOW,
        );
        let meet = query(
            &config,
            &mut state,
            &source,
            "sam@example.test",
            json!({"type":"reason_to_meet","topic":"robotics hiring"}),
            NOW,
        );
        assert_eq!(meet.status, 202);
        for audit in [catch_up.audit, meet.audit] {
            let text = audit.to_string();
            assert!(
                !text.contains("Japan") && !text.contains("robotics"),
                "{text}"
            );
            assert_eq!(audit["caller"], "sam@example.test");
        }
    }

    #[test]
    fn reason_to_meet_needs_an_owner_reason() {
        let source = Fake { signals: json!([]) };
        let (config, mut state) = (config(), PeerState::default());
        let reply = query(
            &config,
            &mut state,
            &source,
            "sam@example.test",
            json!({"type":"reason_to_meet","topic":"robotics hiring"}),
            NOW,
        );
        let ticket = reply.body["ticket"].as_str().unwrap().to_owned();
        assert_eq!(
            approve(&config, &source, &mut state, &ticket, None, NOW)
                .unwrap_err()
                .0,
            "invalid_request"
        );
        let answer = approve(
            &config,
            &source,
            &mut state,
            &ticket,
            Some("We both hire robotics engineers"),
            NOW,
        )
        .unwrap();
        assert_eq!(answer["answer"]["topic"], "robotics hiring");
    }

    #[test]
    fn policies_that_auto_share_personal_signals_are_invalid() {
        let mut config = config();
        assert!(config.valid());
        config.policy.personal = Gate::Auto;
        assert!(!config.valid());
        assert!(!config.public().to_string().contains(PEPPER));
    }
}
