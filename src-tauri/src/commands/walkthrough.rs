use std::sync::Arc;

use serde_json::{json, Value};

use super::{blocking, SharedState};
use crate::state::Shared;
use crate::walkthrough::{self, Entry, Saved};

fn view(key: &str, saved: Option<Saved>) -> Value {
    match saved {
        Some(saved) => json!({ "key": key, "found": true, "walkthrough": saved }),
        None => json!({ "key": key, "found": false }),
    }
}

fn changed(shared: &Shared, key: &str) {
    shared.emit("walkthrough-changed", json!({ "key": key }));
}

#[tauri::command]
pub async fn walkthrough_get(shared: SharedState<'_>, key: String, refresh: bool) -> Result<Value, String> {
    let shared = Arc::clone(&shared);
    blocking(move || {
        let saved = walkthrough::get(&shared, &key, refresh)?;
        if refresh {
            changed(&shared, &key);
        }
        Ok(view(&key, saved))
    })
    .await
}

#[tauri::command]
pub async fn walkthrough_search(shared: SharedState<'_>, query: String) -> Result<Vec<Entry>, String> {
    let shared = Arc::clone(&shared);
    blocking(move || Ok(walkthrough::search(&walkthrough::all_entries(&shared)?, &query))).await
}

#[tauri::command]
pub async fn walkthrough_pick(shared: SharedState<'_>, key: String, title: String, url: String) -> Result<Value, String> {
    let shared = Arc::clone(&shared);
    blocking(move || {
        let saved = walkthrough::pick(&shared, &key, &Entry { title, url })?;
        changed(&shared, &key);
        Ok(view(&key, Some(saved)))
    })
    .await
}

#[tauri::command]
pub async fn walkthrough_source(shared: SharedState<'_>, key: String, source: String) -> Result<Value, String> {
    let shared = Arc::clone(&shared);
    blocking(move || {
        let Some(entry) = walkthrough::find_in(&shared, &key, &source)? else {
            return Ok(json!({ "key": key, "found": false, "no_match": true }));
        };
        let saved = walkthrough::pick(&shared, &key, &entry)?;
        changed(&shared, &key);
        Ok(view(&key, Some(saved)))
    })
    .await
}

#[tauri::command]
pub fn walkthrough_mark(shared: SharedState<'_>, key: String, id: String, done: bool) -> Result<Value, String> {
    let saved = walkthrough::mark(&shared, &key, &id, done)?;
    changed(&shared, &key);
    Ok(view(&key, Some(saved)))
}

#[tauri::command]
pub fn walkthrough_route(shared: SharedState<'_>, key: String, route: usize) -> Result<Value, String> {
    let saved = walkthrough::set_route(&shared, &key, route)?;
    changed(&shared, &key);
    Ok(view(&key, Some(saved)))
}

#[tauri::command]
pub fn walkthrough_clear(shared: SharedState<'_>, key: String) -> Result<Value, String> {
    let saved = walkthrough::clear(&shared, &key)?;
    changed(&shared, &key);
    Ok(view(&key, Some(saved)))
}

#[tauri::command]
pub async fn walkthrough_translate(shared: SharedState<'_>, key: String) -> Result<Value, String> {
    let shared = Arc::clone(&shared);
    blocking(move || {
        let before = walkthrough::load(&shared, &key).is_some_and(|s| s.translated);
        let saved = walkthrough::translate(&shared, &key)?;
        if !before && saved.as_ref().is_some_and(|s| s.translated) {
            changed(&shared, &key);
        }
        Ok(view(&key, saved))
    })
    .await
}

#[tauri::command]
pub async fn walkthrough_current(shared: SharedState<'_>) -> Result<Value, String> {
    let shared = Arc::clone(&shared);
    blocking(move || {
        let snap = shared.snapshot();
        if !snap.detected || snap.key.is_empty() {
            return Ok(json!({ "key": "", "found": false }));
        }
        let saved = walkthrough::get(&shared, &snap.key, false).unwrap_or(None);
        let mut out = view(&snap.key, saved);
        out["name"] = json!(snap.game_name);
        Ok(out)
    })
    .await
}

#[tauri::command]
pub fn toggle_walkthrough_overlay(shared: SharedState<'_>) {
    crate::ui_windows::toggle_walkthrough(&shared);
}
