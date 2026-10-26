//! Read the same saved Lens and relationship evidence as the People website.
use crate::{Commands, Response, command_name, fail, people_client};
use clap::Args;
use serde_json::{Value, json};
use std::time::Instant;

#[derive(Args, Debug, Clone)]
pub(crate) struct WebArgs {
    /// Hosted People origin; alternatively set PEOPLEGRAPH_WEB_URL. Requires PEOPLEGRAPH_WEB_TOKEN.
    #[arg(long)]
    pub url: Option<String>,
}

#[derive(Args, Debug, Clone)]
pub(crate) struct SearchArgs {
    /// Search your People account using 1–200 characters.
    pub query: String,
    /// Maximum people returned (1–50; service default 20).
    #[arg(long, value_parser = clap::value_parser!(u8).range(1..=50))]
    pub limit: Option<u8>,
    #[command(flatten)]
    pub web: WebArgs,
}

#[derive(Args, Debug, Clone)]
pub(crate) struct ConnectionArgs {
    /// Exact person ID or email. Resolve names with search first.
    #[arg(long)]
    pub from: String,
    /// Exact person ID or email. Resolve names with search first.
    #[arg(long)]
    pub to: String,
    #[command(flatten)]
    pub web: WebArgs,
}

#[derive(Args, Debug, Clone)]
pub(crate) struct HelpersArgs {
    /// Exact person ID whose saved context should guide helper matching.
    #[arg(long)]
    pub person_id: String,
    #[command(flatten)]
    pub web: WebArgs,
}

pub(crate) fn run(command: &Commands, start: Instant) -> Response {
    let name = command_name(command);
    let (web, path, payload) = match command {
        Commands::Lens(web) => (web, "/api/people-agent/lens", None),
        Commands::Matches(web) => (web, "/api/people-agent/matches", Some(json!({}))),
        Commands::Search(args) => {
            if args.query.trim().is_empty() || args.query.trim().encode_utf16().count() > 200 {
                return fail(
                    name,
                    "invalid_request",
                    "Provide a search query of 1–200 characters.".into(),
                    start,
                );
            }
            let mut payload = json!({"query":args.query});
            if let Some(limit) = args.limit {
                payload["limit"] = Value::from(limit);
            }
            (&args.web, "/api/people-agent/search", Some(payload))
        }
        Commands::Connection(args) => {
            if args.from.trim().is_empty() || args.to.trim().is_empty() {
                return fail(
                    name,
                    "invalid_request",
                    "Provide exact non-empty person IDs or emails for --from and --to.".into(),
                    start,
                );
            }
            (
                &args.web,
                "/api/people-agent/connection",
                Some(json!({"from":args.from,"to":args.to})),
            )
        }
        Commands::Helpers(args) => {
            if args.person_id.trim().is_empty() {
                return fail(
                    name,
                    "invalid_request",
                    "Provide an exact non-empty --person-id.".into(),
                    start,
                );
            }
            (
                &args.web,
                "/api/people-agent/helpers",
                Some(json!({"personId":args.person_id})),
            )
        }
        _ => unreachable!("private agent command dispatch"),
    };
    people_client::request(name, web.url.as_deref(), path, payload, start)
}
