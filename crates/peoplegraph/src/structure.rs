//! Owner-only answers about the shape of the network (hosted only): why-now, contrast, widen,
//! bridges and the topic atlas.
use crate::{Commands, Response, fail, hosted, people_client, url_encode};
use clap::Args;
use std::time::Instant;

#[derive(Args, Debug, Clone)]
pub(crate) struct WhyNowArgs {
    #[arg(long)]
    url: Option<String>,
    /// At most this many people (1-25).
    #[arg(long, default_value_t = 10)]
    limit: u8,
}

#[derive(Args, Debug, Clone)]
pub(crate) struct ContrastArgs {
    #[arg(long)]
    url: Option<String>,
    /// The topic to find outside perspectives on.
    topic: String,
    /// An assumption to test: people whose evidence challenges it rank higher.
    #[arg(long)]
    claim: Option<String>,
}

#[derive(Args, Debug, Clone)]
pub(crate) struct WidenArgs {
    #[arg(long)]
    url: Option<String>,
}

#[derive(Args, Debug, Clone)]
pub(crate) struct BridgesArgs {
    #[arg(long)]
    url: Option<String>,
    /// Only pairs who both have evidence about this topic.
    #[arg(long)]
    topic: Option<String>,
}

#[derive(Args, Debug, Clone)]
pub(crate) struct AtlasArgs {
    #[arg(long)]
    url: Option<String>,
    /// The topic to map.
    topic: String,
}

fn get(command: &'static str, url: Option<&str>, path: String, start: Instant) -> Response {
    match people_client::configure(url) {
        Ok(client) => hosted::machine(&client, command, "GET", &path, None, start),
        Err((kind, message)) => fail(command, kind, message.into(), start),
    }
}

pub(crate) fn run(command: &Commands, start: Instant) -> Response {
    match command {
        Commands::WhyNow(args) => get(
            "why-now",
            args.url.as_deref(),
            format!("/api/people/why-now?limit={}", args.limit),
            start,
        ),
        Commands::Contrast(args) => {
            let mut path = format!("/api/people/contrast?topic={}", url_encode(&args.topic));
            if let Some(claim) = &args.claim {
                path.push_str(&format!("&claim={}", url_encode(claim)));
            }
            get("contrast", args.url.as_deref(), path, start)
        }
        Commands::Widen(args) => get(
            "widen",
            args.url.as_deref(),
            "/api/people/widen".into(),
            start,
        ),
        Commands::Bridges(args) => {
            let path = match &args.topic {
                Some(topic) => format!("/api/people/bridges?topic={}", url_encode(topic)),
                None => "/api/people/bridges".into(),
            };
            get("bridges", args.url.as_deref(), path, start)
        }
        Commands::Atlas(args) => get(
            "atlas",
            args.url.as_deref(),
            format!("/api/people/atlas?topic={}", url_encode(&args.topic)),
            start,
        ),
        _ => unreachable!("structure::run handles structure commands only"),
    }
}
