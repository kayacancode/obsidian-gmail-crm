//! Owner-private life signals, catch-up briefs, owner timeline and company stints (hosted only).
use crate::{Commands, Response, fail, hosted, people_client, url_encode};
use clap::{Args, Subcommand};
use serde_json::{Value, json};
use std::time::Instant;

#[derive(Args, Debug, Clone)]
pub(crate) struct SignalsArgs {
    /// Hosted People origin; alternatively set PEOPLEGRAPH_WEB_URL.
    #[arg(long, global = true)]
    url: Option<String>,
    #[command(subcommand)]
    command: SignalsCommand,
}

#[derive(Subcommand, Debug, Clone)]
enum SignalsCommand {
    /// List unexpired first-hand life signals, optionally for one person ID.
    List {
        #[arg(long)]
        person: Option<String>,
    },
    /// Start extracting life signals from opted-in mail, meeting notes and your own notes.
    On,
    /// Stop extracting life signals. Stored signals stay until forgotten or expired.
    Off,
    /// Delete one signal, every signal about one person, or all of them.
    Forget {
        #[arg(conflicts_with_all = ["person", "all"], required_unless_present_any = ["person", "all"])]
        id: Option<String>,
        #[arg(long, conflicts_with = "all")]
        person: Option<String>,
        #[arg(long)]
        all: bool,
    },
}

#[derive(Args, Debug, Clone)]
pub(crate) struct BriefArgs {
    #[arg(long)]
    url: Option<String>,
    /// Recorded email, exact name, or person ID.
    person: String,
}

#[derive(Args, Debug, Clone)]
pub(crate) struct MeArgs {
    #[arg(long, global = true)]
    url: Option<String>,
    #[command(subcommand)]
    command: MeCommand,
}

#[derive(Subcommand, Debug, Clone)]
enum MeCommand {
    /// Add an entry to your own timeline (only on your explicit request).
    Add {
        text: String,
        #[arg(long)]
        category: Option<String>,
        /// YYYY-MM-DD; defaults to today.
        #[arg(long)]
        date: Option<String>,
    },
    List,
    Forget {
        id: String,
    },
}

#[derive(Args, Debug, Clone)]
pub(crate) struct StintsArgs {
    #[arg(long, global = true)]
    url: Option<String>,
    #[command(subcommand)]
    command: StintsCommand,
}

#[derive(Subcommand, Debug, Clone)]
enum StintsCommand {
    /// Company history for one person ID.
    Show {
        person: String,
    },
    /// Correct a person's company history; owner edits win over email history.
    Set {
        person: String,
        #[arg(long)]
        company: String,
        /// YYYY-MM
        #[arg(long)]
        from: String,
        /// YYYY-MM; omit for a current role.
        #[arg(long)]
        to: Option<String>,
    },
    Forget {
        id: String,
    },
}

#[derive(Args, Debug, Clone)]
pub(crate) struct JobMovesArgs {
    #[arg(long)]
    url: Option<String>,
}

#[derive(Args, Debug, Clone)]
pub(crate) struct TeammatesArgs {
    #[arg(long)]
    url: Option<String>,
    /// Person ID.
    person: String,
}

/// Person IDs are opaque base64url hashes; anything with a space, `@` or shorter is a name.
fn looks_like_person_id(value: &str) -> bool {
    value.len() >= 20
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b':'))
}

fn request(
    command: &'static str,
    url: Option<&str>,
    method: &str,
    path: String,
    body: Option<Value>,
    start: Instant,
) -> Response {
    match people_client::configure(url) {
        Ok(client) => hosted::machine(&client, command, method, &path, body, start),
        Err((kind, message)) => fail(command, kind, message.into(), start),
    }
}

pub(crate) fn run(command: &Commands, start: Instant) -> Response {
    match command {
        Commands::Signals(args) => {
            let url = args.url.as_deref();
            match &args.command {
                SignalsCommand::List { person } => request(
                    "signals",
                    url,
                    "GET",
                    match person {
                        Some(id) => format!("/api/people/signals?personId={}", url_encode(id)),
                        None => "/api/people/signals".into(),
                    },
                    None,
                    start,
                ),
                SignalsCommand::On | SignalsCommand::Off => request(
                    "signals",
                    url,
                    "POST",
                    "/api/people/signals/settings".into(),
                    Some(json!({"enabled":matches!(args.command,SignalsCommand::On)})),
                    start,
                ),
                SignalsCommand::Forget { id, person, all } => request(
                    "signals",
                    url,
                    "DELETE",
                    "/api/people/signals".into(),
                    Some(match (id, person) {
                        (Some(id), _) => json!({"id":id}),
                        (_, Some(person)) => json!({"personId":person}),
                        _ => json!({"all":all}),
                    }),
                    start,
                ),
            }
        }
        Commands::Brief(args) => {
            let value = args.person.trim();
            let key = if value.contains('@') {
                "email"
            } else if looks_like_person_id(value) {
                "personId"
            } else {
                "query"
            };
            request(
                "brief",
                args.url.as_deref(),
                "GET",
                format!("/api/people/brief?{key}={}", url_encode(value)),
                None,
                start,
            )
        }
        Commands::Me(args) => {
            let url = args.url.as_deref();
            match &args.command {
                MeCommand::Add {
                    text,
                    category,
                    date,
                } => {
                    let mut body = json!({"text":text});
                    if let Some(category) = category {
                        body["category"] = json!(category);
                    }
                    if let Some(date) = date {
                        body["date"] = json!(date);
                    }
                    request(
                        "me",
                        url,
                        "POST",
                        "/api/people/timeline".into(),
                        Some(body),
                        start,
                    )
                }
                MeCommand::List => {
                    request("me", url, "GET", "/api/people/timeline".into(), None, start)
                }
                MeCommand::Forget { id } => request(
                    "me",
                    url,
                    "DELETE",
                    "/api/people/timeline".into(),
                    Some(json!({"id":id})),
                    start,
                ),
            }
        }
        Commands::Stints(args) => {
            let url = args.url.as_deref();
            match &args.command {
                StintsCommand::Show { person } => request(
                    "stints",
                    url,
                    "GET",
                    format!("/api/people/stints?personId={}", url_encode(person)),
                    None,
                    start,
                ),
                StintsCommand::Set {
                    person,
                    company,
                    from,
                    to,
                } => request(
                    "stints",
                    url,
                    "POST",
                    "/api/people/stints".into(),
                    Some(json!({"personId":person,"company":company,"from":from,"to":to})),
                    start,
                ),
                StintsCommand::Forget { id } => request(
                    "stints",
                    url,
                    "DELETE",
                    "/api/people/stints".into(),
                    Some(json!({"id":id})),
                    start,
                ),
            }
        }
        Commands::JobMoves(args) => request(
            "job-moves",
            args.url.as_deref(),
            "GET",
            "/api/people/job-moves".into(),
            None,
            start,
        ),
        Commands::Teammates(args) => request(
            "teammates",
            args.url.as_deref(),
            "GET",
            format!(
                "/api/people/teammates?personId={}",
                url_encode(&args.person)
            ),
            None,
            start,
        ),
        _ => unreachable!("life::run handles life commands only"),
    }
}
