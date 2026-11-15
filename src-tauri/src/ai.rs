//! AI features through the Claude Messages API (raw HTTP, API key auth),
//! DeepSeek, or the local Claude Code CLI.

use crate::settings::tr;
use serde_json::{json, Value};

const API_URL: &str = "https://api.anthropic.com/v1/messages";
const API_VERSION: &str = "2026-10-21";
const FALLBACK_BETA: &str = "server-side-fallback-2026-07-01";

/// Largest text sent to the model; above this it is cut and the user is
/// told so in the result.
pub const MAX_DIFF_CHARS: usize = 600_000;

const DEEPSEEK_URL: &str = "https://api.deepseek.com/chat/completions";

/// Smaller diff limit for DeepSeek (smaller context window than Claude).
pub const DEEPSEEK_MAX_DIFF_CHARS: usize = 300_000;

pub struct AiRequest<'a> {
    /// "anthropic" | "deepseek" | "claude-cli"
    pub provider: &'a str,
    /// API key; for "claude-cli" the CLI path from Settings (empty = find it)
    pub api_key: &'a str,
    pub model: &'a str,
    pub system: String,
    pub user: String,
    pub effort: &'a str,
    pub max_tokens: u32,
}

/// Models that accept the `output_config.effort` parameter.
fn supports_effort(model: &str) -> bool {
    !(model.starts_with("claude-haiku-4") || model.contains("sonnet-4-5") || model.contains("3-"))
}

/// Models that accept server-side `fallbacks: "default"`.
fn supports_fallback(model: &str) -> bool {
    matches!(model, "claude-opus-5-5" | "claude-opus-5" | "claude-fable-5-1" | "claude-sonnet-5-5")
}

pub async fn complete(req: AiRequest<'_>) -> Result<String, String> {
    if req.provider == "deepseek" {
        return complete_deepseek(req).await;
    }
    if req.provider == "claude-cli" {
        let (path, model, system, user) = (req.api_key.to_string(), req.model.to_string(), req.system, req.user);
        let effort = supports_effort(&model).then(|| req.effort.to_string());
        return tauri::async_runtime::spawn_blocking(move || crate::claude_cli::complete(&path, &model, effort.as_deref(), &system, &user))
            .await
            .map_err(|e| e.to_string())?;
    }
    if req.api_key.trim().is_empty() {
        return Err(tr("Nincs megadva Anthropic API kulcs (Beállítások → AI).", "No Anthropic API key is set (Settings → AI)."));
    }
    let mut body = json!({
        "model": req.model,
        "max_tokens": req.max_tokens,
        "system": req.system,
        "messages": [{ "role": "user", "content": req.user }],
    });
    if supports_effort(req.model) {
        body["output_config"] = json!({ "effort": req.effort });
    }
    let fallback = supports_fallback(req.model);
    if fallback {
        body["fallbacks"] = json!("default");
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(600))
        .build()
        .map_err(|e| e.to_string())?;
    let mut http = client
        .post(API_URL)
        .header("x-api-key", req.api_key.trim())
        .header("anthropic-version", API_VERSION)
        .header("content-type", "application/json");
    if fallback {
        http = http.header("anthropic-beta", FALLBACK_BETA);
    }
    let resp = http.json(&body).send().await.map_err(|e| format!("{}: {e}", tr("Hálózati hiba", "Network error")))?;
    let status = resp.status();
    let v: Value = resp.json().await.map_err(|e| format!("{}: {e}", tr("Hibás válasz", "Invalid response")))?;
    if !status.is_success() {
        let unknown = tr("ismeretlen hiba", "unknown error");
        let msg = v["error"]["message"].as_str().unwrap_or(&unknown);
        let kind = v["error"]["type"].as_str().unwrap_or("");
        return Err(match status.as_u16() {
            401 => format!("{} ({msg})", tr("Érvénytelen API kulcs", "Invalid API key")),
            429 => format!("{} ({msg})", tr("Túl sok kérés / kvóta elfogyott, próbáld később", "Too many requests / quota exceeded, try again later")),
            529 => format!("{} ({msg})", tr("Az API túlterhelt, próbáld később", "The API is overloaded, try again later")),
            c => format!("{} {c} {kind}: {msg}", tr("API hiba", "API error")),
        });
    }
    if v["stop_reason"].as_str() == Some("refusal") {
        let expl = v["stop_details"]["explanation"].as_str().unwrap_or("");
        return Err(format!("{} {expl}", tr("A modell elutasította a kérést.", "The model declined the request.")));
    }
    let text: String = v["content"]
        .as_array()
        .map(|blocks| {
            blocks
                .iter()
                .filter(|b| b["type"] == "text")
                .filter_map(|b| b["text"].as_str())
                .collect::<Vec<_>>()
                .join("")
        })
        .unwrap_or_default();
    if text.trim().is_empty() {
        return Err(tr("Üres válasz érkezett a modelltől.", "The model returned an empty response."));
    }
    let mut text = text.trim().to_string();
    if v["stop_reason"].as_str() == Some("max_tokens") {
        text.push_str(&tr("\n\n_(A válasz a maximális hossznál megszakadt.)_", "\n\n_(The answer was cut at the maximum length.)_"));
    }
    Ok(text)
}

/// DeepSeek: OpenAI-compatible chat completions API, Bearer key.
async fn complete_deepseek(req: AiRequest<'_>) -> Result<String, String> {
    if req.api_key.trim().is_empty() {
        return Err(tr("Nincs megadva DeepSeek API kulcs (Beállítások → AI).", "No DeepSeek API key is set (Settings → AI)."));
    }
    // max_tokens is left to the server default: the per-model limits are not published.
    let body = json!({
        "model": req.model,
        "messages": [
            { "role": "system", "content": req.system },
            { "role": "user", "content": req.user },
        ],
        "stream": false,
    });
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(600))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .post(DEEPSEEK_URL)
        .bearer_auth(req.api_key.trim())
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("{}: {e}", tr("Hálózati hiba", "Network error")))?;
    let status = resp.status();
    let raw = resp.text().await.map_err(|e| format!("{}: {e}", tr("Hibás válasz", "Invalid response")))?;
    let v: Value = serde_json::from_str(&raw).unwrap_or(Value::Null);
    if !status.is_success() {
        let msg = v["error"]["message"].as_str().map(str::to_string).unwrap_or_else(|| raw.chars().take(300).collect());
        return Err(match status.as_u16() {
            401 => format!("{} ({msg})", tr("Érvénytelen DeepSeek API kulcs", "Invalid DeepSeek API key")),
            402 => format!("{} ({msg})", tr("Elfogyott a DeepSeek egyenleg", "DeepSeek balance is insufficient")),
            429 => format!("{} ({msg})", tr("Túl sok kérés, próbáld később", "Too many requests, try again later")),
            500 | 503 => format!("{} ({msg})", tr("A DeepSeek szerver túlterhelt vagy hibás, próbáld később", "The DeepSeek server is busy or failing, try again later")),
            c => format!("DeepSeek {} {c}: {msg}", tr("hiba", "error")),
        });
    }
    let choice = &v["choices"][0];
    let text = choice["message"]["content"].as_str().unwrap_or("").trim().to_string();
    if text.is_empty() {
        return Err(tr("Üres válasz érkezett a modelltől.", "The model returned an empty response."));
    }
    let mut text = text;
    if choice["finish_reason"].as_str() == Some("length") {
        text.push_str(&tr("\n\n_(A válasz a maximális hossznál megszakadt.)_", "\n\n_(The answer was cut at the maximum length.)_"));
    }
    Ok(text)
}

pub fn cut_diff(diff: &str, provider: &str) -> (String, bool) {
    let max = if provider == "deepseek" { DEEPSEEK_MAX_DIFF_CHARS } else { MAX_DIFF_CHARS };
    if diff.len() <= max {
        return (diff.to_string(), false);
    }
    let mut end = max;
    while !diff.is_char_boundary(end) {
        end -= 1;
    }
    (diff[..end].to_string(), true)
}

fn lang_name(lang: &str) -> &'static str {
    if lang == "en" { "English" } else { "Hungarian" }
}

/// What the AI does when the user only presses the AI button.
pub const NOTE_DEFAULT_ASK: &str = "Summarise this note using the default structure.";
pub const MERGE_DEFAULT_ASK: &str = "Merge the two versions using the default structure.";

pub fn note_system(lang: &str) -> String {
    format!(
        "You are a writing assistant inside NoteStar, a plain-text / Markdown notes app. The user gives you one note \
         (inside <note>) and a request.\n\
         Answer in {lang}, formatted as Markdown.\n\
         When no specific request is made: ## Összefoglaló / Summary (3–6 bullet points), ## Teendők / Action items \
         (only if the note contains tasks, as a `- [ ]` checklist), ## Javaslatok / Suggestions (at most three short ideas \
         to make the note clearer or more complete).\n\
         When the request asks you to change the note (fix spelling or grammar, rewrite, shorten, expand, translate, format, \
         turn into a list or table…), return the COMPLETE new text of the note in ONE fenced code block marked ```markdown, \
         keeping the note's own language unless a translation is asked for, followed by at most two short sentences about \
         what you changed. Never invent facts that are not in the note. When the request is a question, answer it directly \
         and concisely. Use the heading language that matches {lang}.",
        lang = lang_name(lang)
    )
}

pub fn merge_system(lang: &str) -> String {
    format!(
        "You are inside NoteStar, a notes app that syncs plain-text / Markdown notes between devices. The same note was \
         edited on two devices before they synced, so there are two versions: <version_a> (this computer) and <version_b> \
         (the conflict copy from the other device).\n\
         Default task: produce one merged note that keeps every piece of information from both versions; where they \
         contradict, prefer the more complete or more recent-looking text and mention the choice. Return the COMPLETE merged \
         note in ONE fenced code block marked ```markdown (in the note's own language), then, in {lang}, a short \
         ## Változások / Changes list: what came from A, what from B, and any decision the user should check. \
         When the user asks a follow-up question, answer it directly.",
        lang = lang_name(lang)
    )
}
