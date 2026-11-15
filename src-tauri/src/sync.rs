//! Two-way sync of the notes folder with one target.
//!
//! Three-way comparison per file: the local file, the remote file and the
//! state saved after the previous sync (content hash and remote rev). Whatever
//! changed on one side only is copied to the other; deletions are copied too.
//! When both sides changed, nothing is lost: the remote version is saved next
//! to the local one as a conflict copy and both are uploaded.
//!
//! Safety nets: the state belongs to one notes folder + target address (change
//! either and the next sync is a fresh, merge-only first sync); a sync that
//! would delete many files stops and asks; local deletions go to the recycle bin.

use crate::notes;
use crate::remote::{Remote, RemoteFile};
use crate::settings::{tr, Target};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeSet, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// What was true of a file after the last successful sync.
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct Base {
    pub rel: String,
    /// sha256 of the content
    pub hash: String,
    /// Remote rev
    pub rev: String,
    /// Local mtime (ms) and size: unchanged ones are not hashed again
    pub mtime: i64,
    pub size: u64,
}

#[derive(Serialize, Deserialize, Default)]
#[serde(default)]
pub struct State {
    /// Notes folder + target address this state belongs to
    pub key: String,
    /// lower-case relative path → base
    pub files: HashMap<String, Base>,
    pub last_sync: i64,
    pub last_ok: bool,
    pub last_msg: String,
}

#[derive(Serialize, Default, Debug)]
pub struct Report {
    pub uploaded: u32,
    pub downloaded: u32,
    pub deleted_local: u32,
    pub deleted_remote: u32,
    /// Conflict copies created (relative paths)
    pub conflicts: Vec<String>,
    pub errors: Vec<String>,
    /// Local notes written or deleted by the sync (the UI reloads them)
    pub changed: Vec<String>,
    /// Notes in sync after the run
    pub files: usize,
    pub ms: u64,
}

#[derive(Serialize)]
pub struct Info {
    pub id: String,
    pub last_sync: i64,
    pub ok: bool,
    pub msg: String,
    pub files: usize,
}

static RUNNING: Mutex<Vec<String>> = Mutex::new(Vec::new());

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

pub fn hash(data: &[u8]) -> String {
    let d = Sha256::digest(data);
    d.iter().map(|b| format!("{b:02x}")).collect()
}

fn key_of(rel: &str) -> String {
    rel.to_lowercase()
}

fn state_path(dir: &Path, id: &str) -> PathBuf {
    let safe: String = id.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_').collect();
    dir.join("sync").join(format!("{}.json", if safe.is_empty() { "target" } else { &safe }))
}

pub fn load_state(dir: &Path, id: &str) -> State {
    std::fs::read_to_string(state_path(dir, id)).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
}

fn save_state(dir: &Path, id: &str, st: &State) -> Result<(), String> {
    let p = state_path(dir, id);
    let json = serde_json::to_string(st).map_err(|e| e.to_string())?;
    notes::write_atomic(&p, json.as_bytes())
}

pub fn forget(dir: &Path, id: &str) {
    let _ = std::fs::remove_file(state_path(dir, id));
}

pub fn info(dir: &Path, targets: &[Target]) -> Vec<Info> {
    targets
        .iter()
        .map(|t| {
            let st = load_state(dir, &t.id);
            Info { id: t.id.clone(), last_sync: st.last_sync, ok: st.last_ok, msg: st.last_msg, files: st.files.len() }
        })
        .collect()
}

/// Identity of "these notes with this remote place": a different one starts afresh.
fn identity(notes_dir: &Path, t: &Target) -> String {
    let place = match t.kind.as_str() {
        "folder" => t.path.trim().replace('\\', "/").trim_end_matches('/').to_lowercase(),
        "webdav" => format!("{}|{}|{}", t.url.trim().trim_end_matches('/'), t.user, t.path.trim().trim_matches('/')),
        _ => format!("{}|{}", t.client_id.trim(), t.path.trim().trim_matches('/').to_lowercase()),
    };
    format!("{}|{}|{}", notes_dir.to_string_lossy().replace('\\', "/").to_lowercase(), t.kind, place)
}

struct Local {
    rel: String,
    hash: String,
    mtime: i64,
    size: u64,
}

fn scan_local(root: &Path, exts: &[String], base: &HashMap<String, Base>) -> Result<HashMap<String, Local>, String> {
    let mut out = HashMap::new();
    for e in notes::list(root, exts)? {
        if e.dir {
            continue;
        }
        let k = key_of(&e.rel);
        let known = base.get(&k).filter(|b| b.mtime == e.mtime && b.size == e.size && !b.hash.is_empty());
        let h = match known {
            Some(b) => b.hash.clone(),
            None => match std::fs::read(root.join(&e.rel)) {
                Ok(buf) => hash(&buf),
                Err(_) => continue, // locked / vanished: next time
            },
        };
        out.insert(k, Local { rel: e.rel, hash: h, mtime: e.mtime, size: e.size });
    }
    Ok(out)
}

/// The local file still is what the scan saw (the editor may save meanwhile).
fn unchanged_since_scan(root: &Path, l: Option<&Local>, rel: &str) -> bool {
    let p = root.join(rel);
    match (l, std::fs::metadata(&p)) {
        (Some(l), Ok(m)) => notes::mtime_ms(&m) == l.mtime && m.len() == l.size,
        (None, Err(_)) => true,
        _ => false,
    }
}

/// `dir/name (conflict 2026-11-15 1430).md`, unique in the notes folder.
fn conflict_name(root: &Path, rel: &str) -> String {
    let (dir, file) = match rel.rsplit_once('/') {
        Some((d, f)) => (d, f),
        None => ("", rel),
    };
    let (stem, ext) = match file.rsplit_once('.') {
        Some((s, e)) if !s.is_empty() => (s.to_string(), format!(".{e}")),
        _ => (file.to_string(), String::new()),
    };
    let label = format!("{} {}", tr("ütközés", "conflict"), chrono::Local::now().format("%Y-%m-%d %H%M"));
    notes::unique(root, dir, &format!("{stem} ({label})"), &ext).unwrap_or_else(|_| format!("{rel}.conflict"))
}

enum Act {
    Upload(String),
    Download(String),
    DelRemote(String),
    DelLocal(String),
    /// Changed on both sides (or new on both): compare, maybe conflict copy
    Both(String),
    /// Gone on both sides: drop from the state
    Forget(String),
}

pub struct Run<'a> {
    pub notes_dir: &'a Path,
    pub exts: &'a [String],
    pub state_dir: &'a Path,
    pub target: &'a Target,
    /// Run even when many files would be deleted
    pub force: bool,
    pub progress: &'a (dyn Fn(usize, usize, &str) + Sync),
    pub on_token: &'a (dyn Fn(&str) + Sync),
}

pub async fn run(r: Run<'_>) -> Result<Report, String> {
    let id = r.target.id.clone();
    {
        let mut running = RUNNING.lock().unwrap();
        if running.contains(&id) {
            return Err("SYNC_BUSY".into());
        }
        running.push(id.clone());
    }
    let started = std::time::Instant::now();
    let res = run_inner(&r).await;
    RUNNING.lock().unwrap().retain(|x| x != &id);

    // remember the outcome for the status bar
    let mut st = load_state(r.state_dir, &id);
    st.last_sync = now_ms();
    match &res {
        Ok(rep) => {
            st.last_ok = rep.errors.is_empty();
            st.last_msg = rep.errors.first().cloned().unwrap_or_default();
        }
        Err(e) if e.starts_with("SYNC_MASS_DELETE") || e == "SYNC_BUSY" => {}
        Err(e) => {
            st.last_ok = false;
            st.last_msg = e.clone();
        }
    }
    let _ = save_state(r.state_dir, &id, &st);
    res.map(|mut rep| {
        rep.ms = started.elapsed().as_millis() as u64;
        rep
    })
}

async fn run_inner(r: &Run<'_>) -> Result<Report, String> {
    let root = r.notes_dir;
    if r.target.kind == "folder" {
        // a target inside the notes folder (or the other way round) would copy itself forever
        let canon = |p: &Path| std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
        let (n, t) = (canon(root), canon(Path::new(r.target.path.trim())));
        if t.starts_with(&n) || n.starts_with(&t) {
            return Err(tr(
                "A cél mappa nem lehet a jegyzetmappa, és nem lehet benne vagy fölötte.",
                "The target folder cannot be the notes folder, nor inside or above it.",
            ));
        }
    }
    let ident = identity(root, r.target);
    let mut st = load_state(r.state_dir, &r.target.id);
    if st.key != ident {
        // other notes folder or other remote place: the old state means nothing here
        st.files.clear();
        st.key = ident;
    }
    let remote = Remote::open(r.target, r.on_token).await?;

    let local = {
        let (root, exts, base) = (root.to_path_buf(), r.exts.to_vec(), st.files.clone());
        tauri::async_runtime::spawn_blocking(move || scan_local(&root, &exts, &base)).await.map_err(|e| e.to_string())??
    };
    let remote_files: HashMap<String, RemoteFile> = remote
        .list()
        .await?
        .into_iter()
        .filter(|f| notes::is_note(f.rel.rsplit('/').next().unwrap_or(&f.rel), r.exts))
        .map(|f| (key_of(&f.rel), f))
        .collect();

    // ── plan ──
    let keys: BTreeSet<String> = local.keys().chain(remote_files.keys()).chain(st.files.keys()).cloned().collect();
    let mut plan = vec![];
    for k in keys {
        let (l, rm, b) = (local.get(&k), remote_files.get(&k), st.files.get(&k));
        let lc = match (l, b) {
            (Some(l), Some(b)) => l.hash != b.hash,
            (None, None) => false,
            _ => true,
        };
        let rc = match (rm, b) {
            (Some(rm), Some(b)) => rm.rev != b.rev,
            (None, None) => false,
            _ => true,
        };
        let act = match (lc, rc, l.is_some(), rm.is_some()) {
            (false, false, true, true) => continue,
            (false, false, _, _) => Act::Forget(k),
            (true, false, true, _) => Act::Upload(k),
            (true, false, false, true) => Act::DelRemote(k),
            (true, false, false, false) => Act::Forget(k),
            (false, true, _, true) => Act::Download(k),
            (false, true, true, false) => Act::DelLocal(k),
            (false, true, false, false) => Act::Forget(k),
            // both changed
            (true, true, true, true) => Act::Both(k),
            (true, true, true, false) => Act::Upload(k),   // edited here, deleted there: keep the edit
            (true, true, false, true) => Act::Download(k), // deleted here, edited there: keep the edit
            (true, true, false, false) => Act::Forget(k),
        };
        plan.push(act);
    }

    let deletions = plan.iter().filter(|a| matches!(a, Act::DelLocal(_) | Act::DelRemote(_))).count();
    if !r.force && deletions > 10 && deletions * 2 > st.files.len() {
        return Err(format!("SYNC_MASS_DELETE:{deletions}"));
    }

    // ── execute ──
    let mut rep = Report::default();
    let total = plan.iter().filter(|a| !matches!(a, Act::Forget(_))).count();
    let mut done = 0;
    let mut changed: HashSet<String> = HashSet::new();
    for act in plan {
        let res: Result<(), String> = async {
            match &act {
                Act::Forget(k) => {
                    st.files.remove(k);
                }
                Act::Upload(k) => {
                    let l = &local[k];
                    (r.progress)(done, total, &l.rel);
                    let p = root.join(&l.rel);
                    let m = std::fs::metadata(&p).map_err(|e| format!("{}: {e}", l.rel))?;
                    let data = std::fs::read(&p).map_err(|e| format!("{}: {e}", l.rel))?;
                    let h = hash(&data);
                    let rev = remote.put(&l.rel, data).await?;
                    st.files.insert(k.clone(), Base { rel: l.rel.clone(), hash: h, rev, mtime: notes::mtime_ms(&m), size: m.len() });
                    rep.uploaded += 1;
                }
                Act::Download(k) => {
                    let rm = &remote_files[k];
                    // a local file of the same name in another letter case keeps its name
                    let rel = local.get(k).map(|l| l.rel.clone()).unwrap_or_else(|| rm.rel.clone());
                    (r.progress)(done, total, &rel);
                    if !unchanged_since_scan(root, local.get(k), &rel) {
                        return Ok(()); // edited meanwhile: next sync sorts it out
                    }
                    let data = remote.get(&rm.rel).await?;
                    let p = notes::safe_join(root, &rel)?;
                    notes::write_atomic(&p, &data)?;
                    let m = std::fs::metadata(&p).map_err(|e| e.to_string())?;
                    st.files.insert(k.clone(), Base { rel: rel.clone(), hash: hash(&data), rev: rm.rev.clone(), mtime: notes::mtime_ms(&m), size: m.len() });
                    changed.insert(rel);
                    rep.downloaded += 1;
                }
                Act::DelRemote(k) => {
                    let rel = st.files.get(k).map(|b| b.rel.clone()).unwrap_or_else(|| remote_files[k].rel.clone());
                    (r.progress)(done, total, &rel);
                    remote.delete(&remote_files[k].rel).await?;
                    st.files.remove(k);
                    rep.deleted_remote += 1;
                }
                Act::DelLocal(k) => {
                    let l = &local[k];
                    (r.progress)(done, total, &l.rel);
                    if !unchanged_since_scan(root, Some(l), &l.rel) {
                        return Ok(());
                    }
                    notes::delete(root, &l.rel)?;
                    st.files.remove(k);
                    changed.insert(l.rel.clone());
                    rep.deleted_local += 1;
                }
                Act::Both(k) => {
                    let (l, rm) = (&local[k], &remote_files[k]);
                    (r.progress)(done, total, &l.rel);
                    let theirs = remote.get(&rm.rel).await?;
                    let p = root.join(&l.rel);
                    let m = std::fs::metadata(&p).map_err(|e| format!("{}: {e}", l.rel))?;
                    let ours = std::fs::read(&p).map_err(|e| format!("{}: {e}", l.rel))?;
                    let h = hash(&ours);
                    if hash(&theirs) == h {
                        // the same content on both sides (e.g. first sync of a copy)
                        st.files.insert(k.clone(), Base { rel: l.rel.clone(), hash: h, rev: rm.rev.clone(), mtime: notes::mtime_ms(&m), size: m.len() });
                        return Ok(());
                    }
                    // keep both: theirs as a conflict copy here and there, ours under the name
                    let copy = conflict_name(root, &l.rel);
                    let cp = notes::safe_join(root, &copy)?;
                    notes::write_atomic(&cp, &theirs)?;
                    let cm = std::fs::metadata(&cp).map_err(|e| e.to_string())?;
                    let crev = remote.put(&copy, theirs.clone()).await?;
                    st.files.insert(key_of(&copy), Base { rel: copy.clone(), hash: hash(&theirs), rev: crev, mtime: notes::mtime_ms(&cm), size: cm.len() });
                    let rev = remote.put(&l.rel, ours).await?;
                    st.files.insert(k.clone(), Base { rel: l.rel.clone(), hash: h, rev, mtime: notes::mtime_ms(&m), size: m.len() });
                    changed.insert(copy.clone());
                    rep.conflicts.push(copy);
                    rep.uploaded += 1;
                }
            }
            Ok(())
        }
        .await;
        if !matches!(act, Act::Forget(_)) {
            done += 1;
        }
        if let Err(e) = res {
            rep.errors.push(e);
            if rep.errors.len() >= 20 {
                rep.errors.push(tr("Túl sok hiba, a szinkron leállt.", "Too many errors, the sync stopped."));
                break;
            }
        }
    }
    (r.progress)(total, total, "");
    rep.files = st.files.len();
    rep.changed = changed.into_iter().collect();
    save_state(r.state_dir, &r.target.id, &st)?;
    Ok(rep)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("notestar-test-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn target(dir: &Path) -> Target {
        Target { id: "t1".into(), name: "x".into(), kind: "folder".into(), path: dir.to_string_lossy().into_owned(), ..Default::default() }
    }

    async fn sync(notes: &Path, state: &Path, t: &Target) -> Report {
        let exts = vec!["md".to_string(), "txt".to_string()];
        run(Run { notes_dir: notes, exts: &exts, state_dir: state, target: t, force: false, progress: &|_, _, _| {}, on_token: &|_| {} })
            .await
            .unwrap()
    }

    fn put(p: &Path, rel: &str, s: &str) {
        let f = p.join(rel);
        std::fs::create_dir_all(f.parent().unwrap()).unwrap();
        std::fs::write(f, s).unwrap();
        // make sure the next write gets a different mtime
        std::thread::sleep(std::time::Duration::from_millis(20));
    }

    #[test]
    fn two_way_folder_sync() {
        tauri::async_runtime::block_on(async {
            let (a, b, st) = (tmp("a"), tmp("b"), tmp("st"));
            let t = target(&b);
            put(&a, "one.md", "1");
            put(&a, "sub/two.md", "2");
            put(&b, "three.txt", "3");
            put(&b, "image.png", "x");
            let r = sync(&a, &st, &t).await;
            assert_eq!((r.uploaded, r.downloaded), (2, 1));
            assert_eq!(std::fs::read_to_string(b.join("sub/two.md")).unwrap(), "2");
            assert_eq!(std::fs::read_to_string(a.join("three.txt")).unwrap(), "3");
            assert!(!a.join("image.png").exists());

            // nothing changed: nothing to do
            let r = sync(&a, &st, &t).await;
            assert_eq!((r.uploaded, r.downloaded, r.deleted_local, r.deleted_remote), (0, 0, 0, 0));

            // edit on the remote side, delete on the local side
            put(&b, "one.md", "1 edited there");
            std::fs::remove_file(a.join("three.txt")).unwrap();
            let r = sync(&a, &st, &t).await;
            assert_eq!((r.downloaded, r.deleted_remote), (1, 1));
            assert_eq!(std::fs::read_to_string(a.join("one.md")).unwrap(), "1 edited there");
            assert!(!b.join("three.txt").exists());

            // both sides edit the same note: a conflict copy keeps the other version
            put(&a, "sub/two.md", "mine");
            put(&b, "sub/two.md", "theirs");
            let r = sync(&a, &st, &t).await;
            assert_eq!(r.conflicts.len(), 1);
            assert_eq!(std::fs::read_to_string(a.join("sub/two.md")).unwrap(), "mine");
            assert_eq!(std::fs::read_to_string(b.join("sub/two.md")).unwrap(), "mine");
            assert_eq!(std::fs::read_to_string(a.join(&r.conflicts[0])).unwrap(), "theirs");
            assert!(b.join(&r.conflicts[0]).exists());

            for d in [a, b, st] {
                let _ = std::fs::remove_dir_all(d);
            }
        });
    }

    #[test]
    fn mass_delete_is_stopped() {
        tauri::async_runtime::block_on(async {
            let (a, b, st) = (tmp("ma"), tmp("mb"), tmp("mst"));
            let t = target(&b);
            for i in 0..20 {
                put(&a, &format!("n{i}.md"), "x");
            }
            sync(&a, &st, &t).await;
            for i in 0..20 {
                std::fs::remove_file(b.join(format!("n{i}.md"))).unwrap();
            }
            let exts = vec!["md".to_string()];
            let res = run(Run { notes_dir: &a, exts: &exts, state_dir: &st, target: &t, force: false, progress: &|_, _, _| {}, on_token: &|_| {} }).await;
            assert!(res.unwrap_err().starts_with("SYNC_MASS_DELETE:20"));
            assert!(a.join("n0.md").exists());
            for d in [a, b, st] {
                let _ = std::fs::remove_dir_all(d);
            }
        });
    }

    #[test]
    fn new_remote_place_starts_fresh() {
        tauri::async_runtime::block_on(async {
            let (a, b, c, st) = (tmp("fa"), tmp("fb"), tmp("fc"), tmp("fst"));
            put(&a, "keep.md", "k");
            sync(&a, &st, &target(&b)).await;
            // the same target id pointed at an empty folder must not delete local notes
            let r = sync(&a, &st, &target(&c)).await;
            assert_eq!((r.deleted_local, r.uploaded), (0, 1));
            assert!(a.join("keep.md").exists());
            for d in [a, b, c, st] {
                let _ = std::fs::remove_dir_all(d);
            }
        });
    }
}
