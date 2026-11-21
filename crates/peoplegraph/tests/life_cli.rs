use serde_json::{Value, json};
use std::io::{Read, Write};
use std::net::TcpListener;
use std::process::{Command, Output};
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

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
    let home = std::env::temp_dir().join(format!("peoplegraph-life-home-{}", std::process::id()));
    command
        .env("HOME", &home)
        .env("XDG_CONFIG_HOME", home.join("config"));
    command
}

/// One-shot HTTP server: answers `body` and reports the raw request it received.
fn fixture(body: &'static str) -> (String, mpsc::Receiver<String>) {
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
        write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
        send.send(String::from_utf8(data).unwrap()).unwrap();
    });
    (address, receive)
}

fn run(args: &[&str]) -> (Output, Value) {
    let (address, received) = fixture(r#"{"ok":true}"#);
    let output = cli()
        .args(args)
        .env("PEOPLEGRAPH_WEB_URL", &address)
        .env("PEOPLEGRAPH_WEB_TOKEN", "people_fixture_secret")
        .output()
        .unwrap();
    let request = received.recv_timeout(Duration::from_secs(5)).unwrap();
    let body = request.split_once("\r\n\r\n").unwrap().1;
    (output, serde_json::from_str(body).unwrap())
}

fn sent(args: &[&str]) -> Value {
    let (output, body) = run(args);
    assert!(
        output.status.success(),
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    body
}

#[test]
fn signals_on_off_and_forget_use_the_life_routes() {
    assert_eq!(
        sent(&["signals", "on"]),
        json!({"method":"POST","path":"/api/people/signals/settings","body":{"enabled":true}})
    );
    assert_eq!(
        sent(&["signals", "off"]),
        json!({"method":"POST","path":"/api/people/signals/settings","body":{"enabled":false}})
    );
    assert_eq!(
        sent(&["signals", "forget", "--all"]),
        json!({"method":"DELETE","path":"/api/people/signals","body":{"all":true}})
    );
    assert_eq!(
        sent(&["signals", "list", "--person", "person_123456789012345678"]),
        json!({"method":"GET","path":"/api/people/signals?personId=person_123456789012345678"})
    );
}

#[test]
fn brief_routes_email_name_and_id_to_the_right_parameter() {
    assert_eq!(
        sent(&["brief", "maya@acme.com"]),
        json!({"method":"GET","path":"/api/people/brief?email=maya%40acme.com"})
    );
    assert_eq!(
        sent(&["brief", "Maya Rivera"]),
        json!({"method":"GET","path":"/api/people/brief?query=Maya%20Rivera"})
    );
    assert_eq!(
        sent(&["brief", "Hk3xQ9bZ_aL2mN8pR4sT6vW1yC5dE7fG"]),
        json!({"method":"GET","path":"/api/people/brief?personId=Hk3xQ9bZ_aL2mN8pR4sT6vW1yC5dE7fG"})
    );
}

#[test]
fn me_and_stints_send_owner_edits() {
    assert_eq!(
        sent(&[
            "me",
            "add",
            "Moved to Lisbon",
            "--category",
            "moved",
            "--date",
            "2026-03-01"
        ]),
        json!({"method":"POST","path":"/api/people/timeline","body":{"text":"Moved to Lisbon","category":"moved","date":"2026-03-01"}})
    );
    assert_eq!(
        sent(&["me", "forget", "entry-1"]),
        json!({"method":"DELETE","path":"/api/people/timeline","body":{"id":"entry-1"}})
    );
    assert_eq!(
        sent(&[
            "stints",
            "set",
            "person_1",
            "--company",
            "Acme",
            "--from",
            "2023-01",
            "--to",
            "2024-06"
        ]),
        json!({"method":"POST","path":"/api/people/stints","body":{"personId":"person_1","company":"Acme","from":"2023-01","to":"2024-06"}})
    );
    assert_eq!(
        sent(&["job-moves"]),
        json!({"method":"GET","path":"/api/people/job-moves"})
    );
    assert_eq!(
        sent(&["teammates", "person_1"]),
        json!({"method":"GET","path":"/api/people/teammates?personId=person_1"})
    );
}

#[test]
fn who_knows_include_former_is_hosted_only() {
    let output = cli()
        .args([
            "--local",
            "who-knows",
            "--company",
            "acme",
            "--include-former",
        ])
        .output()
        .unwrap();
    let value: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(value["error"]["kind"], "unsupported_locally");
    let (_, body) = run(&["who-knows", "--company", "acme", "--include-former"]);
    assert_eq!(body["include_former"], true);
}
