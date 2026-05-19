use clap::{Args, Parser, Subcommand, ValueEnum};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::cmp::Reverse;
use std::collections::HashMap;
use std::env;
use std::fs;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::{Instant, SystemTime, UNIX_EPOCH};
use strsim::jaro_winkler;

const COMMAND_VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(Parser, Debug, Clone)]
#[command(name = "peoplegraph")]
#[command(version = COMMAND_VERSION)]
#[command(
    about = "Graph queries and merge-review writes over the Obsidian Gmail CRM contact cache"
)]
struct Cli {
    #[command(subcommand)]
    command: Commands,

    #[arg(long, global = true, value_enum, default_value_t = OutputFormat::Json)]
    format: OutputFormat,

    #[arg(long, global = true)]
    cache: Option<PathBuf>,

    #[arg(long, global = true)]
    host: Option<String>,

    #[arg(long, global = true)]
    token: Option<String>,

    #[arg(long, global = true)]
    quiet: bool,
}

#[derive(Clone, Debug, ValueEnum)]
enum OutputFormat {
    Json,
    Jsonl,
}

#[derive(Subcommand, Debug, Clone)]
enum Commands {
    /// Fuzzy match a person by name, email, or alias.
    FindPerson(FindPersonArgs),
    /// Return score fields for one email.
    Score(EmailArg),
    /// Return people at a company/domain ranked by relationship score.
    WhoKnows(WhoKnowsArgs),
    /// Return neighbors for one email once edge data is present in the cache.
    GetNeighbors(EmailArg),
    /// Return the edge between two emails once edge data is present in the cache.
    GetEdges(GetEdgesArgs),
    /// Suggest duplicate/contact-fragment rows to review for canonical identity cleanup.
    SuggestDuplicates(SuggestDuplicatesArgs),
    /// Inspect pending merge proposals without modifying the queue.
    MergeQueue(MergeQueueArgs),
    /// Apply a reviewed merge by writing canonical identity metadata to the cache.
    ApplyMerge(ApplyMergeArgs),
    /// Dismiss a merge candidate as a false positive.
    DismissMerge(DismissMergeArgs),
    /// Record a merge proposal once the local merge queue is implemented.
    ProposeMerge(ProposeMergeArgs),
    /// Describe the command surface for agent introspection.
    Describe,
    /// Return binary version information.
    Version,
    /// Serve read-only PeopleGraph queries over HTTP.
    Serve(ServeArgs),
}

#[derive(Args, Debug, Clone)]
struct FindPersonArgs {
    query: String,

    #[arg(long, default_value_t = 10)]
    limit: usize,
}

#[derive(Args, Debug, Clone)]
struct EmailArg {
    email: String,
}

#[derive(Args, Debug, Clone)]
struct WhoKnowsArgs {
    #[arg(long)]
    company: String,

    #[arg(long, default_value_t = 25)]
    limit: usize,
}

#[derive(Args, Debug, Clone)]
struct GetEdgesArgs {
    #[arg(long)]
    from: String,

    #[arg(long)]
    to: String,
}

#[derive(Args, Debug, Clone)]
struct SuggestDuplicatesArgs {
    #[arg(long, default_value_t = 25)]
    limit: usize,

    #[arg(long, default_value_t = 0.82)]
    min_confidence: f64,
}

#[derive(Args, Debug, Clone)]
struct MergeQueueArgs {
    #[arg(long, default_value = "pending")]
    status: String,

    #[arg(long, default_value_t = 25)]
    limit: usize,
}

#[derive(Args, Debug, Clone)]
struct ApplyMergeArgs {
    a: String,
    b: String,
}

#[derive(Args, Debug, Clone)]
struct DismissMergeArgs {
    a: String,
    b: String,

    #[arg(long, default_value = "not_duplicate")]
    reason: String,
}

#[derive(Args, Debug, Clone)]
struct ProposeMergeArgs {
    a: String,
    b: String,
}

#[derive(Args, Debug, Clone)]
struct ServeArgs {
    #[arg(long, default_value = "127.0.0.1:8787")]
    bind: String,

    #[arg(long)]
    token: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ContactIndex {
    #[serde(default, alias = "schema_version")]
    schema_version: Option<u32>,
    #[serde(default)]
    last_sync: Option<String>,
    #[serde(default)]
    user_email: Option<String>,
    contacts: HashMap<String, Contact>,
    #[serde(default)]
    edges: Vec<ContactEdge>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Contact {
    #[serde(default)]
    name: String,
    #[serde(default)]
    email: String,
    #[serde(default)]
    last_contact: Option<String>,
    #[serde(default)]
    first_contact: Option<String>,
    #[serde(default)]
    sent_count: u32,
    #[serde(default)]
    received_count: u32,
    #[serde(default)]
    total_exchanges: u32,
    #[serde(default)]
    subjects: Vec<String>,
    #[serde(default)]
    last_subject: String,
    #[serde(default)]
    domain: String,
    #[serde(default)]
    thread_count: Option<u32>,
    #[serde(default)]
    max_thread_depth: Option<u32>,
    #[serde(default)]
    back_and_forth_threads: Option<u32>,
    #[serde(default)]
    rsvp_only_threads: Option<u32>,
    #[serde(default)]
    last_thread_depth: Option<u32>,
    #[serde(default)]
    canonical_id: Option<String>,
    #[serde(default)]
    aliases: Vec<String>,
    #[serde(default)]
    last_canonical_sync: Option<String>,
    #[serde(default)]
    role: Option<String>,
    #[serde(default)]
    company: Option<String>,
    #[serde(default)]
    score: Option<CachedScore>,
    #[serde(default, alias = "relationship_depth")]
    relationship_depth: Option<u8>,
    #[serde(default, alias = "relationship_recency")]
    relationship_recency: Option<u8>,
    #[serde(default, alias = "combined_score")]
    combined_score: Option<u8>,
    #[serde(default)]
    quadrant: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CachedScore {
    #[serde(default, alias = "relationship_depth")]
    depth: Option<u8>,
    #[serde(default, alias = "relationship_recency")]
    recency: Option<u8>,
    #[serde(default, alias = "combined_score")]
    combined: Option<u8>,
    #[serde(default)]
    quadrant: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ContactEdge {
    source_email: String,
    source_name: String,
    target_email: String,
    target_name: String,
    #[serde(rename = "type")]
    edge_type: String,
    context: String,
    #[serde(default)]
    combined_score: u8,
    #[serde(default)]
    source_score: Option<u8>,
    #[serde(default)]
    target_score: Option<u8>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct MergeQueue {
    schema_version: u32,
    updated_at_unix: u64,
    candidates: Vec<MergeCandidate>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct MergeCandidate {
    a_email: String,
    a_name: String,
    b_email: String,
    b_name: String,
    status: String,
    proposed_at_unix: u64,
    source: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    dismissed_at_unix: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    dismiss_reason: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
struct Response {
    ok: bool,
    command: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    data: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    stats: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<ApiError>,
}

#[derive(Debug, Serialize, Deserialize)]
struct ApiError {
    kind: String,
    message: String,
}

#[derive(Clone, Debug, Serialize)]
struct ScoreOut {
    depth: u8,
    recency: u8,
    combined: u8,
    quadrant: String,
}

#[derive(Clone, Debug)]
struct ContactRow {
    email: String,
    contact: Contact,
}

#[derive(Clone, Debug)]
struct DuplicateSuggestion {
    confidence: f64,
    primary: ContactRow,
    duplicate: ContactRow,
    reasons: Vec<String>,
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    let start = Instant::now();
    let command = command_name(&cli.command);
    let response = run(&cli, command, start);
    let ok = response.ok;

    if let Err(err) = print_response(&response, &cli.format) {
        if !cli.quiet {
            eprintln!("peoplegraph: failed to write JSON response: {err}");
        }
        return ExitCode::from(1);
    }

    if ok {
        ExitCode::SUCCESS
    } else {
        ExitCode::from(1)
    }
}

fn run(cli: &Cli, command: &'static str, start: Instant) -> Response {
    if let Commands::Serve(args) = &cli.command {
        return serve_http(cli, args, start);
    }

    if cli.host.is_some() {
        return remote_run(cli, command, start);
    }

    match &cli.command {
        Commands::Describe => ok(
            command,
            describe_payload(),
            json!({ "ms": elapsed_ms(start) }),
        ),
        Commands::Version => ok(
            command,
            json!({ "name": "peoplegraph", "version": COMMAND_VERSION }),
            json!({ "ms": elapsed_ms(start) }),
        ),
        Commands::FindPerson(args) => with_index(cli, command, start, |index| {
            find_person(index, &args.query, args.limit, start)
        }),
        Commands::Score(args) => with_index(cli, command, start, |index| {
            score_person(index, &args.email, start)
        }),
        Commands::WhoKnows(args) => with_index(cli, command, start, |index| {
            who_knows(index, &args.company, args.limit, start)
        }),
        Commands::GetNeighbors(args) => with_index(cli, command, start, |index| {
            get_neighbors(index, &args.email, start)
        }),
        Commands::GetEdges(args) => with_index(cli, command, start, |index| {
            get_edges(index, &args.from, &args.to, start)
        }),
        Commands::SuggestDuplicates(args) => suggest_duplicates(cli, command, args, start),
        Commands::MergeQueue(args) => merge_queue(cli, command, args, start),
        Commands::ApplyMerge(args) => apply_merge(cli, command, args, start),
        Commands::DismissMerge(args) => dismiss_merge(cli, command, args, start),
        Commands::ProposeMerge(args) => propose_merge(cli, command, args, start),
        Commands::Serve(_) => unreachable!("serve handled before command dispatch"),
    }
}

fn remote_run(cli: &Cli, command: &'static str, start: Instant) -> Response {
    let Some(path) = remote_path(&cli.command) else {
        return fail(
            command,
            "remote_command_not_supported",
            format!("{command} is not available through --host in V1"),
            start,
        );
    };
    let Some(host) = cli
        .host
        .as_deref()
        .map(str::trim)
        .filter(|host| !host.is_empty())
    else {
        return fail(
            command,
            "remote_host_missing",
            "pass --host <url> or run against a local cache".to_string(),
            start,
        );
    };
    let Some(token) = access_token(cli.token.as_deref()) else {
        return fail(
            command,
            "remote_token_missing",
            "pass --token <value> or set PEOPLEGRAPH_TOKEN".to_string(),
            start,
        );
    };

    let url = format!("{}{}", host.trim_end_matches('/'), path);
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .http_status_as_error(false)
        .build()
        .into();
    let mut response = match agent
        .get(&url)
        .header("Authorization", format!("Bearer {token}"))
        .call()
    {
        Ok(response) => response,
        Err(err) => {
            return fail(
                command,
                "remote_request_failed",
                format!("failed to query {url}: {err}"),
                start,
            );
        }
    };

    let status = response.status().as_u16();
    let body = match response.body_mut().read_to_string() {
        Ok(body) => body,
        Err(err) => {
            return fail(
                command,
                "remote_read_failed",
                format!("failed to read response body from {url}: {err}"),
                start,
            );
        }
    };
    let parsed = serde_json::from_str::<Response>(&body).unwrap_or_else(|err| {
        fail(
            command,
            "remote_parse_failed",
            format!("remote returned HTTP {status}, but response was not PeopleGraph JSON: {err}"),
            start,
        )
    });

    if status >= 400 && parsed.ok {
        return fail(
            command,
            "remote_http_error",
            format!("remote returned HTTP {status}"),
            start,
        );
    }
    parsed
}

fn remote_path(command: &Commands) -> Option<String> {
    match command {
        Commands::FindPerson(args) => Some(format!(
            "/find-person?query={}&limit={}",
            url_encode(&args.query),
            args.limit.max(1)
        )),
        Commands::Score(args) => Some(format!("/score?email={}", url_encode(&args.email))),
        Commands::WhoKnows(args) => Some(format!(
            "/who-knows?company={}&limit={}",
            url_encode(&args.company),
            args.limit.max(1)
        )),
        Commands::GetNeighbors(args) => {
            Some(format!("/get-neighbors?email={}", url_encode(&args.email)))
        }
        Commands::GetEdges(args) => Some(format!(
            "/get-edges?from={}&to={}",
            url_encode(&args.from),
            url_encode(&args.to)
        )),
        Commands::SuggestDuplicates(args) => Some(format!(
            "/suggest-duplicates?limit={}&min_confidence={}",
            args.limit.max(1),
            args.min_confidence
        )),
        Commands::MergeQueue(args) => Some(format!(
            "/merge-queue?status={}&limit={}",
            url_encode(&args.status),
            args.limit.max(1)
        )),
        Commands::Describe => Some("/describe".to_string()),
        Commands::Version => Some("/version".to_string()),
        Commands::ApplyMerge(_)
        | Commands::DismissMerge(_)
        | Commands::ProposeMerge(_)
        | Commands::Serve(_) => None,
    }
}

fn serve_http(cli: &Cli, args: &ServeArgs, start: Instant) -> Response {
    let Some(token) = access_token(args.token.as_deref().or(cli.token.as_deref())) else {
        return fail(
            "serve",
            "token_missing",
            "serve requires --token <value> or PEOPLEGRAPH_TOKEN".to_string(),
            start,
        );
    };
    let cache_path = match resolve_cache_path(cli.cache.as_deref()) {
        Ok(path) => path,
        Err(message) => return fail("serve", "cache_not_found", message, start),
    };
    let listener = match TcpListener::bind(&args.bind) {
        Ok(listener) => listener,
        Err(err) => {
            return fail(
                "serve",
                "bind_failed",
                format!("failed to bind {}: {err}", args.bind),
                start,
            );
        }
    };

    if !cli.quiet {
        eprintln!(
            "peoplegraph serve listening on http://{} using {}",
            args.bind,
            cache_path.display()
        );
    }

    for stream in listener.incoming() {
        match stream {
            Ok(mut stream) => handle_http_stream(&mut stream, cli, &cache_path, &token),
            Err(err) if !cli.quiet => eprintln!("peoplegraph serve connection failed: {err}"),
            Err(_) => {}
        }
    }

    ok(
        "serve",
        json!({ "stopped": true }),
        json!({ "ms": elapsed_ms(start) }),
    )
}

fn handle_http_stream(stream: &mut TcpStream, cli: &Cli, cache_path: &Path, token: &str) {
    let start = Instant::now();
    let mut buffer = [0_u8; 16_384];
    let read = match stream.read(&mut buffer) {
        Ok(read) => read,
        Err(err) => {
            let response = fail("remote", "request_read_failed", err.to_string(), start);
            write_http_response(stream, 400, &response);
            return;
        }
    };
    let request = String::from_utf8_lossy(&buffer[..read]);
    let Some((path, headers)) = parse_http_request(&request) else {
        let response = fail(
            "remote",
            "bad_request",
            "expected a GET request".to_string(),
            start,
        );
        write_http_response(stream, 400, &response);
        return;
    };

    let authorized = headers
        .get("authorization")
        .and_then(|value| value.strip_prefix("Bearer "))
        .is_some_and(|value| value == token);
    if !authorized {
        let response = fail(
            "remote",
            "unauthorized",
            "missing or invalid bearer token".to_string(),
            start,
        );
        write_http_response(stream, 401, &response);
        return;
    }

    let response = run_remote_request(cli, cache_path, &path, start);
    let status = if response.ok { 200 } else { 400 };
    write_http_response(stream, status, &response);
}

fn run_remote_request(cli: &Cli, cache_path: &Path, path: &str, start: Instant) -> Response {
    let (route, query) = path.split_once('?').unwrap_or((path, ""));
    let params = parse_query(query);
    let command = match route {
        "/describe" => Commands::Describe,
        "/version" => Commands::Version,
        "/find-person" => Commands::FindPerson(FindPersonArgs {
            query: query_param(&params, "query"),
            limit: query_usize(&params, "limit", 10),
        }),
        "/score" => Commands::Score(EmailArg {
            email: query_param(&params, "email"),
        }),
        "/who-knows" => Commands::WhoKnows(WhoKnowsArgs {
            company: query_param(&params, "company"),
            limit: query_usize(&params, "limit", 25),
        }),
        "/get-neighbors" => Commands::GetNeighbors(EmailArg {
            email: query_param(&params, "email"),
        }),
        "/get-edges" => Commands::GetEdges(GetEdgesArgs {
            from: query_param(&params, "from"),
            to: query_param(&params, "to"),
        }),
        "/suggest-duplicates" => Commands::SuggestDuplicates(SuggestDuplicatesArgs {
            limit: query_usize(&params, "limit", 25),
            min_confidence: query_f64(&params, "min_confidence", 0.82),
        }),
        "/merge-queue" => Commands::MergeQueue(MergeQueueArgs {
            status: query_param_default(&params, "status", "pending"),
            limit: query_usize(&params, "limit", 25),
        }),
        "/health" => {
            return ok(
                "health",
                json!({ "version": COMMAND_VERSION }),
                json!({ "ms": elapsed_ms(start) }),
            );
        }
        _ => {
            return fail(
                "remote",
                "not_found",
                format!("unknown PeopleGraph route: {route}"),
                start,
            );
        }
    };
    let command_name = command_name(&command);
    let request_cli = Cli {
        command,
        format: OutputFormat::Json,
        cache: Some(cache_path.to_path_buf()),
        host: None,
        token: None,
        quiet: cli.quiet,
    };
    run(&request_cli, command_name, start)
}

fn parse_http_request(request: &str) -> Option<(String, HashMap<String, String>)> {
    let mut lines = request.lines();
    let line = lines.next()?;
    let mut parts = line.split_whitespace();
    let method = parts.next()?;
    let path = parts.next()?;
    if method != "GET" {
        return None;
    }

    let mut headers = HashMap::new();
    for line in lines {
        let line = line.trim_end_matches('\r');
        if line.is_empty() {
            break;
        }
        if let Some((name, value)) = line.split_once(':') {
            headers.insert(name.trim().to_ascii_lowercase(), value.trim().to_string());
        }
    }
    Some((path.to_string(), headers))
}

fn write_http_response(stream: &mut TcpStream, status: u16, response: &Response) {
    let reason = match status {
        200 => "OK",
        400 => "Bad Request",
        401 => "Unauthorized",
        _ => "Error",
    };
    let body = serde_json::to_string_pretty(response).unwrap_or_else(|_| {
        r#"{"ok":false,"command":"remote","error":{"kind":"serialize_failed","message":"failed to serialize response"}}"#.to_string()
    });
    let header = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    let _ = stream.write_all(header.as_bytes());
    let _ = stream.write_all(body.as_bytes());
}

fn access_token(explicit: Option<&str>) -> Option<String> {
    explicit
        .map(str::trim)
        .filter(|token| !token.is_empty())
        .map(ToString::to_string)
        .or_else(|| {
            env::var("PEOPLEGRAPH_TOKEN")
                .ok()
                .map(|token| token.trim().to_string())
                .filter(|token| !token.is_empty())
        })
}

fn url_encode(value: &str) -> String {
    let mut encoded = String::new();
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                encoded.push(byte as char);
            }
            _ => encoded.push_str(&format!("%{byte:02X}")),
        }
    }
    encoded
}

fn url_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'%' if index + 2 < bytes.len() => {
                if let (Some(high), Some(low)) =
                    (hex_value(bytes[index + 1]), hex_value(bytes[index + 2]))
                {
                    decoded.push((high << 4) | low);
                    index += 3;
                    continue;
                }
                decoded.push(bytes[index]);
                index += 1;
            }
            b'+' => {
                decoded.push(b' ');
                index += 1;
            }
            byte => {
                decoded.push(byte);
                index += 1;
            }
        }
    }
    String::from_utf8_lossy(&decoded).to_string()
}

fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

fn parse_query(query: &str) -> HashMap<String, String> {
    query
        .split('&')
        .filter(|part| !part.is_empty())
        .map(|part| {
            let (key, value) = part.split_once('=').unwrap_or((part, ""));
            (url_decode(key), url_decode(value))
        })
        .collect()
}

fn query_param(params: &HashMap<String, String>, key: &str) -> String {
    query_param_default(params, key, "")
}

fn query_param_default(params: &HashMap<String, String>, key: &str, default: &str) -> String {
    params
        .get(key)
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| default.to_string())
}

fn query_usize(params: &HashMap<String, String>, key: &str, default: usize) -> usize {
    params
        .get(key)
        .and_then(|value| value.parse::<usize>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(default)
}

fn query_f64(params: &HashMap<String, String>, key: &str, default: f64) -> f64 {
    params
        .get(key)
        .and_then(|value| value.parse::<f64>().ok())
        .filter(|value| value.is_finite())
        .unwrap_or(default)
}

fn with_index<F>(cli: &Cli, command: &'static str, start: Instant, f: F) -> Response
where
    F: FnOnce(&ContactIndex) -> Response,
{
    let index = match load_index(cli, command, start) {
        Ok((_cache_path, index)) => index,
        Err(response) => return *response,
    };

    f(&index)
}

fn load_index(
    cli: &Cli,
    command: &'static str,
    start: Instant,
) -> Result<(PathBuf, ContactIndex), Box<Response>> {
    let cache_path = match resolve_cache_path(cli.cache.as_deref()) {
        Ok(path) => path,
        Err(message) => return Err(Box::new(fail(command, "cache_not_found", message, start))),
    };

    let content = match fs::read_to_string(&cache_path) {
        Ok(content) => content,
        Err(err) => {
            return Err(Box::new(fail(
                command,
                "cache_read_failed",
                format!("failed to read {}: {err}", cache_path.display()),
                start,
            )));
        }
    };

    let index = match serde_json::from_str::<ContactIndex>(&content) {
        Ok(index) => index,
        Err(err) => {
            return Err(Box::new(fail(
                command,
                "cache_parse_failed",
                format!("failed to parse {}: {err}", cache_path.display()),
                start,
            )));
        }
    };

    Ok((cache_path, index))
}

fn find_person(index: &ContactIndex, query: &str, limit: usize, start: Instant) -> Response {
    let rows = rows(index);
    let query_norm = normalize(query);
    let query_email = query.trim().to_ascii_lowercase();
    let mut matches: Vec<(f64, ContactRow)> = rows
        .into_iter()
        .filter_map(|row| {
            let confidence = match_confidence(&row, &query_norm, &query_email);
            (confidence >= 0.72).then_some((confidence, row))
        })
        .collect();

    matches.sort_by(|(a_conf, a), (b_conf, b)| {
        b_conf
            .total_cmp(a_conf)
            .then_with(|| {
                infer_score(&b.contact)
                    .combined
                    .cmp(&infer_score(&a.contact).combined)
            })
            .then_with(|| a.contact.name.cmp(&b.contact.name))
    });

    let total = matches.len();
    let limit = limit.max(1);
    let data_matches: Vec<Value> = matches
        .into_iter()
        .take(limit)
        .map(|(confidence, row)| contact_match_value(&row, confidence))
        .collect();
    let returned = data_matches.len();

    ok(
        "find-person",
        json!({ "matches": data_matches }),
        json!({
            "matched": total,
            "returned": returned,
            "contact_count": index.contacts.len(),
            "schema_version": index.schema_version,
            "last_sync": &index.last_sync,
            "user_email": &index.user_email,
            "ms": elapsed_ms(start)
        }),
    )
}

fn score_person(index: &ContactIndex, email: &str, start: Instant) -> Response {
    let email_norm = email.trim().to_ascii_lowercase();
    let Some(row) = find_by_email_or_alias(index, &email_norm) else {
        return fail(
            "score",
            "not_found",
            format!("no contact found for {email}"),
            start,
        );
    };

    let score = infer_score(&row.contact);
    ok(
        "score",
        json!({
            "email": &row.email,
            "name": &row.contact.name,
            "canonical_id": &row.contact.canonical_id,
            "score": score,
            "score_source": score_source(&row.contact),
            "signals": contact_signals(&row.contact),
        }),
        json!({
            "matched": 1,
            "contact_count": index.contacts.len(),
            "schema_version": index.schema_version,
            "last_sync": &index.last_sync,
            "user_email": &index.user_email,
            "ms": elapsed_ms(start)
        }),
    )
}

fn who_knows(index: &ContactIndex, company: &str, limit: usize, start: Instant) -> Response {
    let company_norm = normalize_company(company);
    let mut people: Vec<ContactRow> = rows(index)
        .into_iter()
        .filter(|row| company_matches(&row.contact, &company_norm))
        .collect();

    people.sort_by(|a, b| {
        infer_score(&b.contact)
            .combined
            .cmp(&infer_score(&a.contact).combined)
            .then_with(|| b.contact.total_exchanges.cmp(&a.contact.total_exchanges))
            .then_with(|| a.contact.name.cmp(&b.contact.name))
    });

    let total = people.len();
    let limit = limit.max(1);
    let returned_people: Vec<Value> = people
        .into_iter()
        .take(limit)
        .map(|row| {
            let score = infer_score(&row.contact);
            let company = display_company(&row.contact);
            let company_source = company_source(&row.contact, company.as_deref());
            json!({
                "email": &row.email,
                "name": &row.contact.name,
                "role": &row.contact.role,
                "company": company,
                "company_source": company_source,
                "domain": &row.contact.domain,
                "canonical_id": &row.contact.canonical_id,
                "score": score,
                "score_source": score_source(&row.contact),
                "last_contact": &row.contact.last_contact,
                "total_exchanges": row.contact.total_exchanges,
            })
        })
        .collect();
    let returned = returned_people.len();

    ok(
        "who-knows",
        json!({
            "company": company,
            "people": returned_people,
            "ranked_by": "combined_score_desc",
        }),
        json!({
            "matched": total,
            "returned": returned,
            "contact_count": index.contacts.len(),
            "schema_version": index.schema_version,
            "last_sync": &index.last_sync,
            "user_email": &index.user_email,
            "ms": elapsed_ms(start)
        }),
    )
}

fn get_neighbors(index: &ContactIndex, email: &str, start: Instant) -> Response {
    let email_norm = resolve_email(index, email);
    let mut neighbors: Vec<Value> = index
        .edges
        .iter()
        .filter_map(|edge| {
            let source = edge.source_email.to_ascii_lowercase();
            let target = edge.target_email.to_ascii_lowercase();
            if source == email_norm {
                Some(neighbor_value(
                    index,
                    edge,
                    &edge.target_email,
                    &edge.target_name,
                    "outgoing",
                ))
            } else if target == email_norm {
                Some(neighbor_value(
                    index,
                    edge,
                    &edge.source_email,
                    &edge.source_name,
                    "incoming",
                ))
            } else {
                None
            }
        })
        .collect();

    neighbors.sort_by(|a, b| {
        value_u64(b, "edge_score")
            .cmp(&value_u64(a, "edge_score"))
            .then_with(|| value_str(a, "name").cmp(&value_str(b, "name")))
    });

    let matched = neighbors.len();
    ok(
        "get-neighbors",
        json!({
            "email": email_norm,
            "neighbors": neighbors,
        }),
        json!({
            "matched": matched,
            "edge_count": index.edges.len(),
            "contact_count": index.contacts.len(),
            "schema_version": index.schema_version,
            "last_sync": &index.last_sync,
            "user_email": &index.user_email,
            "ms": elapsed_ms(start)
        }),
    )
}

fn get_edges(index: &ContactIndex, from: &str, to: &str, start: Instant) -> Response {
    let from_email = resolve_email(index, from);
    let to_email = resolve_email(index, to);
    let mut edges: Vec<&ContactEdge> = index
        .edges
        .iter()
        .filter(|edge| {
            let source = edge.source_email.to_ascii_lowercase();
            let target = edge.target_email.to_ascii_lowercase();
            (source == from_email && target == to_email)
                || (source == to_email && target == from_email)
        })
        .collect();

    edges.sort_by_key(|edge| Reverse(edge.combined_score));
    let matched = edges.len();
    let edge_values: Vec<Value> = edges.iter().map(|edge| edge_value(edge)).collect();

    ok(
        "get-edges",
        json!({
            "from": person_ref(index, &from_email),
            "to": person_ref(index, &to_email),
            "edges": edge_values,
            "aggregate_score": aggregate_edge_score(&edges),
        }),
        json!({
            "matched": matched,
            "edge_count": index.edges.len(),
            "contact_count": index.contacts.len(),
            "schema_version": index.schema_version,
            "last_sync": &index.last_sync,
            "user_email": &index.user_email,
            "ms": elapsed_ms(start)
        }),
    )
}

fn suggest_duplicates(
    cli: &Cli,
    command: &'static str,
    args: &SuggestDuplicatesArgs,
    start: Instant,
) -> Response {
    let (cache_path, index) = match load_index(cli, command, start) {
        Ok(loaded) => loaded,
        Err(response) => return *response,
    };
    let queue_path = merge_queue_path(&cache_path);
    let queue = read_merge_queue(&queue_path);
    let min_confidence = args.min_confidence.clamp(0.0, 1.0);
    let contact_rows = rows(&index);
    let mut suggestions = Vec::new();
    let mut skipped_queue = 0;

    for (left_index, left) in contact_rows.iter().enumerate() {
        for right in contact_rows.iter().skip(left_index + 1) {
            if already_canonicalized_together(left, right) {
                continue;
            }
            if queue_pair_status(&queue, &left.email, &right.email).is_some() {
                skipped_queue += 1;
                continue;
            }
            if skip_default_duplicate_candidate(left, right) {
                continue;
            }
            if let Some((confidence, reasons)) = duplicate_confidence(left, right)
                && confidence >= min_confidence
            {
                let (primary, duplicate) = primary_duplicate(left, right);
                suggestions.push(DuplicateSuggestion {
                    confidence,
                    primary: primary.clone(),
                    duplicate: duplicate.clone(),
                    reasons,
                });
            }
        }
    }

    suggestions.sort_by(|a, b| {
        b.confidence
            .total_cmp(&a.confidence)
            .then_with(|| {
                b.primary
                    .contact
                    .total_exchanges
                    .cmp(&a.primary.contact.total_exchanges)
            })
            .then_with(|| a.primary.contact.name.cmp(&b.primary.contact.name))
    });

    let matched = suggestions.len();
    let limit = args.limit.max(1);
    let returned_suggestions: Vec<Value> = suggestions
        .into_iter()
        .take(limit)
        .map(|suggestion| {
            json!({
                "confidence": round_confidence(suggestion.confidence),
                "reasons": suggestion.reasons,
                "primary": contact_brief(&suggestion.primary),
                "duplicate": contact_brief(&suggestion.duplicate),
                "next_command": format!(
                    "peoplegraph propose-merge {} {}",
                    suggestion.primary.email,
                    suggestion.duplicate.email
                ),
                "dismiss_command": format!(
                    "peoplegraph dismiss-merge {} {} --reason not_duplicate",
                    suggestion.primary.email,
                    suggestion.duplicate.email
                ),
                "next_action": {
                    "command": "propose-merge",
                    "args": [
                        suggestion.primary.email,
                        suggestion.duplicate.email
                    ]
                },
                "review_actions": [
                    {
                        "command": "propose-merge",
                        "args": [
                            suggestion.primary.email,
                            suggestion.duplicate.email
                        ]
                    },
                    {
                        "command": "dismiss-merge",
                        "args": [
                            suggestion.primary.email,
                            suggestion.duplicate.email
                        ],
                        "reason": "not_duplicate"
                    }
                ],
            })
        })
        .collect();
    let returned = returned_suggestions.len();

    ok(
        "suggest-duplicates",
        json!({
            "suggestions": returned_suggestions,
            "min_confidence": round_confidence(min_confidence),
            "queue_path": queue_path.display().to_string(),
        }),
        json!({
            "matched": matched,
            "returned": returned,
            "skipped_existing_queue": skipped_queue,
            "queue_size": queue.candidates.len(),
            "contact_count": index.contacts.len(),
            "schema_version": index.schema_version,
            "last_sync": &index.last_sync,
            "user_email": &index.user_email,
            "ms": elapsed_ms(start)
        }),
    )
}

fn merge_queue(
    cli: &Cli,
    command: &'static str,
    args: &MergeQueueArgs,
    start: Instant,
) -> Response {
    let (cache_path, index) = match load_index(cli, command, start) {
        Ok(loaded) => loaded,
        Err(response) => return *response,
    };
    let queue_path = merge_queue_path(&cache_path);
    let queue = read_merge_queue(&queue_path);
    let status = args.status.trim().to_ascii_lowercase();
    let limit = args.limit.max(1);
    let mut candidates: Vec<&MergeCandidate> = queue
        .candidates
        .iter()
        .filter(|candidate| {
            status == "all" || candidate.status.trim().eq_ignore_ascii_case(&status)
        })
        .collect();

    candidates.sort_by_key(|candidate| Reverse(candidate.proposed_at_unix));
    let matched = candidates.len();
    let returned_candidates: Vec<Value> = candidates
        .into_iter()
        .take(limit)
        .map(|candidate| merge_candidate_value(&index, candidate))
        .collect();
    let returned = returned_candidates.len();
    let pending_count = queue
        .candidates
        .iter()
        .filter(|candidate| candidate.status.eq_ignore_ascii_case("pending"))
        .count();
    let applied_count = queue
        .candidates
        .iter()
        .filter(|candidate| candidate.status.eq_ignore_ascii_case("applied"))
        .count();
    let dismissed_count = queue
        .candidates
        .iter()
        .filter(|candidate| candidate.status.eq_ignore_ascii_case("dismissed"))
        .count();

    ok(
        command,
        json!({
            "queue_path": queue_path.display().to_string(),
            "schema_version": queue.schema_version,
            "updated_at_unix": queue.updated_at_unix,
            "status_filter": status,
            "candidates": returned_candidates,
        }),
        json!({
            "queue_size": queue.candidates.len(),
            "pending": pending_count,
            "applied": applied_count,
            "dismissed": dismissed_count,
            "matched": matched,
            "returned": returned,
            "contact_count": index.contacts.len(),
            "schema_version": index.schema_version,
            "last_sync": &index.last_sync,
            "user_email": &index.user_email,
            "ms": elapsed_ms(start)
        }),
    )
}

fn apply_merge(
    cli: &Cli,
    command: &'static str,
    args: &ApplyMergeArgs,
    start: Instant,
) -> Response {
    let (cache_path, index) = match load_index(cli, command, start) {
        Ok(loaded) => loaded,
        Err(response) => return *response,
    };
    let a_email = resolve_email(&index, &args.a);
    let b_email = resolve_email(&index, &args.b);
    if a_email == b_email {
        return fail(
            command,
            "invalid_merge",
            "merge candidates resolve to the same email".to_string(),
            start,
        );
    }

    let Some(a_key) = contact_key_for_email(&index, &a_email) else {
        return fail(
            command,
            "not_found",
            format!("no contact found for {a_email}"),
            start,
        );
    };
    let Some(b_key) = contact_key_for_email(&index, &b_email) else {
        return fail(
            command,
            "not_found",
            format!("no contact found for {b_email}"),
            start,
        );
    };

    let canonical_id = canonical_id_for_merge(&index, &a_email, &b_email);
    let canonical_synced_at = unix_seconds_iso();
    let aliases = merge_aliases(&index, &a_email, &b_email);

    let mut index_json = match read_json_value(&cache_path) {
        Ok(value) => value,
        Err(message) => return fail(command, "cache_read_failed", message, start),
    };
    if let Err(message) = apply_canonical_to_contact(
        &mut index_json,
        &a_key,
        &canonical_id,
        &aliases,
        &canonical_synced_at,
    )
    .and_then(|_| {
        apply_canonical_to_contact(
            &mut index_json,
            &b_key,
            &canonical_id,
            &aliases,
            &canonical_synced_at,
        )
    }) {
        return fail(command, "cache_write_failed", message, start);
    }
    if let Err(message) = write_json_value(&cache_path, &index_json) {
        return fail(command, "cache_write_failed", message, start);
    }

    let queue_path = merge_queue_path(&cache_path);
    let mut queue = read_merge_queue(&queue_path);
    let queue_status = mark_merge_applied(&mut queue, &index, &a_email, &b_email);
    if let Err(message) = write_merge_queue(&queue_path, &queue) {
        return fail(command, "queue_write_failed", message, start);
    }
    let pending_count = queue
        .candidates
        .iter()
        .filter(|candidate| candidate.status.eq_ignore_ascii_case("pending"))
        .count();

    ok(
        command,
        json!({
            "applied": true,
            "canonical_id": canonical_id,
            "last_canonical_sync": canonical_synced_at,
            "aliases": aliases,
            "queue_path": queue_path.display().to_string(),
            "queue_status": queue_status,
            "contacts": {
                "primary": applied_contact_ref(&index, &a_email, &canonical_id, &aliases, &canonical_synced_at),
                "merged": applied_contact_ref(&index, &b_email, &canonical_id, &aliases, &canonical_synced_at),
            }
        }),
        json!({
            "matched": 1,
            "queue_size": queue.candidates.len(),
            "pending": pending_count,
            "ms": elapsed_ms(start)
        }),
    )
}

fn dismiss_merge(
    cli: &Cli,
    command: &'static str,
    args: &DismissMergeArgs,
    start: Instant,
) -> Response {
    let (cache_path, index) = match load_index(cli, command, start) {
        Ok(loaded) => loaded,
        Err(response) => return *response,
    };
    let a_email = resolve_email(&index, &args.a);
    let b_email = resolve_email(&index, &args.b);
    if a_email == b_email {
        return fail(
            command,
            "invalid_merge",
            "merge candidates resolve to the same email".to_string(),
            start,
        );
    }

    let queue_path = merge_queue_path(&cache_path);
    let mut queue = read_merge_queue(&queue_path);
    let dismissed_at = unix_seconds();
    let reason = args.reason.trim();
    let reason = if reason.is_empty() {
        "not_duplicate"
    } else {
        reason
    };
    let queue_status =
        mark_merge_dismissed(&mut queue, &index, &a_email, &b_email, reason, dismissed_at);
    if let Err(message) = write_merge_queue(&queue_path, &queue) {
        return fail(command, "queue_write_failed", message, start);
    }
    let pending_count = queue
        .candidates
        .iter()
        .filter(|candidate| candidate.status.eq_ignore_ascii_case("pending"))
        .count();
    let dismissed_count = queue
        .candidates
        .iter()
        .filter(|candidate| candidate.status.eq_ignore_ascii_case("dismissed"))
        .count();

    ok(
        command,
        json!({
            "dismissed": true,
            "reason": reason,
            "dismissed_at_unix": dismissed_at,
            "queue_path": queue_path.display().to_string(),
            "queue_status": queue_status,
            "candidate": {
                "a": person_ref(&index, &a_email),
                "b": person_ref(&index, &b_email),
                "status": "dismissed"
            }
        }),
        json!({
            "matched": 1,
            "queue_size": queue.candidates.len(),
            "pending": pending_count,
            "dismissed": dismissed_count,
            "ms": elapsed_ms(start)
        }),
    )
}

fn propose_merge(
    cli: &Cli,
    command: &'static str,
    args: &ProposeMergeArgs,
    start: Instant,
) -> Response {
    let (cache_path, index) = match load_index(cli, command, start) {
        Ok(loaded) => loaded,
        Err(response) => return *response,
    };
    let a_email = resolve_email(&index, &args.a);
    let b_email = resolve_email(&index, &args.b);
    if a_email == b_email {
        return fail(
            command,
            "invalid_merge",
            "merge candidates resolve to the same email".to_string(),
            start,
        );
    }

    let queue_path = merge_queue_path(&cache_path);
    let mut queue = read_merge_queue(&queue_path);
    let now = unix_seconds();
    let mut queue_status = "queued";
    let mut queued = true;
    if let Some(candidate) = queue
        .candidates
        .iter_mut()
        .find(|candidate| same_pair(&candidate.a_email, &candidate.b_email, &a_email, &b_email))
    {
        if candidate.status.eq_ignore_ascii_case("dismissed") {
            candidate.status = "pending".to_string();
            candidate.dismissed_at_unix = None;
            candidate.dismiss_reason = None;
            candidate.proposed_at_unix = now;
            candidate.source = "peoplegraph".to_string();
            queue_status = "reopened_dismissed";
        } else {
            queued = false;
            queue_status = "already_queued";
        }
    } else {
        queue.candidates.push(MergeCandidate {
            a_email: a_email.clone(),
            a_name: contact_name(&index, &a_email),
            b_email: b_email.clone(),
            b_name: contact_name(&index, &b_email),
            status: "pending".to_string(),
            proposed_at_unix: now,
            source: "peoplegraph".to_string(),
            dismissed_at_unix: None,
            dismiss_reason: None,
        });
    }
    queue.updated_at_unix = now;

    if let Err(err) = write_merge_queue(&queue_path, &queue) {
        return fail(
            command,
            "queue_write_failed",
            format!("failed to write {}: {err}", queue_path.display()),
            start,
        );
    }

    ok(
        command,
        json!({
            "queued": queued,
            "queue_status": queue_status,
            "queue_path": queue_path.display().to_string(),
            "candidate": {
                "a": person_ref(&index, &a_email),
                "b": person_ref(&index, &b_email),
                "status": "pending"
            }
        }),
        json!({
            "matched": if queued { 1 } else { 0 },
            "queue_size": queue.candidates.len(),
            "ms": elapsed_ms(start)
        }),
    )
}

fn contact_match_value(row: &ContactRow, confidence: f64) -> Value {
    let score = infer_score(&row.contact);
    json!({
        "email": &row.email,
        "name": &row.contact.name,
        "aliases": &row.contact.aliases,
        "canonical_id": &row.contact.canonical_id,
        "score": score,
        "score_source": score_source(&row.contact),
        "match_confidence": round_confidence(confidence),
    })
}

fn neighbor_value(
    index: &ContactIndex,
    edge: &ContactEdge,
    neighbor_email: &str,
    neighbor_name: &str,
    direction: &str,
) -> Value {
    let email = neighbor_email.to_ascii_lowercase();
    let row = find_by_email_or_alias(index, &email);
    let score = row.as_ref().map(|row| infer_score(&row.contact));
    json!({
        "email": email,
        "name": row.as_ref().map(|row| row.contact.name.as_str()).unwrap_or(neighbor_name),
        "canonical_id": row.as_ref().and_then(|row| row.contact.canonical_id.as_ref()),
        "score": score,
        "edge_score": edge.combined_score,
        "edge": {
            "type": &edge.edge_type,
            "context": &edge.context,
            "direction": direction,
            "source_email": &edge.source_email,
            "source_name": &edge.source_name,
            "target_email": &edge.target_email,
            "target_name": &edge.target_name,
            "source_score": &edge.source_score,
            "target_score": &edge.target_score,
        }
    })
}

fn edge_value(edge: &ContactEdge) -> Value {
    json!({
        "source_email": &edge.source_email,
        "source_name": &edge.source_name,
        "target_email": &edge.target_email,
        "target_name": &edge.target_name,
        "type": &edge.edge_type,
        "context": &edge.context,
        "combined_score": edge.combined_score,
        "source_score": &edge.source_score,
        "target_score": &edge.target_score,
    })
}

fn aggregate_edge_score(edges: &[&ContactEdge]) -> Option<u8> {
    edges.iter().map(|edge| edge.combined_score).max()
}

fn person_ref(index: &ContactIndex, email: &str) -> Value {
    let row = find_by_email_or_alias(index, email);
    json!({
        "email": email,
        "name": row.as_ref().map(|row| row.contact.name.as_str()).unwrap_or(email),
        "canonical_id": row.as_ref().and_then(|row| row.contact.canonical_id.as_ref()),
        "score": row.as_ref().map(|row| infer_score(&row.contact)),
    })
}

fn applied_contact_ref(
    index: &ContactIndex,
    email: &str,
    canonical_id: &str,
    aliases: &[String],
    canonical_synced_at: &str,
) -> Value {
    let row = find_by_email_or_alias(index, email);
    json!({
        "email": email,
        "name": row.as_ref().map(|row| row.contact.name.as_str()).unwrap_or(email),
        "canonical_id": canonical_id,
        "last_canonical_sync": canonical_synced_at,
        "aliases": aliases,
        "score": row.as_ref().map(|row| infer_score(&row.contact)),
    })
}

fn resolve_email(index: &ContactIndex, query: &str) -> String {
    let email = query.trim().to_ascii_lowercase();
    find_by_email_or_alias(index, &email)
        .map(|row| row.email)
        .unwrap_or(email)
}

fn contact_name(index: &ContactIndex, email: &str) -> String {
    find_by_email_or_alias(index, email)
        .map(|row| row.contact.name)
        .unwrap_or_else(|| email.to_string())
}

fn contact_key_for_email(index: &ContactIndex, email: &str) -> Option<String> {
    let email = email.trim().to_ascii_lowercase();
    index
        .contacts
        .iter()
        .find_map(|(key, contact)| {
            let row_email = canonical_email(key, contact);
            (key.eq_ignore_ascii_case(&email)
                || row_email == email
                || contact.email.trim().eq_ignore_ascii_case(&email))
            .then(|| key.clone())
        })
        .or_else(|| {
            index.contacts.iter().find_map(|(key, contact)| {
                contact
                    .aliases
                    .iter()
                    .any(|alias| alias.trim().eq_ignore_ascii_case(&email))
                    .then(|| key.clone())
            })
        })
}

fn canonical_id_for_merge(index: &ContactIndex, a_email: &str, b_email: &str) -> String {
    [a_email, b_email]
        .iter()
        .find_map(|email| {
            find_by_email_or_alias(index, email)
                .and_then(|row| row.contact.canonical_id)
                .map(|id| id.trim().to_string())
                .filter(|id| !id.is_empty())
        })
        .unwrap_or_else(|| format!("local:{a_email}"))
}

fn merge_aliases(index: &ContactIndex, a_email: &str, b_email: &str) -> Vec<String> {
    let mut aliases = Vec::new();
    push_unique_email(&mut aliases, a_email);
    push_unique_email(&mut aliases, b_email);
    for email in [a_email, b_email] {
        if let Some(row) = find_by_email_or_alias(index, email) {
            push_unique_email(&mut aliases, &row.email);
            for alias in row.contact.aliases {
                push_unique_email(&mut aliases, &alias);
            }
        }
    }
    aliases
}

fn push_unique_email(values: &mut Vec<String>, email: &str) {
    let email = email.trim().to_ascii_lowercase();
    if email.is_empty() {
        return;
    }
    if !values
        .iter()
        .any(|existing| existing.eq_ignore_ascii_case(&email))
    {
        values.push(email);
    }
}

fn read_json_value(path: &Path) -> Result<Value, String> {
    let content = fs::read_to_string(path)
        .map_err(|err| format!("failed to read {}: {err}", path.display()))?;
    serde_json::from_str(&content)
        .map_err(|err| format!("failed to parse {}: {err}", path.display()))
}

fn write_json_value(path: &Path, value: &Value) -> Result<(), String> {
    let content = serde_json::to_string_pretty(value).map_err(|err| err.to_string())?;
    fs::write(path, content).map_err(|err| format!("failed to write {}: {err}", path.display()))
}

fn apply_canonical_to_contact(
    index_json: &mut Value,
    key: &str,
    canonical_id: &str,
    aliases: &[String],
    canonical_synced_at: &str,
) -> Result<(), String> {
    let contact = index_json
        .get_mut("contacts")
        .and_then(Value::as_object_mut)
        .and_then(|contacts| contacts.get_mut(key))
        .and_then(Value::as_object_mut)
        .ok_or_else(|| format!("contact not found in JSON cache: {key}"))?;

    contact.insert(
        "canonicalId".to_string(),
        Value::String(canonical_id.to_string()),
    );
    contact.insert(
        "lastCanonicalSync".to_string(),
        Value::String(canonical_synced_at.to_string()),
    );

    let mut merged_aliases = contact
        .get("aliases")
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(Value::as_str)
                .map(ToString::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    for alias in aliases {
        push_unique_email(&mut merged_aliases, alias);
    }
    contact.insert(
        "aliases".to_string(),
        Value::Array(merged_aliases.into_iter().map(Value::String).collect()),
    );

    Ok(())
}

fn merge_queue_path(cache_path: &Path) -> PathBuf {
    cache_path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join("merge-queue.json")
}

fn merge_candidate_value(index: &ContactIndex, candidate: &MergeCandidate) -> Value {
    let next_actions = merge_candidate_actions(candidate);
    json!({
        "a": person_ref(index, &candidate.a_email),
        "b": person_ref(index, &candidate.b_email),
        "a_name": &candidate.a_name,
        "b_name": &candidate.b_name,
        "status": &candidate.status,
        "source": &candidate.source,
        "proposed_at_unix": candidate.proposed_at_unix,
        "dismissed_at_unix": candidate.dismissed_at_unix,
        "dismiss_reason": &candidate.dismiss_reason,
        "next_actions": next_actions,
        "next_action": next_actions.first(),
    })
}

fn merge_candidate_actions(candidate: &MergeCandidate) -> Vec<Value> {
    let status = candidate.status.trim().to_ascii_lowercase();
    match status.as_str() {
        "pending" => vec![
            json!({
                "command": "apply-merge",
                "args": [&candidate.a_email, &candidate.b_email],
            }),
            json!({
                "command": "dismiss-merge",
                "args": [&candidate.a_email, &candidate.b_email],
                "reason": "not_duplicate",
            }),
        ],
        "dismissed" => vec![json!({
            "command": "propose-merge",
            "args": [&candidate.a_email, &candidate.b_email],
        })],
        _ => Vec::new(),
    }
}

fn mark_merge_applied(
    queue: &mut MergeQueue,
    index: &ContactIndex,
    a_email: &str,
    b_email: &str,
) -> &'static str {
    let now = unix_seconds();
    queue.updated_at_unix = now;
    if let Some(candidate) = queue
        .candidates
        .iter_mut()
        .find(|candidate| same_pair(&candidate.a_email, &candidate.b_email, a_email, b_email))
    {
        candidate.status = "applied".to_string();
        candidate.dismissed_at_unix = None;
        candidate.dismiss_reason = None;
        return "updated_existing";
    }

    queue.candidates.push(MergeCandidate {
        a_email: a_email.to_string(),
        a_name: contact_name(index, a_email),
        b_email: b_email.to_string(),
        b_name: contact_name(index, b_email),
        status: "applied".to_string(),
        proposed_at_unix: now,
        source: "peoplegraph".to_string(),
        dismissed_at_unix: None,
        dismiss_reason: None,
    });
    "recorded_direct_apply"
}

fn mark_merge_dismissed(
    queue: &mut MergeQueue,
    index: &ContactIndex,
    a_email: &str,
    b_email: &str,
    reason: &str,
    dismissed_at: u64,
) -> &'static str {
    queue.updated_at_unix = dismissed_at;
    if let Some(candidate) = queue
        .candidates
        .iter_mut()
        .find(|candidate| same_pair(&candidate.a_email, &candidate.b_email, a_email, b_email))
    {
        candidate.status = "dismissed".to_string();
        candidate.dismissed_at_unix = Some(dismissed_at);
        candidate.dismiss_reason = Some(reason.to_string());
        return "updated_existing";
    }

    queue.candidates.push(MergeCandidate {
        a_email: a_email.to_string(),
        a_name: contact_name(index, a_email),
        b_email: b_email.to_string(),
        b_name: contact_name(index, b_email),
        status: "dismissed".to_string(),
        proposed_at_unix: dismissed_at,
        source: "peoplegraph".to_string(),
        dismissed_at_unix: Some(dismissed_at),
        dismiss_reason: Some(reason.to_string()),
    });
    "recorded_direct_dismiss"
}

fn read_merge_queue(path: &Path) -> MergeQueue {
    let candidates = fs::read_to_string(path)
        .ok()
        .and_then(|content| serde_json::from_str::<MergeQueue>(&content).ok())
        .map(|queue| queue.candidates)
        .unwrap_or_default();

    MergeQueue {
        schema_version: 1,
        updated_at_unix: unix_seconds(),
        candidates,
    }
}

fn write_merge_queue(path: &Path, queue: &MergeQueue) -> Result<(), String> {
    let content = serde_json::to_string_pretty(queue).map_err(|err| err.to_string())?;
    fs::write(path, content).map_err(|err| err.to_string())
}

fn queue_pair_status<'a>(queue: &'a MergeQueue, a_email: &str, b_email: &str) -> Option<&'a str> {
    queue
        .candidates
        .iter()
        .find(|candidate| same_pair(&candidate.a_email, &candidate.b_email, a_email, b_email))
        .map(|candidate| candidate.status.as_str())
}

fn same_pair(a1: &str, b1: &str, a2: &str, b2: &str) -> bool {
    let a1 = a1.to_ascii_lowercase();
    let b1 = b1.to_ascii_lowercase();
    let a2 = a2.to_ascii_lowercase();
    let b2 = b2.to_ascii_lowercase();
    (a1 == a2 && b1 == b2) || (a1 == b2 && b1 == a2)
}

fn unix_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn unix_seconds_iso() -> String {
    unix_to_utc_iso(unix_seconds())
}

fn unix_to_utc_iso(seconds: u64) -> String {
    let days = (seconds / 86_400) as i64;
    let seconds_of_day = seconds % 86_400;
    let (year, month, day) = civil_from_unix_days(days);
    let hour = seconds_of_day / 3_600;
    let minute = (seconds_of_day % 3_600) / 60;
    let second = seconds_of_day % 60;
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}Z")
}

fn civil_from_unix_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = mp + if mp < 10 { 3 } else { -9 };
    let year = year + if month <= 2 { 1 } else { 0 };
    (year, month, day)
}

fn value_u64(value: &Value, key: &str) -> u64 {
    value.get(key).and_then(Value::as_u64).unwrap_or(0)
}

fn value_str(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

fn rows(index: &ContactIndex) -> Vec<ContactRow> {
    index
        .contacts
        .iter()
        .map(|(key, contact)| ContactRow {
            email: canonical_email(key, contact),
            contact: contact.clone(),
        })
        .collect()
}

fn canonical_email(key: &str, contact: &Contact) -> String {
    if contact.email.trim().is_empty() {
        key.to_ascii_lowercase()
    } else {
        contact.email.trim().to_ascii_lowercase()
    }
}

fn find_by_email_or_alias(index: &ContactIndex, email: &str) -> Option<ContactRow> {
    let contact_rows = rows(index);
    contact_rows
        .iter()
        .find(|row| row.email == email || row.contact.email.trim().eq_ignore_ascii_case(email))
        .cloned()
        .or_else(|| {
            contact_rows.into_iter().find(|row| {
                row.contact
                    .aliases
                    .iter()
                    .any(|alias| alias.trim().eq_ignore_ascii_case(email))
            })
        })
}

fn already_canonicalized_together(left: &ContactRow, right: &ContactRow) -> bool {
    let left_id = left.contact.canonical_id.as_deref().map(str::trim);
    let right_id = right.contact.canonical_id.as_deref().map(str::trim);
    matches!((left_id, right_id), (Some(a), Some(b)) if !a.is_empty() && a == b)
}

fn duplicate_confidence(left: &ContactRow, right: &ContactRow) -> Option<(f64, Vec<String>)> {
    if left.email == right.email {
        return None;
    }

    let mut confidence: f64 = 0.0;
    let mut reasons = Vec::new();
    let same_domain = same_non_generic_domain(left, right);
    let left_name = normalize(&left.contact.name);
    let right_name = normalize(&right.contact.name);
    let left_compact = compact_normalize(&left.contact.name);
    let right_compact = compact_normalize(&right.contact.name);

    if alias_overlap(left, right) {
        confidence = confidence.max(0.99);
        reasons.push("shared_email_or_alias".to_string());
    }

    if left_name.len() >= 4 && left_name == right_name {
        confidence = confidence.max(if same_domain { 0.96 } else { 0.9 });
        reasons.push(
            if same_domain {
                "same_name_same_domain"
            } else {
                "same_name"
            }
            .to_string(),
        );
    }

    if left_compact.len() >= 5 && right_compact.len() >= 5 {
        let name_similarity = jaro_winkler(&left_compact, &right_compact);
        if same_domain && name_similarity >= 0.91 {
            confidence = confidence.max(name_similarity.min(0.95));
            reasons.push("similar_name_same_domain".to_string());
        } else if name_similarity >= 0.95 {
            confidence = confidence.max(0.88);
            reasons.push("very_similar_name".to_string());
        }

        if same_domain
            && (left_compact.starts_with(&right_compact)
                || right_compact.starts_with(&left_compact))
        {
            confidence = confidence.max(0.94);
            reasons.push("name_prefix_same_domain".to_string());
        }
    }

    let left_local = email_local(&left.email);
    let right_local = email_local(&right.email);
    if same_domain
        && ((left_compact.len() >= 5 && right_local.contains(&left_compact))
            || (right_compact.len() >= 5 && left_local.contains(&right_compact)))
    {
        confidence = confidence.max(0.9);
        reasons.push("name_matches_other_email_local_part".to_string());
    }

    if same_domain
        && (is_fragment_row(left) || is_fragment_row(right))
        && weak_name_prefix_match(&left_compact, &right_compact)
    {
        confidence = confidence.max(0.78);
        reasons.push("short_fragment_same_domain".to_string());
    }

    if confidence > 0.0 {
        reasons.sort();
        reasons.dedup();
        Some((confidence, reasons))
    } else {
        None
    }
}

fn alias_overlap(left: &ContactRow, right: &ContactRow) -> bool {
    let right_email = right.email.as_str();
    let left_email = left.email.as_str();
    left.contact
        .aliases
        .iter()
        .any(|alias| alias.trim().eq_ignore_ascii_case(right_email))
        || right
            .contact
            .aliases
            .iter()
            .any(|alias| alias.trim().eq_ignore_ascii_case(left_email))
}

fn skip_default_duplicate_candidate(left: &ContactRow, right: &ContactRow) -> bool {
    is_service_or_org_row(left) && is_service_or_org_row(right)
}

fn is_service_or_org_row(row: &ContactRow) -> bool {
    let local = email_local(&row.email);
    if local.starts_with("reply+")
        || local.starts_with("no-reply")
        || local.starts_with("noreply")
        || local.contains("notification")
    {
        return true;
    }

    let compact_name = compact_normalize(&row.contact.name);
    if compact_name.starts_with("norepl") || compact_name.starts_with("noreply") {
        return true;
    }

    let local_words = normalize(&local);
    let service_words = [
        "apply",
        "billing",
        "discover",
        "events",
        "express",
        "hello",
        "hi",
        "hey",
        "invoice",
        "invite",
        "mail",
        "news",
        "statements",
        "updates",
        "workatastartup",
    ];
    if service_words
        .iter()
        .any(|word| local_words.split_whitespace().any(|part| part == *word))
    {
        return true;
    }

    !looks_like_person_name(&row.contact.name)
}

fn looks_like_person_name(name: &str) -> bool {
    let normalized = normalize(name);
    let parts: Vec<&str> = normalized.split_whitespace().collect();
    if parts.len() < 2 || parts.len() > 4 {
        return false;
    }

    let org_words = [
        "ai",
        "airbnb",
        "anthropic",
        "combinator",
        "events",
        "github",
        "granola",
        "incorporated",
        "labs",
        "lovable",
        "newsletter",
        "region",
        "startup",
        "tinkerers",
        "updates",
    ];
    !parts.iter().any(|part| org_words.contains(part))
}

fn same_non_generic_domain(left: &ContactRow, right: &ContactRow) -> bool {
    let left_domain = left.contact.domain.trim().to_ascii_lowercase();
    let right_domain = right.contact.domain.trim().to_ascii_lowercase();
    !left_domain.is_empty() && left_domain == right_domain && !is_generic_email_domain(&left_domain)
}

fn weak_name_prefix_match(left: &str, right: &str) -> bool {
    let shorter_len = left.len().min(right.len());
    shorter_len >= 3 && (left.starts_with(right) || right.starts_with(left))
}

fn is_fragment_row(row: &ContactRow) -> bool {
    let local = email_local(&row.email);
    local.len() == 1 || compact_normalize(&row.contact.name).len() <= 3
}

fn primary_duplicate<'a>(
    left: &'a ContactRow,
    right: &'a ContactRow,
) -> (&'a ContactRow, &'a ContactRow) {
    let left_rank = duplicate_primary_rank(left);
    let right_rank = duplicate_primary_rank(right);
    if right_rank > left_rank {
        (right, left)
    } else {
        (left, right)
    }
}

fn duplicate_primary_rank(row: &ContactRow) -> (u8, u32, usize, usize) {
    (
        u8::from(!is_fragment_row(row)),
        row.contact.total_exchanges,
        compact_normalize(&row.contact.name).len(),
        email_local(&row.email).len(),
    )
}

fn contact_brief(row: &ContactRow) -> Value {
    json!({
        "email": &row.email,
        "name": &row.contact.name,
        "domain": &row.contact.domain,
        "company": display_company(&row.contact),
        "canonical_id": &row.contact.canonical_id,
        "score": infer_score(&row.contact),
        "score_source": score_source(&row.contact),
        "last_contact": &row.contact.last_contact,
        "total_exchanges": row.contact.total_exchanges,
    })
}

fn email_local(email: &str) -> String {
    email
        .split('@')
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase()
}

fn compact_normalize(value: &str) -> String {
    normalize(value)
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric())
        .collect()
}

fn match_confidence(row: &ContactRow, query_norm: &str, query_email: &str) -> f64 {
    if row.email == query_email
        || row.contact.email.trim().eq_ignore_ascii_case(query_email)
        || row
            .contact
            .aliases
            .iter()
            .any(|alias| alias.trim().eq_ignore_ascii_case(query_email))
    {
        return 1.0;
    }

    if row.email.contains(query_email)
        || row
            .contact
            .aliases
            .iter()
            .any(|alias| alias.to_ascii_lowercase().contains(query_email))
    {
        return 0.96;
    }

    let name_norm = normalize(&row.contact.name);
    if !query_norm.is_empty() && name_norm.contains(query_norm) {
        return 0.93;
    }

    if !query_norm.is_empty() && query_norm.contains(&name_norm) && name_norm.len() >= 4 {
        return 0.88;
    }

    let score = jaro_winkler(&name_norm, query_norm);
    if score > 0.84 { score } else { 0.0 }
}

fn infer_score(contact: &Contact) -> ScoreOut {
    let cached = contact.score.as_ref();
    let depth = cached
        .and_then(|score| score.depth)
        .or(contact.relationship_depth)
        .unwrap_or_else(|| compute_depth(contact));
    let recency = cached
        .and_then(|score| score.recency)
        .or(contact.relationship_recency)
        .unwrap_or_else(|| compute_recency(days_since_contact(contact)));
    let combined = cached
        .and_then(|score| score.combined)
        .or(contact.combined_score)
        .unwrap_or_else(|| compute_combined(contact));
    let quadrant = cached
        .and_then(|score| score.quadrant.clone())
        .or_else(|| contact.quadrant.clone())
        .unwrap_or_else(|| compute_quadrant(contact));

    ScoreOut {
        depth: depth.clamp(1, 5),
        recency: recency.clamp(1, 10),
        combined: combined.min(100),
        quadrant,
    }
}

fn score_source(contact: &Contact) -> &'static str {
    let has_cached_score = contact.score.as_ref().is_some_and(|score| {
        score.depth.is_some() || score.recency.is_some() || score.combined.is_some()
    });
    if has_cached_score
        || contact.relationship_depth.is_some()
        || contact.relationship_recency.is_some()
        || contact.combined_score.is_some()
        || contact.quadrant.is_some()
    {
        "cached"
    } else {
        "estimated_from_metadata"
    }
}

fn display_company(contact: &Contact) -> Option<String> {
    contact
        .company
        .as_deref()
        .map(str::trim)
        .filter(|company| !company.is_empty())
        .map(ToString::to_string)
        .or_else(|| infer_company_from_domain(&contact.domain))
}

fn company_source(contact: &Contact, company: Option<&str>) -> &'static str {
    if contact
        .company
        .as_deref()
        .map(str::trim)
        .is_some_and(|company| !company.is_empty())
    {
        "cache"
    } else if company.is_some() {
        "domain"
    } else {
        "none"
    }
}

fn infer_company_from_domain(domain: &str) -> Option<String> {
    let domain = domain.trim().to_ascii_lowercase();
    if domain.is_empty() || is_generic_email_domain(&domain) {
        return None;
    }

    let raw = domain.split('.').next()?.trim();
    if raw.is_empty() {
        return None;
    }

    Some(
        raw.split(['-', '_'])
            .filter(|part| !part.is_empty())
            .map(|part| {
                let mut chars = part.chars();
                match chars.next() {
                    Some(first) => {
                        format!("{}{}", first.to_ascii_uppercase(), chars.as_str())
                    }
                    None => String::new(),
                }
            })
            .collect::<Vec<_>>()
            .join(" "),
    )
}

fn is_generic_email_domain(domain: &str) -> bool {
    matches!(
        domain,
        "gmail.com"
            | "yahoo.com"
            | "hotmail.com"
            | "outlook.com"
            | "icloud.com"
            | "aol.com"
            | "protonmail.com"
            | "me.com"
            | "live.com"
            | "mail.com"
    )
}

fn compute_depth(contact: &Contact) -> u8 {
    let total = contact.total_exchanges;
    let back_and_forth = contact.back_and_forth_threads.unwrap_or(0);
    let max_thread = contact.max_thread_depth.unwrap_or(0);
    let rsvp_only = contact.rsvp_only_threads.unwrap_or(0);
    let thread_count = contact.thread_count.unwrap_or(0);

    if thread_count == 0 && total > 0 {
        if total >= 20 {
            return 4;
        }
        if total >= 8 {
            return 3;
        }
        if total >= 3 {
            return 2;
        }
        return 1;
    }

    if back_and_forth >= 3 && total >= 20 && max_thread >= 5 {
        return 5;
    }
    if back_and_forth >= 1 && total >= 8 {
        return 4;
    }
    if total >= 8 && max_thread >= 3 {
        return 3;
    }
    if total >= 3 {
        if rsvp_only > 0 && rsvp_only >= thread_count / 2 {
            return 1;
        }
        return 2;
    }
    1
}

fn compute_recency(days: Option<i64>) -> u8 {
    match days {
        None => 1,
        Some(days) if days <= 2 => 10,
        Some(days) if days <= 7 => 9,
        Some(days) if days <= 14 => 8,
        Some(days) if days <= 21 => 7,
        Some(days) if days <= 30 => 6,
        Some(days) if days <= 60 => 5,
        Some(days) if days <= 90 => 4,
        Some(days) if days <= 120 => 3,
        Some(days) if days <= 180 => 2,
        Some(_) => 1,
    }
}

fn compute_combined(contact: &Contact) -> u8 {
    ((compute_strength_score(contact) + compute_momentum_score(contact)) / 2).min(100)
}

fn compute_strength_score(contact: &Contact) -> u8 {
    let total = contact.total_exchanges as f64;
    if total == 0.0 {
        return 0;
    }

    let volume_score = ((total + 1.0).log2() * 4.0).min(25.0);
    let depth_score = {
        let back_and_forth = contact.back_and_forth_threads.unwrap_or(0) as f64;
        let max_thread = contact.max_thread_depth.unwrap_or(0) as f64;
        (back_and_forth * 5.0).min(20.0) + (max_thread * 2.0).min(10.0)
    };
    let initiation_score = if contact.total_exchanges > 0 {
        let min_side = contact.sent_count.min(contact.received_count) as f64;
        let max_side = contact.sent_count.max(contact.received_count).max(1) as f64;
        5.0 + (min_side / max_side) * 20.0
    } else {
        5.0
    };
    let span_score = match (&contact.first_contact, &contact.last_contact) {
        (Some(first), Some(last)) => {
            let span_days = date_days(last)
                .zip(date_days(first))
                .map(|(l, f)| l - f)
                .unwrap_or(0);
            ((span_days.max(0) as f64 / 365.0) * 12.5).min(25.0)
        }
        _ => 0.0,
    };

    (volume_score + depth_score + initiation_score + span_score)
        .round()
        .clamp(0.0, 100.0) as u8
}

fn compute_momentum_score(contact: &Contact) -> u8 {
    let Some(days) = days_since_contact(contact) else {
        return 0;
    };
    let decay_score = (-0.02 * days.max(0) as f64).exp() * 80.0;
    let trend_score = {
        let last_depth = contact.last_thread_depth.unwrap_or(0);
        let back_and_forth = contact.back_and_forth_threads.unwrap_or(0);
        (last_depth * 2).min(10) + (back_and_forth * 2).min(10)
    };
    (decay_score + trend_score as f64).round().clamp(0.0, 100.0) as u8
}

fn compute_quadrant(contact: &Contact) -> String {
    let mut is_strong = compute_strength_score(contact) >= 40;
    let is_active = compute_momentum_score(contact) >= 30;
    if !is_strong && contact.back_and_forth_threads.unwrap_or(0) >= 1 && contact.sent_count >= 2 {
        is_strong = true;
    }

    match (is_strong, is_active) {
        (true, true) => "nurture",
        (true, false) => "re-engage",
        (false, true) => "developing",
        (false, false) => "deprioritize",
    }
    .to_string()
}

fn days_since_contact(contact: &Contact) -> Option<i64> {
    let last = contact.last_contact.as_ref()?;
    let last_days = date_days(last)?;
    let now_days = current_unix_days();
    Some(now_days - last_days)
}

fn date_days(value: &str) -> Option<i64> {
    let date = value.get(0..10)?;
    let mut parts = date.split('-');
    let year = parts.next()?.parse::<i32>().ok()?;
    let month = parts.next()?.parse::<u32>().ok()?;
    let day = parts.next()?.parse::<u32>().ok()?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    Some(days_from_civil(year, month, day))
}

fn current_unix_days() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
        / 86_400
}

fn days_from_civil(year: i32, month: u32, day: u32) -> i64 {
    let year = year - i32::from(month <= 2);
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let yoe = year - era * 400;
    let month = month as i32;
    let doy = (153 * (month + if month > 2 { -3 } else { 9 }) + 2) / 5 + day as i32 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    (era * 146_097 + doe - 719_468) as i64
}

fn contact_signals(contact: &Contact) -> Value {
    json!({
        "total_exchanges": contact.total_exchanges,
        "sent": contact.sent_count,
        "received": contact.received_count,
        "thread_count": contact.thread_count,
        "back_and_forth_threads": contact.back_and_forth_threads,
        "max_thread_depth": contact.max_thread_depth,
        "last_thread_depth": contact.last_thread_depth,
        "rsvp_only_threads": contact.rsvp_only_threads,
        "first_contact": contact.first_contact,
        "last_contact": contact.last_contact,
        "domain": contact.domain,
        "subject_count": contact.subjects.len(),
        "last_subject": contact.last_subject,
        "last_canonical_sync": contact.last_canonical_sync,
    })
}

fn company_matches(contact: &Contact, company_norm: &str) -> bool {
    let domain = normalize_company(&contact.domain);
    let company = contact
        .company
        .as_deref()
        .map(normalize_company)
        .unwrap_or_default();
    let role = contact
        .role
        .as_deref()
        .map(normalize_company)
        .unwrap_or_default();

    [domain.as_str(), company.as_str(), role.as_str()]
        .iter()
        .any(|candidate| {
            !candidate.is_empty()
                && (candidate == &company_norm
                    || candidate.contains(company_norm)
                    || company_norm.contains(*candidate))
        })
}

fn normalize_company(value: &str) -> String {
    normalize(value)
        .trim_end_matches(" inc")
        .trim_end_matches(" llc")
        .trim_end_matches(" corp")
        .trim_end_matches(" co")
        .trim_end_matches(" ltd")
        .trim_end_matches(" com")
        .trim()
        .to_string()
}

fn normalize(value: &str) -> String {
    value
        .to_ascii_lowercase()
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { ' ' })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn round_confidence(confidence: f64) -> f64 {
    (confidence * 100.0).round() / 100.0
}

fn resolve_cache_path(explicit: Option<&Path>) -> Result<PathBuf, String> {
    if let Some(path) = explicit {
        return path
            .exists()
            .then(|| path.to_path_buf())
            .ok_or_else(|| format!("cache path does not exist: {}", path.display()));
    }

    if let Ok(path) = env::var("PEOPLEGRAPH_CACHE") {
        let path = PathBuf::from(path);
        if path.exists() {
            return Ok(path);
        }
    }

    let mut dir =
        env::current_dir().map_err(|err| format!("cannot read current directory: {err}"))?;
    loop {
        let candidate = dir.join(".obsidian/plugins/gmail-crm/contact-index.json");
        if candidate.exists() {
            return Ok(candidate);
        }
        let local = dir.join("contact-index.json");
        if local.exists() {
            return Ok(local);
        }
        if !dir.pop() {
            break;
        }
    }

    if let Some(path) = resolve_obsidian_cache_path() {
        return Ok(path);
    }

    Err("no contact-index.json found; pass --cache <path> or set PEOPLEGRAPH_CACHE".to_string())
}

fn resolve_obsidian_cache_path() -> Option<PathBuf> {
    let config_path = obsidian_config_path()?;
    let content = fs::read_to_string(config_path).ok()?;
    let config: Value = serde_json::from_str(&content).ok()?;
    let vaults = config.get("vaults")?.as_object()?;
    let mut candidates = Vec::new();

    for vault in vaults.values() {
        if let Some(vault_path) = vault.get("path").and_then(Value::as_str) {
            let cache_path =
                Path::new(vault_path).join(".obsidian/plugins/gmail-crm/contact-index.json");
            if cache_path.exists() {
                let is_open = vault.get("open").and_then(Value::as_bool).unwrap_or(false);
                let ts = vault.get("ts").and_then(Value::as_i64).unwrap_or(0);
                candidates.push((is_open, ts, cache_path));
            }
        }
    }

    candidates.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| b.1.cmp(&a.1)));
    candidates.into_iter().map(|(_, _, path)| path).next()
}

fn obsidian_config_path() -> Option<PathBuf> {
    env::var_os("HOME")
        .map(PathBuf::from)
        .map(|home| home.join("Library/Application Support/obsidian/obsidian.json"))
}

fn command_name(command: &Commands) -> &'static str {
    match command {
        Commands::FindPerson(_) => "find-person",
        Commands::Score(_) => "score",
        Commands::WhoKnows(_) => "who-knows",
        Commands::GetNeighbors(_) => "get-neighbors",
        Commands::GetEdges(_) => "get-edges",
        Commands::SuggestDuplicates(_) => "suggest-duplicates",
        Commands::MergeQueue(_) => "merge-queue",
        Commands::ApplyMerge(_) => "apply-merge",
        Commands::DismissMerge(_) => "dismiss-merge",
        Commands::ProposeMerge(_) => "propose-merge",
        Commands::Describe => "describe",
        Commands::Version => "version",
        Commands::Serve(_) => "serve",
    }
}

fn describe_payload() -> Value {
    json!({
        "name": "peoplegraph",
        "version": COMMAND_VERSION,
        "summary": "Graph primitive CLI and explicit merge-review writer over Obsidian Gmail CRM contact-index.json",
        "global_flags": [
            "--format json|jsonl",
            "--cache <path>",
            "--host <url>",
            "--token <value>",
            "--quiet"
        ],
        "commands": [
            {
                "name": "find-person",
                "usage": "peoplegraph find-person <query>",
                "status": "implemented"
            },
            {
                "name": "score",
                "usage": "peoplegraph score <email>",
                "status": "implemented"
            },
            {
                "name": "who-knows",
                "usage": "peoplegraph who-knows --company <name>",
                "status": "implemented"
            },
            {
                "name": "get-neighbors",
                "usage": "peoplegraph get-neighbors <email>",
                "status": "implemented"
            },
            {
                "name": "get-edges",
                "usage": "peoplegraph get-edges --from <email> --to <email>",
                "status": "implemented"
            },
            {
                "name": "suggest-duplicates",
                "usage": "peoplegraph suggest-duplicates --limit 25 --min-confidence 0.82",
                "status": "implemented"
            },
            {
                "name": "merge-queue",
                "usage": "peoplegraph merge-queue --status pending --limit 25",
                "status": "implemented"
            },
            {
                "name": "apply-merge",
                "usage": "peoplegraph apply-merge <a> <b>",
                "status": "implemented_local_cache_write"
            },
            {
                "name": "dismiss-merge",
                "usage": "peoplegraph dismiss-merge <a> <b> --reason not_duplicate",
                "status": "implemented_local_queue"
            },
            {
                "name": "propose-merge",
                "usage": "peoplegraph propose-merge <a> <b>",
                "status": "implemented_local_queue"
            },
            {
                "name": "describe",
                "usage": "peoplegraph describe",
                "status": "implemented"
            },
            {
                "name": "version",
                "usage": "peoplegraph version",
                "status": "implemented"
            },
            {
                "name": "serve",
                "usage": "PEOPLEGRAPH_TOKEN=<token> peoplegraph --cache /path/to/contact-index.json serve --bind 127.0.0.1:8787",
                "status": "implemented_read_only_http"
            }
        ],
        "remote_query_contract": {
            "server": "peoplegraph --cache /path/to/contact-index.json serve --bind 127.0.0.1:8787",
            "client": "peoplegraph --host http://127.0.0.1:8787 --token <token> who-knows --company Disney",
            "auth": "Bearer token from --token or PEOPLEGRAPH_TOKEN",
            "read_only_commands": [
                "describe",
                "version",
                "find-person",
                "score",
                "who-knows",
                "get-neighbors",
                "get-edges",
                "suggest-duplicates",
                "merge-queue"
            ],
            "local_only_write_commands": [
                "propose-merge",
                "dismiss-merge",
                "apply-merge"
            ]
        },
        "output_contract": {
            "ok": "boolean",
            "command": "string",
            "data": "command-specific object on success",
            "stats": "matched/returned/ms metadata",
            "error": "kind/message on failure"
        }
    })
}

fn ok(command: impl Into<String>, data: Value, stats: Value) -> Response {
    Response {
        ok: true,
        command: command.into(),
        data: Some(data),
        stats: Some(stats),
        error: None,
    }
}

fn fail(
    command: impl Into<String>,
    kind: impl Into<String>,
    message: String,
    start: Instant,
) -> Response {
    Response {
        ok: false,
        command: command.into(),
        data: None,
        stats: Some(json!({ "ms": elapsed_ms(start) })),
        error: Some(ApiError {
            kind: kind.into(),
            message,
        }),
    }
}

fn elapsed_ms(start: Instant) -> u128 {
    start.elapsed().as_millis()
}

fn print_response(response: &Response, format: &OutputFormat) -> Result<(), serde_json::Error> {
    match format {
        OutputFormat::Json => {
            println!("{}", serde_json::to_string_pretty(response)?);
        }
        OutputFormat::Jsonl => {
            println!("{}", serde_json::to_string(response)?);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_iso_date_to_unix_days() {
        assert_eq!(date_days("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(date_days("1970-01-02"), Some(1));
    }

    #[test]
    fn formats_unix_seconds_as_utc_iso() {
        assert_eq!(unix_to_utc_iso(0), "1970-01-01T00:00:00Z");
        assert_eq!(unix_to_utc_iso(1_778_864_760), "2026-05-15T17:06:00Z");
    }

    #[test]
    fn exact_alias_match_is_confident() {
        let row = ContactRow {
            email: "kaya@example.com".to_string(),
            contact: Contact {
                name: "Kaya Jones".to_string(),
                email: "kaya@example.com".to_string(),
                aliases: vec!["kayajones901@gmail.com".to_string()],
                ..empty_contact()
            },
        };

        assert_eq!(
            match_confidence(
                &row,
                &normalize("kayajones901@gmail.com"),
                "kayajones901@gmail.com"
            ),
            1.0
        );
    }

    #[test]
    fn exact_email_lookup_beats_alias_lookup() {
        let mut contacts = HashMap::new();
        contacts.insert(
            "primary@example.com".to_string(),
            Contact {
                name: "Primary".to_string(),
                email: "primary@example.com".to_string(),
                aliases: vec!["alias@example.com".to_string()],
                ..empty_contact()
            },
        );
        contacts.insert(
            "alias@example.com".to_string(),
            Contact {
                name: "Alias".to_string(),
                email: "alias@example.com".to_string(),
                aliases: vec!["primary@example.com".to_string()],
                ..empty_contact()
            },
        );
        let index = ContactIndex {
            schema_version: Some(1),
            last_sync: None,
            user_email: None,
            contacts,
            edges: vec![],
        };

        let row = find_by_email_or_alias(&index, "primary@example.com").unwrap();
        assert_eq!(row.contact.name, "Primary");
    }

    #[test]
    fn exact_contact_key_beats_alias_match() {
        let mut contacts = HashMap::new();
        contacts.insert(
            "primary@example.com".to_string(),
            Contact {
                name: "Primary".to_string(),
                email: "primary@example.com".to_string(),
                aliases: vec!["alias@example.com".to_string()],
                ..empty_contact()
            },
        );
        contacts.insert(
            "alias@example.com".to_string(),
            Contact {
                name: "Alias".to_string(),
                email: "alias@example.com".to_string(),
                aliases: vec!["primary@example.com".to_string()],
                ..empty_contact()
            },
        );
        let index = ContactIndex {
            schema_version: Some(1),
            last_sync: None,
            user_email: None,
            contacts,
            edges: vec![],
        };

        assert_eq!(
            contact_key_for_email(&index, "primary@example.com"),
            Some("primary@example.com".to_string())
        );
        assert_eq!(
            contact_key_for_email(&index, "alias@example.com"),
            Some("alias@example.com".to_string())
        );
    }

    #[test]
    fn company_match_uses_domain() {
        let contact = Contact {
            domain: "disney.com".to_string(),
            ..empty_contact()
        };
        assert!(company_matches(&contact, &normalize_company("Disney")));
    }

    #[test]
    fn display_company_falls_back_to_domain() {
        let contact = Contact {
            domain: "betaworks.com".to_string(),
            ..empty_contact()
        };

        assert_eq!(display_company(&contact), Some("Betaworks".to_string()));
    }

    #[test]
    fn display_company_ignores_generic_email_domain() {
        let contact = Contact {
            domain: "gmail.com".to_string(),
            ..empty_contact()
        };

        assert_eq!(display_company(&contact), None);
    }

    #[test]
    fn duplicate_confidence_detects_contact_fragment() {
        let primary = ContactRow {
            email: "fundaccounting@betaworks.com".to_string(),
            contact: Contact {
                name: "Fund Accounting".to_string(),
                email: "fundaccounting@betaworks.com".to_string(),
                domain: "betaworks.com".to_string(),
                total_exchanges: 3,
                ..empty_contact()
            },
        };
        let fragment = ContactRow {
            email: "g@betaworks.com".to_string(),
            contact: Contact {
                name: "fundaccountin".to_string(),
                email: "g@betaworks.com".to_string(),
                domain: "betaworks.com".to_string(),
                total_exchanges: 1,
                ..empty_contact()
            },
        };

        let (confidence, reasons) = duplicate_confidence(&primary, &fragment).unwrap();
        assert!(confidence >= 0.82);
        assert!(reasons.contains(&"similar_name_same_domain".to_string()));
    }

    #[test]
    fn duplicate_primary_prefers_non_fragment() {
        let primary = ContactRow {
            email: "john@betaworks.com".to_string(),
            contact: Contact {
                name: "John Borthwick".to_string(),
                email: "john@betaworks.com".to_string(),
                domain: "betaworks.com".to_string(),
                total_exchanges: 471,
                ..empty_contact()
            },
        };
        let fragment = ContactRow {
            email: "n@betaworks.com".to_string(),
            contact: Contact {
                name: "joh".to_string(),
                email: "n@betaworks.com".to_string(),
                domain: "betaworks.com".to_string(),
                total_exchanges: 1,
                ..empty_contact()
            },
        };

        let (chosen, duplicate) = primary_duplicate(&fragment, &primary);
        assert_eq!(chosen.email, "john@betaworks.com");
        assert_eq!(duplicate.email, "n@betaworks.com");
    }

    #[test]
    fn duplicate_scanner_skips_service_account_pairs_by_default() {
        let left = ContactRow {
            email: "discover@airbnb.com".to_string(),
            contact: Contact {
                name: "Airbnb".to_string(),
                email: "discover@airbnb.com".to_string(),
                domain: "airbnb.com".to_string(),
                total_exchanges: 7,
                ..empty_contact()
            },
        };
        let right = ContactRow {
            email: "express@airbnb.com".to_string(),
            contact: Contact {
                name: "Airbnb".to_string(),
                email: "express@airbnb.com".to_string(),
                domain: "airbnb.com".to_string(),
                total_exchanges: 57,
                ..empty_contact()
            },
        };

        assert!(skip_default_duplicate_candidate(&left, &right));
    }

    #[test]
    fn merge_queue_path_lives_next_to_cache() {
        let path = Path::new("/tmp/vault/.obsidian/plugins/gmail-crm/contact-index.json");
        assert_eq!(
            merge_queue_path(path),
            PathBuf::from("/tmp/vault/.obsidian/plugins/gmail-crm/merge-queue.json")
        );
    }

    #[test]
    fn queue_pair_status_matches_reversed_pairs() {
        let queue = MergeQueue {
            schema_version: 1,
            updated_at_unix: 0,
            candidates: vec![MergeCandidate {
                a_email: "a@example.com".to_string(),
                a_name: "A".to_string(),
                b_email: "b@example.com".to_string(),
                b_name: "B".to_string(),
                status: "dismissed".to_string(),
                proposed_at_unix: 0,
                source: "peoplegraph".to_string(),
                dismissed_at_unix: Some(1),
                dismiss_reason: Some("not_duplicate".to_string()),
            }],
        };

        assert_eq!(
            queue_pair_status(&queue, "b@example.com", "a@example.com"),
            Some("dismissed")
        );
    }

    #[test]
    fn merge_aliases_includes_both_emails() {
        let mut contacts = HashMap::new();
        contacts.insert(
            "harper@2389.ai".to_string(),
            Contact {
                name: "Harper Reed".to_string(),
                email: "harper@2389.ai".to_string(),
                aliases: vec!["old@2389.ai".to_string()],
                ..empty_contact()
            },
        );
        contacts.insert(
            "harper@nata2.org".to_string(),
            Contact {
                name: "Harper Reed".to_string(),
                email: "harper@nata2.org".to_string(),
                ..empty_contact()
            },
        );
        let index = ContactIndex {
            schema_version: Some(1),
            last_sync: None,
            user_email: None,
            contacts,
            edges: vec![],
        };

        assert_eq!(
            merge_aliases(&index, "harper@2389.ai", "harper@nata2.org"),
            vec![
                "harper@2389.ai".to_string(),
                "harper@nata2.org".to_string(),
                "old@2389.ai".to_string()
            ]
        );
    }

    #[test]
    fn canonical_id_defaults_to_local_primary_email() {
        let mut contacts = HashMap::new();
        contacts.insert(
            "a@example.com".to_string(),
            Contact {
                email: "a@example.com".to_string(),
                ..empty_contact()
            },
        );
        contacts.insert(
            "b@example.com".to_string(),
            Contact {
                email: "b@example.com".to_string(),
                ..empty_contact()
            },
        );
        let index = ContactIndex {
            schema_version: Some(1),
            last_sync: None,
            user_email: None,
            contacts,
            edges: vec![],
        };

        assert_eq!(
            canonical_id_for_merge(&index, "a@example.com", "b@example.com"),
            "local:a@example.com"
        );
    }

    #[test]
    fn remote_path_encodes_query_values() {
        let command = Commands::WhoKnows(WhoKnowsArgs {
            company: "Disney Parks & Resorts".to_string(),
            limit: 5,
        });

        assert_eq!(
            remote_path(&command),
            Some("/who-knows?company=Disney%20Parks%20%26%20Resorts&limit=5".to_string())
        );
    }

    #[test]
    fn parse_query_decodes_percent_and_plus_values() {
        let params = parse_query("company=Disney+Parks%20%26%20Resorts&limit=5");

        assert_eq!(
            query_param(&params, "company"),
            "Disney Parks & Resorts".to_string()
        );
        assert_eq!(query_usize(&params, "limit", 25), 5);
    }

    #[test]
    fn parse_http_request_normalizes_headers() {
        let request = "GET /who-knows?company=Disney HTTP/1.1\r\nAuthorization: Bearer token\r\nHost: localhost\r\n\r\n";
        let (path, headers) = parse_http_request(request).unwrap();

        assert_eq!(path, "/who-knows?company=Disney");
        assert_eq!(
            headers.get("authorization"),
            Some(&"Bearer token".to_string())
        );
    }

    fn empty_contact() -> Contact {
        Contact {
            name: String::new(),
            email: String::new(),
            last_contact: None,
            first_contact: None,
            sent_count: 0,
            received_count: 0,
            total_exchanges: 0,
            subjects: vec![],
            last_subject: String::new(),
            domain: String::new(),
            thread_count: None,
            max_thread_depth: None,
            back_and_forth_threads: None,
            rsvp_only_threads: None,
            last_thread_depth: None,
            canonical_id: None,
            aliases: vec![],
            last_canonical_sync: None,
            role: None,
            company: None,
            score: None,
            relationship_depth: None,
            relationship_recency: None,
            combined_score: None,
            quadrant: None,
        }
    }
}
