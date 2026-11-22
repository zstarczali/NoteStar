//! The other side of a sync: a local (cloud-synced) folder, OneDrive, Dropbox
//! or WebDAV. Every provider offers the same four operations on files given by
//! their path relative to the sync root (`/` separators).

use crate::settings::{tr, Target};
use crate::{dropbox, notes, onedrive, webdav};
use std::path::PathBuf;
use std::time::Duration;

/// A file on the remote side.
#[derive(Clone, Debug)]
pub struct RemoteFile {
    pub rel: String,
    /// Changes whenever the content changes (etag, rev, cTag, mtime+size)
    pub rev: String,
}

pub enum Remote {
    Folder(PathBuf),
    OneDrive(onedrive::OneDrive),
    Dropbox(dropbox::Dropbox),
    WebDav(webdav::WebDav),
}

pub fn http() -> reqwest::Client {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(20))
        .timeout(Duration::from_secs(300))
        .user_agent(concat!("NoteStar/", env!("CARGO_PKG_VERSION")))
        .build()
        .unwrap_or_default()
}

/// `a/b` + `c.md` → `a/b/c.md` (root "/" or "" = no prefix).
pub fn join_remote(root: &str, rel: &str) -> String {
    let root = root.trim().trim_matches('/');
    let rel = rel.trim_matches('/');
    match (root.is_empty(), rel.is_empty()) {
        (true, _) => format!("/{rel}"),
        (false, true) => format!("/{root}"),
        (false, false) => format!("/{root}/{rel}"),
    }
}

/// Error text of a failed HTTP response (JSON error fields or the start of the body).
pub fn http_error(service: &str, status: reqwest::StatusCode, body: &str) -> String {
    let v: serde_json::Value = serde_json::from_str(body).unwrap_or(serde_json::Value::Null);
    let msg = v["error"]["message"]
        .as_str()
        .or(v["error_description"].as_str())
        .or(v["error_summary"].as_str())
        .or(v["error"].as_str())
        .map(String::from)
        .unwrap_or_else(|| body.chars().take(300).collect::<String>().trim().to_string());
    let hint = match status.as_u16() {
        401 => tr(" (a bejelentkezés lejárt vagy hibás – jelentkezz be újra)", " (the sign-in expired or is wrong – sign in again)"),
        403 => tr(" (nincs jogosultság)", " (access denied)"),
        429 => tr(" (túl sok kérés, próbáld később)", " (too many requests, try again later)"),
        507 => tr(" (betelt a tárhely)", " (storage is full)"),
        _ => String::new(),
    };
    if msg.is_empty() {
        format!("{service}: HTTP {status}{hint}")
    } else {
        format!("{service}: HTTP {} – {msg}{hint}", status.as_u16())
    }
}

impl Remote {
    /// Connects (signs in with the refresh token). `on_token` receives a
    /// rotated refresh token, if the provider sends a new one.
    pub async fn open(t: &Target, on_token: &(dyn Fn(&str) + Sync)) -> Result<Remote, String> {
        match t.kind.as_str() {
            "folder" => {
                let p = PathBuf::from(t.path.trim());
                if t.path.trim().is_empty() {
                    return Err(tr("Nincs megadva a cél mappa.", "No target folder is set."));
                }
                if !p.is_absolute() {
                    return Err(format!("{}: {}", tr("A cél mappának teljes útvonalnak kell lennie", "The target folder must be a full path"), t.path));
                }
                // the parent must exist: a missing drive / unplugged USB disk is an error, not an empty folder
                match p.parent() {
                    Some(parent) if !parent.as_os_str().is_empty() && !parent.exists() => {
                        return Err(format!("{}: {}", tr("A cél mappa nem érhető el", "The target folder is not available"), parent.display()))
                    }
                    _ => {}
                }
                std::fs::create_dir_all(&p).map_err(|e| format!("{}: {e}", p.display()))?;
                Ok(Remote::Folder(p))
            }
            "onedrive" => Ok(Remote::OneDrive(onedrive::OneDrive::open(&t.client_id, &t.refresh_token, &t.path, on_token).await?)),
            "dropbox" => Ok(Remote::Dropbox(dropbox::Dropbox::open(&t.client_id, &t.refresh_token, &t.path, on_token).await?)),
            "webdav" => Ok(Remote::WebDav(webdav::WebDav::new(&t.url, &t.user, &t.password, &t.path)?)),
            k => Err(format!("{}: {k}", tr("Ismeretlen szinkron típus", "Unknown sync type"))),
        }
    }

    /// Every file under the sync root (folders are implied by the paths).
    /// A root that does not exist yet is an empty list.
    pub async fn list(&self) -> Result<Vec<RemoteFile>, String> {
        match self {
            Remote::Folder(root) => {
                let root = root.clone();
                tauri::async_runtime::spawn_blocking(move || {
                    let mut out = vec![];
                    for e in notes::list(&root, &[])? {
                        if !e.dir {
                            out.push(RemoteFile { rel: e.rel, rev: format!("{}-{}", e.mtime, e.size) });
                        }
                    }
                    // hidden, so the listing skipped them
                    for f in notes::META_FILES {
                        if let Ok(m) = std::fs::metadata(root.join(f)) {
                            out.push(RemoteFile { rel: (*f).into(), rev: format!("{}-{}", notes::mtime_ms(&m), m.len()) });
                        }
                    }
                    Ok(out)
                })
                .await
                .map_err(|e| e.to_string())?
            }
            Remote::OneDrive(c) => c.list().await,
            Remote::Dropbox(c) => c.list().await,
            Remote::WebDav(c) => c.list().await,
        }
    }

    pub async fn get(&self, rel: &str) -> Result<Vec<u8>, String> {
        match self {
            Remote::Folder(root) => {
                let p = notes::safe_join(root, rel)?;
                std::fs::read(&p).map_err(|e| format!("{}: {e}", p.display()))
            }
            Remote::OneDrive(c) => c.get(rel).await,
            Remote::Dropbox(c) => c.get(rel).await,
            Remote::WebDav(c) => c.get(rel).await,
        }
    }

    /// Writes a file (parent folders are created) and returns its new rev.
    pub async fn put(&self, rel: &str, data: Vec<u8>) -> Result<String, String> {
        match self {
            Remote::Folder(root) => {
                let p = notes::safe_join(root, rel)?;
                notes::write_atomic(&p, &data)?;
                let m = std::fs::metadata(&p).map_err(|e| e.to_string())?;
                Ok(format!("{}-{}", notes::mtime_ms(&m), m.len()))
            }
            Remote::OneDrive(c) => c.put(rel, data).await,
            Remote::Dropbox(c) => c.put(rel, data).await,
            Remote::WebDav(c) => c.put(rel, data).await,
        }
    }

    /// Deletes a file (into the provider's recycle bin where it has one).
    pub async fn delete(&self, rel: &str) -> Result<(), String> {
        match self {
            Remote::Folder(root) => {
                let p = notes::safe_join(root, rel)?;
                if !p.exists() {
                    return Ok(());
                }
                trash::delete(&p).or_else(|_| std::fs::remove_file(&p)).map_err(|e| format!("{}: {e}", p.display()))?;
                // an emptied folder goes too, so deleted folders do not linger as empty shells
                let mut dir = p.parent().map(PathBuf::from);
                while let Some(d) = dir {
                    if d == *root || std::fs::remove_dir(&d).is_err() {
                        break;
                    }
                    dir = d.parent().map(PathBuf::from);
                }
                Ok(())
            }
            Remote::OneDrive(c) => c.delete(rel).await,
            Remote::Dropbox(c) => c.delete(rel).await,
            Remote::WebDav(c) => c.delete(rel).await,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::join_remote;

    #[test]
    fn joins_remote_paths() {
        assert_eq!(join_remote("/NoteStar", "a/b.md"), "/NoteStar/a/b.md");
        assert_eq!(join_remote("NoteStar/", ""), "/NoteStar");
        assert_eq!(join_remote("/", "x.md"), "/x.md");
        assert_eq!(join_remote("", "x.md"), "/x.md");
    }
}
