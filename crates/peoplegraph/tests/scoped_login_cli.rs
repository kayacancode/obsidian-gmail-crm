use serde_json::{Value, json};
use std::fs;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::PathBuf;
use std::process::{Command, Output};
use std::sync::{
    atomic::{AtomicU64, Ordering},
    mpsc,
};
use std::thread;
use std::time::{Duration, Instant};

const TOKEN: &str = "people_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
static NEXT: AtomicU64 = AtomicU64::new(0);
struct Sandbox(PathBuf);
impl Sandbox {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "pg-scoped-login-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&path).unwrap();
        Self(path)
    }
    fn cli(&self) -> Command {
        let mut cmd = Command::new(env!("CARGO_BIN_EXE_peoplegraph"));
        for key in [
            "PEOPLEGRAPH_WEB_URL",
            "PEOPLEGRAPH_WEB_TOKEN",
            "PEOPLEGRAPH_HOST",
            "PEOPLEGRAPH_TOKEN",
            "PEOPLEGRAPH_CACHE",
        ] {
            cmd.env_remove(key);
        }
        cmd.env("HOME", &self.0)
            .env("XDG_CONFIG_HOME", self.0.join("config"));
        cmd
    }
    fn config(&self) -> PathBuf {
        self.0.join("config/peoplegraph/config.json")
    }
}
impl Drop for Sandbox {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn envelope(output: &Output) -> Value {
    serde_json::from_slice(&output.stdout)
        .unwrap_or_else(|error| panic!("{error}: {}", String::from_utf8_lossy(&output.stderr)))
}
fn fixture(responses: Vec<Value>) -> (String, mpsc::Receiver<String>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(60);
        for response in responses {
            let mut stream = loop {
                match listener.accept() {
                    Ok((stream, _)) => break stream,
                    Err(error)
                        if error.kind() == std::io::ErrorKind::WouldBlock
                            && Instant::now() < deadline =>
                    {
                        thread::sleep(Duration::from_millis(10))
                    }
                    _ => return,
                }
            };
            stream.set_nonblocking(false).unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(20)))
                .unwrap();
            let mut bytes = Vec::new();
            let mut buffer = [0; 2048];
            loop {
                let n = stream.read(&mut buffer).unwrap();
                if n == 0 {
                    break;
                }
                bytes.extend_from_slice(&buffer[..n]);
                if let Some(offset) = bytes.windows(4).position(|part| part == b"\r\n\r\n") {
                    let headers = String::from_utf8_lossy(&bytes[..offset]);
                    let length = headers
                        .lines()
                        .find_map(|line| {
                            line.to_ascii_lowercase()
                                .strip_prefix("content-length:")
                                .and_then(|s| s.trim().parse::<usize>().ok())
                        })
                        .unwrap_or(0);
                    if bytes.len() >= offset + 4 + length {
                        break;
                    }
                }
            }
            let body = response.to_string();
            write!(stream,"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).unwrap();
            let _ = tx.send(String::from_utf8(bytes).unwrap());
        }
    });
    (origin, rx)
}
fn start_response() -> Value {
    json!({"challengeId":"a".repeat(64),"pollSecret":"b".repeat(64),"userCode":"ABCDEF123456","interval":5})
}
fn poll_response(scopes: Value) -> Value {
    json!({"token":TOKEN,"owner":"owner@test","expiresAt":4_000_000_000u64,"scopes":scopes})
}
fn request_body(request: &str) -> Value {
    serde_json::from_str(request.split_once("\r\n\r\n").unwrap().1).unwrap()
}

#[test]
fn browser_login_persists_one_scoped_key_for_graph_and_private_commands_then_self_revokes() {
    let sandbox = Sandbox::new();
    let scopes = json!(["people:read", "people:write", "sources:manage"]);
    let (origin, rx) = fixture(vec![
        start_response(),
        poll_response(scopes.clone()),
        json!({"ok":true,"command":"find-person","data":{"people":[{"id":"ada"}]},"stats":{}}),
        json!({"fields":{"focus":"Saved lens"},"revision":"r1"}),
        json!({"revoked":true}),
    ]);
    let login = sandbox
        .cli()
        .args([
            "login",
            "--url",
            &origin,
            "--no-browser",
            "--write",
            "--scope",
            "sources:manage",
        ])
        .output()
        .unwrap();
    assert!(
        login.status.success(),
        "{}",
        String::from_utf8_lossy(&login.stderr)
    );
    assert_eq!(envelope(&login)["data"]["scopes"], scopes);
    assert_eq!(
        request_body(&rx.recv_timeout(Duration::from_secs(1)).unwrap())["scopes"],
        scopes
    );
    assert!(
        rx.recv_timeout(Duration::from_secs(1))
            .unwrap()
            .starts_with("POST /api/cli/device/poll ")
    );
    let saved: Value = serde_json::from_slice(&fs::read(sandbox.config()).unwrap()).unwrap();
    assert_eq!(saved["profiles"][0]["token"], TOKEN);
    assert_eq!(saved["active_origin"], origin);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(sandbox.config()).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
    let graph = sandbox.cli().args(["find-person", "Ada"]).output().unwrap();
    assert!(
        graph.status.success(),
        "{}",
        String::from_utf8_lossy(&graph.stdout)
    );
    assert_eq!(envelope(&graph)["data"]["people"][0]["id"], "ada");
    let request = rx.recv_timeout(Duration::from_secs(1)).unwrap();
    assert!(request.starts_with("POST /api/cli/v1/query "));
    assert!(request.contains(TOKEN));
    let lens = sandbox.cli().arg("lens").output().unwrap();
    assert!(
        lens.status.success(),
        "{}",
        String::from_utf8_lossy(&lens.stdout)
    );
    assert_eq!(envelope(&lens)["data"]["fields"]["focus"], "Saved lens");
    let request = rx.recv_timeout(Duration::from_secs(1)).unwrap();
    assert!(request.starts_with("GET /api/people-agent/lens "));
    assert!(request.contains(TOKEN));
    let logout = sandbox.cli().arg("logout").output().unwrap();
    assert!(
        logout.status.success(),
        "{}",
        String::from_utf8_lossy(&logout.stdout)
    );
    assert!(!sandbox.config().exists());
    let request = rx.recv_timeout(Duration::from_secs(1)).unwrap();
    assert!(request.starts_with("POST /api/cli/logout "));
    assert!(request.contains(TOKEN));
    for output in [login, graph, lens, logout] {
        assert!(!String::from_utf8_lossy(&output.stdout).contains(TOKEN));
        assert!(!String::from_utf8_lossy(&output.stderr).contains(TOKEN));
    }
}

#[test]
fn login_revokes_and_refuses_a_key_with_unapproved_scopes() {
    let sandbox = Sandbox::new();
    let (origin, rx) = fixture(vec![
        start_response(),
        poll_response(json!(["people:read", "people:write"])),
        json!({"revoked":true}),
    ]);
    let output = sandbox
        .cli()
        .args(["login", "--url", &origin, "--no-browser"])
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert_eq!(envelope(&output)["error"]["kind"], "login_failed");
    assert!(!sandbox.config().exists());
    assert_eq!(
        request_body(&rx.recv_timeout(Duration::from_secs(1)).unwrap())["scopes"],
        json!(["people:read"])
    );
    let _ = rx.recv_timeout(Duration::from_secs(1)).unwrap();
    let revoked = rx.recv_timeout(Duration::from_secs(1)).unwrap();
    assert!(revoked.starts_with("POST /api/cli/logout "));
    assert!(revoked.contains(TOKEN));
    assert!(!String::from_utf8_lossy(&output.stdout).contains(TOKEN));
}
