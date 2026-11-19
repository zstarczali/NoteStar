//! WebDAV (Nextcloud, ownCloud, Synology, Apache mod_dav, …) with basic auth.

use crate::remote::{http, http_error, RemoteFile};
use crate::settings::tr;
use std::collections::HashSet;
use std::sync::Mutex;

const PROPFIND_BODY: &str = r#"<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getetag/><d:getcontentlength/><d:getlastmodified/></d:prop></d:propfind>"#;

pub struct WebDav {
    http: reqwest::Client,
    user: String,
    password: String,
    /// Address of the sync root, ending in `/`
    base: reqwest::Url,
    /// Folders known to exist (MKCOL is skipped for them)
    made: Mutex<HashSet<String>>,
}

fn method(name: &str) -> reqwest::Method {
    reqwest::Method::from_bytes(name.as_bytes()).expect("valid method")
}

/// One entry of a PROPFIND answer.
#[derive(Debug, PartialEq)]
struct DavItem {
    /// Decoded URL path
    path: String,
    dir: bool,
    rev: String,
}

fn parse_multistatus(xml: &str) -> Result<Vec<DavItem>, String> {
    let doc = roxmltree::Document::parse(xml).map_err(|e| format!("WebDAV: {} ({e})", tr("hibás válasz", "invalid answer")))?;
    let mut out = vec![];
    for resp in doc.descendants().filter(|n| n.tag_name().name() == "response") {
        let Some(href) = resp.descendants().find(|n| n.tag_name().name() == "href").and_then(|n| n.text()) else { continue };
        // the href may be a full URL or a path; keep the decoded path
        let raw_path = match reqwest::Url::parse(href.trim()) {
            Ok(u) => u.path().to_string(),
            Err(_) => href.trim().to_string(),
        };
        let path = urlencoding::decode(&raw_path).map(|s| s.into_owned()).unwrap_or(raw_path);
        // only the props of a successful propstat count
        let mut dir = false;
        let (mut etag, mut len, mut modified) = (String::new(), String::new(), String::new());
        for ps in resp.children().filter(|n| n.tag_name().name() == "propstat") {
            let ok = ps
                .children()
                .find(|n| n.tag_name().name() == "status")
                .and_then(|n| n.text())
                .map(|s| s.contains(" 200"))
                .unwrap_or(true);
            if !ok {
                continue;
            }
            for p in ps.descendants() {
                match p.tag_name().name() {
                    "collection" => dir = true,
                    "getetag" => etag = p.text().unwrap_or("").trim().trim_start_matches("W/").trim_matches('"').to_string(),
                    "getcontentlength" => len = p.text().unwrap_or("").trim().to_string(),
                    "getlastmodified" => modified = p.text().unwrap_or("").trim().to_string(),
                    _ => {}
                }
            }
        }
        let rev = if etag.is_empty() { format!("{modified}-{len}") } else { etag };
        out.push(DavItem { path, dir, rev });
    }
    Ok(out)
}

impl WebDav {
    pub fn new(url: &str, user: &str, password: &str, folder: &str) -> Result<Self, String> {
        let url = url.trim();
        if url.is_empty() {
            return Err(tr("Nincs megadva a WebDAV cím.", "No WebDAV address is set."));
        }
        let mut base = reqwest::Url::parse(url).map_err(|_| format!("{}: {url}", tr("Érvénytelen WebDAV cím", "Invalid WebDAV address")))?;
        if base.scheme() != "https" && base.scheme() != "http" {
            return Err(format!("{}: {url}", tr("Érvénytelen WebDAV cím", "Invalid WebDAV address")));
        }
        {
            let mut segs = base.path_segments_mut().map_err(|_| tr("Érvénytelen WebDAV cím", "Invalid WebDAV address"))?;
            segs.pop_if_empty();
            for s in folder.split('/').filter(|s| !s.trim().is_empty()) {
                segs.push(s.trim());
            }
            segs.push(""); // trailing slash: a collection
        }
        Ok(WebDav { http: http(), user: user.to_string(), password: password.to_string(), base, made: Mutex::new(HashSet::new()) })
    }

    fn url(&self, rel: &str) -> reqwest::Url {
        let mut u = self.base.clone();
        {
            let mut segs = u.path_segments_mut().expect("base is a hierarchical URL");
            segs.pop_if_empty();
            for s in rel.split('/').filter(|s| !s.is_empty()) {
                segs.push(s);
            }
        }
        u
    }

    fn req(&self, m: reqwest::Method, url: reqwest::Url) -> reqwest::RequestBuilder {
        let rb = self.http.request(m, url);
        if self.user.is_empty() { rb } else { rb.basic_auth(&self.user, Some(&self.password)) }
    }

    async fn propfind(&self, url: reqwest::Url, depth: &str) -> Result<Option<Vec<DavItem>>, String> {
        let r = self
            .req(method("PROPFIND"), url)
            .header("Depth", depth)
            .header("Content-Type", "application/xml; charset=utf-8")
            .body(PROPFIND_BODY)
            .send()
            .await
            .map_err(|e| format!("WebDAV: {e}"))?;
        let status = r.status();
        let body = r.text().await.unwrap_or_default();
        if status.as_u16() == 404 {
            return Ok(None);
        }
        if !status.is_success() {
            return Err(http_error("WebDAV", status, &body));
        }
        parse_multistatus(&body).map(Some)
    }

    pub async fn list(&self) -> Result<Vec<RemoteFile>, String> {
        let base_path = urlencoding::decode(self.base.path()).map(|s| s.into_owned()).unwrap_or_else(|_| self.base.path().to_string());
        let mut out = vec![];
        let mut dirs = vec![String::new()];
        let mut seen = HashSet::new();
        while let Some(rel_dir) = dirs.pop() {
            if !seen.insert(rel_dir.clone()) || seen.len() > 20_000 {
                continue;
            }
            // collections are asked for with a trailing slash (else some servers answer 301)
            let mut url = self.url(&rel_dir);
            url.path_segments_mut().expect("hierarchical").pop_if_empty().push("");
            let Some(items) = self.propfind(url, "1").await? else {
                if rel_dir.is_empty() {
                    return Ok(vec![]); // the sync folder does not exist yet
                }
                continue;
            };
            for it in items {
                let Some(rel) = it.path.strip_prefix(&base_path) else { continue };
                let rel = rel.trim_matches('/').to_string();
                if rel.is_empty() || rel == rel_dir || crate::notes::ignored_rel(&rel) {
                    continue;
                }
                if it.dir {
                    self.made.lock().unwrap().insert(rel.clone());
                    dirs.push(rel);
                } else {
                    out.push(RemoteFile { rel, rev: it.rev });
                }
            }
        }
        Ok(out)
    }

    pub async fn get(&self, rel: &str) -> Result<Vec<u8>, String> {
        let r = self.req(reqwest::Method::GET, self.url(rel)).send().await.map_err(|e| format!("WebDAV: {e}"))?;
        let status = r.status();
        if !status.is_success() {
            return Err(http_error("WebDAV", status, &r.text().await.unwrap_or_default()));
        }
        r.bytes().await.map(|b| b.to_vec()).map_err(|e| format!("WebDAV: {e}"))
    }

    /// MKCOL for the sync root and every parent folder of `rel` not known yet.
    async fn ensure_dirs(&self, rel: &str) -> Result<(), String> {
        let parts: Vec<&str> = rel.split('/').filter(|s| !s.is_empty()).collect();
        let mut chain = vec![String::new()];
        for i in 1..parts.len() {
            chain.push(parts[..i].join("/"));
        }
        for dir in chain {
            if self.made.lock().unwrap().contains(&dir) {
                continue;
            }
            let mut url = self.url(&dir);
            url.path_segments_mut().expect("hierarchical").pop_if_empty().push("");
            let r = self.req(method("MKCOL"), url).send().await.map_err(|e| format!("WebDAV: {e}"))?;
            let s = r.status().as_u16();
            // 201 created, 405 already exists (some servers: 301 / 409 for existing)
            if !(r.status().is_success() || s == 405 || s == 301) {
                return Err(http_error("WebDAV", r.status(), &r.text().await.unwrap_or_default()));
            }
            self.made.lock().unwrap().insert(dir);
        }
        Ok(())
    }

    pub async fn put(&self, rel: &str, data: Vec<u8>) -> Result<String, String> {
        self.ensure_dirs(rel).await?;
        let r = self.req(reqwest::Method::PUT, self.url(rel)).body(data).send().await.map_err(|e| format!("WebDAV: {e}"))?;
        let status = r.status();
        let etag = r.headers().get("etag").and_then(|v| v.to_str().ok()).map(|s| s.trim().trim_start_matches("W/").trim_matches('"').to_string());
        if !status.is_success() {
            return Err(http_error("WebDAV", status, &r.text().await.unwrap_or_default()));
        }
        if let Some(e) = etag.filter(|e| !e.is_empty()) {
            return Ok(e);
        }
        // no ETag in the answer: ask for the file's props
        Ok(self.propfind(self.url(rel), "0").await?.and_then(|v| v.into_iter().next()).map(|i| i.rev).unwrap_or_default())
    }

    pub async fn delete(&self, rel: &str) -> Result<(), String> {
        let r = self.req(reqwest::Method::DELETE, self.url(rel)).send().await.map_err(|e| format!("WebDAV: {e}"))?;
        let status = r.status();
        if status.is_success() || status.as_u16() == 404 {
            Ok(())
        } else {
            Err(http_error("WebDAV", status, &r.text().await.unwrap_or_default()))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_urls() {
        let w = WebDav::new("https://cloud.example.com/remote.php/dav/files/me/", "me", "pw", "/Note Star/").unwrap();
        assert_eq!(w.base.as_str(), "https://cloud.example.com/remote.php/dav/files/me/Note%20Star/");
        assert_eq!(w.url("a/árvíz.md").as_str(), "https://cloud.example.com/remote.php/dav/files/me/Note%20Star/a/%C3%A1rv%C3%ADz.md");
    }

    #[test]
    fn parses_multistatus() {
        let xml = r#"<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:">
 <d:response><d:href>/dav/Notes/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype><d:getetag>"root"</d:getetag></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
 <d:response><d:href>https://h.example/dav/Notes/%C3%A1.md</d:href><d:propstat><d:prop><d:resourcetype/><d:getetag>W/"abc"</d:getetag><d:getcontentlength>12</d:getcontentlength></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
  <d:propstat><d:prop><d:getlastmodified/></d:prop><d:status>HTTP/1.1 404 Not Found</d:status></d:propstat></d:response>
</d:multistatus>"#;
        let items = parse_multistatus(xml).unwrap();
        assert_eq!(items.len(), 2);
        assert!(items[0].dir);
        assert_eq!(items[1], DavItem { path: "/dav/Notes/á.md".into(), dir: false, rev: "abc".into() });
    }
}
