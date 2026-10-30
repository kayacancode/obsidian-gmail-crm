//! Typed connected-source controls over the existing owner-scoped machine adapter.
use crate::{
    Response,
    agent::WebArgs,
    config, elapsed_ms, fail, ok,
    people_client::{self, Client, ClientError},
};
use clap::{Args, Subcommand, ValueEnum};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
use std::{
    io::{IsTerminal, Read},
    time::Instant,
};

#[derive(Args, Debug, Clone)]
pub(crate) struct SourcesArgs {
    #[command(flatten)]
    web: WebArgs,
    #[command(subcommand)]
    action: SourcesAction,
}

#[derive(Subcommand, Debug, Clone)]
enum SourcesAction {
    /// Read Gmail account and Granola connection status. Requires sources:manage.
    Status,
    /// Connect a source; Gmail requires browser consent, Granola reads its key from stdin.
    Connect {
        #[command(subcommand)]
        provider: ConnectProvider,
    },
    /// Request a background import. Completion is reported by sources status.
    Sync {
        #[command(subcommand)]
        provider: SyncProvider,
    },
    /// Explicitly enable or disable automatic Gmail body context for one inbox.
    Context {
        #[command(subcommand)]
        provider: ContextProvider,
    },
}

#[derive(Subcommand, Debug, Clone)]
enum ConnectProvider {
    /// Return the People Accounts URL to complete Google's browser consent.
    Gmail,
    /// Read a Granola API key from piped stdin and start importing meetings.
    Granola {
        #[arg(long, required = true)]
        key_stdin: bool,
        /// recent imports the last 90 days; all imports all available meetings.
        #[arg(long, value_enum, default_value = "recent")]
        range: HistoryRange,
    },
}

#[derive(Subcommand, Debug, Clone)]
enum SyncProvider {
    Gmail {
        /// Exact connected inbox address, never a display name.
        #[arg(long)]
        email: String,
        /// Omit to resume the inbox's saved range; recent or all requests a full rescan.
        #[arg(long, value_enum)]
        range: Option<HistoryRange>,
    },
    Granola,
}

#[derive(Subcommand, Debug, Clone)]
enum ContextProvider {
    Gmail {
        #[arg(long)]
        email: String,
        #[arg(value_enum)]
        state: ContextState,
    },
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, ValueEnum)]
#[serde(rename_all = "lowercase")]
enum HistoryRange {
    Recent,
    All,
}

#[derive(Clone, Debug, ValueEnum)]
enum ContextState {
    On,
    Off,
}

// Decode only public status fields. Extra provider grants or API keys must never be printed.
#[derive(Deserialize, Serialize)]
struct Accounts {
    account: String,
    configured: bool,
    accounts: Vec<Account>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Account {
    email: String,
    status: AccountStatus,
    range: HistoryRange,
    processed: u64,
    last_sync: u64,
    error: String,
    context_enabled: bool,
    context_count: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    context_error: Option<String>,
    calendar_enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    calendar_status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    calendar_last_sync: Option<u64>,
    calendar_count: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    photos_enabled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    other_photos_enabled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    photo_status: Option<String>,
    photo_count: u64,
    matched_photo_count: u64,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum AccountStatus {
    Connected,
    Syncing,
    Reconnect,
    Error,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct GranolaStatus {
    connected: bool,
    status: Option<GranolaState>,
    range: Option<HistoryRange>,
    last_sync: u64,
    next_sync: u64,
    error: String,
    counts: GranolaCounts,
    folders: Vec<GranolaFolder>,
    identities: Vec<GranolaIdentity>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
enum GranolaState {
    Connected,
    Syncing,
    ReconnectRequired,
    Error,
}

#[derive(Deserialize, Serialize)]
struct GranolaCounts {
    folders: u64,
    notes: u64,
    pending: u64,
    extracted: u64,
    failed: u64,
    skipped: u64,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct GranolaFolder {
    id: String,
    name: String,
    parent_id: Option<String>,
    excluded: bool,
    note_count: u64,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct GranolaIdentity {
    attendee_email: String,
    attendee_name: String,
    contact_email: String,
    contact_name: String,
    probability: f64,
}

fn error(kind: &'static str, message: &str) -> ClientError {
    ClientError {
        kind,
        message: message.into(),
    }
}
fn malformed() -> ClientError {
    error(
        "web_response_invalid",
        "People returned invalid source status; the operation is not confirmed.",
    )
}
fn decode<T: DeserializeOwned>(value: Value) -> Result<T, ClientError> {
    serde_json::from_value(value).map_err(|_| malformed())
}
fn request(
    client: &Client,
    method: &str,
    path: &str,
    body: Option<Value>,
) -> Result<Value, ClientError> {
    let mut envelope = json!({"method":method,"path":path});
    if let Some(body) = body {
        envelope["body"] = body;
    }
    client.request_json("POST", "/api/people-agent/request", Some(envelope))
}
fn valid_email(email: &str) -> bool {
    !email.is_empty()
        && email.encode_utf16().count() <= 320
        && !email.chars().any(|c| c.is_whitespace() || c.is_control())
        && email.split_once('@').is_some_and(|(local, domain)| {
            !local.is_empty() && !domain.is_empty() && !domain.contains('@')
        })
}
fn accounts(client: &Client) -> Result<Accounts, ClientError> {
    let result: Accounts = decode(request(client, "GET", "/api/accounts", None)?)?;
    if !valid_email(&result.account)
        || result.accounts.len() > 10
        || result.accounts.iter().any(|a| !valid_email(&a.email))
    {
        return Err(malformed());
    }
    Ok(result)
}
fn account(client: &Client, email: &str) -> Result<Account, ClientError> {
    if !valid_email(email) {
        return Err(error(
            "invalid_request",
            "Provide one exact connected inbox email address.",
        ));
    }
    let result = accounts(client)?;
    if !result.configured {
        return Err(error(
            "mail_not_configured",
            "Email connections are not enabled on this server.",
        ));
    }
    let mut matches = result
        .accounts
        .into_iter()
        .filter(|a| a.email.eq_ignore_ascii_case(email));
    let selected = matches.next().ok_or_else(|| error("account_not_found", "That inbox is not connected. Run peoplegraph sources status to see connected addresses."))?;
    if matches.next().is_some() {
        return Err(malformed());
    }
    Ok(selected)
}
fn granola_status(value: Value) -> Result<GranolaStatus, ClientError> {
    let status: GranolaStatus = decode(value)?;
    if status.connected != status.status.is_some() || status.connected != status.range.is_some() {
        return Err(malformed());
    }
    Ok(status)
}
fn syncable_granola(status: &GranolaStatus) -> Result<(), ClientError> {
    if !status.connected {
        return Err(error(
            "source_not_connected",
            "Granola is not connected. Run peoplegraph sources connect granola --key-stdin.",
        ));
    }
    match status.status {
        Some(GranolaState::Connected | GranolaState::Syncing) => Ok(()),
        Some(GranolaState::ReconnectRequired) => Err(error(
            "source_reconnect_required",
            "Granola requires a new key. Run peoplegraph sources connect granola --key-stdin.",
        )),
        _ => Err(error(
            "source_sync_failed",
            "Granola did not schedule a sync. Run peoplegraph sources status for the connection state.",
        )),
    }
}
fn read_key() -> Result<String, ClientError> {
    let stdin = std::io::stdin();
    if stdin.is_terminal() {
        return Err(error(
            "invalid_request",
            "Pipe the Granola API key into --key-stdin; interactive input would echo the key.",
        ));
    }
    let mut bytes = Vec::new();
    stdin.take(515).read_to_end(&mut bytes).map_err(|_| {
        error(
            "invalid_request",
            "Could not read the Granola API key from stdin.",
        )
    })?;
    if bytes.len() > 514 {
        return Err(error(
            "invalid_request",
            "Provide one Granola API key of at most 512 bytes.",
        ));
    }
    let input = String::from_utf8(bytes)
        .map_err(|_| error("invalid_request", "Provide a valid Granola API key."))?;
    let key = input
        .strip_suffix("\r\n")
        .or_else(|| input.strip_suffix('\n'))
        .unwrap_or(&input);
    if !(8..=512).contains(&key.len())
        || !key.starts_with("grn_")
        || !key.bytes().all(|b| (b'!'..=b'~').contains(&b))
    {
        return Err(error(
            "invalid_request",
            "Provide one valid Granola API key beginning with grn_.",
        ));
    }
    Ok(key.to_owned())
}
fn confirmed(value: Value) -> Result<(), ClientError> {
    if value["ok"] != true {
        return Err(malformed());
    }
    Ok(())
}

fn contains_secret(value: &Value, secret: &str) -> bool {
    match value {
        Value::String(text) => text.contains(secret),
        Value::Array(values) => values.iter().any(|value| contains_secret(value, secret)),
        Value::Object(values) => values
            .iter()
            .any(|(key, value)| key.contains(secret) || contains_secret(value, secret)),
        _ => false,
    }
}

fn execute(args: &SourcesArgs) -> Result<Value, ClientError> {
    // Read and validate the secret before configuring or contacting the service. Never put it in argv.
    let key = if matches!(
        args.action,
        SourcesAction::Connect {
            provider: ConnectProvider::Granola { .. }
        }
    ) {
        Some(read_key()?)
    } else {
        None
    };
    let client = people_client::configure(args.web.url.as_deref())
        .map_err(|(kind, message)| error(kind, message))?;
    match &args.action {
        SourcesAction::Status => {
            let gmail = accounts(&client)?;
            let granola = granola_status(request(&client, "GET", "/api/granola/status", None)?)?;
            Ok(json!({"gmail":gmail,"granola":granola}))
        }
        SourcesAction::Connect {
            provider: ConnectProvider::Gmail,
        } => {
            let origin = config::resolve(args.web.url.as_deref())
                .map_err(|(kind, message)| error(kind, message))?
                .origin;
            let expected = format!("{origin}/accounts");
            let value = request(&client, "POST", "/api/accounts/connect", Some(json!({})))?;
            if value["requiresBrowser"] != true
                || value["browserHandoff"]["url"] != expected
                || value["browserHandoff"]["reason"] != "provider_oauth_requires_browser"
            {
                return Err(malformed());
            }
            Ok(
                json!({"provider":"gmail","status":"requires_browser_consent","requiresBrowser":true,"browserHandoff":{"url":expected,"reason":"provider_oauth_requires_browser"},"message":"Open this URL and sign in to the same People account to connect Gmail. Complete Google consent, then run peoplegraph sources status."}),
            )
        }
        SourcesAction::Connect {
            provider: ConnectProvider::Granola { range, .. },
        } => {
            let status = granola_status(request(
                &client,
                "POST",
                "/api/granola/connect",
                Some(json!({"apiKey":key,"range":range})),
            )?)?;
            if !status.connected || !matches!(status.status, Some(GranolaState::Syncing)) {
                return Err(malformed());
            }
            let result = json!({"provider":"granola","status":"sync_started","connection":status});
            if contains_secret(&result, key.as_deref().ok_or_else(malformed)?) {
                return Err(malformed());
            }
            Ok(result)
        }
        SourcesAction::Sync {
            provider: SyncProvider::Gmail { email, range },
        } => {
            let selected = account(&client, email)?;
            if matches!(selected.status, AccountStatus::Reconnect) {
                return Err(error(
                    "source_reconnect_required",
                    "Gmail needs Google consent again. Run peoplegraph sources connect gmail.",
                ));
            }
            if matches!(selected.status, AccountStatus::Syncing) {
                return Ok(
                    json!({"provider":"gmail","email":selected.email,"status":"already_syncing","range":selected.range}),
                );
            }
            let mut body = json!({"email":selected.email});
            if let Some(range) = range {
                body["range"] = json!(range);
            }
            confirmed(request(&client, "POST", "/api/accounts/sync", Some(body))?)?;
            Ok(
                json!({"provider":"gmail","email":selected.email,"status":"sync_requested","range":range.unwrap_or(selected.range)}),
            )
        }
        SourcesAction::Sync {
            provider: SyncProvider::Granola,
        } => {
            let status = granola_status(request(
                &client,
                "POST",
                "/api/granola/sync",
                Some(json!({})),
            )?)?;
            syncable_granola(&status)?;
            Ok(json!({"provider":"granola","status":"sync_requested","connection":status}))
        }
        SourcesAction::Context {
            provider: ContextProvider::Gmail { email, state },
        } => {
            let selected = account(&client, email)?;
            let enabled = matches!(state, ContextState::On);
            confirmed(request(
                &client,
                "POST",
                "/api/accounts/context",
                Some(json!({"email":selected.email,"enabled":enabled})),
            )?)?;
            Ok(json!({"provider":"gmail","email":selected.email,"contextEnabled":enabled}))
        }
    }
}

pub(crate) fn run(args: &SourcesArgs, start: Instant) -> Response {
    match execute(args) {
        Ok(data) => ok("sources", data, json!({"ms":elapsed_ms(start),"backend":"people_web"})),
        Err(error) if error.kind == "insufficient_scope" => fail("sources", "insufficient_scope", "Source management requires explicit permission. Run peoplegraph login --write --scope sources:manage for this People origin, then retry.".into(), start),
        Err(error) => error.response("sources", start),
    }
}
