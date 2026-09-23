use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
};
#[derive(Serialize, Deserialize)]
pub struct WebProfile {
    pub version: u8,
    pub backend: String,
    pub origin: String,
    pub owner: String,
    pub token: String,
    pub expires_at: u64,
}
pub fn profile_path() -> Result<PathBuf, String> {
    let home = std::env::var_os("HOME").map(PathBuf::from);
    #[cfg(target_os = "macos")]
    let base = home.map(|p| p.join("Library/Application Support"));
    #[cfg(target_os = "windows")]
    let base = std::env::var_os("APPDATA").map(PathBuf::from);
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let base = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .or_else(|| home.map(|p| p.join(".config")));
    base.map(|p| p.join("peoplegraph/web-profile.json"))
        .ok_or_else(|| "Cannot locate your configuration directory.".into())
}
pub fn origin(value: &str) -> Result<String, String> {
    let uri = value
        .parse::<ureq::http::Uri>()
        .map_err(|_| "Invalid People origin.".to_string())?;
    let scheme = uri.scheme_str().ok_or("Origin needs https://.")?;
    let host = uri.host().ok_or("Origin needs a hostname.")?;
    if uri.authority().is_none()
        || value.contains('@')
        || uri.query().is_some()
        || value.contains('#')
        || !matches!(uri.path(), "" | "/")
    {
        return Err("Use an origin without a path, credentials, query, or fragment.".into());
    }
    if scheme != "https"
        && !(scheme == "http" && matches!(host, "localhost" | "127.0.0.1" | "[::1]"))
    {
        return Err("Use HTTPS (HTTP is allowed only for localhost development).".into());
    }
    Ok(format!("{}://{}", scheme, uri.authority().unwrap()).to_lowercase())
}
pub fn load_profile(path: &Path) -> Result<Option<WebProfile>, String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("Cannot inspect web profile.".into()),
    };
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err("Web profile must be a regular file.".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o077 != 0 {
            return Err("Web profile permissions must be owner-only (chmod 600).".into());
        }
    }
    let profile: WebProfile =
        serde_json::from_slice(&fs::read(path).map_err(|_| "Cannot read web profile.")?)
            .map_err(|_| "Invalid web profile; run peoplegraph login again.")?;
    if profile.version != 1
        || profile.backend != "people-web"
        || origin(&profile.origin)? != profile.origin
        || !profile.token.starts_with("pgd1_")
        || profile.token.len() != 69
    {
        return Err("Invalid web profile; run peoplegraph login again.".into());
    }
    Ok(Some(profile))
}
pub fn save_profile(path: &Path, profile: &WebProfile) -> Result<(), String> {
    let parent = path.parent().ok_or("Invalid profile path.")?;
    fs::create_dir_all(parent).map_err(|_| "Cannot create profile directory.")?;
    if fs::symlink_metadata(parent)
        .map_err(|_| "Cannot inspect profile directory.")?
        .file_type()
        .is_symlink()
    {
        return Err("Profile directory must not be a symlink.".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(parent, fs::Permissions::from_mode(0o700))
            .map_err(|_| "Cannot secure profile directory.")?;
    }
    #[cfg(windows)]
    {
        return Err("Web credential storage is currently supported on Unix systems only.".into());
    }
    let temp = parent.join(format!(
        ".profile-{}-{}",
        std::process::id(),
        crate::unix_seconds()
    ));
    let result = (|| {
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options
            .open(&temp)
            .map_err(|_| "Cannot create private profile file.")?;
        file.write_all(&serde_json::to_vec(profile).map_err(|_| "Cannot encode profile.")?)
            .map_err(|_| "Cannot write profile.")?;
        file.sync_all().map_err(|_| "Cannot flush profile.")?;
        fs::rename(&temp, path).map_err(|_| "Cannot replace profile.")?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temp);
    }
    result
}
pub fn remove_profile(path: &Path) -> Result<(), String> {
    fs::remove_file(path)
        .map_err(|_| "Access was revoked, but the local profile could not be removed.".into())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn origins_do_not_accept_credentials_paths_or_insecure_hosts() {
        for value in [
            "http://example.com",
            "https://a.test/path",
            "https://a.test?x=1",
            "https://u:p@a.test",
            "https://a.test/#x",
        ] {
            assert!(origin(value).is_err(), "{value}");
        }
        assert_eq!(origin("https://a.test/").unwrap(), "https://a.test");
        assert!(origin("http://127.0.0.1:8787").is_ok());
    }
    #[cfg(unix)]
    #[test]
    fn failed_profile_write_preserves_existing_login() {
        use std::os::unix::fs::symlink;
        let dir = std::env::temp_dir().join(format!("pg-write-failure-{}", std::process::id()));
        let real = dir.join("real");
        let alias = dir.join("alias");
        let path = real.join("profile.json");
        let mut profile = WebProfile {
            version: 1,
            backend: "people-web".into(),
            origin: "https://a.test".into(),
            owner: "first@test".into(),
            token: format!("pgd1_{}", "a".repeat(64)),
            expires_at: 1,
        };
        save_profile(&path, &profile).unwrap();
        symlink(&real, &alias).unwrap();
        profile.owner = "second@test".into();
        assert!(save_profile(&alias.join("profile.json"), &profile).is_err());
        assert_eq!(load_profile(&path).unwrap().unwrap().owner, "first@test");
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn profile_roundtrip_is_private() {
        let dir = std::env::temp_dir().join(format!("pg-profile-{}", std::process::id()));
        let path = dir.join("profile.json");
        let p = WebProfile {
            version: 1,
            backend: "people-web".into(),
            origin: "https://a.test".into(),
            owner: "a@test".into(),
            token: format!("pgd1_{}", "a".repeat(64)),
            expires_at: 1,
        };
        save_profile(&path, &p).unwrap();
        assert_eq!(load_profile(&path).unwrap().unwrap().owner, "a@test");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        remove_profile(&path).unwrap();
        assert!(load_profile(&path).unwrap().is_none());
        let _ = fs::remove_dir(dir);
    }
}
