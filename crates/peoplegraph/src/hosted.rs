//! Hosted owner commands. All mutations keep the website's validation and authority boundaries.
use crate::{Response, agent::WebArgs, config, elapsed_ms, fail, ok, people_client};
use clap::{Args, Subcommand};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{io::Read, path::PathBuf, time::Instant};

#[derive(Args, Debug, Clone)]
pub(crate) struct LensArgs {
    #[command(flatten)]
    pub web: WebArgs,
    #[command(subcommand)]
    pub action: Option<LensAction>,
}
#[derive(Subcommand, Debug, Clone)]
pub(crate) enum LensAction {
    /// Save explicit owner-approved fields. Unspecified fields are preserved.
    Set(LensSet),
    /// Read the complete Lens state, including pending suggestions and source settings.
    Inspect,
    /// Enable or disable learning from connected context.
    Learning {
        #[arg(value_parser=["on","off"])]
        state: String,
        #[arg(long)]
        revision: Option<String>,
    },
    /// Enable or disable Granola context for the Lens.
    Granola {
        #[arg(value_parser=["on","off"])]
        state: String,
        #[arg(long)]
        revision: Option<String>,
    },
    /// Refresh pending suggestions; does not silently accept inferred edits.
    Refresh {
        #[arg(long)]
        note: Option<String>,
        #[arg(long)]
        revision: Option<String>,
    },
    /// Accept a pending suggestion by its exact ID.
    Accept {
        id: String,
        #[arg(long)]
        revision: Option<String>,
    },
    /// Dismiss a pending suggestion by its exact ID.
    Dismiss {
        id: String,
        #[arg(long)]
        revision: Option<String>,
    },
}
#[derive(Args, Debug, Clone)]
pub(crate) struct LensSet {
    #[arg(long, conflicts_with = "file")]
    focus: Option<String>,
    #[arg(long, conflicts_with = "file")]
    needs: Option<String>,
    #[arg(long, conflicts_with = "file")]
    offers: Option<String>,
    /// Expected current revision. A stale revision fails without retrying.
    #[arg(long, conflicts_with = "file")]
    revision: Option<String>,
    /// Complete {revision,fields:{focus,needs,offers}} JSON; use - for stdin.
    #[arg(long)]
    file: Option<PathBuf>,
}
#[derive(Args, Debug, Clone)]
pub(crate) struct ApiArgs {
    #[arg(value_parser=["GET","POST","PUT","PATCH","DELETE"])]
    method: String,
    /// Registered owner API path, e.g. /api/lens. See status for capabilities.
    path: String,
    /// JSON request body file; use - for stdin.
    #[arg(long)]
    file: Option<PathBuf>,
    /// Stable retry key, where the underlying operation supports it.
    #[arg(long)]
    idempotency_key: Option<String>,
    #[command(flatten)]
    pub web: WebArgs,
}
#[derive(Args, Debug, Clone)]
pub(crate) struct ConfigureArgs {
    #[arg(long)]
    url: String,
    /// Read an existing People integration key from stdin, never from a command argument.
    #[arg(long, required = true)]
    token_stdin: bool,
}
#[derive(Args, Debug, Clone)]
pub(crate) struct StatusArgs {
    /// Inspect redacted configuration without making a request or claiming authentication.
    #[arg(long)]
    offline: bool,
    #[command(flatten)]
    pub web: WebArgs,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct LensDocument {
    revision: String,
    fields: LensFields,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct LensFields {
    focus: String,
    needs: String,
    offers: String,
}
fn invalid(command: &'static str, message: &str, start: Instant) -> Response {
    fail(command, "invalid_request", message.into(), start)
}
fn read_json(path: &std::path::Path) -> Result<Value, &'static str> {
    let mut reader: Box<dyn Read> = if path == std::path::Path::new("-") {
        Box::new(std::io::stdin())
    } else {
        Box::new(std::fs::File::open(path).map_err(|_| "Cannot read the JSON file.")?)
    };
    let mut bytes = Vec::new();
    reader
        .by_ref()
        .take(80001)
        .read_to_end(&mut bytes)
        .map_err(|_| "Cannot read the JSON input.")?;
    if bytes.len() > 80000 {
        return Err("JSON input exceeds 80 KB.");
    }
    serde_json::from_slice(&bytes).map_err(|_| "Provide valid UTF-8 JSON.")
}
fn client(
    url: Option<&str>,
    name: &'static str,
    start: Instant,
) -> Result<people_client::Client, Response> {
    people_client::configure(url).map_err(|(kind, message)| fail(name, kind, message.into(), start))
}
fn machine(
    client: &people_client::Client,
    name: &'static str,
    method: &str,
    path: &str,
    body: Option<Value>,
    start: Instant,
) -> Response {
    let mut envelope = json!({"method":method,"path":path});
    if let Some(body) = body {
        envelope["body"] = body;
    }
    client.request_http(
        name,
        "POST",
        "/api/people-agent/request",
        Some(envelope),
        start,
    )
}
pub(crate) fn configure(args: &ConfigureArgs, start: Instant) -> Response {
    match config::configure_from_reader(&args.url, std::io::stdin()) {
        Ok(data) => ok("configure", data, json!({"ms":elapsed_ms(start)})),
        Err((kind, message)) => fail("configure", kind, message.into(), start),
    }
}
pub(crate) fn api(args: &ApiArgs, start: Instant) -> Response {
    if !args.path.starts_with("/api/")
        || args.path.contains(['#', '\\'])
        || args
            .path
            .bytes()
            .any(|b| b.is_ascii_whitespace() || b.is_ascii_control())
    {
        return invalid("api", "Use a registered relative /api/ path.", start);
    }
    if args.method == "GET" && args.file.is_some() {
        return invalid("api", "GET cannot include a request body.", start);
    }
    let mut envelope = json!({"method":args.method,"path":args.path});
    if let Some(path) = &args.file {
        match read_json(path) {
            Ok(value) => envelope["body"] = value,
            Err(message) => return invalid("api", message, start),
        }
    }
    if let Some(key) = &args.idempotency_key {
        envelope["idempotencyKey"] = json!(key);
    }
    people_client::request(
        "api",
        args.web.url.as_deref(),
        "/api/people-agent/request",
        Some(envelope),
        start,
    )
}
pub(crate) fn status(args: &StatusArgs, start: Instant) -> Response {
    let mut data = match config::metadata() {
        Ok(value) => value,
        Err((kind, message)) => return fail("status", kind, message.into(), start),
    };
    data["cliVersion"] = json!(crate::COMMAND_VERSION);
    data["authenticated"] = Value::Null;
    if let Ok(path) = crate::web_profile::profile_path() {
        match crate::web_profile::load_profile(&path) {
            Ok(Some(p)) => {
                data["legacyDevice"] = json!({"origin":p.origin,"owner":p.owner,"expiresAt":p.expires_at,"scope":"legacy graph reads only","verified":false})
            }
            Ok(None) => {}
            Err(_) => data["legacyDevice"] = json!({"configured":true,"readable":false}),
        }
    }
    let resolved = config::resolve(args.web.url.as_deref());
    if args.offline {
        data["liveCheck"] = json!("not_attempted");
        if let Ok(c) = resolved {
            data["origin"] = json!(c.origin);
            data["credentialSource"] = json!(c.source);
        }
        return ok("status", data, json!({"ms":elapsed_ms(start)}));
    }
    let credential = match resolved {
        Ok(c) => c,
        Err((kind, message)) => return fail("status", kind, message.into(), start),
    };
    let client = match client(args.web.url.as_deref(), "status", start) {
        Ok(c) => c,
        Err(r) => return r,
    };
    match client.request_json("GET", "/api/people-agent/status", None) {
        Ok(remote) => {
            let grants = remote["credential"]["scopes"].as_array();
            let valid_grants = grants.is_some_and(|values| {
                !values.is_empty()
                    && values.len() <= 6
                    && values.iter().all(|v| {
                        matches!(
                            v.as_str(),
                            Some(
                                "people:read"
                                    | "people:write"
                                    | "sources:manage"
                                    | "sharing:manage"
                                    | "booking:manage"
                                    | "integrations:manage"
                            )
                        )
                    })
                    && values
                        .iter()
                        .collect::<std::collections::HashSet<_>>()
                        .len()
                        == values.len()
            });
            if remote["protocolVersion"] != 1
                || !remote["owner"]
                    .as_str()
                    .is_some_and(|s| s.contains('@') && s.len() <= 320)
                || !remote["credential"]["id"]
                    .as_str()
                    .is_some_and(|s| !s.is_empty() && s.len() <= 200)
                || !valid_grants
                || !remote["credential"]["expiresAt"]
                    .as_u64()
                    .is_some_and(|n| n > crate::unix_seconds() * 1000)
                || !remote["capabilities"].is_array()
            {
                return fail("status","web_response_invalid","The server did not return a valid People authentication status; access remains unverified.".into(),start);
            }
            for key in [
                "protocolVersion",
                "owner",
                "apiUrl",
                "mcpUrl",
                "scopeDescriptions",
                "capabilities",
            ] {
                if let Some(value) = remote.get(key) {
                    data[key] = value.clone();
                }
            }
            data["credential"] = json!({"id":remote["credential"]["id"],"name":remote["credential"]["name"],"scopes":remote["credential"]["scopes"],"expiresAt":remote["credential"]["expiresAt"]});
            data["authenticated"] = json!(true);
            data["origin"] = json!(credential.origin);
            data["credentialSource"] = json!(credential.source);
            ok(
                "status",
                data,
                json!({"ms":elapsed_ms(start),"backend":"people_web"}),
            )
        }
        Err(e) => e.response("status", start),
    }
}
pub(crate) fn lens(args: &LensArgs, start: Instant) -> Response {
    let Some(action) = &args.action else {
        return people_client::request(
            "lens",
            args.web.url.as_deref(),
            "/api/people-agent/lens",
            None,
            start,
        );
    };
    let client = match client(args.web.url.as_deref(), "lens", start) {
        Ok(c) => c,
        Err(r) => return r,
    };
    if matches!(action, LensAction::Inspect) {
        return machine(&client, "lens", "GET", "/api/lens", None, start);
    }
    if let LensAction::Set(edit) = action {
        let payload = if let Some(path) = &edit.file {
            match read_json(path) {
                Ok(value) => value,
                Err(message) => return invalid("lens", message, start),
            }
        } else {
            if edit.focus.is_none() && edit.needs.is_none() && edit.offers.is_none() {
                return invalid(
                    "lens",
                    "Provide --focus, --needs, --offers or --file.",
                    start,
                );
            }
            let complete = edit.focus.is_some() && edit.needs.is_some() && edit.offers.is_some();
            let mut current = if complete && edit.revision.is_some() {
                json!({"revision":edit.revision,"fields":{}})
            } else {
                match client.request_json("GET", "/api/people-agent/lens", None) {
                    Ok(value) => {
                        let projection =
                            json!({"revision":value["revision"],"fields":value["fields"]});
                        if serde_json::from_value::<LensDocument>(projection.clone()).is_err() {
                            return fail(
                                "lens",
                                "web_response_invalid",
                                "People returned an incomplete Lens; nothing was saved.".into(),
                                start,
                            );
                        }
                        projection
                    }
                    Err(e) => return e.response("lens", start),
                }
            };
            if let Some(revision) = &edit.revision {
                if current["revision"] != *revision {
                    return fail(
                        "lens",
                        "owner_lens_conflict",
                        "The Lens has changed. Read it again and reconcile before saving.".into(),
                        start,
                    );
                }
            }
            for (name, value) in [
                ("focus", &edit.focus),
                ("needs", &edit.needs),
                ("offers", &edit.offers),
            ] {
                if let Some(value) = value {
                    current["fields"][name] = json!(value);
                }
            }
            current
        };
        let parsed: LensDocument = match serde_json::from_value(payload.clone()) {
            Ok(value) => value,
            Err(_) => {
                return invalid(
                    "lens",
                    "Use exactly {revision,fields:{focus,needs,offers}} with string values.",
                    start,
                );
            }
        };
        if parsed.revision.is_empty()
            || parsed.revision.len() > 100
            || [
                &parsed.fields.focus,
                &parsed.fields.needs,
                &parsed.fields.offers,
            ]
            .iter()
            .any(|v| v.encode_utf16().count() > 500)
        {
            return invalid(
                "lens",
                "Lens fields must be at most 500 characters and revision must be present.",
                start,
            );
        }
        return client.request_http(
            "lens",
            "POST",
            "/api/people-agent/lens",
            Some(payload),
            start,
        );
    }
    let (revision, mut payload) = match action {
        LensAction::Learning { state, revision } => {
            (revision, json!({"action":"learning","enabled":state=="on"}))
        }
        LensAction::Granola { state, revision } => {
            (revision, json!({"action":"granola","enabled":state=="on"}))
        }
        LensAction::Refresh { note, revision } => {
            let mut value = json!({"action":"refresh"});
            if let Some(note) = note {
                value["note"] = json!(note);
            }
            (revision, value)
        }
        LensAction::Accept { id, revision } => (revision, json!({"action":"accept","id":id})),
        LensAction::Dismiss { id, revision } => (revision, json!({"action":"dismiss","id":id})),
        _ => unreachable!(),
    };
    payload["revision"] = if let Some(revision) = revision {
        json!(revision)
    } else {
        match client.request_json("GET", "/api/people-agent/lens", None) {
            Ok(value) => value["revision"].clone(),
            Err(e) => return e.response("lens", start),
        }
    };
    machine(&client, "lens", "POST", "/api/lens", Some(payload), start)
}
