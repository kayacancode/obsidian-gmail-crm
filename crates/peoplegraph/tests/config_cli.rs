use serde_json::{Value, json};
use std::fs;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::PathBuf;
use std::process::{Command, Output, Stdio};
use std::sync::{
    atomic::{AtomicU64, Ordering},
    mpsc,
};
use std::thread;
use std::time::Duration;

static SEQUENCE: AtomicU64 = AtomicU64::new(0);
const TOKEN: &str = "people_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

struct Sandbox(PathBuf);
impl Sandbox {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "people-config-test-{}-{}",
            std::process::id(),
            SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&path).unwrap();
        Self(path)
    }
    fn cli(&self) -> Command {
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
            .env("HOME", &self.0)
            .env("XDG_CONFIG_HOME", self.0.join("config"));
        command
    }
    fn path(&self) -> PathBuf {
        self.0.join("config/peoplegraph/config.json")
    }
    fn config(&self, value: Value) {
        fs::create_dir_all(self.path().parent().unwrap()).unwrap();
        fs::write(self.path(), serde_json::to_vec(&value).unwrap()).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(self.path(), fs::Permissions::from_mode(0o600)).unwrap();
        }
    }
}
impl Drop for Sandbox {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn envelope(output: &Output) -> Value {
    serde_json::from_slice(&output.stdout).unwrap()
}
fn fixture() -> (String, mpsc::Receiver<String>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let deadline = std::time::Instant::now() + Duration::from_secs(4);
        loop {
            match listener.accept() {
                Ok((mut stream, _)) => {
                    stream
                        .set_read_timeout(Some(Duration::from_secs(2)))
                        .unwrap();
                    let mut request = Vec::new();
                    let mut chunk = [0; 2048];
                    while !request.windows(4).any(|bytes| bytes == b"\r\n\r\n") {
                        let size = stream.read(&mut chunk).unwrap();
                        if size == 0 {
                            break;
                        }
                        request.extend_from_slice(&chunk[..size]);
                    }
                    let body = r#"{"fields":{"focus":"fixture"},"revision":"r1","updatedAt":1}"#;
                    write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
                    let _ = tx.send(String::from_utf8(request).unwrap());
                    return;
                }
                Err(error)
                    if error.kind() == std::io::ErrorKind::WouldBlock
                        && std::time::Instant::now() < deadline =>
                {
                    thread::sleep(Duration::from_millis(10))
                }
                _ => return,
            }
        }
    });
    (origin, rx)
}
fn profile(origin: &str, token: &str) -> Value {
    json!({"version":1,"active_origin":origin,"profiles":[{"origin":origin,"token":token}]})
}

#[test]
fn private_commands_load_active_origin_and_credential_without_environment() {
    let sandbox = Sandbox::new();
    let (origin, received) = fixture();
    sandbox.config(profile(&origin, TOKEN));
    let output = sandbox.cli().arg("lens").output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stdout)
    );
    let request = received.recv_timeout(Duration::from_secs(2)).unwrap();
    assert!(request.starts_with("GET /api/people-agent/lens "));
    assert!(
        request
            .to_lowercase()
            .contains(&format!("authorization: bearer {TOKEN}\r\n"))
    );
    assert_eq!(envelope(&output)["data"]["fields"]["focus"], "fixture");
    assert!(!String::from_utf8_lossy(&output.stdout).contains(TOKEN));
}

#[test]
fn stored_credential_is_never_sent_to_an_unconfigured_origin() {
    let sandbox = Sandbox::new();
    sandbox.config(profile("https://saved.example.test", TOKEN));
    let output = sandbox
        .cli()
        .args(["lens", "--url", "http://127.0.0.1:9"])
        .output()
        .unwrap();
    assert_eq!(envelope(&output)["error"]["kind"], "web_token_missing");
    assert!(!String::from_utf8_lossy(&output.stdout).contains(TOKEN));
}

#[test]
fn environment_credential_cannot_follow_a_different_explicit_origin() {
    let sandbox = Sandbox::new();
    let output = sandbox
        .cli()
        .args(["lens", "--url", "http://127.0.0.1:9"])
        .env("PEOPLEGRAPH_WEB_URL", "https://saved.example.test")
        .env("PEOPLEGRAPH_WEB_TOKEN", TOKEN)
        .output()
        .unwrap();
    assert_eq!(
        envelope(&output)["error"]["kind"],
        "credential_origin_mismatch"
    );
    assert!(!String::from_utf8_lossy(&output.stdout).contains(TOKEN));
}

#[test]
fn explicit_origin_selects_its_own_saved_credential() {
    let sandbox = Sandbox::new();
    let (origin, received) = fixture();
    sandbox.config(json!({"version":1,"active_origin":"https://first.example.test","profiles":[
        {"origin":"https://first.example.test","token":"people_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"},
        {"origin":origin,"token":TOKEN}
    ]}));
    let output = sandbox
        .cli()
        .args(["lens", "--url", &origin])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stdout)
    );
    let request = received.recv_timeout(Duration::from_secs(2)).unwrap();
    assert!(request.contains(TOKEN));
    assert!(!request.contains("people_bbbbb"));
}

#[cfg(unix)]
#[test]
fn insecure_or_symlink_config_is_rejected_without_leaking_contents() {
    use std::os::unix::fs::{PermissionsExt, symlink};
    let sandbox = Sandbox::new();
    sandbox.config(profile("http://127.0.0.1:9", TOKEN));
    fs::set_permissions(sandbox.path(), fs::Permissions::from_mode(0o644)).unwrap();
    let output = sandbox.cli().arg("lens").output().unwrap();
    assert_eq!(envelope(&output)["error"]["kind"], "config_permissions");
    assert!(!String::from_utf8_lossy(&output.stdout).contains(TOKEN));
    fs::set_permissions(sandbox.path(), fs::Permissions::from_mode(0o600)).unwrap();
    let real = sandbox.path().with_extension("real");
    fs::rename(sandbox.path(), &real).unwrap();
    symlink(real, sandbox.path()).unwrap();
    let output = sandbox.cli().arg("lens").output().unwrap();
    assert_eq!(envelope(&output)["error"]["kind"], "config_invalid");
}

#[test]
fn malformed_or_oversized_config_does_not_fall_back_to_other_credentials() {
    let sandbox = Sandbox::new();
    sandbox.config(profile("http://127.0.0.1:9", TOKEN));
    for text in [format!("{{invalid {TOKEN}"), " ".repeat(65_537)] {
        fs::write(sandbox.path(), text).unwrap();
        let output = sandbox.cli().arg("lens").output().unwrap();
        assert_eq!(envelope(&output)["error"]["kind"], "config_invalid");
        assert!(!String::from_utf8_lossy(&output.stdout).contains(TOKEN));
    }
}

#[test]
fn configure_reads_stdin_privately_and_preserves_other_origins() {
    let sandbox = Sandbox::new();
    sandbox.config(profile("https://first.example.test", TOKEN));
    let mut child = sandbox
        .cli()
        .args([
            "configure",
            "--url",
            "https://second.example.test/",
            "--token-stdin",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(format!("{TOKEN}\n").as_bytes())
        .unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{} / {}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let saved: Value = serde_json::from_slice(&fs::read(sandbox.path()).unwrap()).unwrap();
    assert_eq!(saved["active_origin"], "https://second.example.test");
    assert_eq!(saved["profiles"].as_array().unwrap().len(), 2);
    assert_eq!(saved["profiles"][0]["origin"], "https://first.example.test");
    assert!(!String::from_utf8_lossy(&output.stdout).contains(TOKEN));
    assert!(!String::from_utf8_lossy(&output.stderr).contains(TOKEN));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(sandbox.path()).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(
            fs::metadata(sandbox.path().parent().unwrap())
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
    }
}

#[test]
fn configure_rejects_device_or_oversized_keys_without_changing_saved_key() {
    let sandbox = Sandbox::new();
    sandbox.config(profile("https://first.example.test", TOKEN));
    let before = fs::read(sandbox.path()).unwrap();
    for value in [format!("pgd1_{}", "b".repeat(64)), "x".repeat(4097)] {
        let mut child = sandbox
            .cli()
            .args([
                "configure",
                "--url",
                "https://second.example.test",
                "--token-stdin",
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let _ = child.stdin.take().unwrap().write_all(value.as_bytes());
        let output = child.wait_with_output().unwrap();
        assert!(!output.status.success());
        assert!(
            ["invalid_credential", "insufficient_scope"]
                .contains(&envelope(&output)["error"]["kind"].as_str().unwrap())
        );
        assert_eq!(fs::read(sandbox.path()).unwrap(), before);
        assert!(!String::from_utf8_lossy(&output.stdout).contains(&value));
        assert!(!String::from_utf8_lossy(&output.stderr).contains(&value));
    }
}
