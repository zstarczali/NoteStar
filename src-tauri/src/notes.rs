//! The notes folder: listing, reading, writing, creating, renaming, deleting
//! and searching plain text notes. Every path the UI sends is relative to the
//! notes folder (with `/` separators) and is checked to stay inside it.

use crate::settings::tr;
use serde::Serialize;
use std::path::{Component, Path, PathBuf};
use std::time::UNIX_EPOCH;

/// Names never listed or synced: hidden files, our temp files, OS litter.
pub fn ignored(name: &str) -> bool {
    name.starts_with('.')
        || name.starts_with('~')
        || name.ends_with(".tmp")
        || name.ends_with(".notestar-tmp")
        || name.eq_ignore_ascii_case("Thumbs.db")
        || name.eq_ignore_ascii_case("desktop.ini")
        || name == "Icon\r"
}

/// Is `name` a note (by extension)? `exts` empty = every file.
pub fn is_note(name: &str, exts: &[String]) -> bool {
    if ignored(name) {
        return false;
    }
    if exts.is_empty() {
        return true;
    }
    match name.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() => exts.iter().any(|e| e.eq_ignore_ascii_case(ext)),
        _ => false,
    }
}

/// `root` + relative path, refusing `..`, absolute paths and drive prefixes.
pub fn safe_join(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let rel = rel.replace('\\', "/");
    let rel = rel.trim_matches('/');
    let mut out = root.to_path_buf();
    for part in Path::new(rel).components() {
        match part {
            Component::Normal(p) => out.push(p),
            Component::CurDir => {}
            _ => return Err(format!("{}: {rel}", tr("Érvénytelen útvonal", "Invalid path"))),
        }
    }
    Ok(out)
}

pub fn mtime_ms(m: &std::fs::Metadata) -> i64 {
    m.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_millis() as i64).unwrap_or(0)
}

#[derive(Serialize, Clone, Debug)]
pub struct Entry {
    /// Relative path with `/` separators
    pub rel: String,
    pub dir: bool,
    pub size: u64,
    /// Modification time, ms since 1970
    pub mtime: i64,
}

/// Every folder and note under `root` (hidden ones skipped).
pub fn list(root: &Path, exts: &[String]) -> Result<Vec<Entry>, String> {
    if !root.is_dir() {
        std::fs::create_dir_all(root).map_err(|e| format!("{}: {e}", root.display()))?;
    }
    let mut out = vec![];
    walk(root, "", exts, &mut out, 0);
    Ok(out)
}

fn walk(dir: &Path, prefix: &str, exts: &[String], out: &mut Vec<Entry>, depth: u32) {
    if depth > 32 {
        return;
    }
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        if ignored(&name) {
            continue;
        }
        let Ok(ft) = e.file_type() else { continue };
        if ft.is_symlink() {
            continue;
        }
        let rel = if prefix.is_empty() { name.clone() } else { format!("{prefix}/{name}") };
        let Ok(m) = e.metadata() else { continue };
        if ft.is_dir() {
            out.push(Entry { rel: rel.clone(), dir: true, size: 0, mtime: mtime_ms(&m) });
            walk(&e.path(), &rel, exts, out, depth + 1);
        } else if is_note(&name, exts) {
            out.push(Entry { rel, dir: false, size: m.len(), mtime: mtime_ms(&m) });
        }
    }
}

#[derive(Serialize)]
pub struct Note {
    pub text: String,
    pub mtime: i64,
    pub size: u64,
    /// The file is not valid UTF-8 (shown read-only so it is not damaged)
    pub lossy: bool,
}

/// Bytes → text: UTF-8 (a BOM is dropped), else a lossy copy.
pub fn decode(buf: &[u8]) -> (String, bool) {
    let b = buf.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(buf);
    match std::str::from_utf8(b) {
        Ok(s) => (s.to_string(), false),
        Err(_) => (String::from_utf8_lossy(b).into_owned(), true),
    }
}

pub fn read(root: &Path, rel: &str) -> Result<Note, String> {
    let p = safe_join(root, rel)?;
    let buf = std::fs::read(&p).map_err(|e| format!("{rel}: {e}"))?;
    let m = std::fs::metadata(&p).map_err(|e| e.to_string())?;
    let (text, lossy) = decode(&buf);
    Ok(Note { text, mtime: mtime_ms(&m), size: m.len(), lossy })
}

/// Writes through a temp file + rename, so a crash never leaves half a note.
pub fn write_atomic(path: &Path, data: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
    }
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let tmp = path.with_file_name(format!(".{name}.notestar-tmp"));
    std::fs::write(&tmp, data).map_err(|e| format!("{}: {e}", path.display()))?;
    if let Err(e) = std::fs::rename(&tmp, path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("{}: {e}", path.display()));
    }
    Ok(())
}

#[derive(Serialize)]
pub struct Saved {
    pub mtime: i64,
    pub size: u64,
}

/// Saves a note. `expect` (the mtime the editor loaded) guards against
/// overwriting a newer version written by a sync or another program.
pub fn write(root: &Path, rel: &str, text: &str, expect: Option<i64>, force: bool) -> Result<Saved, String> {
    let p = safe_join(root, rel)?;
    if let (Some(exp), false) = (expect, force) {
        if let Ok(m) = std::fs::metadata(&p) {
            if exp > 0 && mtime_ms(&m) != exp {
                return Err("NOTE_CHANGED".into());
            }
        }
    }
    write_atomic(&p, text.as_bytes())?;
    let m = std::fs::metadata(&p).map_err(|e| e.to_string())?;
    Ok(Saved { mtime: mtime_ms(&m), size: m.len() })
}

/// Characters not allowed in file names on Windows / macOS / Linux.
pub fn clean_name(name: &str) -> String {
    let s: String = name
        .chars()
        .map(|c| if matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') || c.is_control() { '-' } else { c })
        .collect();
    s.trim().trim_end_matches('.').trim().chars().take(120).collect()
}

/// A path in `dir` named `stem.ext`, `stem 2.ext`, ... that does not exist yet.
pub fn unique(root: &Path, dir: &str, stem: &str, ext: &str) -> Result<String, String> {
    let dir = dir.trim_matches('/');
    for n in 1..10_000 {
        let name = if n == 1 { format!("{stem}{ext}") } else { format!("{stem} {n}{ext}") };
        let rel = if dir.is_empty() { name } else { format!("{dir}/{name}") };
        if !safe_join(root, &rel)?.exists() {
            return Ok(rel);
        }
    }
    Err(tr("Nem található szabad fájlnév.", "No free file name found."))
}

/// Creates an empty note (or one starting with `# title`) and returns its path.
pub fn create(root: &Path, dir: &str, title: &str, ext: &str) -> Result<String, String> {
    let stem = clean_name(title);
    let stem = if stem.is_empty() { tr("Új jegyzet", "New note") } else { stem };
    let ext = format!(".{}", ext.trim_start_matches('.'));
    let rel = unique(root, dir, &stem, &ext)?;
    let body = if ext == ".md" && !title.trim().is_empty() { format!("# {}\n\n", title.trim()) } else { String::new() };
    write_atomic(&safe_join(root, &rel)?, body.as_bytes())?;
    Ok(rel)
}

pub fn create_dir(root: &Path, parent: &str, name: &str) -> Result<String, String> {
    let name = clean_name(name);
    if name.is_empty() {
        return Err(tr("Adj meg egy nevet.", "Enter a name."));
    }
    let parent = parent.trim_matches('/');
    let rel = if parent.is_empty() { name } else { format!("{parent}/{name}") };
    let p = safe_join(root, &rel)?;
    if p.exists() {
        return Err(format!("{}: {rel}", tr("Már létezik", "Already exists")));
    }
    std::fs::create_dir_all(&p).map_err(|e| format!("{rel}: {e}"))?;
    Ok(rel)
}

/// Renames or moves a note / folder (inside the notes folder).
pub fn rename(root: &Path, from: &str, to: &str) -> Result<(), String> {
    let a = safe_join(root, from)?;
    let b = safe_join(root, to)?;
    if a == b {
        return Ok(());
    }
    if b.starts_with(&a) {
        return Err(tr("Egy mappát nem lehet önmagába mozgatni.", "A folder cannot be moved into itself."));
    }
    // only the letter case changes: allowed on case-insensitive file systems
    let same_file = from.to_lowercase() == to.to_lowercase();
    if b.exists() && !same_file {
        return Err(format!("{}: {to}", tr("Már létezik", "Already exists")));
    }
    if let Some(parent) = b.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::rename(&a, &b).map_err(|e| format!("{from} → {to}: {e}"))
}

/// Moves a note or folder to the recycle bin.
pub fn delete(root: &Path, rel: &str) -> Result<(), String> {
    let p = safe_join(root, rel)?;
    if p == root {
        return Err(tr("A jegyzetmappa nem törölhető.", "The notes folder cannot be deleted."));
    }
    trash::delete(&p).map_err(|e| format!("{rel}: {e}"))
}

#[derive(Serialize)]
pub struct Hit {
    pub rel: String,
    /// 1-based line of the first match (0 = only the name matched)
    pub line: usize,
    pub snippet: String,
    pub count: usize,
}

/// Full-text search (case-insensitive) in every note; name matches count too.
pub fn search(root: &Path, exts: &[String], query: &str, max: usize) -> Result<Vec<Hit>, String> {
    let q = query.trim().to_lowercase();
    if q.is_empty() {
        return Ok(vec![]);
    }
    let mut out = vec![];
    for e in list(root, exts)? {
        if e.dir || e.size > 8 * 1024 * 1024 {
            continue;
        }
        let Ok(buf) = std::fs::read(root.join(&e.rel)) else { continue };
        let (text, _) = decode(&buf);
        let mut first: Option<(usize, String)> = None;
        let mut count = 0;
        for (i, line) in text.lines().enumerate() {
            let low = line.to_lowercase();
            let n = low.matches(&q).count();
            if n > 0 {
                count += n;
                if first.is_none() {
                    first = Some((i + 1, snippet(line, &low, &q)));
                }
            }
        }
        let name_hit = e.rel.to_lowercase().contains(&q);
        if count > 0 || name_hit {
            let (line, snippet) = first.unwrap_or((0, String::new()));
            out.push(Hit { rel: e.rel, line, snippet, count });
        }
    }
    out.sort_by(|a, b| b.count.cmp(&a.count).then(a.rel.cmp(&b.rel)));
    out.truncate(max);
    Ok(out)
}

/// About 120 characters of `line` around the first match.
fn snippet(line: &str, low: &str, q: &str) -> String {
    let chars: Vec<char> = line.chars().collect();
    // the char index of the match (lower-casing may change byte lengths)
    let at = low.find(q).map(|b| low[..b].chars().count()).unwrap_or(0).min(chars.len());
    let start = at.saturating_sub(40);
    let end = (at + 80).min(chars.len());
    let mut s: String = chars[start..end].iter().collect();
    if start > 0 {
        s = format!("…{}", s.trim_start());
    }
    if end < chars.len() {
        s.push('…');
    }
    s.trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn safe_join_refuses_escapes() {
        let root = Path::new("/notes");
        assert!(safe_join(root, "a/b.md").is_ok());
        assert!(safe_join(root, "../x.md").is_err());
        assert!(safe_join(root, "a/../../x.md").is_err());
        assert_eq!(safe_join(root, "/a/b.md").unwrap(), Path::new("/notes/a/b.md"));
    }

    #[test]
    fn note_filter() {
        let exts = vec!["md".to_string(), "txt".to_string()];
        assert!(is_note("a.md", &exts));
        assert!(is_note("A.TXT", &exts));
        assert!(!is_note("a.png", &exts));
        assert!(!is_note(".md", &exts));
        assert!(!is_note(".hidden.md", &exts));
        assert!(is_note("x.png", &[]));
    }

    #[test]
    fn names_are_cleaned() {
        assert_eq!(clean_name("a/b:c?"), "a-b-c-");
        assert_eq!(clean_name("  hello.  "), "hello");
    }

    #[test]
    fn snippet_handles_unicode() {
        let line = "Árvíztűrő tükörfúrógép és még sok más szöveg";
        let low = line.to_lowercase();
        assert!(snippet(line, &low, "tükör").contains("tükörfúrógép"));
    }
}
