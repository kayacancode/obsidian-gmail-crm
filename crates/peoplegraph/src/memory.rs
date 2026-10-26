//! Explicit hosted People memory client. The legacy local-cache server is unchanged.
use clap::{Args, Subcommand, ValueEnum};
use serde_json::{Value, json};
use std::env;
use std::fs::File;
use std::io::Read;
use std::path::PathBuf;
use std::time::{Duration, Instant};

#[derive(Args, Debug, Clone)]
pub(crate) struct MemoryArgs {
    /// Hosted People origin; alternatively set PEOPLEGRAPH_WEB_URL.
    #[arg(long, global = true)]
    url: Option<String>,
    #[command(subcommand)]
    command: MemoryCommand,
}

#[derive(Subcommand, Debug, Clone)]
enum MemoryCommand {
    /// Read private relationship memory for one exact email.
    Lookup {
        #[arg(long)]
        email: String,
    },
    /// Append owner-authorized context without replacing the profile or steering note.
    Capture(CaptureArgs),
    /// Save an explicitly edited complete profile using its current revision.
    Save {
        /// UTF-8 JSON object file, or - for stdin. Maximum 80,000 bytes.
        #[arg(long)]
        file: PathBuf,
    },
}

#[derive(Args, Debug, Clone)]
struct CaptureArgs {
    #[arg(long)]
    email: String,
    #[arg(long)]
    name: String,
    /// Stable ID from the original note/message. Reuse for retries, not changed content.
    #[arg(long)]
    source_id: String,
    #[arg(long, value_enum, default_value_t = SourceKind::Text)]
    source_kind: SourceKind,
    #[arg(
        long,
        conflicts_with = "text_file",
        required_unless_present = "text_file"
    )]
    text: Option<String>,
    /// UTF-8 text file, or - for stdin. Maximum 2,000 characters.
    #[arg(long, conflicts_with = "text", required_unless_present = "text")]
    text_file: Option<PathBuf>,
    #[arg(long)]
    company: Option<String>,
}

#[derive(Debug, Clone, ValueEnum)]
enum SourceKind {
    Text,
    VoiceTranscript,
}

fn origin(value: &str) -> Result<String, &'static str> {
    let parsed: ureq::http::Uri = value.trim().parse().map_err(|_| "invalid_web_url")?;
    let authority = parsed.authority().ok_or("invalid_web_url")?;
    let host = authority.host();
    let loopback = matches!(host, "localhost" | "127.0.0.1" | "[::1]");
    if authority.as_str().contains('@')
        || parsed.query().is_some()
        || !matches!(parsed.path(), "" | "/")
        || !(parsed.scheme_str() == Some("https")
            || parsed.scheme_str() == Some("http") && loopback)
    {
        return Err("invalid_web_url");
    }
    Ok(format!("{}://{}", parsed.scheme_str().unwrap(), authority))
}

fn text_length(value: &str) -> usize {
    value.encode_utf16().count()
}
fn capture_payload(args: &CaptureArgs) -> Result<Value, &'static str> {
    let text = if let Some(text) = &args.text {
        text.clone()
    } else {
        let path = args.text_file.as_ref().ok_or("invalid_capture")?;
        let reader: Box<dyn Read> = if path.as_os_str() == "-" {
            Box::new(std::io::stdin())
        } else {
            Box::new(File::open(path).map_err(|_| "text_file_unreadable")?)
        };
        let mut text = String::new();
        reader
            .take(8001)
            .read_to_string(&mut text)
            .map_err(|_| "text_file_unreadable")?;
        text
    };
    if text.trim().is_empty()
        || text_length(&text) > 2000
        || args.name.trim().is_empty()
        || text_length(&args.name) > 160
        || args.source_id.trim().is_empty()
        || text_length(&args.source_id) > 200
        || args
            .company
            .as_deref()
            .is_some_and(|value| text_length(value) > 160)
    {
        return Err("invalid_capture");
    }
    let mut body = json!({"email":args.email,"name":args.name,"text":text,"sourceId":args.source_id,
        "sourceKind":match args.source_kind {SourceKind::Text=>"text",SourceKind::VoiceTranscript=>"voice_transcript"}});
    if let Some(company) = &args.company {
        body["company"] = json!(company);
    }
    Ok(body)
}

fn save_payload(path: &PathBuf) -> Result<Value, &'static str> {
    let reader: Box<dyn Read> = if path.as_os_str() == "-" {
        Box::new(std::io::stdin())
    } else {
        Box::new(File::open(path).map_err(|_| "memory_file_unreadable")?)
    };
    let mut bytes = Vec::new();
    reader
        .take(80_001)
        .read_to_end(&mut bytes)
        .map_err(|_| "memory_file_unreadable")?;
    if bytes.len() > 80_000 {
        return Err("memory_file_too_large");
    }
    let text = String::from_utf8(bytes).map_err(|_| "memory_file_unreadable")?;
    let profile: Value = serde_json::from_str(&text).map_err(|_| "invalid_memory_file")?;
    if !profile.is_object() {
        return Err("invalid_memory_file");
    }
    // Exact editable fields and current revision are checked by the shared API.
    // Preserve the supplied object; never infer edits or refresh/retry a conflict.
    Ok(profile)
}

pub(crate) fn run(args: &MemoryArgs, start: Instant) -> super::Response {
    let fail = |kind: &str, message: &str| super::fail("memory", kind, message.to_string(), start);
    let target = args
        .url
        .clone()
        .or_else(|| env::var("PEOPLEGRAPH_WEB_URL").ok());
    let Some(target) = target else {
        return fail(
            "web_url_missing",
            "Set PEOPLEGRAPH_WEB_URL or pass memory --url <https-origin>.",
        );
    };
    let target = match origin(&target) {
        Ok(value) => value,
        Err(error) => {
            return fail(
                error,
                "Use an HTTPS origin without credentials, path or query; HTTP is allowed only on localhost.",
            );
        }
    };
    let token = env::var("PEOPLEGRAPH_WEB_TOKEN").unwrap_or_default();
    if token.trim().is_empty() {
        return fail(
            "web_token_missing",
            "Set PEOPLEGRAPH_WEB_TOKEN to a People integration credential.",
        );
    }
    let (path, payload) = match &args.command {
        MemoryCommand::Lookup { email } => (
            format!(
                "/api/people-agent/lookup?email={}",
                super::url_encode(email)
            ),
            None,
        ),
        MemoryCommand::Capture(input) => match capture_payload(input) {
            Ok(body) => (
                "/api/people-agent/capture".to_string(),
                Some(body.to_string()),
            ),
            Err(error) => {
                return fail(
                    error,
                    "Provide a readable UTF-8 note of at most 2,000 characters, name, exact email and stable source ID.",
                );
            }
        },
        MemoryCommand::Save { file } => match save_payload(file) {
            Ok(profile) => (
                "/api/people-agent/save".to_string(),
                Some(profile.to_string()),
            ),
            Err(error) => {
                return fail(
                    error,
                    "Provide a UTF-8 JSON object of at most 80,000 bytes containing the complete editable profile and its current revision.",
                );
            }
        },
    };
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .http_status_as_error(false)
        .max_redirects(0)
        .timeout_global(Some(Duration::from_secs(30)))
        .build()
        .into();
    let url = format!("{target}{path}");
    let response = if let Some(body) = payload {
        agent
            .post(&url)
            .header("authorization", format!("Bearer {}", token.trim()))
            .header("content-type", "application/json")
            .send(body.as_str())
    } else {
        agent
            .get(&url)
            .header("authorization", format!("Bearer {}", token.trim()))
            .call()
    };
    let mut response = match response {
        Ok(response) => response,
        Err(_) => {
            return fail(
                "web_request_failed",
                "The People service could not be reached.",
            );
        }
    };
    let status = response.status().as_u16();
    let text = match response
        .body_mut()
        .with_config()
        .limit(1_000_000)
        .read_to_string()
    {
        Ok(text) => text,
        Err(_) => {
            return fail(
                "web_response_invalid",
                "The People service returned an unreadable response.",
            );
        }
    };
    let data: Value = match serde_json::from_str(&text) {
        Ok(data) => data,
        Err(_) => {
            return fail(
                "web_response_invalid",
                "The People service did not return JSON.",
            );
        }
    };
    if !(200..300).contains(&status) {
        let supplied = data.get("error").and_then(Value::as_str).unwrap_or("");
        let allowed = [
            "people_memory_unauthorized",
            "insufficient_scope",
            "unknown_person",
            "not_found",
            "idempotency_conflict",
            "relationship_memory_conflict",
            "person_context_conflict",
            "capture_conflict",
            "memory_capacity",
            "invalid_request",
            "rate_limited",
        ];
        return fail(
            if allowed.contains(&supplied) {
                supplied
            } else {
                "web_request_failed"
            },
            &format!("People request failed (HTTP {status}); no local cache was changed."),
        );
    }
    super::ok(
        "memory",
        data,
        json!({"ms":super::elapsed_ms(start),"backend":"people_web"}),
    )
}
