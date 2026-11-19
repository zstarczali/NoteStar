//! Microsoft OneDrive through Microsoft Graph.
//!
//! Sign-in is the OAuth device-code flow: NoteStar shows a short code, the user
//! enters it at microsoft.com/devicelogin, and NoteStar receives a refresh token
//! that is saved with the sync target. It needs the user's own Azure app
//! registration (public client, "Allow public client flows" on); its
//! application (client) id is entered in Settings.

use crate::remote::{http, http_error, join_remote, RemoteFile};
use crate::settings::tr;
use serde::Serialize;
use serde_json::{json, Value};

const LOGIN: &str = "https://login.microsoftonline.com";
const GRAPH: &str = "https://graph.microsoft.com/v1.0";
const SCOPE: &str = "Files.ReadWrite offline_access User.Read";
/// Above this an upload session is needed (Graph's simple upload limit is 4 MB).
const SIMPLE_MAX: usize = 4 * 1024 * 1024;
/// Upload-session chunk: a multiple of 320 KiB, as Graph requires (5 MiB).
const CHUNK: usize = 320 * 1024 * 16;

/// Sign-in authority per client id. Apps registered for "personal Microsoft
/// accounts only" are refused on `/common` (AADSTS9002346 / 9002331) and must use
/// `/consumers`; the first such refusal switches the client id over.
static TENANTS: std::sync::Mutex<Vec<(String, &'static str)>> = std::sync::Mutex::new(Vec::new());

fn tenant(client_id: &str) -> &'static str {
    TENANTS.lock().unwrap().iter().find(|(c, _)| c == client_id).map(|(_, t)| *t).unwrap_or("common")
}

fn no_client_id() -> String {
    tr(
        "Nincs megadva a OneDrive alkalmazás (client) azonosító (App ID).",
        "No OneDrive application (client) ID is set.",
    )
}

/// POST a form to the token service (`devicecode` or `token`), retrying on
/// `/consumers` when the app is personal-account-only.
async fn auth_post(client_id: &str, endpoint: &str, form: &[(&str, &str)]) -> Result<(reqwest::StatusCode, Value), String> {
    let client_id = client_id.trim();
    let http = http();
    loop {
        let t = tenant(client_id);
        let r = http
            .post(format!("{LOGIN}/{t}/oauth2/v2.0/{endpoint}"))
            .form(form)
            .send()
            .await
            .map_err(|e| format!("OneDrive: {e}"))?;
        let status = r.status();
        let v: Value = r.json().await.unwrap_or(Value::Null);
        let desc = v["error_description"].as_str().unwrap_or("");
        if t == "common" && (desc.contains("AADSTS9002346") || desc.contains("AADSTS9002331") || desc.contains("/consumers endpoint")) {
            TENANTS.lock().unwrap().push((client_id.to_string(), "consumers"));
            continue;
        }
        return Ok((status, v));
    }
}

fn auth_error(v: &Value) -> String {
    let desc = v["error_description"].as_str().unwrap_or("");
    let first = desc.lines().next().unwrap_or("").trim();
    let mut msg = format!("OneDrive: {}", if first.is_empty() { v["error"].as_str().unwrap_or("error") } else { first });
    if desc.contains("AADSTS7000218") {
        msg.push_str(&tr(
            "\nAz Azure alkalmazásnál kapcsold be: Authentication → Allow public client flows = Yes.",
            "\nIn the Azure app registration turn on: Authentication → Allow public client flows = Yes.",
        ));
    } else if desc.contains("AADSTS700016") {
        msg.push_str(&tr("\nEllenőrizd az App ID-t.", "\nCheck the App ID."));
    }
    msg
}

#[derive(Serialize)]
pub struct DeviceCode {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    pub interval: u64,
    pub expires_in: u64,
}

pub async fn device_start(client_id: &str) -> Result<DeviceCode, String> {
    if client_id.trim().is_empty() {
        return Err(no_client_id());
    }
    let (status, v) = auth_post(client_id, "devicecode", &[("client_id", client_id.trim()), ("scope", SCOPE)]).await?;
    if !status.is_success() {
        return Err(auth_error(&v));
    }
    Ok(DeviceCode {
        device_code: v["device_code"].as_str().unwrap_or_default().into(),
        user_code: v["user_code"].as_str().unwrap_or_default().into(),
        verification_uri: v["verification_uri"].as_str().unwrap_or("https://microsoft.com/devicelogin").into(),
        interval: v["interval"].as_u64().unwrap_or(5),
        expires_in: v["expires_in"].as_u64().unwrap_or(900),
    })
}

#[derive(Serialize)]
pub struct SignIn {
    /// "pending" | "ok"
    pub status: String,
    pub refresh_token: String,
    pub account: String,
}

/// One poll of the device-code flow: "pending" until the user has signed in.
pub async fn device_poll(client_id: &str, device_code: &str) -> Result<SignIn, String> {
    let form = [
        ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
        ("client_id", client_id.trim()),
        ("device_code", device_code),
    ];
    let (_, v) = auth_post(client_id, "token", &form).await?;
    match v["error"].as_str() {
        Some("authorization_pending") | Some("slow_down") => {
            return Ok(SignIn { status: "pending".into(), refresh_token: String::new(), account: String::new() })
        }
        Some(_) => return Err(auth_error(&v)),
        None => {}
    }
    let access = v["access_token"].as_str().unwrap_or_default();
    let me: Value = match http().get(format!("{GRAPH}/me")).bearer_auth(access).send().await {
        Ok(r) => r.json().await.unwrap_or(Value::Null),
        Err(_) => Value::Null,
    };
    let account = me["userPrincipalName"].as_str().or(me["mail"].as_str()).or(me["displayName"].as_str()).unwrap_or("OneDrive");
    Ok(SignIn { status: "ok".into(), refresh_token: v["refresh_token"].as_str().unwrap_or_default().into(), account: account.into() })
}

pub struct OneDrive {
    http: reqwest::Client,
    access: String,
    /// The sync root on the drive, e.g. "/NoteStar"
    root: String,
}

/// Graph address of an item by its path on the drive ("/a/b.md").
fn item(path: &str) -> String {
    let p = path.trim_matches('/');
    if p.is_empty() {
        format!("{GRAPH}/me/drive/root")
    } else {
        let enc: Vec<String> = p.split('/').map(|s| urlencoding::encode(s).into_owned()).collect();
        format!("{GRAPH}/me/drive/root:/{}:", enc.join("/"))
    }
}

fn rev_of(it: &Value) -> String {
    it["cTag"].as_str().or(it["eTag"].as_str()).map(String::from).unwrap_or_else(|| {
        format!("{}-{}", it["lastModifiedDateTime"].as_str().unwrap_or(""), it["size"].as_u64().unwrap_or(0))
    })
}

impl OneDrive {
    pub async fn open(client_id: &str, refresh: &str, root: &str, on_token: &(dyn Fn(&str) + Sync)) -> Result<Self, String> {
        if client_id.trim().is_empty() {
            return Err(no_client_id());
        }
        if refresh.is_empty() {
            return Err(tr("A OneDrive célhoz jelentkezz be (Beállítások → Szinkron).", "Sign in to the OneDrive target (Settings → Sync)."));
        }
        let form = [("grant_type", "refresh_token"), ("client_id", client_id.trim()), ("refresh_token", refresh), ("scope", SCOPE)];
        let (status, v) = auth_post(client_id, "token", &form).await?;
        if !status.is_success() {
            return Err(format!("{}\n{}", auth_error(&v), tr("Jelentkezz be újra a Beállításokban.", "Sign in again in Settings.")));
        }
        if let Some(rt) = v["refresh_token"].as_str() {
            if rt != refresh {
                on_token(rt);
            }
        }
        Ok(OneDrive { http: http(), access: v["access_token"].as_str().unwrap_or_default().into(), root: root.to_string() })
    }

    async fn send_json(&self, rb: reqwest::RequestBuilder) -> Result<(reqwest::StatusCode, Value), String> {
        let r = rb.bearer_auth(&self.access).send().await.map_err(|e| format!("OneDrive: {e}"))?;
        let status = r.status();
        let body = r.text().await.unwrap_or_default();
        if !status.is_success() {
            return Err(http_error("OneDrive", status, &body));
        }
        Ok((status, serde_json::from_str(&body).unwrap_or(Value::Null)))
    }

    pub async fn list(&self) -> Result<Vec<RemoteFile>, String> {
        let mut out = vec![];
        let mut dirs = vec![String::new()];
        while let Some(rel_dir) = dirs.pop() {
            let mut url = format!(
                "{}/children?$top=999&$select=name,size,folder,file,cTag,eTag,lastModifiedDateTime",
                item(&join_remote(&self.root, &rel_dir))
            );
            loop {
                let r = self.http.get(&url).bearer_auth(&self.access).send().await.map_err(|e| format!("OneDrive: {e}"))?;
                let status = r.status();
                let body = r.text().await.unwrap_or_default();
                if status.as_u16() == 404 && rel_dir.is_empty() {
                    return Ok(vec![]); // the sync folder does not exist yet
                }
                if !status.is_success() {
                    return Err(http_error("OneDrive", status, &body));
                }
                let v: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
                for it in v["value"].as_array().cloned().unwrap_or_default() {
                    let name = it["name"].as_str().unwrap_or_default();
                    if name.is_empty() {
                        continue;
                    }
                    let rel = if rel_dir.is_empty() { name.to_string() } else { format!("{rel_dir}/{name}") };
                    if crate::notes::ignored_rel(&rel) {
                        continue;
                    }
                    if it.get("folder").is_some() {
                        dirs.push(rel);
                    } else if it.get("file").is_some() {
                        out.push(RemoteFile { rev: rev_of(&it), rel });
                    }
                }
                match v["@odata.nextLink"].as_str() {
                    Some(next) => url = next.to_string(),
                    None => break,
                }
            }
        }
        Ok(out)
    }

    pub async fn get(&self, rel: &str) -> Result<Vec<u8>, String> {
        let url = format!("{}/content", item(&join_remote(&self.root, rel)));
        let r = self.http.get(url).bearer_auth(&self.access).send().await.map_err(|e| format!("OneDrive: {e}"))?;
        let status = r.status();
        if !status.is_success() {
            return Err(http_error("OneDrive", status, &r.text().await.unwrap_or_default()));
        }
        r.bytes().await.map(|b| b.to_vec()).map_err(|e| format!("OneDrive: {e}"))
    }

    pub async fn put(&self, rel: &str, data: Vec<u8>) -> Result<String, String> {
        let path = join_remote(&self.root, rel);
        if data.len() <= SIMPLE_MAX {
            // PUT by path creates the missing parent folders too
            let (_, v) = self.send_json(self.http.put(format!("{}/content", item(&path))).body(data)).await?;
            return Ok(rev_of(&v));
        }
        let body = json!({ "item": { "@microsoft.graph.conflictBehavior": "replace" } });
        let (_, v) = self.send_json(self.http.post(format!("{}/createUploadSession", item(&path))).json(&body)).await?;
        let url = v["uploadUrl"].as_str().ok_or("OneDrive: no upload URL")?.to_string();
        let total = data.len();
        let mut start = 0;
        while start < total {
            let end = (start + CHUNK).min(total);
            let r = self
                .http
                .put(&url)
                .header("Content-Range", format!("bytes {start}-{}/{total}", end - 1))
                .body(data[start..end].to_vec())
                .send()
                .await
                .map_err(|e| format!("OneDrive: {e}"))?;
            let status = r.status();
            let text = r.text().await.unwrap_or_default();
            if !status.is_success() {
                let _ = self.http.delete(&url).send().await;
                return Err(http_error("OneDrive", status, &text));
            }
            if end == total {
                let v: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
                return Ok(rev_of(&v));
            }
            start = end;
        }
        Ok(String::new())
    }

    /// Deletes a file (it goes to the OneDrive recycle bin).
    pub async fn delete(&self, rel: &str) -> Result<(), String> {
        let r = self.http.delete(item(&join_remote(&self.root, rel))).bearer_auth(&self.access).send().await.map_err(|e| format!("OneDrive: {e}"))?;
        let status = r.status();
        if status.is_success() || status.as_u16() == 404 {
            Ok(())
        } else {
            Err(http_error("OneDrive", status, &r.text().await.unwrap_or_default()))
        }
    }
}
