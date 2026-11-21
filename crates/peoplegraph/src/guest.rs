//! Guest ask, owner side (hosted only). Outsiders ask the owner's network a question; nothing
//! reaches them until the owner answers here. Answers describe people and never name them.
use crate::{Commands, Response, fail, hosted, people_client};
use clap::{Args, Subcommand};
use serde_json::{Value, json};
use std::io::Read;
use std::time::Instant;

const MAX_ANSWER_BYTES: u64 = 16_000;

#[derive(Args, Debug, Clone)]
pub(crate) struct GuestArgs {
    #[arg(long, global = true)]
    url: Option<String>,
    #[command(subcommand)]
    command: GuestCommand,
}

#[derive(Subcommand, Debug, Clone)]
enum GuestCommand {
    /// Guest questions with their drafts (owner-only), newest first.
    Pending,
    /// One guest question by id.
    Show { id: String },
    /// Approve the draft as it is, or an edited answer from a JSON file (`{text, people:[{ref, description}]}`).
    Answer {
        id: String,
        /// A JSON answer file, or - for standard input.
        #[arg(long)]
        file: Option<String>,
    },
    /// Decline one guest question.
    Decline { id: String },
    /// Turn guest ask on.
    On,
    /// Turn guest ask off.
    Off,
}

fn machine(
    url: Option<&str>,
    method: &str,
    path: &str,
    body: Option<Value>,
    start: Instant,
) -> Response {
    match people_client::configure(url) {
        Ok(client) => hosted::machine(&client, "guest", method, path, body, start),
        Err((kind, message)) => fail("guest", kind, message.into(), start),
    }
}

fn read_answer(file: &str) -> Result<Value, String> {
    let mut text = String::new();
    let read = if file == "-" {
        std::io::stdin()
            .take(MAX_ANSWER_BYTES)
            .read_to_string(&mut text)
    } else {
        std::fs::File::open(file).and_then(|f| f.take(MAX_ANSWER_BYTES).read_to_string(&mut text))
    };
    read.map_err(|_| "Cannot read the answer file as UTF-8 text.".to_owned())?;
    serde_json::from_str(&text).map_err(|_| "The answer file is not valid JSON.".to_owned())
}

pub(crate) fn run(command: &Commands, start: Instant) -> Response {
    let Commands::Guest(args) = command else {
        unreachable!("guest::run handles guest only")
    };
    let url = args.url.as_deref();
    match &args.command {
        GuestCommand::Pending => machine(url, "GET", "/api/people/guest-asks", None, start),
        GuestCommand::Show { id } => {
            let mut response = machine(url, "GET", "/api/people/guest-asks", None, start);
            if !response.ok {
                return response;
            }
            let found = response.data.as_ref().and_then(|data| {
                data["asks"]
                    .as_array()?
                    .iter()
                    .find(|a| a["id"] == id.as_str())
                    .cloned()
            });
            match found {
                Some(ask) => {
                    response.data = Some(json!({"ask":ask}));
                    response
                }
                None => fail(
                    "guest",
                    "not_found",
                    "No guest question has that id.".into(),
                    start,
                ),
            }
        }
        GuestCommand::Answer { id, file } => {
            let mut body = json!({"id":id});
            if let Some(file) = file {
                match read_answer(file) {
                    Ok(answer) => body["answer"] = answer,
                    Err(message) => return fail("guest", "invalid_request", message, start),
                }
            }
            machine(
                url,
                "POST",
                "/api/people/guest-asks/answer",
                Some(body),
                start,
            )
        }
        GuestCommand::Decline { id } => machine(
            url,
            "POST",
            "/api/people/guest-asks/decline",
            Some(json!({"id":id})),
            start,
        ),
        GuestCommand::On | GuestCommand::Off => machine(
            url,
            "POST",
            "/api/people/guest-asks/settings",
            Some(json!({"enabled":matches!(args.command, GuestCommand::On)})),
            start,
        ),
    }
}
