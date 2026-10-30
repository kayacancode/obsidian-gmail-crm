use serde_json::{Value, json};
use std::{
    io::{Read, Write},
    net::TcpListener,
    process::{Command, Output},
    sync::mpsc,
    thread,
    time::Duration,
};
fn cli() -> Command {
    let mut c = Command::new(env!("CARGO_BIN_EXE_peoplegraph"));
    for k in [
        "PEOPLEGRAPH_WEB_URL",
        "PEOPLEGRAPH_WEB_TOKEN",
        "PEOPLEGRAPH_HOST",
        "PEOPLEGRAPH_TOKEN",
        "PEOPLEGRAPH_CACHE",
    ] {
        c.env_remove(k);
    }
    let home = std::env::temp_dir().join(format!("people-parity-empty-{}", std::process::id()));
    c.env("HOME", &home)
        .env("XDG_CONFIG_HOME", home.join("config"));
    c
}
fn value(o: &Output) -> Value {
    serde_json::from_slice(&o.stdout)
        .unwrap_or_else(|_| panic!("{}", String::from_utf8_lossy(&o.stderr)))
}
fn fixture(replies: Vec<(u16, Value)>) -> (String, mpsc::Receiver<String>) {
    let l = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", l.local_addr().unwrap());
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        for (status, body) in replies {
            let (mut s, _) = l.accept().unwrap();
            s.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
            let mut data = Vec::new();
            let mut chunk = [0; 2048];
            loop {
                let n = s.read(&mut chunk).unwrap();
                if n == 0 {
                    break;
                }
                data.extend_from_slice(&chunk[..n]);
                if let Some(i) = data.windows(4).position(|b| b == b"\r\n\r\n") {
                    let h = String::from_utf8_lossy(&data[..i]);
                    let n = h
                        .lines()
                        .find_map(|l| {
                            l.to_lowercase()
                                .strip_prefix("content-length:")
                                .and_then(|s| s.trim().parse::<usize>().ok())
                        })
                        .unwrap_or(0);
                    if data.len() >= i + 4 + n {
                        break;
                    }
                }
            }
            let body = body.to_string();
            write!(s,"HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).unwrap();
            tx.send(String::from_utf8(data).unwrap()).unwrap();
        }
    });
    (url, rx)
}
fn authenticated(url: &str) -> Command {
    let mut c = cli();
    c.env("PEOPLEGRAPH_WEB_URL", url)
        .env("PEOPLEGRAPH_WEB_TOKEN", "people_fixture_secret");
    c
}
fn body(s: &str) -> Value {
    serde_json::from_str(s.split("\r\n\r\n").nth(1).unwrap()).unwrap()
}

#[test]
fn version_and_describe_always_report_the_installed_binary() {
    for command in ["version", "describe"] {
        let o = cli()
            .arg(command)
            .env("PEOPLEGRAPH_HOST", "http://127.0.0.1:1")
            .output()
            .unwrap();
        assert!(o.status.success(), "{}", value(&o));
        assert_eq!(value(&o)["data"]["version"], env!("CARGO_PKG_VERSION"));
    }
}
#[test]
fn lens_partial_edit_preserves_other_fields_and_uses_fetched_revision() {
    let before =
        json!({"revision":"r1","fields":{"focus":"old","needs":"keep need","offers":"keep offer"}});
    let (url, rx) = fixture(vec![(200, before), (200, json!({"revision":"r2"}))]);
    let o = authenticated(&url)
        .args(["lens", "set", "--focus", "new focus"])
        .output()
        .unwrap();
    assert!(o.status.success(), "{}", value(&o));
    assert!(
        rx.recv_timeout(Duration::from_secs(2))
            .unwrap()
            .starts_with("GET /api/people-agent/lens ")
    );
    let request = rx.recv_timeout(Duration::from_secs(2)).unwrap();
    assert!(request.starts_with("POST /api/people-agent/lens "));
    assert_eq!(
        body(&request),
        json!({"revision":"r1","fields":{"focus":"new focus","needs":"keep need","offers":"keep offer"}})
    );
}
#[test]
fn stale_lens_edit_is_not_retried() {
    let (url, rx) = fixture(vec![(409, json!({"error":"owner_lens_conflict"}))]);
    let o = authenticated(&url)
        .args([
            "lens",
            "set",
            "--revision",
            "stale",
            "--focus",
            "f",
            "--needs",
            "n",
            "--offers",
            "o",
        ])
        .output()
        .unwrap();
    assert!(!o.status.success());
    assert_eq!(value(&o)["error"]["kind"], "owner_lens_conflict");
    assert!(
        rx.recv_timeout(Duration::from_secs(2))
            .unwrap()
            .starts_with("POST /api/people-agent/lens ")
    );
}
#[test]
fn api_uses_scoped_adapter_and_preserves_method_path_and_json() {
    let (url, rx) = fixture(vec![(200, json!({"ok":true}))]);
    let o = authenticated(&url)
        .args(["api", "DELETE", "/api/shares?id=fixture"])
        .output()
        .unwrap();
    assert!(o.status.success(), "{}", value(&o));
    let request = rx.recv_timeout(Duration::from_secs(2)).unwrap();
    assert!(request.starts_with("POST /api/people-agent/request "));
    assert_eq!(
        body(&request),
        json!({"method":"DELETE","path":"/api/shares?id=fixture"})
    );
}
#[test]
fn status_distinguishes_verified_auth_from_configured() {
    let (url, _rx) = fixture(vec![(
        200,
        json!({"protocolVersion":1,"owner":"owner@example.test","credential":{"id":"test-id","scopes":["people:read"],"expiresAt":9999999999999_u64},"capabilities":[]}),
    )]);
    let o = authenticated(&url).arg("status").output().unwrap();
    assert!(o.status.success(), "{}", value(&o));
    let data = &value(&o)["data"];
    assert_eq!(data["authenticated"], true);
    assert_eq!(data["owner"], "owner@example.test");
    assert_eq!(data["credentialSource"], "environment");
    assert!(!o.stdout.windows(21).any(|s| s == b"people_fixture_secret"));
}
#[test]
fn offline_status_does_not_claim_authentication() {
    let o = cli().args(["status", "--offline"]).output().unwrap();
    assert!(o.status.success(), "{}", value(&o));
    assert_eq!(value(&o)["data"]["authenticated"], Value::Null);
}
#[test]
fn malformed_lens_cannot_replace_existing_fields() {
    let (url, _rx) = fixture(vec![(200, json!({"revision":"r1","fields":"unexpected"}))]);
    let o = authenticated(&url)
        .args(["lens", "set", "--focus", "new"])
        .output()
        .unwrap();
    assert!(!o.status.success());
    assert_eq!(value(&o)["error"]["kind"], "web_response_invalid");
}
#[test]
fn explicit_revision_mismatch_stops_before_mutation() {
    let (url, rx) = fixture(vec![(
        200,
        json!({"revision":"r2","fields":{"focus":"f","needs":"n","offers":"o"}}),
    )]);
    let o = authenticated(&url)
        .args(["lens", "set", "--focus", "new", "--revision", "r1"])
        .output()
        .unwrap();
    assert!(!o.status.success());
    assert_eq!(value(&o)["error"]["kind"], "owner_lens_conflict");
    assert!(
        rx.recv_timeout(Duration::from_secs(2))
            .unwrap()
            .starts_with("GET ")
    );
    assert!(rx.recv_timeout(Duration::from_millis(100)).is_err());
}
#[test]
fn status_rejects_unverified_credentials() {
    let (url, _rx) = fixture(vec![(401, json!({"error":"people_memory_unauthorized"}))]);
    let o = authenticated(&url).arg("status").output().unwrap();
    assert!(!o.status.success());
    assert_eq!(value(&o)["error"]["kind"], "people_memory_unauthorized");
    assert_ne!(value(&o)["data"]["authenticated"], true);
}

#[test]
fn status_does_not_treat_arbitrary_success_json_as_verified() {
    for response in [
        json!({}),
        json!({"protocolVersion":1,"owner":"owner@example.test","credential":{"id":"id","scopes":["unknown:scope"],"expiresAt":9999999999999_u64},"capabilities":[]}),
    ] {
        let (url, _rx) = fixture(vec![(200, response)]);
        let output = authenticated(&url).arg("status").output().unwrap();
        assert!(!output.status.success());
        assert_eq!(value(&output)["error"]["kind"], "web_response_invalid");
    }
}
