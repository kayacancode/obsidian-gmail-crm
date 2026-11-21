use serde_json::{Value, json};
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
};

const SAMPLE: &str = include_str!("../fixtures/contact-index.sample.json");

fn home(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("pg-discovery-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn vault(root: &Path) -> PathBuf {
    let cache = root.join(".obsidian/plugins/gmail-crm/contact-index.json");
    fs::create_dir_all(cache.parent().unwrap()).unwrap();
    fs::write(&cache, SAMPLE).unwrap();
    cache
}

fn obsidian(home: &Path, vaults: &[&Path]) {
    let dir = home.join("Library/Application Support/obsidian");
    fs::create_dir_all(&dir).unwrap();
    let mut map = serde_json::Map::new();
    for (i, path) in vaults.iter().enumerate() {
        map.insert(
            format!("v{i}"),
            json!({"path": path, "ts": i, "open": i == 0}),
        );
    }
    fs::write(
        dir.join("obsidian.json"),
        json!({"vaults": map}).to_string(),
    )
    .unwrap();
}

fn run(home: &Path, args: &[&str]) -> Value {
    let mut c = Command::new(env!("CARGO_BIN_EXE_peoplegraph"));
    for k in [
        "PEOPLEGRAPH_WEB_URL",
        "PEOPLEGRAPH_WEB_TOKEN",
        "PEOPLEGRAPH_HOST",
        "PEOPLEGRAPH_TOKEN",
        "PEOPLEGRAPH_CACHE",
        "XDG_CONFIG_HOME",
        "APPDATA",
    ] {
        c.env_remove(k);
    }
    let out = c
        .env("HOME", home)
        .current_dir(home)
        .args(args)
        .output()
        .unwrap();
    serde_json::from_slice(&out.stdout)
        .unwrap_or_else(|_| panic!("{}", String::from_utf8_lossy(&out.stderr)))
}

#[test]
fn hidden_demo_vaults_are_skipped() {
    let h = home("hidden");
    let demo = h.join(".codex/artifacts/demo-vault");
    let real = h.join("Notes");
    vault(&demo);
    let real_cache = vault(&real);
    obsidian(&h, &[&demo, &real]);
    let v = run(&h, &["--local", "find-person", "Maya Rivera"]);
    assert_eq!(v["ok"], true, "{v}");
    assert_eq!(v["stats"]["backend"], "local");
    assert_eq!(
        v["stats"]["source"],
        fs::canonicalize(real_cache).unwrap().display().to_string()
    );
    assert_eq!(v["stats"]["owner"], "owner@example.com");
}

#[test]
fn two_real_vaults_are_ambiguous() {
    let h = home("ambiguous");
    let a = h.join("A");
    let b = h.join("B");
    vault(&a);
    vault(&b);
    obsidian(&h, &[&a, &b]);
    let v = run(&h, &["--local", "find-person", "Maya"]);
    assert_eq!(v["ok"], false);
    assert_eq!(v["error"]["kind"], "ambiguous_cache");
    let message = v["error"]["message"].as_str().unwrap();
    assert!(
        message.contains("/A/") && message.contains("/B/"),
        "{message}"
    );
}

#[test]
fn malformed_or_missing_vaults_fall_through_to_not_found() {
    let h = home("malformed");
    let dir = h.join("Library/Application Support/obsidian");
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("obsidian.json"), "{not json").unwrap();
    assert_eq!(
        run(&h, &["--local", "find-person", "Maya"])["error"]["kind"],
        "cache_not_found"
    );
    obsidian(&h, &[&h.join("does-not-exist")]);
    assert_eq!(
        run(&h, &["--local", "find-person", "Maya"])["error"]["kind"],
        "cache_not_found"
    );
}

#[test]
fn relative_cache_flag_reports_an_absolute_source() {
    let h = home("relative");
    fs::write(h.join("cache.json"), SAMPLE).unwrap();
    let v = run(&h, &["--cache", "./cache.json", "find-person", "Maya"]);
    let source = v["stats"]["source"].as_str().unwrap_or_default();
    assert!(Path::new(source).is_absolute(), "{v}");
}
