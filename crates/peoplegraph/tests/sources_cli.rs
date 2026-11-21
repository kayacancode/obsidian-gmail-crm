use serde_json::{Value, json};
use std::{
    io::{Read, Write},
    net::TcpListener,
    process::{Command, Output, Stdio},
    sync::mpsc,
    thread,
    time::Duration,
};

const KEY: &str = "grn_fictional_source_secret";
fn cli() -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_peoplegraph"));
    for key in [
        "PEOPLEGRAPH_WEB_URL",
        "PEOPLEGRAPH_WEB_TOKEN",
        "PEOPLEGRAPH_HOST",
        "PEOPLEGRAPH_TOKEN",
        "PEOPLEGRAPH_CACHE",
    ] {
        command.env_remove(key);
    }
    let home = std::env::temp_dir().join(format!("people-sources-empty-{}", std::process::id()));
    command
        .env("HOME", &home)
        .env("XDG_CONFIG_HOME", home.join("config"));
    command
}
fn value(output: &Output) -> Value {
    serde_json::from_slice(&output.stdout)
        .unwrap_or_else(|_| panic!("{}", String::from_utf8_lossy(&output.stderr)))
}
fn fixture(replies: Vec<(u16, Value)>) -> (String, mpsc::Receiver<Value>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let (sender, receiver) = mpsc::channel();
    thread::spawn(move || {
        for (status, response) in replies {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let mut bytes = Vec::new();
            let mut chunk = [0; 2048];
            let offset = loop {
                let size = stream.read(&mut chunk).unwrap();
                assert!(size > 0);
                bytes.extend_from_slice(&chunk[..size]);
                if let Some(offset) = bytes.windows(4).position(|b| b == b"\r\n\r\n") {
                    let headers = String::from_utf8_lossy(&bytes[..offset]);
                    assert!(headers.starts_with("POST /api/people-agent/request "));
                    assert!(
                        headers
                            .to_lowercase()
                            .contains("authorization: bearer people_fixture_secret")
                    );
                    let length = headers
                        .lines()
                        .find_map(|line| {
                            line.to_lowercase()
                                .strip_prefix("content-length:")
                                .and_then(|n| n.trim().parse::<usize>().ok())
                        })
                        .unwrap();
                    if bytes.len() >= offset + 4 + length {
                        break offset + 4;
                    }
                }
            };
            sender
                .send(serde_json::from_slice(&bytes[offset..]).unwrap())
                .unwrap();
            let response = response.to_string().replace(
                "ORIGIN_PLACEHOLDER",
                &format!("http://{}", stream.local_addr().unwrap()),
            );
            write!(stream, "HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{response}", response.len()).unwrap();
        }
    });
    (url, receiver)
}
fn authenticated(url: &str) -> Command {
    let mut command = cli();
    command
        .env("PEOPLEGRAPH_WEB_URL", url)
        .env("PEOPLEGRAPH_WEB_TOKEN", "people_fixture_secret");
    command
}
fn with_stdin(mut command: Command, input: &[u8]) -> Output {
    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all(input).unwrap();
    child.wait_with_output().unwrap()
}
fn accounts() -> Value {
    json!({"account":"owner@example.test","configured":true,"accounts":[{"email":"inbox@example.test","status":"connected","range":"recent","processed":20,"lastSync":1000,"error":"","contextEnabled":false,"contextCount":0,"calendarEnabled":true,"calendarStatus":"ready","calendarLastSync":1000,"calendarCount":1,"photosEnabled":true,"otherPhotosEnabled":true,"photoStatus":"ready","photoCount":2,"matchedPhotoCount":2}]})
}
fn granola() -> Value {
    json!({"connected":true,"status":"syncing","range":"recent","lastSync":1000,"nextSync":0,"error":"","counts":{"folders":0,"notes":1,"pending":1,"extracted":0,"failed":0,"skipped":0},"folders":[],"identities":[]})
}
fn received(receiver: &mpsc::Receiver<Value>) -> Value {
    receiver.recv_timeout(Duration::from_secs(2)).unwrap()
}

#[test]
fn status_combines_both_sources_and_drops_unexpected_secret_fields() {
    let mut mail = accounts();
    mail["grant"] = json!(KEY);
    mail["accounts"][0]["refresh_token"] = json!(KEY);
    let mut meetings = granola();
    meetings["apiKey"] = json!(KEY);
    let (url, receiver) = fixture(vec![(200, mail), (200, meetings)]);
    let output = authenticated(&url)
        .args(["sources", "status"])
        .output()
        .unwrap();
    assert!(output.status.success(), "{}", value(&output));
    assert_eq!(
        value(&output)["data"]["gmail"]["accounts"][0]["email"],
        "inbox@example.test"
    );
    assert_eq!(value(&output)["data"]["granola"]["status"], "syncing");
    assert!(!String::from_utf8_lossy(&output.stdout).contains(KEY));
    assert_eq!(
        received(&receiver),
        json!({"method":"GET","path":"/api/accounts"})
    );
    assert_eq!(
        received(&receiver),
        json!({"method":"GET","path":"/api/granola/status"})
    );
}

#[test]
fn gmail_connect_reports_pending_browser_consent_without_claiming_connection() {
    let (url, receiver) = fixture(vec![(
        200,
        json!({"requiresBrowser":true,"browserHandoff":{"url":"ORIGIN_PLACEHOLDER/accounts","reason":"provider_oauth_requires_browser"}}),
    )]);
    let output = authenticated(&url)
        .args(["sources", "connect", "gmail", "--url", &url])
        .output()
        .unwrap();
    assert!(output.status.success(), "{}", value(&output));
    assert_eq!(value(&output)["data"]["status"], "requires_browser_consent");
    assert_eq!(
        value(&output)["data"]["browserHandoff"]["url"],
        format!("{url}/accounts")
    );
    assert!(value(&output)["data"].get("connected").is_none());
    assert_eq!(
        received(&receiver),
        json!({"method":"POST","path":"/api/accounts/connect","body":{}})
    );
}

#[test]
fn gmail_connect_rejects_foreign_or_malformed_handoffs() {
    for body in [
        json!({"requiresBrowser":true,"browserHandoff":{"url":"https://evil.test/accounts"}}),
        json!({"connected":true}),
        json!({"requiresBrowser":true,"browserHandoff":{"url":"ORIGIN_PLACEHOLDER/accounts?token=secret","reason":"provider_oauth_requires_browser"}}),
    ] {
        let (url, _receiver) = fixture(vec![(200, body)]);
        let output = authenticated(&url)
            .args(["sources", "connect", "gmail"])
            .output()
            .unwrap();
        assert!(!output.status.success());
        assert_eq!(value(&output)["error"]["kind"], "web_response_invalid");
        assert!(!String::from_utf8_lossy(&output.stdout).contains("evil.test"));
    }
}

#[test]
fn granola_connect_reads_a_bounded_stdin_key_and_never_echoes_it() {
    let mut response = granola();
    response["apiKey"] = json!(KEY);
    let (url, receiver) = fixture(vec![(200, response)]);
    let mut command = authenticated(&url);
    command.args([
        "sources",
        "connect",
        "granola",
        "--key-stdin",
        "--range",
        "all",
    ]);
    let output = with_stdin(command, format!("{KEY}\n").as_bytes());
    assert!(output.status.success(), "{}", value(&output));
    assert_eq!(value(&output)["data"]["status"], "sync_started");
    assert_eq!(
        received(&receiver),
        json!({"method":"POST","path":"/api/granola/connect","body":{"apiKey":KEY,"range":"all"}})
    );
    assert!(!String::from_utf8_lossy(&output.stdout).contains(KEY));
    assert!(!String::from_utf8_lossy(&output.stderr).contains(KEY));
}

#[test]
fn granola_connect_does_not_echo_a_key_even_inside_an_allowed_status_field() {
    let mut response = granola();
    response["error"] = json!(KEY);
    let (url, _receiver) = fixture(vec![(200, response)]);
    let mut command = authenticated(&url);
    command.args(["sources", "connect", "granola", "--key-stdin"]);
    let output = with_stdin(command, KEY.as_bytes());
    assert!(!output.status.success());
    assert_eq!(value(&output)["error"]["kind"], "web_response_invalid");
    assert!(!String::from_utf8_lossy(&output.stdout).contains(KEY));
}

#[test]
fn gmail_sync_does_not_claim_a_new_range_while_already_syncing() {
    let mut response = accounts();
    response["accounts"][0]["status"] = json!("syncing");
    let (url, receiver) = fixture(vec![(200, response)]);
    let output = authenticated(&url)
        .args([
            "sources",
            "sync",
            "gmail",
            "--email",
            "inbox@example.test",
            "--range",
            "all",
        ])
        .output()
        .unwrap();
    assert!(output.status.success(), "{}", value(&output));
    assert_eq!(value(&output)["data"]["status"], "already_syncing");
    assert_eq!(value(&output)["data"]["range"], "recent");
    received(&receiver);
    assert!(receiver.recv_timeout(Duration::from_millis(100)).is_err());
}

#[test]
fn reconnect_states_require_new_provider_consent_without_claiming_sync() {
    let mut mail = accounts();
    mail["accounts"][0]["status"] = json!("reconnect");
    let (url, receiver) = fixture(vec![(200, mail)]);
    let output = authenticated(&url)
        .args(["sources", "sync", "gmail", "--email", "inbox@example.test"])
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert_eq!(value(&output)["error"]["kind"], "source_reconnect_required");
    received(&receiver);
    assert!(receiver.recv_timeout(Duration::from_millis(100)).is_err());
    let mut meetings = granola();
    meetings["status"] = json!("reconnect_required");
    let (url, _receiver) = fixture(vec![(200, meetings)]);
    let output = authenticated(&url)
        .args(["sources", "sync", "granola"])
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert_eq!(value(&output)["error"]["kind"], "source_reconnect_required");
}

#[test]
fn invalid_granola_keys_fail_before_network_and_do_not_echo_input() {
    for key in [
        "bad-secret-key".to_owned(),
        format!("grn_{}", "x".repeat(509)),
        "grn_hidden\nextra".to_owned(),
    ] {
        let mut command = authenticated("http://127.0.0.1:1");
        command.args(["sources", "connect", "granola", "--key-stdin"]);
        let output = with_stdin(command, key.as_bytes());
        assert!(!output.status.success());
        assert_eq!(value(&output)["error"]["kind"], "invalid_request");
        assert!(!String::from_utf8_lossy(&output.stdout).contains(&key));
    }
}

#[test]
fn gmail_sync_selects_exact_connected_account_and_passes_explicit_range() {
    let (url, receiver) = fixture(vec![(200, accounts()), (200, json!({"ok":true}))]);
    let output = authenticated(&url)
        .args([
            "sources",
            "sync",
            "gmail",
            "--email",
            "INBOX@example.test",
            "--range",
            "all",
        ])
        .output()
        .unwrap();
    assert!(output.status.success(), "{}", value(&output));
    assert_eq!(value(&output)["data"]["status"], "sync_requested");
    assert_eq!(
        received(&receiver),
        json!({"method":"GET","path":"/api/accounts"})
    );
    assert_eq!(
        received(&receiver),
        json!({"method":"POST","path":"/api/accounts/sync","body":{"email":"inbox@example.test","range":"all"}})
    );
}

#[test]
fn unknown_gmail_account_never_starts_a_sync() {
    let (url, receiver) = fixture(vec![(200, accounts())]);
    let output = authenticated(&url)
        .args(["sources", "sync", "gmail", "--email", "other@example.test"])
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert_eq!(value(&output)["error"]["kind"], "account_not_found");
    assert_eq!(
        received(&receiver),
        json!({"method":"GET","path":"/api/accounts"})
    );
    assert!(receiver.recv_timeout(Duration::from_millis(100)).is_err());
}

#[test]
fn granola_sync_checks_connection_state_instead_of_claiming_a_disconnected_sync() {
    for (response, expected) in [
        (granola(), None),
        (
            json!({"connected":false,"status":null,"range":null,"lastSync":0,"nextSync":0,"error":"","counts":{"folders":0,"notes":0,"pending":0,"extracted":0,"failed":0,"skipped":0},"folders":[],"identities":[]}),
            Some("source_not_connected"),
        ),
    ] {
        let (url, receiver) = fixture(vec![(200, response)]);
        let output = authenticated(&url)
            .args(["sources", "sync", "granola"])
            .output()
            .unwrap();
        assert_eq!(
            received(&receiver),
            json!({"method":"POST","path":"/api/granola/sync","body":{}})
        );
        if let Some(expected) = expected {
            assert!(!output.status.success());
            assert_eq!(value(&output)["error"]["kind"], expected);
        } else {
            assert!(output.status.success(), "{}", value(&output));
            assert_eq!(value(&output)["data"]["status"], "sync_requested");
        }
    }
}

#[test]
fn context_changes_only_the_exact_selected_inbox() {
    for (state, enabled) in [("on", true), ("off", false)] {
        let (url, receiver) = fixture(vec![(200, accounts()), (200, json!({"ok":true}))]);
        let output = authenticated(&url)
            .args([
                "sources",
                "context",
                "gmail",
                "--email",
                "inbox@example.test",
                state,
            ])
            .output()
            .unwrap();
        assert!(output.status.success(), "{}", value(&output));
        assert_eq!(value(&output)["data"]["contextEnabled"], enabled);
        received(&receiver);
        assert_eq!(
            received(&receiver),
            json!({"method":"POST","path":"/api/accounts/context","body":{"email":"inbox@example.test","enabled":enabled}})
        );
    }
}

#[test]
fn source_scope_failures_explain_explicit_login_without_retrying() {
    let (url, receiver) = fixture(vec![(
        403,
        json!({"error":"insufficient_scope","message":KEY,"requiredScopes":["sources:manage"]}),
    )]);
    let output = authenticated(&url)
        .args(["sources", "status"])
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert_eq!(value(&output)["error"]["kind"], "insufficient_scope");
    assert!(
        value(&output)["error"]["message"]
            .as_str()
            .unwrap()
            .contains("peoplegraph login --write --scope sources:manage")
    );
    assert!(!String::from_utf8_lossy(&output.stdout).contains(KEY));
    received(&receiver);
    assert!(receiver.recv_timeout(Duration::from_millis(100)).is_err());
}

#[test]
fn malformed_source_success_and_legacy_backend_flags_fail_closed() {
    let (url, _receiver) = fixture(vec![(200, json!({"accounts":"wrong"}))]);
    let output = authenticated(&url)
        .args(["sources", "status"])
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert_eq!(value(&output)["error"]["kind"], "web_response_invalid");
    let output = cli()
        .args(["sources", "status", "--local"])
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert_eq!(value(&output)["error"]["kind"], "incompatible_backend");
}
