use serde_json::{Value, json};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::Duration;

const TOKEN: &str = "people_fixture_secret";

fn home(name: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!("peoplegraph-peer-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&path);
    path
}

fn cli(home: &PathBuf) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_peoplegraph"));
    for key in [
        "PEOPLEGRAPH_WEB_URL",
        "PEOPLEGRAPH_WEB_TOKEN",
        "PEOPLEGRAPH_HOST",
        "PEOPLEGRAPH_TOKEN",
        "PEOPLEGRAPH_CACHE",
        "PEOPLEGRAPH_PEER_TEST_IDENTITY",
    ] {
        command.env_remove(key);
    }
    command
        .env("HOME", home)
        .env("XDG_CONFIG_HOME", home.join("config"));
    command
}

fn run(command: &mut Command) -> Value {
    let output = command.output().unwrap();
    serde_json::from_slice(&output.stdout).unwrap_or_else(|_| {
        panic!(
            "stdout: {} stderr: {}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        )
    })
}

fn peers_file(home: &Path) -> PathBuf {
    home.join("config/peoplegraph/peers.json")
}

/// A hosted People stand-in answering the two owner-only peer routes through the machine endpoint.
fn hosted() -> String {
    let server = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = format!("http://{}", server.local_addr().unwrap());
    thread::spawn(move || {
        for stream in server.incoming() {
            let mut stream = stream.unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let mut data = Vec::new();
            let mut chunk = [0; 4096];
            loop {
                let size = stream.read(&mut chunk).unwrap_or(0);
                if size == 0 {
                    break;
                }
                data.extend_from_slice(&chunk[..size]);
                if let Some(offset) = data.windows(4).position(|b| b == b"\r\n\r\n") {
                    let headers = String::from_utf8_lossy(&data[..offset]).to_ascii_lowercase();
                    let length = headers
                        .lines()
                        .find_map(|l| l.strip_prefix("content-length:"))
                        .and_then(|v| v.trim().parse::<usize>().ok())
                        .unwrap_or(0);
                    if data.len() >= offset + 4 + length {
                        break;
                    }
                }
            }
            let text = String::from_utf8_lossy(&data);
            let envelope: Value = text
                .split_once("\r\n\r\n")
                .and_then(|(_, body)| serde_json::from_str(body).ok())
                .unwrap_or(Value::Null);
            let path = envelope["path"].as_str().unwrap_or("");
            let body = if path == "/api/people/peer-directory" {
                json!({"people":[{"personId":"p-ada","emails":["ada@example.test"]}]})
            } else if path.contains("type=knows") {
                json!({"known":true,"band":"strong","lastContactMonth":"2026-10"})
            } else if path.contains("type=catch_up") {
                json!({"signals":[
                    {"category":"travel","tier":"open","summary":"Back from Japan","observedMonth":"2026-10","expiresAt":"2026-12-01T00:00:00.000Z"},
                    {"category":"milestone","tier":"personal","summary":"Got married","observedMonth":"2026-09","expiresAt":"2027-03-01T00:00:00.000Z"}
                ]})
            } else {
                json!({"error":"not_found"})
            }
            .to_string();
            let _ = write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
        }
    });
    address
}

struct Server(Child);

impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

/// Start `peer serve` on loopback with a fixed test caller; returns the server and its address.
fn serve(home: &PathBuf, origin: &str, caller: &str) -> (Server, String) {
    let mut child = cli(home)
        .args(["peer", "serve", "--port", "0", "--test-bind", "127.0.0.1"])
        .env("PEOPLEGRAPH_WEB_URL", origin)
        .env("PEOPLEGRAPH_WEB_TOKEN", TOKEN)
        .env("PEOPLEGRAPH_PEER_TEST_IDENTITY", caller)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let mut line = String::new();
    BufReader::new(child.stdout.take().unwrap())
        .read_line(&mut line)
        .unwrap();
    let ready: Value = serde_json::from_str(&line).unwrap_or_else(|_| panic!("ready: {line}"));
    let listening = ready["data"]["listening"].as_str().unwrap().to_owned();
    (Server(child), format!("http://{listening}"))
}

#[test]
fn init_keeps_the_pepper_private_and_refuses_shared_files() {
    let home = home("init");
    let output = cli(&home)
        .args(["peer", "init", "--group", "betaworks"])
        .output()
        .unwrap();
    let value: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(value["ok"], true, "{value}");
    let file: Value = serde_json::from_slice(&std::fs::read(peers_file(&home)).unwrap()).unwrap();
    let pepper = file["pepper"].as_str().unwrap();
    assert!(pepper.len() >= 64);
    assert!(!String::from_utf8_lossy(&output.stdout).contains(pepper));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(peers_file(&home))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
    }
    let status = cli(&home).args(["peer", "status"]).output().unwrap();
    assert!(!String::from_utf8_lossy(&status.stdout).contains(pepper));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(peers_file(&home), std::fs::Permissions::from_mode(0o644))
            .unwrap();
        let refused = run(cli(&home).args(["peer", "status"]));
        assert_eq!(refused["ok"], false);
        assert_eq!(refused["error"]["kind"], "config_permissions");
    }
}

#[test]
fn peers_answer_attribute_hold_personal_signals_and_report_gaps() {
    let (answerer, asker) = (home("answerer"), home("asker"));
    let origin = hosted();
    assert_eq!(
        run(cli(&answerer).args(["peer", "init", "--group", "betaworks"]))["ok"],
        true
    );
    run(cli(&answerer).args(["peer", "allow", "asker@example.test"]));
    let pepper = serde_json::from_slice::<Value>(&std::fs::read(peers_file(&answerer)).unwrap())
        .unwrap()["pepper"]
        .as_str()
        .unwrap()
        .to_owned();
    let mut join = cli(&asker)
        .args(["peer", "join", "--group", "betaworks", "--pepper-stdin"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    join.stdin
        .take()
        .unwrap()
        .write_all(pepper.as_bytes())
        .unwrap();
    let joined: Value = serde_json::from_slice(&join.wait_with_output().unwrap().stdout).unwrap();
    assert_eq!(joined["ok"], true, "{joined}");
    let (_server, address) = serve(&answerer, &origin, "asker@example.test");
    run(cli(&asker).args([
        "peer",
        "add",
        "answerer@example.test",
        "--address",
        &address,
    ]));
    run(cli(&asker).args([
        "peer",
        "add",
        "ghost@example.test",
        "--address",
        "http://127.0.0.1:9",
    ]));

    let knows = run(cli(&asker).args(["peer", "ask", "knows", "Ada@Example.test"]));
    assert_eq!(knows["ok"], true, "{knows}");
    assert_eq!(knows["data"]["results"][0]["peer"], "answerer@example.test");
    assert_eq!(knows["data"]["results"][0]["answer"]["band"], "strong");
    assert_eq!(knows["data"]["gaps"][0]["peer"], "ghost@example.test");

    let catch_up = run(cli(&asker).args(["peer", "ask", "catch-up", "ada@example.test"]));
    let held = &catch_up["data"]["results"][0];
    assert_eq!(held["status"], 202, "{catch_up}");
    let text = held.to_string();
    assert!(
        text.contains("Back from Japan") && !text.contains("married"),
        "{text}"
    );
    let ticket = held["answer"]["ticket"].as_str().unwrap().to_owned();

    let pending = run(cli(&answerer).args(["peer", "pending"]));
    assert_eq!(pending["data"]["tickets"][0]["id"], ticket.as_str());
    let approved = run(cli(&answerer)
        .args(["peer", "approve", &ticket])
        .env("PEOPLEGRAPH_WEB_URL", &origin)
        .env("PEOPLEGRAPH_WEB_TOKEN", TOKEN));
    assert_eq!(approved["ok"], true, "{approved}");

    let status = run(cli(&asker).args([
        "peer",
        "ask",
        "status",
        "--peer",
        "answerer@example.test",
        &ticket,
    ]));
    assert!(
        status["data"]["answer"].to_string().contains("Got married"),
        "{status}"
    );

    let log = run(cli(&answerer).args(["peer", "log"]));
    let entries = log["data"]["entries"].as_array().unwrap();
    assert!(entries.len() >= 3);
    assert!(entries.iter().all(|e| e["caller"] == "asker@example.test"));
    assert!(!log.to_string().contains("Japan"));
}

#[test]
fn serve_needs_tailscale() {
    let home = home("notailscale");
    run(cli(&home).args(["peer", "init", "--group", "betaworks"]));
    let value = run(cli(&home).args(["peer", "serve"]).env("PATH", ""));
    assert_eq!(value["ok"], false);
    assert_eq!(value["error"]["kind"], "tailscale_unavailable");
}

/// An answering home that allows `asker@example.test`, serving as `caller`.
fn answering(name: &str, caller: &str) -> (PathBuf, Server, String) {
    let home = home(name);
    run(cli(&home).args(["peer", "init", "--group", "betaworks"]));
    run(cli(&home).args(["peer", "allow", "asker@example.test"]));
    let (server, address) = serve(&home, &hosted(), caller);
    (home, server, address)
}

/// One raw request; returns the status line's code, or `None` if nothing came back in time.
fn raw(address: &str, request: &[u8], wait: Duration) -> Option<u16> {
    let mut stream = std::net::TcpStream::connect(address.trim_start_matches("http://")).unwrap();
    stream.set_read_timeout(Some(wait)).unwrap();
    stream.write_all(request).unwrap();
    let mut response = String::new();
    let _ = stream.read_to_string(&mut response);
    response.split_whitespace().nth(1)?.parse().ok()
}

fn knows(person: char) -> Vec<u8> {
    let body = json!({"type":"knows","person":person.to_string().repeat(64)}).to_string();
    format!(
        "POST /peer/v1/query HTTP/1.1\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
        body.len()
    )
    .into_bytes()
}

#[test]
fn an_answer_is_withheld_when_it_cannot_be_audited() {
    let (home, _server, address) = answering("audit", "asker@example.test");
    assert_eq!(
        raw(&address, &knows('a'), Duration::from_secs(5)),
        Some(200)
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let log = home.join("config/peoplegraph/peer-audit.jsonl");
        std::fs::set_permissions(&log, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert_eq!(
            raw(&address, &knows('b'), Duration::from_secs(5)),
            Some(503)
        );
    }
}

#[test]
fn non_members_are_refused_before_they_send_anything() {
    let (_home, _server, address) = answering("nonmember", "eve@example.test");
    assert_eq!(raw(&address, b"", Duration::from_secs(2)), Some(403));
}

#[test]
fn a_slow_member_does_not_hold_up_other_requests() {
    let (_home, _server, address) = answering("slow", "asker@example.test");
    let mut slow = std::net::TcpStream::connect(address.trim_start_matches("http://")).unwrap();
    slow.write_all(b"POST /peer/v1/query HTTP/1.1\r\n").unwrap();
    let started = std::time::Instant::now();
    assert_eq!(
        raw(&address, &knows('c'), Duration::from_secs(4)),
        Some(200)
    );
    assert!(
        started.elapsed() < Duration::from_secs(2),
        "{:?}",
        started.elapsed()
    );
    drop(slow);
}
