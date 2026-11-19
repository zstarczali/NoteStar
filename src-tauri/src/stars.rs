//! Starred notes, kept in a small file in the notes folder so the sync carries
//! them to the other machines.
//!
//! Every note has a mark (starred or not) with the time it was set. Two
//! versions of the file merge mark by mark, the later one wins, so stars set
//! or removed on different machines all survive the sync (no conflict copy).
//! A removed star stays in the file as `on: false`: without it the other
//! machines would bring the star back.

use crate::notes;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Mutex;

/// Relative path of the stars file (hidden: not shown in the tree).
pub const FILE: &str = ".notestar-stars.json";

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
pub struct Mark {
    pub on: bool,
    /// When it was set (ms)
    pub t: i64,
}

#[derive(Serialize, Deserialize, Default, Debug, PartialEq)]
#[serde(default)]
pub struct Stars {
    pub v: u32,
    /// note path → mark
    pub stars: BTreeMap<String, Mark>,
}

/// The app and the sync both write the file: one at a time.
static LOCK: Mutex<()> = Mutex::new(());

pub fn is_file(rel: &str) -> bool {
    rel.eq_ignore_ascii_case(FILE)
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

pub fn parse(data: &[u8]) -> Stars {
    serde_json::from_slice(data).unwrap_or_default()
}

fn to_bytes(s: &Stars) -> Vec<u8> {
    let mut out = serde_json::to_vec_pretty(&Stars { v: 1, stars: s.stars.clone() }).unwrap_or_default();
    out.push(b'\n');
    out
}

fn load(root: &Path) -> Stars {
    std::fs::read(root.join(FILE)).map(|d| parse(&d)).unwrap_or_default()
}

fn save(root: &Path, s: &Stars) -> Result<(), String> {
    notes::write_atomic(&root.join(FILE), &to_bytes(s))
}

/// Mark by mark, the later wins (on a tie the star stays).
pub fn merge(a: &Stars, b: &Stars) -> Stars {
    let mut out = Stars { v: 1, stars: a.stars.clone() };
    for (k, m) in &b.stars {
        match out.stars.get(k) {
            Some(o) if o.t > m.t || (o.t == m.t && o.on) => {}
            _ => {
                out.stars.insert(k.clone(), *m);
            }
        }
    }
    out
}

/// The starred notes.
pub fn list(root: &Path) -> Vec<String> {
    let _g = LOCK.lock().unwrap();
    load(root).stars.into_iter().filter(|(_, m)| m.on).map(|(k, _)| k).collect()
}

/// Sets marks (`(path, starred)`); returns the starred notes after it.
pub fn set(root: &Path, changes: &[(String, bool)]) -> Result<Vec<String>, String> {
    let _g = LOCK.lock().unwrap();
    let mut s = load(root);
    let now = now_ms();
    let mut ch = false;
    for (rel, on) in changes {
        let old = s.stars.get(rel).copied();
        if old.map(|m| m.on) == Some(*on) || (old.is_none() && !on) {
            continue;
        }
        // later than the mark it replaces, even when this clock is behind
        let t = old.map_or(now, |m| now.max(m.t + 1));
        s.stars.insert(rel.clone(), Mark { on: *on, t });
        ch = true;
    }
    if ch {
        save(root, &s)?;
    }
    Ok(s.stars.into_iter().filter(|(_, m)| m.on).map(|(k, _)| k).collect())
}

/// Stars kept by an older version on this machine only: added with the
/// oldest time, so a removal made on another machine still wins.
pub fn import(root: &Path, rels: &[String]) -> Result<(), String> {
    let _g = LOCK.lock().unwrap();
    let mut s = load(root);
    let mut ch = false;
    for rel in rels {
        if !s.stars.contains_key(rel) {
            s.stars.insert(rel.clone(), Mark { on: true, t: 1 });
            ch = true;
        }
    }
    if ch {
        save(root, &s)?;
    }
    Ok(())
}

/// The sync found the file changed on both sides: merges `theirs` into the
/// local file and returns the merged content (to upload).
pub fn merge_local(root: &Path, theirs: &[u8]) -> Result<Vec<u8>, String> {
    let _g = LOCK.lock().unwrap();
    let merged = merge(&load(root), &parse(theirs));
    save(root, &merged)?;
    Ok(to_bytes(&merged))
}

/// Locks out the app's writes while the sync replaces the local file.
pub fn write_downloaded(root: &Path, data: &[u8]) -> Result<(), String> {
    let _g = LOCK.lock().unwrap();
    // the app may have written since the sync looked: keep both
    let merged = merge(&load(root), &parse(data));
    save(root, &merged)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn m(on: bool, t: i64) -> Mark {
        Mark { on, t }
    }

    #[test]
    fn later_mark_wins() {
        let mut a = Stars::default();
        a.stars.insert("x.md".into(), m(true, 10));
        a.stars.insert("y.md".into(), m(true, 10));
        let mut b = Stars::default();
        b.stars.insert("x.md".into(), m(false, 20)); // removed later elsewhere
        b.stars.insert("y.md".into(), m(false, 5)); // removed earlier: the star stays
        b.stars.insert("z.md".into(), m(true, 7)); // starred elsewhere
        let r = merge(&a, &b);
        assert_eq!(r.stars["x.md"], m(false, 20));
        assert_eq!(r.stars["y.md"], m(true, 10));
        assert_eq!(r.stars["z.md"], m(true, 7));
        assert_eq!(merge(&a, &b), merge(&b, &a));
    }

    #[test]
    fn set_and_import() {
        let d = std::env::temp_dir().join(format!("notestar-stars-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        assert_eq!(set(&d, &[("a.md".into(), true), ("b.md".into(), true)]).unwrap(), vec!["a.md", "b.md"]);
        assert_eq!(set(&d, &[("a.md".into(), false)]).unwrap(), vec!["b.md"]);
        // an old local star does not bring back one removed here
        import(&d, &["a.md".into(), "c.md".into()]).unwrap();
        assert_eq!(list(&d), vec!["b.md", "c.md"]);
        let _ = std::fs::remove_dir_all(&d);
    }
}
