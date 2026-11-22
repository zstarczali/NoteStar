//! Note colours, kept in a small file in the notes folder so the sync carries
//! them to the other machines — the same way as the stars (`stars.rs`), in a
//! file of their own, so the NoteStar versions that know only the stars
//! leave it alone.
//!
//! Every note has a mark (a colour name, or "" for none) with the time it was
//! set. Two versions of the file merge mark by mark, the later one wins. A
//! removed colour stays in the file as `""`: without it the other machines
//! would bring the colour back.

use crate::notes;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Mutex;

/// Relative path of the colours file (hidden: not shown in the tree).
pub const FILE: &str = ".notestar-colors.json";

/// The colours the app offers; anything else read from the file is kept but shown as none.
pub const NAMES: &[&str] = &["red", "orange", "yellow", "green", "blue", "purple", "gray"];

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Mark {
    /// colour name, "" = none
    pub c: String,
    /// When it was set (ms)
    pub t: i64,
}

#[derive(Serialize, Deserialize, Default, Debug, PartialEq)]
#[serde(default)]
pub struct Colors {
    pub v: u32,
    /// note path → mark
    pub colors: BTreeMap<String, Mark>,
}

/// The app and the sync both write the file: one at a time.
static LOCK: Mutex<()> = Mutex::new(());

pub fn is_file(rel: &str) -> bool {
    rel.eq_ignore_ascii_case(FILE)
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

pub fn parse(data: &[u8]) -> Colors {
    serde_json::from_slice(data).unwrap_or_default()
}

fn to_bytes(s: &Colors) -> Vec<u8> {
    let mut out = serde_json::to_vec_pretty(&Colors { v: 1, colors: s.colors.clone() }).unwrap_or_default();
    out.push(b'\n');
    out
}

fn load(root: &Path) -> Colors {
    std::fs::read(root.join(FILE)).map(|d| parse(&d)).unwrap_or_default()
}

fn save(root: &Path, s: &Colors) -> Result<(), String> {
    notes::write_atomic(&root.join(FILE), &to_bytes(s))
}

fn current(s: Colors) -> BTreeMap<String, String> {
    s.colors.into_iter().filter(|(_, m)| !m.c.is_empty()).map(|(k, m)| (k, m.c)).collect()
}

/// Mark by mark, the later wins; on a tie the greater name, so both sides agree.
pub fn merge(a: &Colors, b: &Colors) -> Colors {
    let mut out = Colors { v: 1, colors: a.colors.clone() };
    for (k, m) in &b.colors {
        match out.colors.get(k) {
            Some(o) if o.t > m.t || (o.t == m.t && o.c >= m.c) => {}
            _ => {
                out.colors.insert(k.clone(), m.clone());
            }
        }
    }
    out
}

/// The coloured notes: path → colour.
pub fn list(root: &Path) -> BTreeMap<String, String> {
    let _g = LOCK.lock().unwrap();
    current(load(root))
}

/// Sets marks (`(path, colour)`, "" = none); returns the coloured notes after it.
pub fn set(root: &Path, changes: &[(String, String)]) -> Result<BTreeMap<String, String>, String> {
    let _g = LOCK.lock().unwrap();
    let mut s = load(root);
    let now = now_ms();
    let mut ch = false;
    for (rel, c) in changes {
        if !c.is_empty() && !NAMES.contains(&c.as_str()) {
            return Err(format!("unknown colour: {c}"));
        }
        let old = s.colors.get(rel).cloned();
        if old.as_ref().map(|m| &m.c) == Some(c) || (old.is_none() && c.is_empty()) {
            continue;
        }
        // later than the mark it replaces, even when this clock is behind
        let t = old.map_or(now, |m| now.max(m.t + 1));
        s.colors.insert(rel.clone(), Mark { c: c.clone(), t });
        ch = true;
    }
    if ch {
        save(root, &s)?;
    }
    Ok(current(s))
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

    fn m(c: &str, t: i64) -> Mark {
        Mark { c: c.into(), t }
    }

    #[test]
    fn later_mark_wins() {
        let mut a = Colors::default();
        a.colors.insert("x.md".into(), m("red", 10));
        a.colors.insert("y.md".into(), m("blue", 10));
        a.colors.insert("w.md".into(), m("green", 30));
        let mut b = Colors::default();
        b.colors.insert("x.md".into(), m("", 20)); // removed later elsewhere
        b.colors.insert("y.md".into(), m("", 5)); // removed earlier: the colour stays
        b.colors.insert("z.md".into(), m("purple", 7)); // coloured elsewhere
        b.colors.insert("w.md".into(), m("yellow", 30)); // same time: the same winner on both sides
        let r = merge(&a, &b);
        assert_eq!(r.colors["x.md"], m("", 20));
        assert_eq!(r.colors["y.md"], m("blue", 10));
        assert_eq!(r.colors["z.md"], m("purple", 7));
        assert_eq!(r.colors["w.md"], m("yellow", 30));
        assert_eq!(merge(&a, &b), merge(&b, &a));
    }

    #[test]
    fn set_and_list() {
        let d = std::env::temp_dir().join(format!("notestar-colors-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        let r = set(&d, &[("a.md".into(), "red".into()), ("b.md".into(), "blue".into())]).unwrap();
        assert_eq!(r.len(), 2);
        let r = set(&d, &[("a.md".into(), "".into()), ("b.md".into(), "green".into())]).unwrap();
        assert_eq!(r.into_iter().collect::<Vec<_>>(), vec![("b.md".to_string(), "green".to_string())]);
        assert!(set(&d, &[("c.md".into(), "#ff0000".into())]).is_err());
        assert_eq!(list(&d).len(), 1);
        // the removal stays as a tombstone
        assert_eq!(load(&d).colors["a.md"].c, "");
        let _ = std::fs::remove_dir_all(&d);
    }
}
