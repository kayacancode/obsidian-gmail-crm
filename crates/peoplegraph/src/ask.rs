//! `peoplegraph ask`: hosted natural-language questions, or a small local rule set over the cache.
use crate::{
    Cli, ContactCardArgs, ReconnectArgs, Response, contact_card, fail, find_person, hosted,
    load_feedback, peer, people_client, reconnect, who_knows, with_index,
};
use clap::Args;
use serde_json::{Value, json};
use std::time::Instant;

#[derive(Args, Debug, Clone)]
pub(crate) struct AskArgs {
    /// Hosted People origin; alternatively set PEOPLEGRAPH_WEB_URL.
    #[arg(long)]
    url: Option<String>,
    /// One question about your network, at most 500 characters.
    question: String,
}

/// Intents the local cache can answer, with the text each rule captured.
enum Local {
    Company(String),
    Reconnect,
    CatchUp(String),
    Lookup(String),
}

/// Case-insensitive markers; the captured value keeps the owner's original spelling.
fn after(question: &str, markers: &[&str], anchored: bool) -> Option<String> {
    let lower = question.to_ascii_lowercase();
    markers.iter().find_map(|marker| {
        let at = if anchored {
            lower.starts_with(marker).then_some(0)
        } else {
            lower.find(marker)
        }?;
        let value = question[at + marker.len()..].trim();
        (!value.is_empty()).then(|| value.to_string())
    })
}

fn local_interpretation(question: &str) -> Option<Local> {
    let q = question.trim().trim_end_matches(['?', '.', '!']).trim();
    let lower = q.to_ascii_lowercase();
    if let Some(company) = after(
        q,
        &[
            "who do i know at ",
            "who do we know at ",
            "who i know at ",
            "anyone at ",
            "people at ",
        ],
        false,
    ) {
        return Some(Local::Company(company));
    }
    if let Some(person) = after(
        q,
        &[
            "catch me up on ",
            "catch me up with ",
            "catch up with ",
            "brief me on ",
            "before i talk to ",
            "before i call ",
            "before i meet ",
            "before i catch up with ",
            "before my call with ",
        ],
        false,
    ) {
        return Some(Local::CatchUp(person));
    }
    // Checked after catch-up: "before I talk to Maya … reach out" is about Maya, not the reconnect list.
    if ["reconnect", "losing touch", "reach out to", "gone quiet"]
        .iter()
        .any(|marker| lower.contains(marker))
    {
        return Some(Local::Reconnect);
    }
    after(q, &["who is ", "find ", "tell me about ", "look up "], true).map(Local::Lookup)
}

fn interpretation(intent: &str, params: Value) -> Value {
    json!({"intent":intent,"params":params,"confidence":1,"classifier":"local_rules"})
}

/// Person-shaped entries from a local result, in the hosted `answers` shape.
fn local_answers(result: &Value) -> Vec<Value> {
    let rows: Vec<&Value> = ["people", "matches"]
        .iter()
        .find_map(|key| result[*key].as_array())
        .map(|list| list.iter().collect())
        .unwrap_or_else(|| {
            let card = &result["source_of_truth"]["contact"];
            if card.is_object() { vec![card] } else { vec![] }
        });
    rows.into_iter()
        .map(|row| {
            json!({
                "personId": row["email"],
                "name": row["name"],
                "when": {"lastContact": row["last_contact"]},
            })
        })
        .collect()
}

/// Keep the inner command's envelope; its data becomes `result` beside the interpretation, answers and gaps.
fn wrap(mut response: Response, interpretation: Value, gaps: &[&str]) -> Response {
    let result = response.data.take().unwrap_or(Value::Null);
    let answers = local_answers(&result);
    response.data = Some(
        json!({"interpretation":interpretation,"answers":answers,"result":result,"gaps":gaps}),
    );
    response.command = "ask".into();
    response
}

pub(crate) fn run(cli: &Cli, args: &AskArgs, start: Instant) -> Response {
    let question = args.question.trim();
    if question.is_empty() || question.chars().count() > 500 {
        return fail(
            "ask",
            "invalid_request",
            "Ask one question of 1–500 characters.".into(),
            start,
        );
    }
    if !(cli.local || cli.cache.is_some()) {
        return match people_client::configure(args.url.as_deref()) {
            // Peer questions are classified by hosted People but asked from here, on the owner's request.
            Ok(client) => peer::ask_with_peers(hosted::machine(
                &client,
                "ask",
                "POST",
                "/api/people/ask",
                Some(json!({"question":question})),
                start,
            )),
            Err((kind, message)) => fail("ask", kind, message.into(), start),
        };
    }
    match local_interpretation(question) {
        Some(Local::Company(company)) => {
            let inner = with_index(cli, "ask", start, |index| {
                let feedback = match load_feedback(cli) {
                    Ok(store) => store,
                    Err(message) => return fail("ask", "feedback_unreadable", message, start),
                };
                who_knows(index, &feedback, &company, 25, start)
            });
            wrap(
                inner,
                interpretation("company", json!({"company":company})),
                &[],
            )
        }
        Some(Local::Reconnect) => wrap(
            reconnect(
                cli,
                "ask",
                &ReconnectArgs {
                    limit: 10,
                    min_score: 0,
                },
                start,
            ),
            interpretation("reconnect", json!({})),
            &[],
        ),
        Some(Local::CatchUp(person)) => wrap(
            contact_card(
                cli,
                "ask",
                &ContactCardArgs {
                    query: person.clone(),
                },
                start,
            ),
            interpretation("catch_up", json!({"person":person,"scope":"activity_only"})),
            &["Activity only; life signals and notes need hosted People"],
        ),
        Some(Local::Lookup(person)) => {
            let inner = with_index(cli, "ask", start, |index| {
                find_person(index, &person, 10, false, false, start)
            });
            wrap(
                inner,
                interpretation("lookup", json!({"person":person})),
                &[],
            )
        }
        None => {
            let mut response = fail(
                "ask",
                "unsupported_locally",
                "The local cache answers who-knows, reconnect, catch-up and lookup questions; ask the hosted People network for anything else.".into(),
                start,
            );
            response.data = Some(
                json!({"interpretation":{"intent":"clarify","params":{},"confidence":0,"classifier":"local_rules"}}),
            );
            response
        }
    }
}
