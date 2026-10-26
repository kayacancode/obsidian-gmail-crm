use serde_json::{Value, json};
use std::io::{Read, Write};
use std::net::TcpListener;
use std::process::{Command, Output};
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

fn cli() -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_peoplegraph"));
    for name in [
        "PEOPLEGRAPH_WEB_URL",
        "PEOPLEGRAPH_WEB_TOKEN",
        "PEOPLEGRAPH_HOST",
        "PEOPLEGRAPH_TOKEN",
        "PEOPLEGRAPH_CACHE",
    ] {
        command.env_remove(name);
    }
    command
}

fn fixture(body: String, status: &str, headers: &str) -> (String, mpsc::Receiver<String>) {
    let server = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = format!("http://{}", server.local_addr().unwrap());
    let status = status.to_string();
    let headers = headers.to_string();
    let (send, receive) = mpsc::channel();
    thread::spawn(move || {
        let (mut stream, _) = server.accept().unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        let mut data = Vec::new();
        let mut chunk = [0; 2048];
        loop {
            let size = stream.read(&mut chunk).unwrap();
            if size == 0 {
                break;
            }
            data.extend_from_slice(&chunk[..size]);
            if let Some(offset) = data.windows(4).position(|bytes| bytes == b"\r\n\r\n") {
                let headers = String::from_utf8_lossy(&data[..offset]);
                let length = headers
                    .lines()
                    .find_map(|line| {
                        line.to_ascii_lowercase()
                            .strip_prefix("content-length:")
                            .and_then(|value| value.trim().parse::<usize>().ok())
                    })
                    .unwrap_or(0);
                if data.len() >= offset + 4 + length {
                    break;
                }
            }
        }
        // An oversized response may cause the client to disconnect before it is all written.
        let _ = write!(
            stream,
            "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n{headers}Connection: close\r\n\r\n{body}",
            body.len()
        );
        let _ = send.send(String::from_utf8(data).unwrap());
    });
    (address, receive)
}

fn envelope(output: &Output) -> Value {
    serde_json::from_slice(&output.stdout).unwrap_or_else(|_| {
        panic!(
            "not JSON: {} / {}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        )
    })
}

#[test]
fn login_and_memory_remain_discoverable_alongside_lens_commands() {
    let output = cli().arg("describe").output().unwrap();
    assert!(output.status.success());
    let response = envelope(&output);
    let commands = response["data"]["commands"].as_array().unwrap();
    for name in [
        "login",
        "logout",
        "memory",
        "lens",
        "matches",
        "search",
        "connection",
        "helpers",
    ] {
        assert!(
            commands.iter().any(|entry| entry["name"] == name),
            "missing command: {name}"
        );
        assert!(
            cli()
                .args([name, "--help"])
                .output()
                .unwrap()
                .status
                .success()
        );
    }
}

#[test]
fn agent_commands_send_exact_routes_payloads_and_people_token() {
    for (args, route, expected) in [
        (vec!["lens"], "GET /api/people-agent/lens ", None),
        (
            vec!["matches"],
            "POST /api/people-agent/matches ",
            Some(json!({})),
        ),
        (
            vec!["search", "clinical research partners", "--limit", "7"],
            "POST /api/people-agent/search ",
            Some(json!({"query":"clinical research partners","limit":7})),
        ),
        (
            vec![
                "connection",
                "--from",
                "person-1",
                "--to",
                "ada@example.test",
            ],
            "POST /api/people-agent/connection ",
            Some(json!({"from":"person-1","to":"ada@example.test"})),
        ),
        (
            vec!["helpers", "--person-id", "person-2"],
            "POST /api/people-agent/helpers ",
            Some(json!({"personId":"person-2"})),
        ),
    ] {
        let (url, received) = fixture(
            r#"{"evidence":[{"source":"saved_lens","text":"owner context"}]}"#.into(),
            "200 OK",
            "",
        );
        let output = cli()
            .args(&args)
            .args(["--url", &url])
            .env("PEOPLEGRAPH_WEB_TOKEN", "people_fixture_secret")
            .env("PEOPLEGRAPH_HOST", "http://wrong-local-host.invalid")
            .env("PEOPLEGRAPH_TOKEN", "wrong_local_token")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let request = received.recv_timeout(Duration::from_secs(3)).unwrap();
        assert!(request.starts_with(route), "{request}");
        assert!(
            request
                .to_ascii_lowercase()
                .contains("authorization: bearer people_fixture_secret\r\n")
        );
        let body = request.split_once("\r\n\r\n").unwrap().1;
        if let Some(expected) = expected {
            assert_eq!(serde_json::from_str::<Value>(body).unwrap(), expected);
        } else {
            assert!(body.is_empty());
        }
        let response = envelope(&output);
        assert_eq!(response["ok"], true);
        assert_eq!(response["command"], args[0]);
        assert_eq!(response["data"]["evidence"][0]["text"], "owner context");
        assert!(!String::from_utf8_lossy(&output.stdout).contains("people_fixture_secret"));
    }
}

#[test]
fn private_commands_require_people_token_and_reject_device_credentials() {
    for args in [
        vec!["lens"],
        vec!["memory", "lookup", "--email", "ada@example.test"],
    ] {
        for (token, expected) in [
            (None, "web_token_missing"),
            (Some("pgd1_device_secret"), "insufficient_scope"),
        ] {
            let mut command = cli();
            command
                .args(&args)
                .env("PEOPLEGRAPH_WEB_URL", "http://127.0.0.1:9")
                .env("PEOPLEGRAPH_TOKEN", "wrong_local_token");
            if let Some(token) = token {
                command.env("PEOPLEGRAPH_WEB_TOKEN", token);
            }
            let output = command.output().unwrap();
            assert!(!output.status.success());
            assert_eq!(envelope(&output)["error"]["kind"], expected);
        }
    }
}

#[test]
fn private_commands_reject_local_and_legacy_backend_flags() {
    for args in [
        vec!["lens"],
        vec!["memory", "lookup", "--email", "ada@example.test"],
    ] {
        for flags in [
            vec!["--local"],
            vec!["--remote"],
            vec!["--host", "http://127.0.0.1:9"],
            vec!["--token", "wrong"],
            vec!["--cache", "/missing.json"],
        ] {
            let output = cli().args(flags).args(&args).output().unwrap();
            assert!(!output.status.success());
            assert_eq!(envelope(&output)["error"]["kind"], "incompatible_backend");
        }
    }
}

#[test]
fn agent_commands_validate_origin_and_search_bounds_before_network() {
    for origin in [
        "http://example.test",
        "https://user:secret@example.test",
        "https://example.test/path",
        "https://example.test/?q=secret",
        "https://example.test/#fragment",
    ] {
        let output = cli()
            .args(["lens", "--url", origin])
            .env("PEOPLEGRAPH_WEB_TOKEN", "secret")
            .output()
            .unwrap();
        assert_eq!(envelope(&output)["error"]["kind"], "invalid_web_url");
    }
    for limit in ["0", "51"] {
        assert!(
            !cli()
                .args(["search", "clinics", "--limit", limit])
                .output()
                .unwrap()
                .status
                .success()
        );
    }
    for args in [
        vec!["search", "   "],
        vec!["connection", "--from", "", "--to", "person-1"],
        vec!["helpers", "--person-id", " "],
    ] {
        let output = cli()
            .args(args)
            .env("PEOPLEGRAPH_WEB_URL", "http://127.0.0.1:9")
            .env("PEOPLEGRAPH_WEB_TOKEN", "secret")
            .output()
            .unwrap();
        assert_eq!(envelope(&output)["error"]["kind"], "invalid_request");
    }
}

#[test]
fn agent_errors_keep_safe_codes_without_server_details_or_fallback() {
    for code in [
        "people_memory_unauthorized",
        "insufficient_scope",
        "unknown_person",
        "ambiguous_person",
        "not_found",
        "invalid_request",
        "rate_limited",
        "owner_lens_conflict",
    ] {
        let (url, received) = fixture(
            json!({"error":code,"details":"private server detail"}).to_string(),
            "409 Conflict",
            "",
        );
        let output = cli()
            .args(["matches", "--url", &url])
            .env("PEOPLEGRAPH_WEB_TOKEN", "secret")
            .output()
            .unwrap();
        assert!(!output.status.success());
        assert_eq!(envelope(&output)["error"]["kind"], code);
        received.recv_timeout(Duration::from_secs(3)).unwrap();
        assert!(!String::from_utf8_lossy(&output.stdout).contains("private server detail"));
    }
}

#[test]
fn agent_responses_reject_non_objects_invalid_json_and_oversized_bodies() {
    for body in [
        "not json".into(),
        "[]".into(),
        "null".into(),
        format!(r#"{{"text":"{}"}}"#, "x".repeat(1_000_001)),
    ] {
        let (url, received) = fixture(body, "200 OK", "");
        let output = cli()
            .args(["lens", "--url", &url])
            .env("PEOPLEGRAPH_WEB_TOKEN", "secret")
            .output()
            .unwrap();
        assert!(!output.status.success());
        assert_eq!(envelope(&output)["error"]["kind"], "web_response_invalid");
        received.recv_timeout(Duration::from_secs(3)).unwrap();
    }
}

#[test]
fn redirects_never_forward_private_credentials() {
    let destination = TcpListener::bind("127.0.0.1:0").unwrap();
    destination.set_nonblocking(true).unwrap();
    let headers = format!(
        "Location: http://{}/steal\r\n",
        destination.local_addr().unwrap()
    );
    let (url, received) = fixture(String::new(), "307 Temporary Redirect", &headers);
    let output = cli()
        .args(["lens", "--url", &url])
        .env("PEOPLEGRAPH_WEB_TOKEN", "secret")
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert_eq!(envelope(&output)["error"]["kind"], "web_redirect_refused");
    received.recv_timeout(Duration::from_secs(3)).unwrap();
    assert!(destination.accept().is_err());
}

#[test]
fn search_rejects_queries_over_the_shared_api_limit() {
    let query = "x".repeat(201);
    let output = cli()
        .args(["search", &query])
        .env("PEOPLEGRAPH_WEB_URL", "http://127.0.0.1:9")
        .env("PEOPLEGRAPH_WEB_TOKEN", "secret")
        .output()
        .unwrap();
    assert_eq!(envelope(&output)["error"]["kind"], "invalid_request");
}

#[test]
fn memory_checks_private_credentials_before_reading_input_files() {
    for (token, expected) in [
        (None, "web_token_missing"),
        (Some("pgd1_device_secret"), "insufficient_scope"),
    ] {
        let mut command = cli();
        command
            .args(["memory", "save", "--file", "/missing-profile-file.json"])
            .env("PEOPLEGRAPH_WEB_URL", "http://127.0.0.1:9");
        if let Some(token) = token {
            command.env("PEOPLEGRAPH_WEB_TOKEN", token);
        }
        let output = command.output().unwrap();
        assert_eq!(envelope(&output)["error"]["kind"], expected);
    }
}
