//! Dropbox through the Dropbox HTTP API v2.
//!
//! Sign-in is OAuth 2 with PKCE and no redirect address: NoteStar opens the
//! Dropbox authorize page, the user allows access and copies the code shown
//! there back into NoteStar, which exchanges it for a refresh token. It needs
//! the user's own Dropbox app (App Console); only its App key is used (no secret).

use crate::remote::{http, http_error, join_remote, RemoteFile};
use crate::settings::tr;
use base64::Engine;
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

const AUTHORIZE: &str = "https://www.dropbox.com/oauth2/authorize";
const TOKEN: &str = "https://api.dropboxapi.com/oauth2/token";
const API: &str = "https://api.dropboxapi.com/2";
const CONTENT: &str = "https://content.dropboxapi.com/2";

fn no_key() -> String {
    tr("Nincs megadva a Dropbox App key.", "No Dropbox App key is set.")
}

fn b64url(data: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(data)
}

#[derive(Serialize)]
pub struct AuthStart {
    pub url: String,
    /// PKCE code verifier, sent back with the code
    pub verifier: String,
}

/// The authorize page address and the PKCE verifier that belongs to it.
pub fn auth_start(app_key: &str) -> Result<AuthStart, String> {
    if app_key.trim().is_empty() {
        return Err(no_key());
    }
    let mut raw = [0u8; 48];
    getrandom::getrandom(&mut raw).map_err(|e| e.to_string())?;
    let verifier = b64url(&raw);
    let challenge = b64url(&Sha256::digest(verifier.as_bytes()));
    let url = format!(
        "{AUTHORIZE}?client_id={}&response_type=code&token_access_type=offline&code_challenge={challenge}&code_challenge_method=S256",
        urlencoding::encode(app_key.trim())
    );
    Ok(AuthStart { url, verifier })
}

#[derive(Serialize)]
pub struct SignIn {
    pub refresh_token: String,
    pub account: String,
}

/// Exchanges the code the user copied from the Dropbox page for a refresh token.
pub async fn auth_finish(app_key: &str, code: &str, verifier: &str) -> Result<SignIn, String> {
    if app_key.trim().is_empty() {
        return Err(no_key());
    }
    let form = [
        ("code", code.trim()),
        ("grant_type", "authorization_code"),
        ("code_verifier", verifier),
        ("client_id", app_key.trim()),
    ];
    let r = http().post(TOKEN).form(&form).send().await.map_err(|e| format!("Dropbox: {e}"))?;
    let status = r.status();
    let body = r.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(http_error("Dropbox", status, &body));
    }
    let v: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
    let access = v["access_token"].as_str().unwrap_or_default();
    let refresh = v["refresh_token"].as_str().unwrap_or_default().to_string();
    if refresh.is_empty() {
        return Err(tr("A Dropbox nem adott frissítő tokent.", "Dropbox returned no refresh token."));
    }
    let me: Value = match http()
        .post(format!("{API}/users/get_current_account"))
        .bearer_auth(access)
        .header("Content-Type", "application/json")
        .body("null")
        .send()
        .await
    {
        Ok(r) => r.json().await.unwrap_or(Value::Null),
        Err(_) => Value::Null,
    };
    let account = me["email"].as_str().or(me["name"]["display_name"].as_str()).unwrap_or("Dropbox").to_string();
    Ok(SignIn { refresh_token: refresh, account })
}

/// JSON for the `Dropbox-API-Arg` header: HTTP headers must be ASCII, so every
/// other character is written as a `\uXXXX` escape (as Dropbox documents).
fn header_json(v: &Value) -> String {
    let s = v.to_string();
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        if c.is_ascii() && c != '\x7f' {
            out.push(c);
        } else {
            let mut buf = [0u16; 2];
            for u in c.encode_utf16(&mut buf) {
                out.push_str(&format!("\\u{u:04x}"));
            }
        }
    }
    out
}

pub struct Dropbox {
    http: reqwest::Client,
    access: String,
    /// The sync root, e.g. "/NoteStar" ("" = the app folder / Dropbox root)
    root: String,
}

impl Dropbox {
    pub async fn open(app_key: &str, refresh: &str, root: &str, _on_token: &(dyn Fn(&str) + Sync)) -> Result<Self, String> {
        if app_key.trim().is_empty() {
            return Err(no_key());
        }
        if refresh.is_empty() {
            return Err(tr("A Dropbox célhoz jelentkezz be (Beállítások → Szinkron).", "Sign in to the Dropbox target (Settings → Sync)."));
        }
        let form = [("grant_type", "refresh_token"), ("refresh_token", refresh), ("client_id", app_key.trim())];
        let r = http().post(TOKEN).form(&form).send().await.map_err(|e| format!("Dropbox: {e}"))?;
        let status = r.status();
        let body = r.text().await.unwrap_or_default();
        if !status.is_success() {
            return Err(format!("{}\n{}", http_error("Dropbox", status, &body), tr("Jelentkezz be újra a Beállításokban.", "Sign in again in Settings.")));
        }
        let v: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
        let root = root.trim().trim_matches('/');
        Ok(Dropbox { http: http(), access: v["access_token"].as_str().unwrap_or_default().into(), root: if root.is_empty() { String::new() } else { format!("/{root}") } })
    }

    fn path(&self, rel: &str) -> String {
        join_remote(&self.root, rel)
    }

    async fn rpc(&self, endpoint: &str, arg: Value) -> Result<Value, (reqwest::StatusCode, String)> {
        let r = self
            .http
            .post(format!("{API}/{endpoint}"))
            .bearer_auth(&self.access)
            .json(&arg)
            .send()
            .await
            .map_err(|e| (reqwest::StatusCode::BAD_GATEWAY, format!("Dropbox: {e}")))?;
        let status = r.status();
        let body = r.text().await.unwrap_or_default();
        if !status.is_success() {
            return Err((status, body));
        }
        Ok(serde_json::from_str(&body).unwrap_or(Value::Null))
    }

    pub async fn list(&self) -> Result<Vec<RemoteFile>, String> {
        let root_lower = self.root.to_lowercase();
        let mut out = vec![];
        let mut v = match self.rpc("files/list_folder", json!({ "path": self.root, "recursive": true, "include_deleted": false })).await {
            Ok(v) => v,
            // the sync folder does not exist yet
            Err((s, body)) if s.as_u16() == 409 && body.contains("not_found") => return Ok(vec![]),
            Err((s, body)) => return Err(http_error("Dropbox", s, &body)),
        };
        loop {
            for e in v["entries"].as_array().cloned().unwrap_or_default() {
                if e[".tag"] != "file" {
                    continue;
                }
                let display = e["path_display"].as_str().unwrap_or_default();
                let lower = e["path_lower"].as_str().unwrap_or_default();
                if !lower.starts_with(&root_lower) {
                    continue;
                }
                // path_display keeps the letter case of the file name; cut by char count of the root
                let cut = self.root.chars().count();
                let rel: String = display.chars().skip(cut).collect::<String>().trim_start_matches('/').to_string();
                if rel.is_empty() || crate::notes::ignored_rel(&rel) {
                    continue;
                }
                let rev = e["content_hash"].as_str().or(e["rev"].as_str()).unwrap_or_default().to_string();
                out.push(RemoteFile { rel, rev });
            }
            if v["has_more"].as_bool() != Some(true) {
                break;
            }
            let cursor = v["cursor"].as_str().unwrap_or_default().to_string();
            v = self.rpc("files/list_folder/continue", json!({ "cursor": cursor })).await.map_err(|(s, b)| http_error("Dropbox", s, &b))?;
        }
        Ok(out)
    }

    pub async fn get(&self, rel: &str) -> Result<Vec<u8>, String> {
        let r = self
            .http
            .post(format!("{CONTENT}/files/download"))
            .bearer_auth(&self.access)
            .header("Dropbox-API-Arg", header_json(&json!({ "path": self.path(rel) })))
            .send()
            .await
            .map_err(|e| format!("Dropbox: {e}"))?;
        let status = r.status();
        if !status.is_success() {
            return Err(http_error("Dropbox", status, &r.text().await.unwrap_or_default()));
        }
        r.bytes().await.map(|b| b.to_vec()).map_err(|e| format!("Dropbox: {e}"))
    }

    pub async fn put(&self, rel: &str, data: Vec<u8>) -> Result<String, String> {
        let arg = json!({ "path": self.path(rel), "mode": "overwrite", "autorename": false, "mute": true });
        let r = self
            .http
            .post(format!("{CONTENT}/files/upload"))
            .bearer_auth(&self.access)
            .header("Dropbox-API-Arg", header_json(&arg))
            .header("Content-Type", "application/octet-stream")
            .body(data)
            .send()
            .await
            .map_err(|e| format!("Dropbox: {e}"))?;
        let status = r.status();
        let body = r.text().await.unwrap_or_default();
        if !status.is_success() {
            return Err(http_error("Dropbox", status, &body));
        }
        let v: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
        Ok(v["content_hash"].as_str().or(v["rev"].as_str()).unwrap_or_default().to_string())
    }

    /// Deletes a file (Dropbox keeps deleted files restorable for a while).
    pub async fn delete(&self, rel: &str) -> Result<(), String> {
        match self.rpc("files/delete_v2", json!({ "path": self.path(rel) })).await {
            Ok(_) => Ok(()),
            Err((s, body)) if s.as_u16() == 409 && body.contains("not_found") => Ok(()),
            Err((s, body)) => Err(http_error("Dropbox", s, &body)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn header_json_is_ascii() {
        let s = header_json(&json!({ "path": "/Jegyzetek/árvíztűrő 😀.md" }));
        assert!(s.is_ascii());
        assert!(s.contains("\\u00e1"));
        assert!(s.contains("\\ud83d\\ude00"));
        let back: Value = serde_json::from_str(&s).unwrap();
        assert_eq!(back["path"], "/Jegyzetek/árvíztűrő 😀.md");
    }

    #[test]
    fn pkce_challenge_shape() {
        let a = auth_start("abc").unwrap();
        assert!(a.url.contains("code_challenge_method=S256"));
        assert!(a.verifier.len() >= 43 && a.verifier.len() <= 128);
    }
}
