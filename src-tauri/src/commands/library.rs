use std::path::PathBuf;
use std::sync::Arc;

use serde_json::{json, Map, Value};

use super::{blocking, SharedState};
use crate::config::{Config, Entry, STATUSES};
use crate::erogamescape::BrandDetails;
use crate::engines::{blacklist_set, is_windows_app, normalize_exe};
use crate::launcher::{self, LaunchError};
use crate::screenshots;
use crate::shell;
use crate::state::{Cmd, Shared};
use crate::vndb::VnResult;
use crate::vndb_list;
use wana_kana::ConvertJapanese;

fn text(entry: &Entry, field: &str) -> String {
    entry
        .get(field)
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}

fn hiragana_variant(value: &str) -> String {
    value.to_hiragana()
}

fn romaji_variant(value: &str) -> String {
    value.to_romaji()
}

fn kunrei_variant(value: &str) -> String {
    let mut result = String::new();
    let mut kana_run = String::new();

    for ch in value.chars() {
        if matches!(ch as u32, 0x3041..=0x30ff | 0x31f0..=0x31ff | 0xff66..=0xff9f) {
            kana_run.push(ch);
        } else {
            if !kana_run.is_empty() {
                result.push_str(&kunrei_romaji(&kana_run));
                kana_run.clear();
            }
            result.push(ch);
        }
    }

    if !kana_run.is_empty() {
        result.push_str(&kunrei_romaji(&kana_run));
    }
    result
}

fn kunrei_romaji(value: &str) -> String {
    let exceptions = [
        ("っぢゃ", '\u{e005}', "ddya"),
        ("っぢゅ", '\u{e006}', "ddyu"),
        ("っぢょ", '\u{e007}', "ddyo"),
        ("っぢ", '\u{e008}', "ddi"),
        ("っづ", '\u{e009}', "ddu"),
        ("ぢゃ", '\u{e000}', "dya"),
        ("ぢゅ", '\u{e001}', "dyu"),
        ("ぢょ", '\u{e002}', "dyo"),
        ("ぢ", '\u{e003}', "di"),
        ("づ", '\u{e004}', "du"),
    ];
    let mut hiragana = value.to_hiragana();
    for (kana, marker, _) in exceptions {
        hiragana = hiragana.replace(kana, &marker.to_string());
    }

    let mut result = kunrei_from_hepburn(&hiragana.to_romaji());
    for (_, marker, romanization) in exceptions {
        result = result.replace(marker, romanization);
    }
    result
}

fn kunrei_from_hepburn(value: &str) -> String {
    [
        ("sha", "sya"),
        ("shu", "syu"),
        ("sho", "syo"),
        ("cha", "tya"),
        ("chu", "tyu"),
        ("cho", "tyo"),
        ("ja", "zya"),
        ("ju", "zyu"),
        ("jo", "zyo"),
        ("shi", "si"),
        ("chi", "ti"),
        ("tsu", "tu"),
        ("fu", "hu"),
        ("ji", "zi"),
    ]
    .into_iter()
    .fold(value.to_string(), |result, (hepburn, kunrei)| {
        result.replace(hepburn, kunrei)
    })
}

fn search_name_forms(names: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut search_names = Vec::new();
    for name in names.into_iter().filter(|name| !name.trim().is_empty()) {
        let hiragana = hiragana_variant(&name);
        let romaji = romaji_variant(&name);
        let kunrei = kunrei_variant(&name);
        let has_hiragana_variant = hiragana != name;
        let has_romaji_variant = romaji != hiragana;
        let has_kunrei_variant = kunrei != name;
        if !search_names.contains(&name) {
            search_names.push(name);
        }
        if has_hiragana_variant && !search_names.contains(&hiragana) {
            search_names.push(hiragana);
        }
        if has_romaji_variant && !search_names.contains(&romaji) {
            search_names.push(romaji);
        }
        if has_kunrei_variant && !search_names.contains(&kunrei) {
            search_names.push(kunrei);
        }
    }
    search_names
}

fn library_search_names(entry: &Entry) -> Vec<String> {
    let names = [
        "title",
        "name",
        "vndb_title",
        "vndb_alttitle",
        "erogamescape_name",
        "erogamescape_furigana",
    ]
    .into_iter()
    .map(|field| text(entry, field))
    .chain(
        entry
            .get("vndb_aliases")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(str::to_string),
    );
    search_name_forms(names)
}

fn library_brand(brand: BrandDetails) -> Value {
    let search_names = search_name_forms([brand.name.clone(), brand.furigana.clone()]);
    json!({
        "id": brand.id,
        "name": brand.name,
        "furigana": brand.furigana,
        "search_names": search_names,
    })
}

fn vndb_search_names(vn: &VnResult) -> Vec<String> {
    search_name_forms(
        [vn.title.clone(), vn.alt_title.clone()]
            .into_iter()
            .chain(vn.aliases.iter().cloned()),
    )
}

fn valid_erogamescape_update(value: &Value) -> bool {
    value.is_null()
}

pub fn visible_games(cfg: &Config) -> Vec<(String, Entry)> {
    let user: Vec<String> = cfg
        .get("blacklist_exe")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    let blacklist = blacklist_set(user.iter().map(String::as_str));

    cfg.all_games()
        .iter()
        .filter(|(key, entry)| {
            let path = text(entry, "path");
            let exe = if path.is_empty() {
                key.split('@').next().unwrap_or("").to_string()
            } else {
                path
            };
            !blacklist.contains(&normalize_exe(&exe)) && !is_windows_app(&exe)
        })
        .map(|(key, entry)| (key.clone(), entry.clone()))
        .collect()
}

fn cover_of(cfg: &Config, entry: &Entry) -> Option<String> {
    cfg.cached_cover(entry)
        .map(|p| p.to_string_lossy().to_string())
}

fn ensure_brand_info(shared: &Shared, id: u64) -> Result<BrandDetails, String> {
    if let Some(brand) = shared.config.lock().unwrap().brand(id).cloned() {
        return Ok(brand);
    }

    let brand = crate::erogamescape::fetch_brand_details(id)?;
    let mut cfg = shared.config.lock().unwrap();
    if let Some(cached) = cfg.brand(id) {
        return Ok(cached.clone());
    }
    cfg.set_brand(brand.clone())
        .map_err(|error| format!("couldn't save brand {}: {error}", brand.id))?;
    Ok(brand)
}

#[tauri::command(async)]
pub fn get_library(shared: SharedState) -> Vec<Value> {
    let (title_priority, games) = {
        let cfg = shared.config.lock().unwrap();
        let title_priority = cfg.display_title_priority();
        let games = visible_games(&cfg)
            .into_iter()
            .map(|(key, entry)| {
                let cover = cover_of(&cfg, &entry);
                (key, entry, cover)
            })
            .collect::<Vec<_>>();
        (title_priority, games)
    };

    games
        .into_iter()
        .map(|(key, entry, cover)| {
            let vn_id = [text(&entry, "vndb_id"), text(&entry, "matched_vndb_id")]
                .into_iter()
                .find(|id| !id.is_empty())
                .unwrap_or_default();
            let mut search_names = library_search_names(&entry);
            if let Some(vn) = shared.vndb.cached(&vn_id) {
                for name in vndb_search_names(&vn) {
                    if !search_names.contains(&name) {
                        search_names.push(name);
                    }
                }
            }

            json!({
                "key": key,
                "name": screenshots::display_name(&key, &entry, &title_priority),
                "furigana": text(&entry, "erogamescape_furigana"),
                "brand_id": entry.get("erogamescape_brand_id").and_then(Value::as_u64),
                "search_names": search_names,
                "status": text(&entry, "status"),
                "playtime": entry.get("playtime_seconds").and_then(Value::as_i64).unwrap_or(0),
                "daily": entry.get("daily").cloned().unwrap_or(json!({})),
                "last_played": entry.get("last_played").and_then(Value::as_i64).unwrap_or(0),
                "finished_at": entry.get("finished_at").and_then(Value::as_i64).unwrap_or(0),
                "nsfw": entry.get("cover_nsfw").and_then(Value::as_bool).unwrap_or(false),
                "has_path": !launcher::launch_exe(&entry).is_empty(),
                "from_vndb": entry.get("vndb_list_only").and_then(Value::as_bool).unwrap_or(false)
                    && launcher::launch_exe(&entry).is_empty(),
                "released": if text(&entry, "released_vn") == vn_id { text(&entry, "released") } else { String::new() },
                "vndb_id": vn_id,
                "cover": cover,
            })
        })
        .collect()
}

#[tauri::command]
pub async fn get_library_brands(shared: SharedState<'_>) -> Result<Vec<Value>, String> {
    let shared = Arc::clone(&shared);
    blocking(move || {
        let mut ids = {
            let cfg = shared.config.lock().unwrap();
            visible_games(&cfg)
                .iter()
                .filter_map(|(_, entry)| {
                    entry
                        .get("erogamescape_brand_id")
                        .and_then(Value::as_u64)
                        .filter(|id| *id > 0)
                })
                .collect::<Vec<_>>()
        };
        ids.sort_unstable();
        ids.dedup();

        let mut brands = Vec::with_capacity(ids.len());
        let mut errors = Vec::new();
        for id in ids {
            match ensure_brand_info(&shared, id) {
                Ok(brand) => brands.push(brand),
                Err(error) => {
                    errors.push(error);
                    brands.push(BrandDetails {
                        id,
                        name: String::new(),
                        furigana: String::new(),
                    });
                }
            }
        }

        if !errors.is_empty() {
            shared.emit(
                "toast",
                json!({
                    "title": format!(
                        "Couldn't load {} brand details; showing brand IDs instead.",
                        errors.len()
                    ),
                    "ok": false,
                }),
            );
            for error in errors {
                eprintln!("{error}");
            }
        }
        Ok(brands.into_iter().map(library_brand).collect())
    })
    .await
}

#[tauri::command]
pub async fn fill_release_dates(shared: SharedState<'_>) -> Result<usize, String> {
    let shared = Arc::clone(&shared);
    blocking(move || {
        let missing: Vec<(String, String)> = {
            let cfg = shared.config.lock().unwrap();
            visible_games(&cfg)
                .into_iter()
                .filter_map(|(key, entry)| {
                    let vn_id = [text(&entry, "vndb_id"), text(&entry, "matched_vndb_id")]
                        .into_iter()
                        .find(|id| !id.is_empty())?;
                    (text(&entry, "released_vn") != vn_id).then_some((key, vn_id))
                })
                .collect()
        };
        if missing.is_empty() {
            return Ok(0);
        }
        let mut ids: Vec<String> = missing.iter().map(|(_, id)| id.clone()).collect();
        ids.sort();
        ids.dedup();
        let dates: std::collections::HashMap<String, String> =
            shared.vndb.release_dates(&ids)?.into_iter().collect();
        {
            let mut cfg = shared.config.lock().unwrap();
            for (key, vn_id) in &missing {
                let date = dates.get(vn_id).cloned().unwrap_or_default();
                cfg.set_game(
                    key,
                    Map::from_iter([
                        ("released".into(), json!(date)),
                        ("released_vn".into(), json!(vn_id)),
                    ]),
                );
            }
        }
        shared.send(Cmd::Reload);
        shared.emit("library-changed", json!({}));
        Ok(missing.len())
    })
    .await
}

#[tauri::command(async)]
pub fn get_game(shared: SharedState, key: String) -> Value {
    let mut cfg = shared.config.lock().unwrap();
    let title_priority = cfg.display_title_priority();
    let entry = cfg.game(&key);

    let folder = screenshots::folder_for(&mut cfg, &key, false);
    let shots = screenshots::list_shots(folder.as_deref());
    let launcher_name = text(&entry, "launcher");
    let tool = launcher::tool_path(&cfg, &launcher_name);
    let duplicates: Vec<Value> = cfg
        .duplicates_of(&key)
        .into_iter()
        .map(|other| {
            let other_entry = cfg.game(&other);
            json!({
                "key": other,
                "name": screenshots::display_name(&other, &other_entry, &title_priority),
                "playtime": other_entry.get("playtime_seconds").and_then(Value::as_i64).unwrap_or(0),
            })
        })
        .collect();

    json!({
        "key": key,
        "name": screenshots::display_name(&key, &entry, &title_priority),
        "entry": entry,
        "cover": cover_of(&cfg, &entry),
        "shots": shots.iter().take(5).map(|p| p.to_string_lossy().to_string()).collect::<Vec<_>>(),
        "shot_count": shots.len(),
        "tool": tool.map(|p| p.to_string_lossy().to_string()),
        "has_token": !cfg.str("vndb_token").trim().is_empty(),
        "vndb_sync": cfg.bool("vndb_sync"),
        "hotkey": cfg.str("screenshot_hotkey"),
        "duplicates": duplicates,
    })
}

#[tauri::command]
pub async fn search_erogamescape(
    query: String,
) -> Result<Vec<crate::erogamescape::GameResult>, String> {
    blocking(move || crate::erogamescape::search(&query)).await
}

#[tauri::command]
pub async fn confirm_erogamescape(
    shared: SharedState<'_>,
    key: String,
    id: u64,
) -> Result<crate::erogamescape::GameDetails, String> {
    let shared = Arc::clone(&shared);
    blocking(move || {
        let details = crate::erogamescape::fetch_details(id)?;
        let brand_error = ensure_brand_info(&shared, details.erogamescape_brand_id).err();
        let mut fields = Map::new();
        fields.insert("erogamescape_id".into(), json!(details.erogamescape_id));
        fields.insert(
            "erogamescape_name".into(),
            json!(details.erogamescape_name),
        );
        fields.insert(
            "erogamescape_furigana".into(),
            json!(details.erogamescape_furigana),
        );
        fields.insert(
            "erogamescape_brand_id".into(),
            json!(details.erogamescape_brand_id),
        );
        let mut cfg = shared.config.lock().unwrap();
        cfg.set_game(&key, fields);
        drop(cfg);

        if let Some(error) = brand_error {
            shared.emit(
                "toast",
                json!({
                    "title": format!("Couldn't save ErogameScape brand information: {error}"),
                    "ok": false,
                }),
            );
        }
        changed(&shared, &key);
        Ok(details)
    })
    .await
}

fn changed(shared: &Shared, key: &str) {
    shared.send(Cmd::Reload);
    shared.emit("library-changed", json!({ "key": key }));
}

#[tauri::command(async)]
pub fn show_game_in_sandboxie(shared: SharedState, key: String) -> Result<(), String> {
    let (entry, location_mode, install_path, default_box) = {
        let config = shared.config.lock().unwrap();
        (
            config.game(&key),
            config.str("sandboxie_location_mode"),
            config.str("sandboxie_install_dir"),
            crate::sandboxie::configured_default_box(&config.str("sandboxie_default_box")),
        )
    };
    let install_dir = crate::sandboxie::configured_install_dir(&location_mode, &install_path)?;
    launcher::show_in_sandboxie(&entry, install_dir.as_deref(), &default_box)
}

#[tauri::command(async)]
pub fn update_game(
    shared: SharedState,
    key: String,
    fields: Map<String, Value>,
) -> Result<(), String> {
    const EDITABLE: [&str; 9] = [
        "status",
        "privacy",
        "title",
        "launcher",
        "section",
        "sandboxie_box",
        "sandboxie_auto_update_box",
        "sandboxie_use_default_box",
        "erogamescape_id",
    ];
    let mut fields = fields;
    let reset_sandboxie_box = fields.get("sandboxie_box").is_some_and(Value::is_null);

    for (field, value) in &fields {
        if !EDITABLE.contains(&field.as_str()) {
            return Err(format!("{field} can't be edited"));
        }
        if field == "sandboxie_box" && value.is_null() {
            continue;
        }
        if field == "status" && !(value == "" || STATUSES.iter().any(|s| value == *s)) {
            return Err(format!("unknown status {value}"));
        }
        if field == "sandboxie_auto_update_box" && !value.is_boolean() {
            return Err("sandboxie_auto_update_box must be a boolean".into());
        }
        if field == "sandboxie_use_default_box" && !value.is_boolean() {
            return Err("sandboxie_use_default_box must be a boolean".into());
        }
        if field == "erogamescape_id" && !valid_erogamescape_update(value) {
            return Err("ErogameScape ID must be confirmed from search results".into());
        }
    }

    if let Some(value) = fields.get("sandboxie_box").filter(|value| !value.is_null()) {
        let Some(box_name) = value.as_str().map(str::trim) else {
            return Err("Sandboxie box name must be a string.".into());
        };
        if box_name.is_empty() {
            return Err("Sandboxie box name must not be empty.".into());
        }
        fields.insert("sandboxie_box".into(), json!(box_name));
    }
    let remove_erogamescape_id = fields.get("erogamescape_id").is_some_and(Value::is_null);
    if remove_erogamescape_id {
        fields.remove("erogamescape_id");
    }

    let status = fields
        .get("status")
        .and_then(Value::as_str)
        .map(str::to_string);
    let vn_id = {
        let mut cfg = shared.config.lock().unwrap();
        if reset_sandboxie_box {
            cfg.remove_game_field(&key, "sandboxie_box");
            fields.remove("sandboxie_box");
        }
        if remove_erogamescape_id {
            cfg.remove_game_field(&key, "erogamescape_id");
            for field in [
                "erogamescape_name",
                "erogamescape_furigana",
                "erogamescape_brand_id",
            ] {
                cfg.remove_game_field(&key, field);
            }
        }
        if !fields.is_empty() {
            cfg.set_game(&key, fields);
        }
        text(&cfg.game(&key), "vndb_id")
    };

    if let Some(status) = status {
        if !vn_id.is_empty() {
            vndb_list::sync_status(&shared, &key, &vn_id, &status, false);
        }
    }

    changed(&shared, &key);
    Ok(())
}

#[tauri::command(async)]
pub fn set_playtime(shared: SharedState, key: String, seconds: i64) {
    shared.send(Cmd::SetPlaytime(key.clone(), seconds));
    shared.emit("library-changed", json!({ "key": key }));
}

fn forget_game(shared: &Shared, key: &str, with_files: bool) -> Result<usize, String> {
    let snap = shared.snapshot();
    if snap.detected && snap.key == key {
        return Err("Close the game before removing it.".into());
    }
    let files = {
        let mut cfg = shared.config.lock().unwrap();
        let files = if with_files {
            cfg.files_of(key)
        } else {
            vec![]
        };
        if let Some(id) = key.strip_prefix(vndb_list::IMPORTED_PREFIX) {
            let mut ignored = cfg
                .get("vndb_import_ignored")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            ignored.push(json!(id));
            let _ = cfg.update(Map::from_iter([(
                "vndb_import_ignored".into(),
                json!(ignored),
            )]));
        }
        cfg.remove_game(key);
        files
    };
    let removed = files
        .iter()
        .filter(|file| std::fs::remove_file(file).is_ok())
        .count();
    changed(shared, key);
    Ok(removed)
}

#[tauri::command(async)]
pub fn remove_game(shared: SharedState, key: String) -> Result<(), String> {
    forget_game(&shared, &key, false).map(|_| ())
}

#[tauri::command(async)]
pub fn delete_game(shared: SharedState, key: String) -> Result<usize, String> {
    forget_game(&shared, &key, true)
}

#[tauri::command]
pub async fn recommendations(
    shared: SharedState<'_>,
    refresh: bool,
) -> Result<crate::reco::Recommendations, String> {
    let shared = Arc::clone(&shared);
    blocking(move || crate::reco::recommendations(&shared, refresh)).await
}

#[tauri::command]
pub async fn import_vndb_finished(shared: SharedState<'_>) -> Result<usize, String> {
    let shared = Arc::clone(&shared);
    blocking(move || vndb_list::import_finished(&shared)).await
}

#[tauri::command(async)]
pub fn merge_games(shared: SharedState, from: String, into: String) -> Result<(), String> {
    let snap = shared.snapshot();
    if snap.detected && (snap.key == from || snap.key == into) {
        return Err("Close the game before merging.".into());
    }
    let (from_shots, into_shots) = {
        let mut cfg = shared.config.lock().unwrap();
        let from_shots = screenshots::folder_for(&mut cfg, &from, false);
        let into_shots = screenshots::folder_for(&mut cfg, &into, false);
        cfg.merge_games(&from, &into);
        (from_shots, into_shots)
    };
    if let (Some(from_shots), Some(into_shots)) = (from_shots, into_shots) {
        screenshots::move_shots(&from_shots, &into_shots)?;
    }
    changed(&shared, &into);
    shared.emit("screenshots-changed", json!({ "key": into }));
    Ok(())
}

#[tauri::command(async)]
pub fn confirm_match(shared: SharedState, key: String) {
    {
        let mut cfg = shared.config.lock().unwrap();
        let entry = cfg.game(&key);
        let vn_id = text(&entry, "matched_vndb_id");
        if vn_id.is_empty() {
            return;
        }
        let mut fields = Map::from_iter([
            ("vndb_id".into(), json!(vn_id)),
            ("match_checked".into(), json!(true)),
        ]);
        let name = text(&entry, "name");
        if !name.is_empty() {
            fields.insert("title".into(), json!(name));
        }
        cfg.set_game(&key, fields);
    }
    changed(&shared, &key);
}

#[tauri::command(async)]
pub fn match_checked(shared: SharedState, key: String) {
    shared
        .config
        .lock()
        .unwrap()
        .set_game(&key, Map::from_iter([("match_checked".into(), json!(true))]));
    changed(&shared, &key);
}

#[tauri::command(async)]
pub fn set_game_path(shared: SharedState, key: String, path: String) {
    shared
        .config
        .lock()
        .unwrap()
        .set_game(&key, Map::from_iter([("launch_path".into(), json!(path))]));
    changed(&shared, &key);
}

#[tauri::command(async)]
pub fn set_tool_path(shared: SharedState, launcher: String, path: String) -> Result<(), String> {
    let setting = launcher::tool_setting(&launcher);
    if setting.is_empty() {
        return Err(format!("unknown launcher {launcher}"));
    }
    let settings = {
        let mut cfg = shared.config.lock().unwrap();
        cfg.update(Map::from_iter([(setting.into(), json!(path))]))
            .map_err(|e| e.to_string())?;
        cfg.data().clone()
    };
    shared.emit("settings-changed", settings);
    Ok(())
}

#[tauri::command(async)]
pub fn create_shortcut(shared: SharedState, key: String) -> Result<String, LaunchError> {
    let cfg = shared.config.lock().unwrap();
    let entry = cfg.game(&key);
    let name = screenshots::display_name(&key, &entry, &cfg.display_title_priority());
    drop(cfg);
    let app_exe = std::env::current_exe().map_err(|e| LaunchError::Failed(e.to_string()))?;
    let game_exe = PathBuf::from(launcher::launch_exe(&entry));
    if !game_exe.is_file() {
        return Err(LaunchError::GameMissing);
    }

    let file_name: String = name
        .chars()
        .map(|c| if "\\/:*?\"<>|".contains(c) { '_' } else { c })
        .collect();
    let dest = shell::desktop_folder().join(format!("{}.lnk", file_name.trim()));
    let shortcut = shell::Shortcut {
        target: &app_exe,
        arguments: &format!("--play \"{key}\""),
        icon: &game_exe,
        description: &format!("Play {name} with Shiori RPC"),
    };
    shell::create_shortcut(&dest, &shortcut).map_err(LaunchError::Failed)?;
    Ok(dest.to_string_lossy().to_string())
}

pub fn play_from_shortcut(shared: &Shared, key: &str) -> bool {
    let cfg = shared.config.lock().unwrap();
    let entry = cfg.game(key);
    !entry.is_empty() && launcher::launch(&cfg, &entry).is_ok()
}

#[tauri::command(async)]
pub fn play_game(shared: SharedState, key: String) -> Result<(), LaunchError> {
    let cfg = shared.config.lock().unwrap();
    let entry = cfg.game(&key);
    launcher::launch(&cfg, &entry)
}

#[tauri::command]
pub async fn vn_length(shared: SharedState<'_>, vn_id: String) -> Result<i64, String> {
    let shared = Arc::clone(&shared);
    blocking(move || Ok(shared.vndb.get(&vn_id)?.map_or(0, |vn| vn.length_minutes))).await
}

#[tauri::command]
pub async fn get_vote(shared: SharedState<'_>, key: String) -> Result<Option<i64>, String> {
    let shared = Arc::clone(&shared);
    blocking(move || vndb_list::vote(&shared, &key)).await
}

#[tauri::command]
pub async fn set_vote(
    shared: SharedState<'_>,
    key: String,
    vote: Option<i64>,
) -> Result<(), String> {
    let shared = Arc::clone(&shared);
    blocking(move || vndb_list::set_vote(&shared, &key, vote)).await
}

fn token_and_library(shared: &Shared) -> Result<(String, Vec<String>), String> {
    let cfg = shared.config.lock().unwrap();
    let ids: Vec<String> = cfg
        .all_games()
        .values()
        .flat_map(|e| [text(e, "vndb_id"), text(e, "matched_vndb_id")])
        .filter(|id| !id.is_empty())
        .collect();
    let token = cfg.str("vndb_token").trim().to_string();
    if token.is_empty() {
        return Err("add your VNDB token in Settings first".into());
    }
    Ok((token, ids))
}

#[tauri::command]
pub async fn get_vndb_labels(shared: SharedState<'_>) -> Result<Value, String> {
    let shared = Arc::clone(&shared);
    blocking(move || {
        let (token, _) = token_and_library(&shared)?;
        Ok(json!({ "labels": shared.vndb.labels(&token)? }))
    })
    .await
}

#[tauri::command]
pub async fn get_vndb_list(shared: SharedState<'_>, label: i64) -> Result<Value, String> {
    let shared = Arc::clone(&shared);
    blocking(move || {
        let (token, in_library) = token_and_library(&shared)?;
        let vns: Vec<VnResult> = shared.vndb.label_list(&token, label)?;
        Ok(json!({ "vns": vns, "in_library": in_library }))
    })
    .await
}

#[tauri::command]
pub async fn get_wishlist(shared: SharedState<'_>) -> Result<Value, String> {
    let shared = Arc::clone(&shared);
    blocking(move || {
        let (token, in_library) = {
            let cfg = shared.config.lock().unwrap();
            let ids: Vec<String> = cfg
                .all_games()
                .values()
                .flat_map(|e| [text(e, "vndb_id"), text(e, "matched_vndb_id")])
                .filter(|id| !id.is_empty())
                .collect();
            (cfg.str("vndb_token").trim().to_string(), ids)
        };
        if token.is_empty() {
            return Err("add your VNDB token in Settings first".into());
        }

        let wishlist: Vec<VnResult> = shared.vndb.wishlist(&token)?;
        Ok(json!({ "wishlist": wishlist, "in_library": in_library }))
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::{
        kunrei_variant, library_brand, library_search_names, romaji_variant, search_name_forms,
        valid_erogamescape_update, BrandDetails,
    };
    use serde_json::{json, Map};

    #[test]
    fn library_filter_names_include_all_sources_and_hiragana_furigana() {
        let entry = Map::from_iter([
            ("title".into(), json!("VNDB title")),
            ("vndb_title".into(), json!("VNDB title")),
            ("vndb_alttitle".into(), json!("VNDB alternate")),
            ("vndb_aliases".into(), json!(["VNDB alias"])),
            ("erogamescape_name".into(), json!("批評空間タイトル")),
            ("erogamescape_furigana".into(), json!("ヒヒョウクウカン")),
        ]);
        let names = library_search_names(&entry);

        for expected in [
            "VNDB title",
            "VNDB alternate",
            "VNDB alias",
            "批評空間タイトル",
            "ヒヒョウクウカン",
            "ひひょうくうかん",
            "hihyoukuukan",
        ] {
            assert!(names.iter().any(|name| name == expected), "{expected}");
        }
    }

    #[test]
    fn brand_search_names_include_hiragana_and_romanized_furigana() {
        let brand = library_brand(BrandDetails {
            id: 1171,
            name: "枕".into(),
            furigana: "マクラ".into(),
        });
        let names = brand["search_names"].as_array().unwrap();

        assert!(names.iter().any(|name| name == "まくら"));
        assert!(names.iter().any(|name| name == "makura"));
    }

    #[test]
    fn furigana_romaji_supports_digraphs_gemination_and_long_vowels() {
        assert_eq!(romaji_variant("ハツユキサクラ"), "hatsuyukisakura");
        assert_eq!(romaji_variant("マッチャ"), "matcha");
        assert_eq!(romaji_variant("ゲーム"), "geemu");
    }

    #[test]
    fn furigana_search_supports_hepburn_and_kunrei_romanization() {
        let names = search_name_forms(["シンブン チュウ".to_string()]);

        assert!(names.iter().any(|name| name == "shinbun chuu"));
        assert!(names.iter().any(|name| name == "sinbun tyuu"));
        assert_eq!(kunrei_variant("Shinシン"), "Shinsin");
        assert_eq!(kunrei_variant("ぢづ"), "didu");
        assert_eq!(kunrei_variant("ヂャヂュヂョ"), "dyadyudyo");
        assert_eq!(kunrei_variant("っぢゃっづ"), "ddyaddu");
        assert_eq!(kunrei_variant("ﾁﾞ"), "di");
    }

    #[test]
    fn erogamescape_ids_must_be_confirmed_and_can_only_be_removed_here() {
        assert!(valid_erogamescape_update(&json!(null)));
        assert!(!valid_erogamescape_update(&json!(12345)));
        assert!(!valid_erogamescape_update(&json!("12345")));
    }
}
