//! Private integration credentials, selected only for their saved origin.
use crate::web_profile;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::HashSet;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

pub(crate) type Error = (&'static str, &'static str);
const MAX_CONFIG_BYTES: u64 = 65_536;
const MAX_TOKEN_BYTES: u64 = 4_096;
const INVALID: Error = (
    "config_invalid",
    "People configuration is invalid; repair it or run peoplegraph configure.",
);
const PERMISSIONS: Error = (
    "config_permissions",
    "People configuration must be an owner-owned regular file with owner-only permissions (chmod 600).",
);
const TOKEN_MISSING: Error = (
    "web_token_missing",
    "No People credential is configured for this origin. Run peoplegraph configure --url <origin> --token-stdin.",
);

// Intentionally neither Debug nor Serialize: this type contains a live secret.
pub(crate) struct Credential {
    pub origin: String,
    pub token: String,
    pub source: &'static str,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Profile {
    origin: String,
    token: String,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Config {
    version: u8,
    active_origin: String,
    profiles: Vec<Profile>,
}

pub(crate) fn config_path() -> Result<PathBuf, Error> {
    if let Some(path) = std::env::var_os("XDG_CONFIG_HOME").filter(|value| !value.is_empty()) {
        let path = PathBuf::from(path);
        if !path.is_absolute() {
            return Err((
                "config_path_invalid",
                "XDG_CONFIG_HOME must be an absolute directory.",
            ));
        }
        return Ok(path.join("peoplegraph/config.json"));
    }
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .map(|home| home.join(".config/peoplegraph/config.json"))
        .ok_or((
            "config_path_missing",
            "Cannot locate your configuration directory.",
        ))
}

fn origin(value: &str) -> Result<String, Error> {
    web_profile::origin(value.trim()).map_err(|_| ("invalid_web_url", "Use an HTTPS origin without credentials, path, query or fragment; HTTP is allowed only on localhost."))
}

fn token(value: &str, stored: bool) -> Result<String, Error> {
    let value = value.trim();
    if value.starts_with("pgd1_") {
        return Err((
            "insufficient_scope",
            "Device login grants read-only graph access. Configure a People integration credential for private commands.",
        ));
    }
    if value.is_empty() {
        return Err(TOKEN_MISSING);
    }
    if value.len() > MAX_TOKEN_BYTES as usize
        || value
            .bytes()
            .any(|byte| byte.is_ascii_whitespace() || byte.is_ascii_control())
    {
        return Err((
            "invalid_credential",
            "Provide one People integration credential without embedded whitespace.",
        ));
    }
    if stored
        && (!value.starts_with("people_")
            || value.len() != 50
            || !value[7..]
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-')))
    {
        return Err((
            "invalid_credential",
            "Provide a People integration credential issued by your People site.",
        ));
    }
    Ok(value.to_owned())
}

#[cfg(unix)]
fn owner_matches(metadata: &fs::Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;
    unsafe extern "C" {
        fn geteuid() -> u32;
    }
    // geteuid has no arguments, cannot fail, and does not mutate process state.
    metadata.uid() == unsafe { geteuid() }
}

fn check_file(metadata: &fs::Metadata) -> Result<(), Error> {
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(INVALID);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o077 != 0 || !owner_matches(metadata) {
            return Err(PERMISSIONS);
        }
    }
    #[cfg(not(unix))]
    return Err((
        "config_permissions",
        "Private credential files require a supported secure store on this platform.",
    ));
    if metadata.len() > MAX_CONFIG_BYTES {
        return Err(INVALID);
    }
    Ok(())
}

fn load(path: &Path) -> Result<Option<Config>, Error> {
    let before = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(("config_unreadable", "Cannot inspect People configuration.")),
    };
    check_file(&before)?;
    if path
        .parent()
        .and_then(|parent| fs::symlink_metadata(parent).ok())
        .is_some_and(|metadata| metadata.file_type().is_symlink())
    {
        return Err(INVALID);
    }
    let file =
        File::open(path).map_err(|_| ("config_unreadable", "Cannot read People configuration."))?;
    let after = file.metadata().map_err(|_| INVALID)?;
    check_file(&after)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if before.dev() != after.dev() || before.ino() != after.ino() {
            return Err(INVALID);
        }
    }
    let mut bytes = Vec::new();
    file.take(MAX_CONFIG_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| INVALID)?;
    if bytes.len() > MAX_CONFIG_BYTES as usize {
        return Err(INVALID);
    }
    let mut config: Config = serde_json::from_slice(&bytes).map_err(|_| INVALID)?;
    if config.version != 1 || config.profiles.is_empty() || config.profiles.len() > 64 {
        return Err(INVALID);
    }
    config.active_origin = origin(&config.active_origin).map_err(|_| INVALID)?;
    let mut seen = HashSet::new();
    for profile in &mut config.profiles {
        profile.origin = origin(&profile.origin).map_err(|_| INVALID)?;
        profile.token = token(&profile.token, true).map_err(|_| INVALID)?;
        if !seen.insert(profile.origin.clone()) {
            return Err(INVALID);
        }
    }
    if !seen.contains(&config.active_origin) {
        return Err(INVALID);
    }
    Ok(Some(config))
}

fn environment(name: &str) -> Result<Option<String>, Error> {
    match std::env::var(name) {
        Ok(value) => Ok((!value.trim().is_empty()).then(|| value.trim().to_owned())),
        Err(std::env::VarError::NotPresent) => Ok(None),
        Err(_) => Err((
            "config_environment_invalid",
            "People environment configuration must be valid UTF-8.",
        )),
    }
}

pub(crate) fn resolve(url: Option<&str>) -> Result<Credential, Error> {
    let explicit = url.map(origin).transpose()?;
    let env_origin = environment("PEOPLEGRAPH_WEB_URL")?
        .as_deref()
        .map(origin)
        .transpose()?;
    let env_token = environment("PEOPLEGRAPH_WEB_TOKEN")?;
    if let Some(value) = env_token {
        if explicit
            .as_ref()
            .zip(env_origin.as_ref())
            .is_some_and(|(a, b)| a != b)
        {
            return Err((
                "credential_origin_mismatch",
                "The explicit origin differs from PEOPLEGRAPH_WEB_URL; its environment credential was not sent.",
            ));
        }
        let origin = explicit.or(env_origin).ok_or(("web_url_missing", "An environment credential requires PEOPLEGRAPH_WEB_URL or an explicit --url; stored origins are not borrowed."))?;
        return Ok(Credential {
            origin,
            token: token(&value, false)?,
            source: "environment",
        });
    }
    // A URL-only override may select its exact saved profile, but cannot take the active profile's key.
    let saved = match config_path() {
        Ok(path) => load(&path)?,
        Err(_) if explicit.is_some() || env_origin.is_some() => None,
        Err(error) => return Err(error),
    };
    let target = explicit.or(env_origin).or_else(|| saved.as_ref().map(|config| config.active_origin.clone()))
        .ok_or(("web_url_missing", "Run peoplegraph configure --url <origin> --token-stdin, set PEOPLEGRAPH_WEB_URL, or pass --url <origin>."))?;
    let profile = saved
        .and_then(|config| {
            config
                .profiles
                .into_iter()
                .find(|profile| profile.origin == target)
        })
        .ok_or(TOKEN_MISSING)?;
    Ok(Credential {
        origin: target,
        token: profile.token,
        source: "config",
    })
}

pub(crate) fn configured() -> Result<bool, Error> {
    if environment("PEOPLEGRAPH_WEB_URL")?.is_some()
        || environment("PEOPLEGRAPH_WEB_TOKEN")?.is_some()
    {
        return Ok(true);
    }
    Ok(load(&config_path()?)?.is_some())
}

pub(crate) fn metadata() -> Result<Value, Error> {
    let path = config_path()?;
    metadata_for(&path)
}

fn metadata_for(path: &Path) -> Result<Value, Error> {
    let config = load(path)?;
    Ok(
        json!({"path":path,"configured":config.is_some(),"activeOrigin":config.as_ref().map(|config| &config.active_origin),
        "profiles":config.map(|config| config.profiles.into_iter().map(|profile| json!({"origin":profile.origin,"credentialType":"people"})).collect::<Vec<_>>()).unwrap_or_default()}),
    )
}

fn write(path: &Path, config: &Config) -> Result<(), Error> {
    let parent = path.parent().ok_or(INVALID)?;
    fs::create_dir_all(parent).map_err(|_| {
        (
            "config_write_failed",
            "Cannot create the People configuration directory.",
        )
    })?;
    let metadata = fs::symlink_metadata(parent).map_err(|_| INVALID)?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(INVALID);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if !owner_matches(&metadata) {
            return Err(PERMISSIONS);
        }
        fs::set_permissions(parent, fs::Permissions::from_mode(0o700)).map_err(|_| PERMISSIONS)?;
    }
    #[cfg(not(unix))]
    return Err((
        "config_permissions",
        "Private credential files require a supported secure store on this platform.",
    ));
    let encoded = serde_json::to_vec_pretty(config).map_err(|_| INVALID)?;
    if encoded.len() > MAX_CONFIG_BYTES as usize {
        return Err(INVALID);
    }
    static SEQUENCE: AtomicU64 = AtomicU64::new(0);
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let temp = parent.join(format!(
        ".config-{}-{nonce}-{}",
        std::process::id(),
        SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    let result = (|| {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temp).map_err(|_| {
            (
                "config_write_failed",
                "Cannot create a private People configuration file.",
            )
        })?;
        file.write_all(&encoded)
            .and_then(|_| file.sync_all())
            .map_err(|_| ("config_write_failed", "Cannot write People configuration."))?;
        fs::rename(&temp, path).map_err(|_| {
            (
                "config_write_failed",
                "Cannot replace People configuration.",
            )
        })?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temp);
    }
    result
}

fn save_to(path: &Path, target: &str, value: &str) -> Result<Value, Error> {
    let target = origin(target)?;
    let value = token(value, true)?;
    let mut config = load(path)?.unwrap_or(Config {
        version: 1,
        active_origin: target.clone(),
        profiles: Vec::new(),
    });
    if let Some(profile) = config
        .profiles
        .iter_mut()
        .find(|profile| profile.origin == target)
    {
        profile.token = value;
    } else {
        if config.profiles.len() >= 64 {
            return Err(INVALID);
        }
        config.profiles.push(Profile {
            origin: target.clone(),
            token: value,
        });
    }
    config.active_origin = target.clone();
    write(path, &config)?;
    Ok(json!({"configured":true,"origin":target,"path":path,"credentialSource":"config"}))
}

pub(crate) fn save(origin: &str, token: &str) -> Result<Value, Error> {
    save_to(&config_path()?, origin, token)
}

pub(crate) fn configure_from_reader(origin: &str, input: impl Read) -> Result<Value, Error> {
    let mut bytes = Vec::new();
    input
        .take(MAX_TOKEN_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| {
            (
                "credential_read_failed",
                "Cannot read the credential from stdin.",
            )
        })?;
    if bytes.len() > MAX_TOKEN_BYTES as usize {
        return Err((
            "invalid_credential",
            "Credential input exceeds the allowed size.",
        ));
    }
    let value = std::str::from_utf8(&bytes)
        .map_err(|_| ("invalid_credential", "Credential input must be UTF-8."))?;
    save(origin, value)
}

pub(crate) fn remove(target: &str) -> Result<Value, Error> {
    remove_from(&config_path()?, target)
}

fn remove_from(path: &Path, target: &str) -> Result<Value, Error> {
    let target = origin(target)?;
    if let Some(mut config) = load(path)? {
        config.profiles.retain(|profile| profile.origin != target);
        if config.profiles.is_empty() {
            fs::remove_file(path).map_err(|_| {
                (
                    "config_write_failed",
                    "Cannot remove the local People credential.",
                )
            })?;
        } else {
            if config.active_origin == target {
                config.active_origin = config.profiles[0].origin.clone();
            }
            write(path, &config)?;
        }
    }
    Ok(json!({"removed":true,"origin":target}))
}

#[cfg(test)]
mod tests {
    use super::*;
    const TOKEN_A: &str = "people_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const TOKEN_B: &str = "people_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    struct Sandbox(PathBuf);
    impl Sandbox {
        fn new() -> Self {
            static SEQUENCE: AtomicU64 = AtomicU64::new(0);
            let path = std::env::temp_dir().join(format!(
                "people-config-unit-{}-{}",
                std::process::id(),
                SEQUENCE.fetch_add(1, Ordering::Relaxed)
            ));
            Self(path)
        }
        fn path(&self) -> PathBuf {
            self.0.join("peoplegraph/config.json")
        }
    }
    impl Drop for Sandbox {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn saving_and_removing_profiles_preserves_other_origins_and_redacts_metadata() {
        let sandbox = Sandbox::new();
        let path = sandbox.path();
        save_to(&path, "https://first.example.test/", TOKEN_A).unwrap();
        let output = save_to(&path, "https://second.example.test", TOKEN_B).unwrap();
        assert!(!output.to_string().contains(TOKEN_B));
        let metadata = metadata_for(&path).unwrap();
        assert_eq!(metadata["activeOrigin"], "https://second.example.test");
        assert_eq!(metadata["profiles"].as_array().unwrap().len(), 2);
        assert!(!metadata.to_string().contains(TOKEN_A));
        assert!(!metadata.to_string().contains(TOKEN_B));
        remove_from(&path, "https://second.example.test").unwrap();
        let saved = load(&path).unwrap().unwrap();
        assert_eq!(saved.active_origin, "https://first.example.test");
        assert_eq!(saved.profiles.len(), 1);
        assert_eq!(saved.profiles[0].token, TOKEN_A);
        remove_from(&path, "https://first.example.test").unwrap();
        assert!(!path.exists());
        assert_eq!(metadata_for(&path).unwrap()["configured"], false);
    }

    #[test]
    fn invalid_saved_key_or_origin_leaves_the_previous_file_unchanged() {
        let sandbox = Sandbox::new();
        let path = sandbox.path();
        save_to(&path, "https://first.example.test", TOKEN_A).unwrap();
        let before = fs::read(&path).unwrap();
        for (origin, token) in [
            ("https://second.example.test", "pgd1_device_secret"),
            ("https://second.example.test", "people_bad"),
            (
                "https://second.example.test",
                "people_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\nattack",
            ),
            ("https://user:secret@other.example.test", TOKEN_B),
            ("http://other.example.test", TOKEN_B),
        ] {
            assert!(save_to(&path, origin, token).is_err());
            assert_eq!(fs::read(&path).unwrap(), before);
        }
    }

    #[cfg(unix)]
    #[test]
    fn symlink_directory_cannot_redirect_a_saved_credential() {
        use std::os::unix::fs::symlink;
        let sandbox = Sandbox::new();
        let path = sandbox.path();
        save_to(&path, "https://first.example.test", TOKEN_A).unwrap();
        let before = fs::read(&path).unwrap();
        let alias = sandbox.0.join("alias");
        symlink(path.parent().unwrap(), &alias).unwrap();
        assert!(
            save_to(
                &alias.join("config.json"),
                "https://second.example.test",
                TOKEN_B
            )
            .is_err()
        );
        assert_eq!(fs::read(&path).unwrap(), before);
    }

    #[test]
    fn duplicate_origins_and_missing_active_profile_fail_closed() {
        let sandbox = Sandbox::new();
        let path = sandbox.path();
        save_to(&path, "https://first.example.test", TOKEN_A).unwrap();
        for value in [
            json!({"version":1,"active_origin":"https://missing.example.test","profiles":[{"origin":"https://first.example.test","token":TOKEN_A}]}),
            json!({"version":1,"active_origin":"https://first.example.test","profiles":[{"origin":"https://first.example.test","token":TOKEN_A},{"origin":"https://FIRST.example.test/","token":TOKEN_B}]}),
        ] {
            fs::write(&path, value.to_string()).unwrap();
            assert!(matches!(load(&path), Err(("config_invalid", _))));
            assert!(metadata_for(&path).is_err());
        }
    }
}
