//! Origin-bound People integration transport. Device credentials never enter this path.
use crate::{Response, config, elapsed_ms, fail, ok};
use serde_json::{Value, json};
use std::time::{Duration, Instant};

pub(crate) struct Client {
    target: String,
    token: String,
}

#[derive(Debug)]
pub(crate) struct ClientError {
    pub kind: &'static str,
    pub message: String,
    pub http_status: Option<u16>,
}

impl ClientError {
    fn new(kind: &'static str, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
            http_status: None,
        }
    }
    pub(crate) fn response(self, command: &'static str, start: Instant) -> Response {
        let mut response = fail(command, self.kind, self.message, start);
        if let Some(status) = self.http_status {
            response.stats.as_mut().unwrap()["httpStatus"] = json!(status);
        }
        response
    }
}

// Ranking has three bounded model stages (15s + 60s + 60s), plus store reads.
// Ordinary reads and the background refresh enqueue retain the short deadline.
fn request_budget(method: &str, path: &str, payload: Option<&Value>) -> Duration {
    let ranking = method == "POST"
        && (matches!(
            path,
            "/api/people-agent/matches" | "/api/people-agent/helpers"
        ) || (path == "/api/people-agent/request"
            && payload.is_some_and(|body| {
                body["method"] == "POST"
                    && matches!(
                        body["path"].as_str(),
                        Some("/api/lens/matches" | "/api/people/helpers" | "/api/people/search")
                    )
            })));
    Duration::from_secs(if ranking { 180 } else { 30 })
}

fn transport_error(error: ureq::Error, budget: Duration, status: Option<u16>) -> ClientError {
    let mut result = if matches!(error, ureq::Error::Timeout(_)) {
        ClientError::new(
            "web_request_timeout",
            format!(
                "The People request exceeded the client's {}ms deadline. Inspect operation status before retrying a mutation; no fallback was used.",
                budget.as_millis()
            ),
        )
    } else if status.is_some() {
        ClientError::new(
            "web_response_invalid",
            "The People service returned an unreadable response.",
        )
    } else {
        ClientError::new(
            "web_request_failed",
            "The People service could not be reached; no fallback was used.",
        )
    };
    result.http_status = status;
    result
}

pub(crate) fn configure(url: Option<&str>) -> Result<Client, config::Error> {
    let credential = config::resolve(url)?;
    Ok(Client {
        target: credential.origin,
        token: credential.token,
    })
}

pub(crate) fn request(
    command: &'static str,
    url: Option<&str>,
    path: &str,
    payload: Option<Value>,
    start: Instant,
) -> Response {
    let method = if payload.is_some() { "POST" } else { "GET" };
    request_http(command, url, method, path, payload, start)
}

pub(crate) fn request_http(
    command: &'static str,
    url: Option<&str>,
    method: &str,
    path: &str,
    payload: Option<Value>,
    start: Instant,
) -> Response {
    match configure(url) {
        Ok(client) => client.request_http(command, method, path, payload, start),
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
        let method = if payload.is_some() { "POST" } else { "GET" };
        self.request_http(command, method, path, payload, start)
    }

    pub(crate) fn request_http(
        &self,
        command: &'static str,
        method: &str,
        path: &str,
        payload: Option<Value>,
        start: Instant,
    ) -> Response {
        match self.request_json(method, path, payload) {
            Ok(data) => ok(
                command,
                data,
                json!({"ms":elapsed_ms(start),"backend":"people_web"}),
            ),
            Err(error) => error.response(command, start),
        }
    }

    /// Return parsed data for safe read/modify/write operations without encoding an outer CLI envelope.
    pub(crate) fn request_json(
        &self,
        method: &str,
        path: &str,
        payload: Option<Value>,
    ) -> Result<Value, ClientError> {
        let budget = request_budget(method, path, payload.as_ref());
        self.request_json_with_timeout(method, path, payload, budget)
    }

    fn request_json_with_timeout(
        &self,
        method: &str,
        path: &str,
        payload: Option<Value>,
        budget: Duration,
    ) -> Result<Value, ClientError> {
        if !matches!(method, "GET" | "POST" | "PUT" | "PATCH" | "DELETE") {
            return Err(ClientError::new(
                "invalid_request",
                "Use GET, POST, PUT, PATCH or DELETE.",
            ));
        }
        if !path.starts_with('/')
            || path.starts_with("//")
            || path.contains(['#', '\\'])
            || path
                .bytes()
                .any(|byte| byte.is_ascii_control() || byte.is_ascii_whitespace())
        {
            return Err(ClientError::new(
                "invalid_request",
                "Use a relative API path beginning with one slash, without a fragment or whitespace.",
            ));
        }
        if method == "GET" && payload.is_some() {
            return Err(ClientError::new(
                "invalid_request",
                "GET requests cannot contain a JSON body.",
            ));
        }
        let agent: ureq::Agent = ureq::Agent::config_builder()
            .http_status_as_error(false)
            .max_redirects(0)
            .timeout_global(Some(budget))
            .build()
            .into();
        let body = payload.map(|value| value.to_string());
        if body.as_ref().is_some_and(|value| value.len() > 1_000_000) {
            return Err(ClientError::new(
                "invalid_request",
                "The JSON request exceeds the allowed size.",
            ));
        }
        let mut request = ureq::http::Request::builder()
            .method(method)
            .uri(format!("{}{path}", self.target))
            .header("authorization", format!("Bearer {}", self.token));
        if body.is_some() {
            request = request.header("content-type", "application/json");
        }
        let response = if let Some(body) = body {
            let request = request.body(body).map_err(|_| {
                ClientError::new("invalid_request", "Cannot build the People request.")
            })?;
            agent.run(request)
        } else {
            let request = request.body(()).map_err(|_| {
                ClientError::new("invalid_request", "Cannot build the People request.")
            })?;
            agent.run(request)
        };
        let mut response = response.map_err(|error| transport_error(error, budget, None))?;
        let status = response.status().as_u16();
        if (300..400).contains(&status) {
            return Err(ClientError::new(
                "web_redirect_refused",
                "People redirected the request; credentials were not forwarded.",
            ));
        }
        let ndjson = response
            .headers()
            .get("content-type")
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.split(';').next())
            .is_some_and(|value| value.trim().eq_ignore_ascii_case("application/x-ndjson"));
        let text = response
            .body_mut()
            .with_config()
            .limit(4 * 1024 * 1024)
            .read_to_string()
            .map_err(|error| transport_error(error, budget, Some(status)))?;
        let invalid_response = || {
            ClientError::new(
                "web_response_invalid",
                "The People service did not return valid JSON objects.",
            )
        };
        let data: Value = if ndjson && (200..300).contains(&status) {
            let events = text
                .lines()
                .filter(|line| !line.trim().is_empty())
                .map(|line| {
                    serde_json::from_str::<Value>(line)
                        .ok()
                        .filter(Value::is_object)
                        .ok_or_else(invalid_response)
                })
                .collect::<Result<Vec<_>, _>>()?;
            json!({"contentType":"application/x-ndjson","events":events})
        } else if (200..300).contains(&status) {
            serde_json::from_str(&text)
                .ok()
                .filter(Value::is_object)
                .ok_or_else(invalid_response)?
        } else {
            // Edge/server failures may be HTML, empty or malformed. Keep their actual status
            // without echoing any response body or misreporting a JSON parse error.
            serde_json::from_str(&text).unwrap_or(Value::Null)
        };
        if !(200..300).contains(&status) {
            let supplied = data
                .get("error")
                .and_then(Value::as_str)
                .or_else(|| {
                    data.get("error")
                        .and_then(|error| error.get("kind"))
                        .and_then(Value::as_str)
                })
                .unwrap_or("");
            // Stable owner-handler recovery codes only. Never reflect arbitrary provider strings,
            // including strings that merely start with "invalid_".
            let allowed = [
                "people_memory_unauthorized",
                "unauthorized",
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
                "browser_handoff_required",
                "method_not_allowed",
                "conflict",
                "credential_scope_escalation",
                "invalid_origin",
                "invalid_scopes",
                "invalid_json",
                "invalid_idempotency_key",
                "request_too_large",
                "unsupported_media_type",
                "people_request_failed",
                "people_memory_failed",
                "server_error",
                // Lens, private context, and identity edits.
                "owner_lens_updating",
                "owner_lens_refresh_busy",
                "owner_lens_disabled",
                "owner_lens_suggestion_missing",
                "invalid_owner_lens",
                "memory_unavailable",
                "ai_unavailable",
                "invalid_helper_output",
                "invalid_extraction",
                "merge_conflict",
                "invalid_person_merge",
                "merge_limit",
                "invalid_draft",
                // Connected sources and evidence retrieval.
                "mail_not_configured",
                "invalid_account",
                "account_limit",
                "invalid_identity",
                "granola_unauthorized",
                "granola_forbidden",
                "granola_rate_limited",
                "granola_timeout",
                "granola_unavailable",
                "retrieval_failed",
                "invalid_relevance_feedback",
                "invalid_relevance_person",
                "unsafe_public_source",
                "public_source_conflict",
                "public_source_limit",
                "graph_unavailable",
                "invalid_graph",
                // Sharing, workspace membership, and introduction requests.
                "share_limit",
                "viewer_limit",
                "unknown_share",
                "invalid_share",
                "admin_required",
                "workspace_changed_retry",
                "workspace_unavailable",
                "workspace_limit",
                "invalid_email",
                "invalid_name",
                "invalid_invite",
                "sign_in_with_invited_email",
                "invite_unavailable",
                "invite_expired",
                "already_a_member",
                "member_limit",
                "invalid_query",
                "invalid_person",
                "person_unavailable",
                "undo_existing_merge_first",
                "own_contribution_not_found",
                "identity_not_resolved",
                "confirmation_limit",
                "exclusion_limit",
                "invite_limit",
                "invalid_contribution",
                "invalid_member",
                "member_not_found",
                "transfer_admin_first",
                "introduction_unavailable",
                "agreement_required",
                "invalid_alternative",
                "invalid_evidence",
                "invalid_recipient",
                "invalid_revision",
                "invalid_state",
                "recipient_required",
                "request_changed",
                "request_unavailable",
                "invalid_cursor",
                // Owner booking/scheduling actions: callers need the exact code to recover safely.
                "verification_required",
                "invalid_code",
                "invalid_request_key",
                "booking_unavailable",
                "email_unavailable",
                "calendar_unavailable",
                "booking_in_progress",
                "request_closed",
                "no_pending_slot",
                "slot_unavailable",
                "settings_changed",
                "settings_conflict",
                "thesis_required",
                "unknown_setting",
                "slug_taken",
                "setup_required",
                "invalid_oauth_state",
                "wrong_owner",
                "intake_required",
                "proposal_changed",
                "ambiguous_proposal_time",
                "nonexistent_proposal_time",
                "booking_failed",
                "scheduling_unauthorized",
                "scheduling_forbidden",
                "booking_calendar_reconnect_required",
                "offer_expired",
                "offer_changed",
                "assessment_required",
                "context_not_requested",
                "scheduling_email_delivery_unknown",
                "scheduling_failed",
                "invalid_instructions",
                "invalid_attendees",
                "invalid_authority",
                "invalid_timezone",
                "invalid_window",
                "invalid_booking_mode",
                "invalid_duration",
                "invalid_owner",
                "invalid_project_url",
                "invalid_proposal_time",
                "invalid_proposed_times",
                "invalid_returning_contacts_enabled",
                "invalid_review_delay",
                "invalid_settings",
                "invalid_slug",
                "invalid_submission",
                "invalid_vip_emails",
                "invalid_weekdays",
                "invalid_working_hours",
            ];
            let kind = allowed
                .into_iter()
                .find(|allowed| *allowed == supplied)
                .unwrap_or("web_request_failed");
            let mut error = ClientError::new(
                kind,
                format!(
                    "People request failed (HTTP {status}); no local cache was changed and no fallback was used."
                ),
            );
            error.http_status = Some(status);
            return Err(error);
        }
        Ok(data)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::thread;

    #[test]
    fn explicit_http_methods_and_json_bodies_reach_only_the_bound_origin() {
        for method in ["GET", "POST", "PUT", "PATCH", "DELETE"] {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let target = format!("http://{}", listener.local_addr().unwrap());
            let reader = thread::spawn(move || {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(3)))
                    .unwrap();
                let mut bytes = Vec::new();
                let mut chunk = [0; 2048];
                loop {
                    let size = stream.read(&mut chunk).unwrap();
                    if size == 0 {
                        break;
                    }
                    bytes.extend_from_slice(&chunk[..size]);
                    if let Some(offset) = bytes.windows(4).position(|bytes| bytes == b"\r\n\r\n") {
                        let header = String::from_utf8_lossy(&bytes[..offset]);
                        let length = header
                            .lines()
                            .find_map(|line| {
                                line.to_lowercase()
                                    .strip_prefix("content-length:")
                                    .and_then(|value| value.trim().parse::<usize>().ok())
                            })
                            .unwrap_or(0);
                        if bytes.len() >= offset + 4 + length {
                            break;
                        }
                    }
                }
                let body = r#"{"revision":"r2"}"#;
                write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
                String::from_utf8(bytes).unwrap()
            });
            let client = Client {
                target,
                token: "fixture_secret".into(),
            };
            let payload = (method != "GET")
                .then(|| json!({"revision":"r1","fields":{"focus":"owner-authorized"}}));
            assert_eq!(
                client
                    .request_json(method, "/api/people-agent/lens", payload.clone())
                    .unwrap(),
                json!({"revision":"r2"})
            );
            let request = reader.join().unwrap();
            assert!(request.starts_with(&format!("{method} /api/people-agent/lens HTTP/1.1\r\n")));
            assert!(
                request
                    .to_lowercase()
                    .contains("authorization: bearer fixture_secret\r\n")
            );
            let body = request.split_once("\r\n\r\n").unwrap().1;
            if let Some(expected) = payload {
                assert_eq!(serde_json::from_str::<Value>(body).unwrap(), expected);
            } else {
                assert!(body.is_empty());
            }
        }
    }

    #[test]
    fn invalid_methods_paths_and_get_payloads_fail_before_network() {
        let client = Client {
            target: "http://127.0.0.1:9".into(),
            token: "fixture_secret".into(),
        };
        for (method, path, payload) in [
            ("HEAD", "/api/people-agent/lens", None),
            ("GET", "https://other.example.test/api", None),
            ("GET", "//other.example.test/api", None),
            ("GET", "/api\\other", None),
            ("GET", "/api#fragment", None),
            ("GET", "/api\r\nAuthorization: leak", None),
            (
                "GET",
                "/api/people-agent/lens",
                Some(json!({"secret":"not-to-send"})),
            ),
        ] {
            let error = client.request_json(method, path, payload).unwrap_err();
            assert_eq!(error.kind, "invalid_request");
            assert!(!error.message.contains("fixture_secret"));
            assert!(!error.message.contains("not-to-send"));
        }
    }

    fn reply(content_type: &str, body: String) -> Client {
        reply_status(content_type, body, "200 OK")
    }

    fn reply_status(content_type: &str, body: String, status: &'static str) -> Client {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let target = format!("http://{}", listener.local_addr().unwrap());
        let content_type = content_type.to_owned();
        thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            // Drain the complete request before closing the socket. Closing with an unread
            // POST body can reset the connection before the client receives this fixture.
            let mut request = Vec::new();
            let mut chunk = [0; 2048];
            loop {
                let size = stream.read(&mut chunk).unwrap();
                if size == 0 {
                    break;
                }
                request.extend_from_slice(&chunk[..size]);
                if let Some(offset) = request.windows(4).position(|bytes| bytes == b"\r\n\r\n") {
                    let headers = String::from_utf8_lossy(&request[..offset]);
                    let length = headers
                        .lines()
                        .find_map(|line| {
                            line.to_ascii_lowercase()
                                .strip_prefix("content-length:")
                                .and_then(|value| value.trim().parse::<usize>().ok())
                        })
                        .unwrap_or(0);
                    if request.len() >= offset + 4 + length {
                        break;
                    }
                }
            }
            let _ = write!(
                stream,
                "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
        });
        Client {
            target,
            token: "fixture_secret".into(),
        }
    }

    #[test]
    fn ndjson_search_events_are_parsed_without_losing_event_boundaries() {
        let client = reply(
            "application/x-ndjson; charset=utf-8",
            "{\"type\":\"start\"}\n\n{\"type\":\"match\",\"personId\":\"p1\"}\n".into(),
        );
        let result = client
            .request_json("GET", "/api/workspaces/w/search-stream", None)
            .unwrap();
        assert_eq!(
            result,
            json!({"contentType":"application/x-ndjson","events":[{"type":"start"},{"type":"match","personId":"p1"}]})
        );
    }

    #[test]
    fn malformed_or_oversized_ndjson_is_rejected_without_raw_response_details() {
        for body in [
            "{\"type\":\"start\"}\nprivate details".to_owned(),
            "null\n".into(),
            "[1]\n".into(),
            format!("{{\"text\":\"{}\"}}\n", "x".repeat(4 * 1024 * 1024)),
        ] {
            let client = reply("application/x-ndjson", body);
            let error = client
                .request_json("GET", "/api/workspaces/w/search-stream", None)
                .unwrap_err();
            assert_eq!(error.kind, "web_response_invalid");
            assert!(!error.message.contains("private details"));
        }
    }

    #[test]
    fn registered_owner_recovery_codes_survive_without_provider_details() {
        for code in [
            "owner_lens_refresh_busy",
            "offer_changed",
            "assessment_required",
            "settings_conflict",
            "slot_unavailable",
            "workspace_changed_retry",
            "owner_lens_updating",
            "invite_expired",
            "granola_unauthorized",
            "public_source_conflict",
        ] {
            let client = reply_status("application/json", json!({"error":code,"message":"provider body fixture_secret","details":{"token":"fixture_secret"}}).to_string(), "409 Conflict");
            let error = client.request_json("POST", "/api/people-agent/request", Some(json!({"method":"POST","path":"/api/booking/scheduling/requests/request-1/confirm"}))).unwrap_err();
            assert_eq!(error.kind, code);
            assert!(!error.message.contains("fixture_secret"));
            assert!(!error.message.contains("provider body"));
        }
    }

    #[test]
    fn worker_failures_preserve_http_status_even_without_json() {
        for body in [
            json!({"error":"people_memory_failed","details":"fixture_secret"}).to_string(),
            "<html>upstream fixture_secret unavailable</html>".into(),
        ] {
            let client = reply_status("text/html", body.clone(), "503 Service Unavailable");
            let result = client.request_http(
                "matches",
                "POST",
                "/api/people-agent/matches",
                Some(json!({})),
                Instant::now(),
            );
            assert!(!result.ok);
            assert_eq!(result.stats.as_ref().unwrap()["httpStatus"], 503);
            let error = result.error.unwrap();
            assert_eq!(
                error.kind,
                if body.starts_with('{') {
                    "people_memory_failed"
                } else {
                    "web_request_failed"
                }
            );
            assert!(error.message.contains("HTTP 503"));
            assert!(!error.message.contains("fixture_secret"));
        }
    }

    #[test]
    fn only_matching_operations_receive_the_model_work_budget() {
        for path in ["/api/people-agent/matches", "/api/people-agent/helpers"] {
            assert_eq!(request_budget("POST", path, None), Duration::from_secs(180));
            assert_eq!(request_budget("GET", path, None), Duration::from_secs(30));
        }
        for path in [
            "/api/lens/matches",
            "/api/people/helpers",
            "/api/people/search",
        ] {
            assert_eq!(
                request_budget(
                    "POST",
                    "/api/people-agent/request",
                    Some(&json!({"method":"POST","path":path}))
                ),
                Duration::from_secs(180)
            );
        }
        for payload in [
            json!({"method":"POST","path":"/api/lens","body":{"action":"refresh"}}),
            json!({"method":"GET","path":"/api/accounts"}),
        ] {
            assert_eq!(
                request_budget("POST", "/api/people-agent/request", Some(&payload)),
                Duration::from_secs(30)
            );
        }
    }

    #[test]
    fn delayed_headers_and_body_report_client_timeout_without_inventing_http_failure() {
        for send_headers in [false, true] {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let target = format!("http://{}", listener.local_addr().unwrap());
            let (release, wait) = std::sync::mpsc::channel();
            let server = thread::spawn(move || {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(3)))
                    .unwrap();
                let mut request = [0; 2048];
                stream.read(&mut request).unwrap();
                if send_headers {
                    write!(stream, "HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n").unwrap();
                }
                let _ = wait.recv_timeout(Duration::from_secs(3));
            });
            let client = Client {
                target,
                token: "fixture_secret".into(),
            };
            let error = client
                .request_json_with_timeout(
                    "GET",
                    "/api/people-agent/lens",
                    None,
                    Duration::from_millis(100),
                )
                .unwrap_err();
            release.send(()).unwrap();
            server.join().unwrap();
            assert_eq!(error.kind, "web_request_timeout");
            assert_eq!(error.http_status, send_headers.then_some(200));
            assert!(error.message.contains("Inspect operation status"));
            assert!(!error.message.contains("fixture_secret"));
            assert!(!error.message.contains("503"));
        }
    }

    #[test]
    fn unknown_error_codes_and_raw_provider_errors_are_never_reflected() {
        for supplied in [
            "provider failed: token=fixture_secret",
            "invalid_provider_fixture_secret",
            "fixture_secret",
        ] {
            let client = reply_status(
                "application/json",
                json!({"error":supplied,"details":"fixture_secret"}).to_string(),
                "502 Bad Gateway",
            );
            let error = client
                .request_json("GET", "/api/people-agent/status", None)
                .unwrap_err();
            assert_eq!(error.kind, "web_request_failed");
            assert!(!error.message.contains("fixture_secret"));
            assert!(!error.message.contains(supplied));
        }
    }
}
