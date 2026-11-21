//! Three-party introductions (hosted only). People records the steps the owner reports and never
//! sends anything; the owner's agent drafts the messages.
use crate::{Commands, Response, fail, hosted, people_client};
use clap::{Args, Subcommand, ValueEnum};
use serde_json::{Value, json};
use std::time::Instant;

#[derive(Args, Debug, Clone)]
pub(crate) struct IntrosArgs {
    #[arg(long, global = true)]
    url: Option<String>,
    #[command(subcommand)]
    command: IntrosCommand,
}

#[derive(Clone, Copy, Debug, ValueEnum)]
#[value(rename_all = "snake_case")]
enum Step {
    AskedIntroducer,
    IntroducerAccepted,
    TargetOptedIn,
    Made,
    Declined,
}

#[derive(Clone, Copy, Debug, ValueEnum)]
#[value(rename_all = "snake_case")]
enum Outcome {
    Met,
    NotMet,
}

#[derive(Subcommand, Debug, Clone)]
enum IntrosCommand {
    /// Your introductions, including shared-workspace requests (read-only).
    List,
    /// One introduction.
    Show { id: String },
    /// Propose one introduction (at most five a day, five open asks per introducer).
    Propose {
        /// `owner` (you introduce) or the introducer's person ID.
        #[arg(long, default_value = "owner")]
        introducer: String,
        /// Two person IDs, or `owner` and a person ID, comma-separated.
        #[arg(long, value_delimiter = ',', required = true)]
        parties: Vec<String>,
        #[arg(long)]
        reason: String,
    },
    /// Record the next step: asked_introducer, introducer_accepted, target_opted_in, made, declined.
    Advance {
        id: String,
        to: Step,
        /// Your vouch, when you are the introducer; only you see it.
        #[arg(long)]
        vouch: Option<String>,
    },
    /// After an introduction was made: did they meet?
    Outcome {
        id: String,
        result: Outcome,
        #[arg(long)]
        note: Option<String>,
    },
}

fn machine(
    url: Option<&str>,
    method: &str,
    path: &str,
    body: Option<Value>,
    start: Instant,
) -> Response {
    match people_client::configure(url) {
        Ok(client) => hosted::machine(&client, "intros", method, path, body, start),
        Err((kind, message)) => fail("intros", kind, message.into(), start),
    }
}

fn name<T: ValueEnum>(value: T) -> String {
    value
        .to_possible_value()
        .map(|v| v.get_name().to_owned())
        .unwrap_or_default()
}

pub(crate) fn run(command: &Commands, start: Instant) -> Response {
    let Commands::Intros(args) = command else {
        unreachable!("intros::run handles intros only")
    };
    let url = args.url.as_deref();
    match &args.command {
        IntrosCommand::List => machine(url, "GET", "/api/people/introductions", None, start),
        IntrosCommand::Show { id } => {
            let mut response = machine(url, "GET", "/api/people/introductions", None, start);
            if !response.ok {
                return response;
            }
            let found = response.data.as_ref().and_then(|data| {
                data["introductions"]
                    .as_array()?
                    .iter()
                    .find(|i| i["id"] == id.as_str())
                    .cloned()
            });
            match found {
                Some(introduction) => {
                    response.data = Some(json!({"introduction":introduction}));
                    response
                }
                None => fail(
                    "intros",
                    "not_found",
                    "No introduction has that id.".into(),
                    start,
                ),
            }
        }
        IntrosCommand::Propose {
            introducer,
            parties,
            reason,
        } => {
            if parties.len() != 2 {
                return fail(
                    "intros",
                    "invalid_request",
                    "Give exactly two parties, comma-separated.".into(),
                    start,
                );
            }
            machine(
                url,
                "POST",
                "/api/people/introductions",
                Some(json!({"introducer":introducer,"parties":parties,"reason":reason})),
                start,
            )
        }
        IntrosCommand::Advance { id, to, vouch } => {
            let mut body = json!({"id":id,"to":name(*to)});
            if let Some(vouch) = vouch {
                body["vouch"] = json!(vouch);
            }
            machine(
                url,
                "POST",
                "/api/people/introductions/advance",
                Some(body),
                start,
            )
        }
        IntrosCommand::Outcome { id, result, note } => {
            let mut body = json!({"id":id,"result":name(*result)});
            if let Some(note) = note {
                body["note"] = json!(note);
            }
            machine(
                url,
                "POST",
                "/api/people/introductions/outcome",
                Some(body),
                start,
            )
        }
    }
}
