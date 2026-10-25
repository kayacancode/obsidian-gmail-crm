use std::io::{Read, Write};
use std::net::TcpListener;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

fn cli() -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_peoplegraph"));
    command
        .env_remove("PEOPLEGRAPH_WEB_URL")
        .env_remove("PEOPLEGRAPH_WEB_TOKEN");
    command
}
fn fixture(body: &'static str, status: &'static str) -> (String, mpsc::Receiver<String>) {
    let server = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = format!("http://{}", server.local_addr().unwrap());
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
        write!(stream, "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
        send.send(String::from_utf8(data).unwrap()).unwrap();
    });
    (address, receive)
}

#[test]
fn memory_lookup_uses_separate_web_origin_token_and_exact_email() {
    let (address, received) = fixture(
        r#"{"memory":{"personId":"person-1","text":"Private context"}}"#,
        "200 OK",
    );
    let result = cli()
        .args([
            "memory",
            "--url",
            &address,
            "lookup",
            "--email",
            "person@example.test",
        ])
        .env("PEOPLEGRAPH_WEB_TOKEN", "people_fixture_secret")
        .env("PEOPLEGRAPH_HOST", "http://wrong-local-host.invalid")
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    let request = received.recv_timeout(Duration::from_secs(3)).unwrap();
    assert!(request.starts_with("GET /api/people-agent/lookup?email=person%40example.test "));
    assert!(
        request
            .to_lowercase()
            .contains("authorization: bearer people_fixture_secret\r\n")
    );
    let data: serde_json::Value = serde_json::from_slice(&result.stdout).unwrap();
    assert_eq!(data["ok"], true);
    assert_eq!(data["data"]["memory"]["personId"], "person-1");
    assert!(!String::from_utf8_lossy(&result.stdout).contains("people_fixture_secret"));
}

#[test]
fn memory_capture_reads_transcript_file_and_preserves_retry_source_id() {
    let (address, received) = fixture(
        r#"{"personId":"person-1","entryId":"entry-1","duplicate":true,"memory":{}}"#,
        "200 OK",
    );
    let path = std::env::temp_dir().join(format!("people-memory-test-{}.txt", std::process::id()));
    std::fs::write(&path, "Met today. Needs clinic design partners.\n").unwrap();
    let result = cli()
        .args([
            "memory",
            "capture",
            "--email",
            "person@example.test",
            "--name",
            "Person",
            "--source-kind",
            "voice-transcript",
            "--source-id",
            "meeting-123",
            "--text-file",
            path.to_str().unwrap(),
        ])
        .env("PEOPLEGRAPH_WEB_URL", &address)
        .env("PEOPLEGRAPH_WEB_TOKEN", "people_fixture_secret")
        .output()
        .unwrap();
    std::fs::remove_file(&path).unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    let request = received.recv_timeout(Duration::from_secs(3)).unwrap();
    assert!(request.starts_with("POST /api/people-agent/capture "));
    let body: serde_json::Value =
        serde_json::from_str(request.split_once("\r\n\r\n").unwrap().1).unwrap();
    assert_eq!(body["sourceId"], "meeting-123");
    assert_eq!(body["sourceKind"], "voice_transcript");
    assert_eq!(body["text"], "Met today. Needs clinic design partners.\n");
    let result: serde_json::Value = serde_json::from_slice(&result.stdout).unwrap();
    assert_eq!(result["data"]["duplicate"], true);
}

#[test]
fn memory_refuses_insecure_remote_origin_and_does_not_use_local_token() {
    let result = cli()
        .args([
            "memory",
            "--url",
            "http://example.test",
            "lookup",
            "--email",
            "person@example.test",
        ])
        .env("PEOPLEGRAPH_WEB_TOKEN", "people_fixture_secret")
        .output()
        .unwrap();
    assert!(!result.status.success());
    let data: serde_json::Value = serde_json::from_slice(&result.stdout).unwrap();
    assert_eq!(data["error"]["kind"], "invalid_web_url");
    let missing = cli()
        .args([
            "memory",
            "--url",
            "https://people.example.test",
            "lookup",
            "--email",
            "person@example.test",
        ])
        .env("PEOPLEGRAPH_TOKEN", "local_secret")
        .output()
        .unwrap();
    let data: serde_json::Value = serde_json::from_slice(&missing.stdout).unwrap();
    assert_eq!(data["error"]["kind"], "web_token_missing");
}

#[test]
fn memory_returns_safe_conflicts_without_echoing_server_error_details() {
    let (address, received) = fixture(
        r#"{"error":"idempotency_conflict","details":"private server detail"}"#,
        "409 Conflict",
    );
    let result = cli()
        .args([
            "memory",
            "--url",
            &address,
            "capture",
            "--email",
            "person@example.test",
            "--name",
            "Person",
            "--source-id",
            "meeting-123",
            "--text",
            "Different text",
        ])
        .env("PEOPLEGRAPH_WEB_TOKEN", "people_fixture_secret")
        .output()
        .unwrap();
    assert!(!result.status.success());
    received.recv_timeout(Duration::from_secs(3)).unwrap();
    let data: serde_json::Value = serde_json::from_slice(&result.stdout).unwrap();
    assert_eq!(data["error"]["kind"], "idempotency_conflict");
    assert!(!String::from_utf8_lossy(&result.stdout).contains("private server detail"));
}

const EDITABLE_PROFILE: &str = r#"{"personId":"person-1","revision":"7d31b22a-b5bf-4b8d-80e2-341bcb1bc023","text":"We met at the clinic.","company":"Clinic","building":"Handoff tools","needs":"Design partners","offers":"Nurse interviews","interests":["clinical workflows"],"pointPersonId":null,"notBefore":null,"relationship":"neutral"}"#;

#[test]
fn memory_save_posts_complete_profile_file_with_its_existing_revision() {
    let (address, received) = fixture(
        r#"{"personId":"person-1","revision":"new-revision"}"#,
        "200 OK",
    );
    let path = std::env::temp_dir().join(format!("people-memory-save-{}.json", std::process::id()));
    std::fs::write(&path, EDITABLE_PROFILE).unwrap();
    let result = cli()
        .args([
            "memory",
            "--url",
            &address,
            "save",
            "--file",
            path.to_str().unwrap(),
        ])
        .env("PEOPLEGRAPH_WEB_TOKEN", "people_fixture_secret")
        .output()
        .unwrap();
    std::fs::remove_file(&path).unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    let request = received.recv_timeout(Duration::from_secs(3)).unwrap();
    assert!(request.starts_with("POST /api/people-agent/save "));
    let actual: serde_json::Value =
        serde_json::from_str(request.split_once("\r\n\r\n").unwrap().1).unwrap();
    assert_eq!(
        actual,
        serde_json::from_str::<serde_json::Value>(EDITABLE_PROFILE).unwrap()
    );
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&result.stdout).unwrap()["ok"],
        true
    );
}

#[test]
fn memory_save_stdin_returns_stale_revision_conflict_without_retry_or_refresh() {
    let (address, received) = fixture(r#"{"error":"person_context_conflict"}"#, "409 Conflict");
    let mut process = cli()
        .args(["memory", "--url", &address, "save", "--file", "-"])
        .env("PEOPLEGRAPH_WEB_TOKEN", "people_fixture_secret")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    process
        .stdin
        .take()
        .unwrap()
        .write_all(EDITABLE_PROFILE.as_bytes())
        .unwrap();
    let result = process.wait_with_output().unwrap();
    assert!(!result.status.success());
    let data: serde_json::Value = serde_json::from_slice(&result.stdout).unwrap();
    assert_eq!(data["error"]["kind"], "person_context_conflict");
    let request = received.recv_timeout(Duration::from_secs(3)).unwrap();
    assert!(request.starts_with("POST /api/people-agent/save "));
    // The fixture handles exactly one request then closes. Any retry or automatic
    // lookup would lose the original conflict or attempt a closed connection.
    assert!(received.try_recv().is_err());
    assert!(!String::from_utf8_lossy(&result.stdout).contains("people_fixture_secret"));
}

#[test]
fn memory_save_rejects_oversized_non_utf8_and_non_object_files_before_network_access() {
    for (suffix, bytes, error) in [
        ("large", vec![b' '; 80_001], "memory_file_too_large"),
        ("utf8", vec![0xff, 0xfe], "memory_file_unreadable"),
        ("array", b"[]".to_vec(), "invalid_memory_file"),
        ("json", b"{invalid".to_vec(), "invalid_memory_file"),
    ] {
        let path = std::env::temp_dir().join(format!(
            "people-memory-{suffix}-{}.json",
            std::process::id()
        ));
        std::fs::write(&path, bytes).unwrap();
        let result = cli()
            .args([
                "memory",
                "--url",
                "http://127.0.0.1:9",
                "save",
                "--file",
                path.to_str().unwrap(),
            ])
            .env("PEOPLEGRAPH_WEB_TOKEN", "people_fixture_secret")
            .output()
            .unwrap();
        std::fs::remove_file(&path).unwrap();
        assert!(!result.status.success());
        let data: serde_json::Value = serde_json::from_slice(&result.stdout).unwrap();
        assert_eq!(data["error"]["kind"], error);
    }
}
