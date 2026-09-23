use crate::{
    Cli, Commands, Response, fail, ok, unix_seconds,
    web_profile::{self, WebProfile},
};
use serde_json::{Value, json};
use std::{
    path::Path,
    time::{Duration, Instant},
};
const DEFAULT_ORIGIN: &str = "https://people-graph.kayarjones901.workers.dev";
fn post(
    origin: &str,
    path: &str,
    body: Value,
    token: Option<&str>,
) -> Result<(u16, Value), String> {
    let origin = web_profile::origin(origin)?;
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .http_status_as_error(false)
        .max_redirects(0)
        .timeout_global(Some(Duration::from_secs(30)))
        .build()
        .into();
    let mut request = agent
        .post(format!("{origin}/api/cli/{path}"))
        .header("Content-Type", "application/json");
    if let Some(token) = token {
        request = request.header("Authorization", format!("Bearer {token}"));
    }
    let mut response = request
        .send(serde_json::to_vec(&body).map_err(|_| "Could not encode request.")?)
        .map_err(|_| "Could not reach People. Check your connection and try again.")?;
    let status = response.status().as_u16();
    if (300..400).contains(&status) {
        return Err("People redirected the request; credentials were not forwarded.".into());
    }
    let text = response
        .body_mut()
        .with_config()
        .limit(4 * 1024 * 1024)
        .read_to_string()
        .map_err(|_| "Could not read People response.")?;
    let data = serde_json::from_str(&text).map_err(|_| "People returned an invalid response.")?;
    Ok((status, data))
}
pub fn login(cli: &Cli, path: &Path, start: Instant) -> Response {
    let result = (|| -> Result<Value, String> {
        let origin = web_profile::origin(cli.host.as_deref().unwrap_or(DEFAULT_ORIGIN))?;
        let name = std::env::var("HOSTNAME")
            .or_else(|_| std::env::var("COMPUTERNAME"))
            .unwrap_or_else(|_| "People CLI".into());
        let (status, data) = post(
            &origin,
            "device/start",
            json!({"deviceName":name.chars().take(80).collect::<String>()}),
            None,
        )?;
        if status != 200 {
            return Err(format!("People could not start login (HTTP {status})."));
        }
        let challenge = data["challengeId"]
            .as_str()
            .ok_or("Invalid login challenge.")?;
        let secret = data["pollSecret"]
            .as_str()
            .ok_or("Invalid login challenge.")?;
        let code = data["userCode"]
            .as_str()
            .filter(|c| c.len() == 12 && c.bytes().all(|b| b.is_ascii_hexdigit()))
            .ok_or("Invalid approval code.")?;
        // Construct the URL from the validated origin; never open an arbitrary server-provided URL.
        let url = format!("{origin}/cli");
        eprintln!(
            "Open {url}\nEnter code: {code}\nApprove read-only access to your People account."
        );
        #[cfg(target_os = "macos")]
        if !matches!(cli.command, Commands::Login { no_browser: true }) {
            let _ = std::process::Command::new("open").arg(&url).output();
        }
        #[cfg(target_os = "linux")]
        if !matches!(cli.command, Commands::Login { no_browser: true }) {
            let _ = std::process::Command::new("xdg-open").arg(&url).output();
        }
        let deadline = Instant::now() + Duration::from_secs(600);
        while Instant::now() < deadline {
            std::thread::sleep(Duration::from_secs(5));
            let (status, result) = post(
                &origin,
                "device/poll",
                json!({"challengeId":challenge,"pollSecret":secret}),
                None,
            )?;
            if status == 202 || status == 429 {
                continue;
            }
            if status != 200 {
                return Err(
                    "Login expired or was already used. Run peoplegraph login again.".into(),
                );
            }
            let token = result["token"]
                .as_str()
                .filter(|t| t.starts_with("pgd1_") && t.len() == 69)
                .ok_or("Invalid device credential.")?;
            let owner = result["owner"]
                .as_str()
                .ok_or("Invalid account response.")?;
            let expires_at = result["expiresAt"]
                .as_u64()
                .filter(|t| *t > unix_seconds())
                .ok_or("Invalid credential expiry.")?;
            let profile = WebProfile {
                version: 1,
                backend: "people-web".into(),
                origin: origin.clone(),
                owner: owner.into(),
                token: token.into(),
                expires_at,
            };
            if let Err(error) = web_profile::save_profile(path, &profile) {
                let _ = post(&origin, "logout", json!({}), Some(token));
                return Err(error);
            }
            return Ok(
                json!({"owner":owner,"source":"people-web","origin":origin,"expiresAt":expires_at}),
            );
        }
        Err("Login expired. Run peoplegraph login again.".into())
    })();
    match result {
        Ok(data) => ok("login", data, json!({})),
        Err(error) => fail("login", "login_failed", error, start),
    }
}
pub fn logout(profile: &WebProfile, path: &Path, start: Instant) -> Response {
    let result = (|| -> Result<(), String> {
        let (status, _) = post(&profile.origin, "logout", json!({}), Some(&profile.token))?;
        if status != 200 && status != 401 {
            return Err(
                "Could not revoke access; your local profile was retained. Try logout again."
                    .into(),
            );
        }
        web_profile::remove_profile(path)
    })();
    match result {
        Ok(()) => ok("logout", json!({"revoked":true}), json!({})),
        Err(message) => fail("logout", "logout_failed", message, start),
    }
}
pub fn query(profile: &WebProfile, cli: &Cli, command: &'static str, start: Instant) -> Response {
    let mut body = json!({"command":command});
    match &cli.command {
        Commands::FindPerson(a) => {
            if a.strict_name_order {
                return fail(
                    command,
                    "unsupported_operation",
                    "Strict name ordering is available only with --local.".into(),
                    start,
                );
            }
            body["query"] = json!(a.query);
            body["limit"] = json!(a.limit);
        }
        Commands::ContactCard(a) => body["query"] = json!(a.query),
        Commands::Score(a) | Commands::GetNeighbors(a) => body["email"] = json!(a.email),
        Commands::WhoKnows(a) => {
            body["company"] = json!(a.company);
            body["limit"] = json!(a.limit);
        }
        Commands::GetEdges(a) => {
            body["from"] = json!(a.from);
            body["to"] = json!(a.to);
        }
        Commands::Reconnect(a) => {
            body["limit"] = json!(a.limit);
            body["min_score"] = json!(a.min_score);
        }
        _ => {
            return fail(
                command,
                "unsupported_operation",
                "This command uses the Obsidian cache. Run it with --local.".into(),
                start,
            );
        }
    }
    if profile.expires_at <= unix_seconds() {
        return fail(
            command,
            "login_required",
            "Your People login expired. Run peoplegraph login.".into(),
            start,
        );
    }
    match post(&profile.origin, "v1/query", body, Some(&profile.token)) {
        Ok((401, _)) => fail(
            command,
            "login_required",
            "Your People access expired or was revoked. Run peoplegraph login.".into(),
            start,
        ),
        Ok((status, value)) => match serde_json::from_value::<Response>(value) {
            Ok(mut result)
                if status == 200
                    && result.command == command
                    && result.stats.as_ref().is_none_or(Value::is_object) =>
            {
                let stats = result.stats.get_or_insert(json!({}));
                stats["owner"] = json!(profile.owner);
                stats["backend"] = json!("people-web");
                result
            }
            _ => fail(
                command,
                "web_query_failed",
                format!("People returned HTTP {status}. No local fallback was used."),
                start,
            ),
        },
        Err(message) => fail(command, "web_query_failed", message, start),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::Parser;
    use std::{
        io::{Read, Write},
        net::TcpListener,
        thread,
    };
    #[test]
    fn malformed_stats_are_a_json_error_instead_of_a_panic() {
        let server = TcpListener::bind("127.0.0.1:0").unwrap();
        let origin = format!("http://{}", server.local_addr().unwrap());
        let task = thread::spawn(move || {
            let (mut stream, _) = server.accept().unwrap();
            let mut buf = [0; 4096];
            let _ = stream.read(&mut buf);
            let body = r#"{"ok":true,"command":"find-person","data":{},"stats":"bad"}"#;
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            )
            .unwrap();
        });
        let profile = WebProfile {
            version: 1,
            backend: "people-web".into(),
            origin,
            owner: "owner@test".into(),
            token: format!("pgd1_{}", "a".repeat(64)),
            expires_at: unix_seconds() + 600,
        };
        let cli = Cli::try_parse_from(["peoplegraph", "find-person", "Ada"]).unwrap();
        let result = query(&profile, &cli, "find-person", Instant::now());
        assert_eq!(result.error.unwrap().kind, "web_query_failed");
        task.join().unwrap();
    }
    #[test]
    fn failed_logout_keeps_profile_for_retry() {
        let dir = std::env::temp_dir().join(format!("pg-logout-{}", std::process::id()));
        let path = dir.join("profile.json");
        let profile = WebProfile {
            version: 1,
            backend: "people-web".into(),
            origin: "http://127.0.0.1:1".into(),
            owner: "owner@test".into(),
            token: format!("pgd1_{}", "a".repeat(64)),
            expires_at: unix_seconds() + 600,
        };
        web_profile::save_profile(&path, &profile).unwrap();
        assert!(!logout(&profile, &path, Instant::now()).ok);
        assert!(web_profile::load_profile(&path).unwrap().is_some());
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn redirects_never_forward_the_device_token() {
        let destination = TcpListener::bind("127.0.0.1:0").unwrap();
        destination.set_nonblocking(true).unwrap();
        let target = destination.local_addr().unwrap();
        let server = TcpListener::bind("127.0.0.1:0").unwrap();
        let origin = format!("http://{}", server.local_addr().unwrap());
        let task = thread::spawn(move || {
            let (mut stream, _) = server.accept().unwrap();
            let mut buf = [0; 4096];
            let _ = stream.read(&mut buf);
            write!(stream,"HTTP/1.1 307 Temporary Redirect\r\nLocation: http://{target}/steal\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").unwrap();
        });
        assert!(
            post(&origin, "v1/query", json!({}), Some("pgd1_secret"))
                .unwrap_err()
                .contains("not forwarded")
        );
        task.join().unwrap();
        assert!(destination.accept().is_err());
    }
    #[test]
    fn web_mutations_and_expired_profiles_fail_before_http() {
        let profile = WebProfile {
            version: 1,
            backend: "people-web".into(),
            origin: "http://127.0.0.1:1".into(),
            owner: "owner@test".into(),
            token: "pgd1_fake".into(),
            expires_at: 0,
        };
        let cli = Cli::try_parse_from(["peoplegraph", "find-person", "Ada"]).unwrap();
        assert_eq!(
            query(&profile, &cli, "find-person", Instant::now())
                .error
                .unwrap()
                .kind,
            "login_required"
        );
        let cli = Cli::try_parse_from([
            "peoplegraph",
            "feedback",
            "--email",
            "a@test",
            "--action",
            "boost",
        ])
        .unwrap();
        assert_eq!(
            query(&profile, &cli, "feedback", Instant::now())
                .error
                .unwrap()
                .kind,
            "unsupported_operation"
        );
    }
}
