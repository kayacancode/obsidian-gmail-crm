//! Curiosity notes and daily moments (hosted only). Notes are private; moments are a few
//! evidenced reasons a day to reach out, and acting on them is the only success measure.
use crate::{Commands, Response, fail, hosted, people_client};
use clap::{Args, Subcommand};
use serde_json::{Value, json};
use std::io::Read;
use std::time::Instant;

#[derive(Args, Debug, Clone)]
pub(crate) struct MindArgs {
    #[arg(long, global = true)]
    url: Option<String>,
    #[command(subcommand)]
    command: MindCommand,
}

#[derive(Subcommand, Debug, Clone)]
enum MindCommand {
    /// Save a curiosity note (markdown with the four headings); --id replaces an active note.
    Set {
        /// A markdown file, or - for standard input.
        #[arg(long)]
        file: String,
        #[arg(long)]
        id: Option<String>,
    },
    /// Show one note.
    Show { id: String },
    /// List active notes (--archived includes archived ones).
    List {
        #[arg(long)]
        archived: bool,
    },
    /// Archive a note so it stops shaping moments.
    Archive { id: String },
}

#[derive(Args, Debug, Clone)]
pub(crate) struct MomentsArgs {
    #[arg(long, global = true)]
    url: Option<String>,
    /// Only today's moments.
    #[arg(long)]
    today: bool,
    #[command(subcommand)]
    command: Option<MomentsCommand>,
}

#[derive(Subcommand, Debug, Clone)]
enum MomentsCommand {
    /// The owner acted on this moment (reached out, or will).
    Act { id: String },
    /// Show it again in three days.
    Snooze { id: String },
    /// Not this kind of moment for these people for 30 days.
    Dismiss { id: String },
    /// New moments per day, 1-10 (default 3).
    Budget { budget: u8 },
}

const MAX_NOTE_BYTES: u64 = 16_384;

fn machine(
    command: &'static str,
    url: Option<&str>,
    method: &str,
    path: &str,
    body: Option<Value>,
    start: Instant,
) -> Response {
    match people_client::configure(url) {
        Ok(client) => hosted::machine(&client, command, method, path, body, start),
        Err((kind, message)) => fail(command, kind, message.into(), start),
    }
}

fn read_note(file: &str) -> Result<String, String> {
    let mut text = String::new();
    let read = if file == "-" {
        std::io::stdin()
            .take(MAX_NOTE_BYTES)
            .read_to_string(&mut text)
    } else {
        std::fs::File::open(file).and_then(|f| f.take(MAX_NOTE_BYTES).read_to_string(&mut text))
    };
    read.map(|_| text)
        .map_err(|_| "Cannot read the note file as UTF-8 text.".to_owned())
}

pub(crate) fn run(command: &Commands, start: Instant) -> Response {
    match command {
        Commands::Mind(args) => {
            let url = args.url.as_deref();
            match &args.command {
                MindCommand::Set { file, id } => {
                    let text = match read_note(file) {
                        Ok(text) => text,
                        Err(message) => return fail("mind", "invalid_request", message, start),
                    };
                    let mut body = json!({"text":text});
                    if let Some(id) = id {
                        body["id"] = json!(id);
                    }
                    machine("mind", url, "POST", "/api/people/mind", Some(body), start)
                }
                MindCommand::Show { id } => {
                    let mut response = machine(
                        "mind",
                        url,
                        "GET",
                        "/api/people/mind?includeArchived=1",
                        None,
                        start,
                    );
                    if !response.ok {
                        return response;
                    }
                    let note = response.data.as_ref().and_then(|data| {
                        data["notes"]
                            .as_array()?
                            .iter()
                            .find(|note| note["id"] == id.as_str())
                            .cloned()
                    });
                    match note {
                        Some(note) => {
                            response.data = Some(json!({"note":note}));
                            response
                        }
                        None => fail("mind", "not_found", "No note has that id.".into(), start),
                    }
                }
                MindCommand::List { archived } => {
                    let path = if *archived {
                        "/api/people/mind?includeArchived=1"
                    } else {
                        "/api/people/mind"
                    };
                    machine("mind", url, "GET", path, None, start)
                }
                MindCommand::Archive { id } => machine(
                    "mind",
                    url,
                    "POST",
                    "/api/people/mind/archive",
                    Some(json!({"id":id})),
                    start,
                ),
            }
        }
        Commands::Moments(args) => {
            let url = args.url.as_deref();
            let update = |id: &str, action: &str| {
                machine(
                    "moments",
                    url,
                    "POST",
                    "/api/people/moments/update",
                    Some(json!({"id":id,"action":action})),
                    start,
                )
            };
            match &args.command {
                None => {
                    let path = if args.today {
                        "/api/people/moments?today=1"
                    } else {
                        "/api/people/moments"
                    };
                    machine("moments", url, "GET", path, None, start)
                }
                Some(MomentsCommand::Act { id }) => update(id, "act"),
                Some(MomentsCommand::Snooze { id }) => update(id, "snooze"),
                Some(MomentsCommand::Dismiss { id }) => update(id, "dismiss"),
                Some(MomentsCommand::Budget { budget }) => machine(
                    "moments",
                    url,
                    "POST",
                    "/api/people/moments/settings",
                    Some(json!({"budget":budget})),
                    start,
                ),
            }
        }
        _ => unreachable!("moments::run handles mind and moments only"),
    }
}
