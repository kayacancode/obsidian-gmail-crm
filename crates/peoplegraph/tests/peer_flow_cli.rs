use serde_json::{Value, json};
use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::thread;
use std::time::Duration;

fn home(name: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "peoplegraph-peerflow-{name}-{}",
        std::process::id()
    ));
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
    serde_json::from_slice(&output.stdout)
        .unwrap_or_else(|_| panic!("{}", String::from_utf8_lossy(&output.stdout)))
}

/// Serves every request with `respond(request body)` until the test ends.
fn server(respond: fn(&Value) -> Value) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = format!("http://{}", listener.local_addr().unwrap());
    thread::spawn(move || {
        for stream in listener.incoming() {
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
            let request: Value = text
                .split_once("\r\n\r\n")
                .and_then(|(_, body)| serde_json::from_str(body).ok())
                .unwrap_or(Value::Null);
            let body = respond(&request).to_string();
            let _ = write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
        }
    });
    address
}

fn peer_answers(request: &Value) -> Value {
    match request["type"].as_str() {
        Some("knows") => json!({"known":true,"band":"some","lastContactMonth":"2026-10"}),
        _ => {
            json!({"signals":[{"category":"travel","summary":"Back from Japan","observedMonth":"2026-10","expiresAt":"2026-12-01T00:00:00.000Z"}]})
        }
    }
}

/// An asker home in a group with one answering peer and one unreachable peer.
fn asker(name: &str) -> PathBuf {
    let home = home(name);
    let mut join = cli(&home)
        .args(["peer", "join", "--group", "betaworks", "--pepper-stdin"])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .spawn()
        .unwrap();
    join.stdin
        .take()
        .unwrap()
        .write_all(b"0123456789abcdef0123456789abcdef0123456789abcdef")
        .unwrap();
    join.wait().unwrap();
    let peer = server(peer_answers);
    run(cli(&home).args(["peer", "add", "maya@example.test", "--address", &peer]));
    run(cli(&home).args([
        "peer",
        "add",
        "ghost@example.test",
        "--address",
        "http://127.0.0.1:9",
    ]));
    home
}

#[test]
fn brief_with_peers_adds_attributed_peer_signals_and_gaps() {
    let home = asker("brief");
    let hosted = server(
        |_| json!({"person":{"id":"p-ada","name":"Ada"},"why":[{"kind":"note","summary":"Met at the robotics dinner","attribution":"first_hand","use":"rank"}],"gaps":[]}),
    );
    let value = run(cli(&home)
        .args(["brief", "ada@example.test", "--peers"])
        .env("PEOPLEGRAPH_WEB_URL", &hosted)
        .env("PEOPLEGRAPH_WEB_TOKEN", "people_fixture_secret"));
    assert_eq!(value["ok"], true, "{value}");
    let why = value["data"]["why"].as_array().unwrap();
    assert_eq!(why[0]["attribution"], "first_hand");
    let peer = why
        .iter()
        .find(|w| w["attribution"] == "peer:maya@example.test")
        .unwrap_or_else(|| panic!("{value}"));
    assert_eq!(peer["summary"], "Back from Japan");
    assert_eq!(peer["use"], "rank");
    assert!(
        value["data"]["gaps"]
            .as_array()
            .unwrap()
            .iter()
            .any(|g| g.as_str().unwrap().contains("ghost@example.test"))
    );
}

#[test]
fn network_questions_are_answered_by_peers_from_the_cli() {
    let home = asker("ask");
    let hosted = server(
        |_| json!({"interpretation":{"intent":"network_ask","params":{"person":"ada@example.test"},"confidence":0.9},"answers":[],"result":null,"gaps":["Peer questions run from the CLI: peoplegraph peer ask"]}),
    );
    let value = run(cli(&home)
        .args(["ask", "what do my peers know about ada@example.test"])
        .env("PEOPLEGRAPH_WEB_URL", &hosted)
        .env("PEOPLEGRAPH_WEB_TOKEN", "people_fixture_secret"));
    assert_eq!(value["ok"], true, "{value}");
    let peers = &value["data"]["peerResults"];
    assert_eq!(
        peers["knows"]["results"][0]["answer"]["known"], true,
        "{value}"
    );
    assert_eq!(
        peers["catchUp"]["results"][0]["answer"]["signals"][0]["summary"],
        "Back from Japan"
    );
    let gaps = value["data"]["gaps"].as_array().unwrap();
    assert!(
        !gaps
            .iter()
            .any(|g| g.as_str().unwrap().contains("run from the CLI"))
    );
    assert!(
        gaps.iter()
            .any(|g| g.as_str().unwrap().contains("ghost@example.test"))
    );
}

#[test]
fn network_questions_without_a_group_say_how_to_join() {
    let home = home("nogroup");
    let hosted = server(
        |_| json!({"interpretation":{"intent":"network_ask","params":{"person":"ada@example.test"},"confidence":0.9},"answers":[],"result":null,"gaps":["Peer questions run from the CLI: peoplegraph peer ask"]}),
    );
    let value = run(cli(&home)
        .args(["ask", "what do my peers know about ada@example.test"])
        .env("PEOPLEGRAPH_WEB_URL", &hosted)
        .env("PEOPLEGRAPH_WEB_TOKEN", "people_fixture_secret"));
    assert_eq!(value["ok"], true, "{value}");
    assert!(
        value["data"]["gaps"].to_string().contains("peer init"),
        "{value}"
    );
}
