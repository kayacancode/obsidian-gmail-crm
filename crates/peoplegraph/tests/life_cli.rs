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

#[test]
fn structure_commands_use_the_structure_routes() {
    assert_eq!(
        sent(&["why-now", "--limit", "5"]),
        json!({"method":"GET","path":"/api/people/why-now?limit=5"})
    );
    assert_eq!(
        sent(&[
            "contrast",
            "nurse scheduling",
            "--claim",
            "nurses won't adopt apps"
        ]),
        json!({"method":"GET","path":"/api/people/contrast?topic=nurse%20scheduling&claim=nurses%20won%27t%20adopt%20apps"})
    );
    assert_eq!(
        sent(&["widen"]),
        json!({"method":"GET","path":"/api/people/widen"})
    );
    assert_eq!(
        sent(&["bridges", "--topic", "robotics"]),
        json!({"method":"GET","path":"/api/people/bridges?topic=robotics"})
    );
    assert_eq!(
        sent(&["atlas", "climate fintech"]),
        json!({"method":"GET","path":"/api/people/atlas?topic=climate%20fintech"})
    );
}

#[test]
fn structure_commands_need_hosted_people() {
    let output = cli().args(["--local", "widen"]).output().unwrap();
    let value: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(value["error"]["kind"], "incompatible_backend");
}

#[test]
fn mind_commands_use_the_curiosity_note_routes() {
    let note = std::env::temp_dir().join(format!("peoplegraph-note-{}.md", std::process::id()));
    std::fs::write(&note, "Agents\n\n## The fringes\n- nurse scheduling\n").unwrap();
    let path = note.to_str().unwrap();
    assert_eq!(
        sent(&["mind", "set", "--file", path]),
        json!({"method":"POST","path":"/api/people/mind","body":{"text":"Agents\n\n## The fringes\n- nurse scheduling\n"}})
    );
    assert_eq!(
        sent(&["mind", "set", "--file", path, "--id", "note_1"]),
        json!({"method":"POST","path":"/api/people/mind","body":{"text":"Agents\n\n## The fringes\n- nurse scheduling\n","id":"note_1"}})
    );
    assert_eq!(
        sent(&["mind", "list", "--archived"]),
        json!({"method":"GET","path":"/api/people/mind?includeArchived=1"})
    );
    assert_eq!(
        sent(&["mind", "archive", "note_1"]),
        json!({"method":"POST","path":"/api/people/mind/archive","body":{"id":"note_1"}})
    );
    let (_, shown) = run(&["mind", "show", "note_1"]);
    assert_eq!(
        shown,
        json!({"method":"GET","path":"/api/people/mind?includeArchived=1"})
    );
    let _ = std::fs::remove_file(note);
}

#[test]
fn moments_commands_use_the_moment_routes() {
    assert_eq!(
        sent(&["moments", "--today"]),
        json!({"method":"GET","path":"/api/people/moments?today=1"})
    );
    assert_eq!(
        sent(&["moments"]),
        json!({"method":"GET","path":"/api/people/moments"})
    );
    for (action, word) in [("act", "act"), ("snooze", "snooze"), ("dismiss", "dismiss")] {
        assert_eq!(
            sent(&["moments", action, "2026-11-21:bridge:a+b"]),
            json!({"method":"POST","path":"/api/people/moments/update","body":{"id":"2026-11-21:bridge:a+b","action":word}})
        );
    }
    assert_eq!(
        sent(&["moments", "budget", "2"]),
        json!({"method":"POST","path":"/api/people/moments/settings","body":{"budget":2}})
    );
}

#[test]
fn intros_commands_use_the_introduction_routes() {
    assert_eq!(
        sent(&["intros", "list"]),
        json!({"method":"GET","path":"/api/people/introductions"})
    );
    assert_eq!(
        sent(&[
            "intros",
            "propose",
            "--parties",
            "person_a,person_b",
            "--reason",
            "Both on nurse scheduling"
        ]),
        json!({"method":"POST","path":"/api/people/introductions","body":{"introducer":"owner","parties":["person_a","person_b"],"reason":"Both on nurse scheduling"}})
    );
    assert_eq!(
        sent(&[
            "intros",
            "propose",
            "--introducer",
            "person_j",
            "--parties",
            "owner,person_b",
            "--reason",
            "John knows Bo"
        ]),
        json!({"method":"POST","path":"/api/people/introductions","body":{"introducer":"person_j","parties":["owner","person_b"],"reason":"John knows Bo"}})
    );
    assert_eq!(
        sent(&[
            "intros",
            "advance",
            "intro_1",
            "introducer_accepted",
            "--vouch",
            "Ada ships"
        ]),
        json!({"method":"POST","path":"/api/people/introductions/advance","body":{"id":"intro_1","to":"introducer_accepted","vouch":"Ada ships"}})
    );
    assert_eq!(
        sent(&["intros", "outcome", "intro_1", "met", "--note", "Coffee"]),
        json!({"method":"POST","path":"/api/people/introductions/outcome","body":{"id":"intro_1","result":"met","note":"Coffee"}})
    );
    let (_, shown) = run(&["intros", "show", "intro_1"]);
    assert_eq!(
        shown,
        json!({"method":"GET","path":"/api/people/introductions"})
    );
}

#[test]
fn guest_commands_use_the_guest_ask_routes() {
    assert_eq!(
        sent(&["guest", "pending"]),
        json!({"method":"GET","path":"/api/people/guest-asks"})
    );
    assert_eq!(
        sent(&["guest", "answer", "ga_1"]),
        json!({"method":"POST","path":"/api/people/guest-asks/answer","body":{"id":"ga_1"}})
    );
    let draft = std::env::temp_dir().join(format!("guest-draft-{}.json", std::process::id()));
    std::fs::write(
        &draft,
        r#"{"text":"One person fits.","people":[{"ref":"p1","description":"A design lead"}]}"#,
    )
    .unwrap();
    assert_eq!(
        sent(&["guest", "answer", "ga_1", "--file", draft.to_str().unwrap()]),
        json!({"method":"POST","path":"/api/people/guest-asks/answer","body":{"id":"ga_1","answer":{"text":"One person fits.","people":[{"ref":"p1","description":"A design lead"}]}}})
    );
    std::fs::remove_file(&draft).unwrap();
    assert_eq!(
        sent(&["guest", "decline", "ga_1"]),
        json!({"method":"POST","path":"/api/people/guest-asks/decline","body":{"id":"ga_1"}})
    );
    assert_eq!(
        sent(&["guest", "on"]),
        json!({"method":"POST","path":"/api/people/guest-asks/settings","body":{"enabled":true}})
    );
    assert_eq!(
        sent(&["guest", "off"]),
        json!({"method":"POST","path":"/api/people/guest-asks/settings","body":{"enabled":false}})
    );
    let (_, shown) = run(&["guest", "show", "ga_1"]);
    assert_eq!(
        shown,
        json!({"method":"GET","path":"/api/people/guest-asks"})
    );
}

#[test]
fn hosted_find_person_sends_include_self_and_strict_name_order() {
    let (_, plain) = run(&["find-person", "Kaya"]);
    assert_eq!(
        plain,
        json!({"command":"find-person","query":"Kaya","limit":10})
    );
    let (_, flagged) = run(&[
        "find-person",
        "Jon Chin",
        "--include-self",
        "--strict-name-order",
    ]);
    assert_eq!(
        flagged,
        json!({"command":"find-person","query":"Jon Chin","limit":10,"include_self":true,"strict_name_order":true})
    );
}
