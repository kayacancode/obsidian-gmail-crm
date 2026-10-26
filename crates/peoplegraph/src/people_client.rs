//! Private People integration transport. Device credentials never enter this path.
use crate::{Response, elapsed_ms, fail, ok, web_profile};
use serde_json::{Value, json};
use std::env;
use std::time::{Duration, Instant};

pub(crate) struct Client {
    target: String,
    token: String,
}

pub(crate) fn configure(url: Option<&str>) -> Result<Client, (&'static str, &'static str)> {
    let target = url
        .map(str::to_owned)
        .or_else(|| env::var("PEOPLEGRAPH_WEB_URL").ok())
        .ok_or((
            "web_url_missing",
            "Set PEOPLEGRAPH_WEB_URL or pass --url <https-origin>.",
        ))?;
    let target = web_profile::origin(target.trim()).map_err(|_| (
        "invalid_web_url",
        "Use an HTTPS origin without credentials, path, query or fragment; HTTP is allowed only on localhost.",
    ))?;
    let token = env::var("PEOPLEGRAPH_WEB_TOKEN")
        .unwrap_or_default()
        .trim()
        .to_string();
    if token.is_empty() {
        return Err((
            "web_token_missing",
            "Set PEOPLEGRAPH_WEB_TOKEN to a People integration credential.",
        ));
    }
    if token.starts_with("pgd1_") {
        return Err((
            "insufficient_scope",
            "Device login grants read-only graph access. Set PEOPLEGRAPH_WEB_TOKEN to a People integration credential for private Lens and memory commands.",
        ));
    }
    Ok(Client { target, token })
}

pub(crate) fn request(
    command: &'static str,
    url: Option<&str>,
    path: &str,
    payload: Option<Value>,
    start: Instant,
) -> Response {
    match configure(url) {
        Ok(client) => client.request(command, path, payload, start),
        Err((kind, message)) => fail(command, kind, message.into(), start),
    }
}

impl Client {
    pub(crate) fn request(
        self,
        command: &'static str,
        path: &str,
        payload: Option<Value>,
        start: Instant,
    ) -> Response {
        let fail = |kind: &str, message: &str| fail(command, kind, message.to_string(), start);
        let Self { target, token } = self;
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
                .header("authorization", format!("Bearer {token}"))
                .header("content-type", "application/json")
                .send(body.to_string().as_str())
        } else {
            agent
                .get(&url)
                .header("authorization", format!("Bearer {token}"))
                .call()
        };
        let mut response = match response {
            Ok(response) => response,
            Err(_) => {
                return fail(
                    "web_request_failed",
                    "The People service could not be reached; no fallback was used.",
                );
            }
        };
        let status = response.status().as_u16();
        if (300..400).contains(&status) {
            return fail(
                "web_redirect_refused",
                "People redirected the request; credentials were not forwarded.",
            );
        }
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
            Ok(data) if Value::is_object(&data) => data,
            _ => {
                return fail(
                    "web_response_invalid",
                    "The People service did not return a JSON object.",
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
                "ambiguous_person",
                "unsupported_operation",
                "owner_lens_conflict",
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
                &format!(
                    "People request failed (HTTP {status}); no local cache was changed and no fallback was used."
                ),
            );
        }
        ok(
            command,
            data,
            json!({"ms":elapsed_ms(start),"backend":"people_web"}),
        )
    }
}
