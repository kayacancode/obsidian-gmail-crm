use serde_json::{Value, json};
use std::io::{Read, Write};
use std::net::TcpListener;
use std::process::Command;
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
    let home = std::env::temp_dir().join(format!("peoplegraph-ask-home-{}", std::process::id()));
    command
        .env("HOME", &home)
        .env("XDG_CONFIG_HOME", home.join("config"));
    command
}

fn sample() -> String {
    format!(
        "{}/fixtures/contact-index.sample.json",
        env!("CARGO_MANIFEST_DIR")
    )
}

fn local(question: &str) -> Value {
    let output = cli()
        .args(["--cache", &sample(), "ask", question])
        .output()
        .unwrap();
    serde_json::from_slice(&output.stdout).unwrap()
}

#[test]
fn hosted_ask_posts_the_question_to_the_ask_route() {
    let server = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = format!("http://{}", server.local_addr().unwrap());
    let (send, received) = mpsc::channel();
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
        let body = r#"{"interpretation":{"intent":"reconnect"}}"#;
        write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
        send.send(String::from_utf8(data).unwrap()).unwrap();
    });
    let output = cli()
        .args(["ask", "who should I reconnect with?"])
        .env("PEOPLEGRAPH_WEB_URL", &address)
        .env("PEOPLEGRAPH_WEB_TOKEN", "people_fixture_secret")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stdout)
    );
    let request = received.recv_timeout(Duration::from_secs(5)).unwrap();
    let body: Value = serde_json::from_str(request.split_once("\r\n\r\n").unwrap().1).unwrap();
    assert_eq!(
        body,
        json!({"method":"POST","path":"/api/people/ask","body":{"question":"who should I reconnect with?"}})
    );
}

#[test]
fn local_company_question_runs_who_knows() {
    let value = local("Who do I know at Disney?");
    assert_eq!(value["ok"], true, "{value}");
    assert_eq!(value["data"]["interpretation"]["intent"], "company");
    assert_eq!(
        value["data"]["interpretation"]["params"]["company"],
        "Disney"
    );
    assert_eq!(value["data"]["interpretation"]["classifier"], "local_rules");
    let people = value["data"]["result"]["people"].as_array().unwrap();
    assert!(people.iter().any(|p| p["name"] == "Maya Rivera"));
}

#[test]
fn local_lookup_resolves_an_exact_email() {
    let value = local("tell me about maya.rivera@disney.com");
    assert_eq!(value["data"]["interpretation"]["intent"], "lookup");
    assert_eq!(value["data"]["result"]["matches"][0]["name_match"], "exact");
}

#[test]
fn local_mode_refuses_questions_it_cannot_answer() {
    let value = local("draft an intro for me");
    assert_eq!(value["ok"], false);
    assert_eq!(value["error"]["kind"], "unsupported_locally");
    assert_eq!(value["data"]["interpretation"]["intent"], "clarify");
}
