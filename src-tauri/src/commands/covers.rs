use std::path::PathBuf;
use std::sync::Arc;

use serde::Serialize;
use serde_json::{json, Map, Value};

use super::{blocking, SharedState};
use crate::config::url_cache_key;
use crate::images;
use crate::state::{Cmd, Shared};
use crate::vndb::{Release, ReleaseCover, ReleaseList, VnResult};

fn apply(shared: &Shared, key: &str, fields: Map<String, Value>) {
    shared.config.lock().unwrap().set_game(key, fields);
    shared.send(Cmd::Reload);
    shared.emit("library-changed", json!({ "key": key }));
}

fn fields(pairs: &[(&str, &str)]) -> Map<String, Value> {
    pairs
        .iter()
        .map(|(k, v)| (k.to_string(), json!(v)))
        .collect()
}

#[tauri::command]
pub async fn search_vndb(shared: SharedState<'_>, query: String) -> Result<Vec<VnResult>, String> {
    let shared = Arc::clone(&shared);
    blocking(move || shared.vndb.search(&query, 12)).await
}

#[tauri::command]
pub async fn get_vndb(shared: SharedState<'_>, vn_id: String) -> Result<VnResult, String> {
    let shared = Arc::clone(&shared);
    blocking(move || {
        shared.vndb.get(&vn_id)?
            .ok_or_else(|| "The selected VN could not be found on VNDB.".to_string())
    })
    .await
}

#[tauri::command]
pub async fn release_covers(
    shared: SharedState<'_>,
    vn_id: String,
) -> Result<Vec<ReleaseCover>, String> {
    let shared = Arc::clone(&shared);
    blocking(move || shared.vndb.release_covers(&vn_id)).await
}

#[tauri::command]
pub async fn vndb_releases(
    shared: SharedState<'_>,
    vn_id: String,
) -> Result<ReleaseList, String> {
    let shared = Arc::clone(&shared);
    blocking(move || shared.vndb.releases(&vn_id)).await
}

fn download_vn_cover(shared: &Shared, vn_id: &str) {
    if let Ok(Some(vn)) = shared.vndb.get(vn_id) {
        shared.vndb.cover_path(&vn.id, &vn.image_url);
    }
}

fn vn_selection_fields(vn_id: &str, title: &str, nsfw: bool) -> Map<String, Value> {
    let mut values = fields(&[
        ("vndb_id", vn_id),
        ("title", title),
        ("cover_source", "vndb"),
        ("cover_value", vn_id),
        ("vndb_release_id", ""),
        ("vndb_release_title", ""),
        ("vndb_release_alttitle", ""),
        ("vndb_release_released", ""),
    ]);
    values.insert("cover_nsfw".into(), json!(nsfw));
    values
}

fn release_title_fields(release: &Release, original_language: Option<&str>) -> Map<String, Value> {
    fields(&[
        ("vndb_release_title", &release.title),
        ("vndb_release_alttitle", release.alternate_title(original_language)),
    ])
}

fn release_selection_fields(
    vn_id: &str,
    title: &str,
    release: &Release,
    original_language: Option<&str>,
    cover: Option<(String, String, bool, Option<bool>)>,
) -> Map<String, Value> {
    let mut values = fields(&[
        ("vndb_id", vn_id),
        ("title", title),
        ("vndb_release_id", &release.id),
        ("vndb_release_released", &release.released),
    ]);
    if let Some((source, value, nsfw, public_safe)) = cover {
        values.extend(fields(&[
            ("cover_source", &source),
            ("cover_value", &value),
        ]));
        values.insert("cover_nsfw".into(), json!(nsfw));
        if let Some(public_safe) = public_safe {
            values.insert("cover_public_safe".into(), json!(public_safe));
        }
    }
    values.extend(release_title_fields(release, original_language));
    values
}

fn is_release_cover(entry: &Map<String, Value>) -> bool {
    entry.get("cover_source").and_then(Value::as_str) == Some("vndb_release")
}

#[tauri::command]
pub async fn set_game_vn(
    shared: SharedState<'_>,
    key: String,
    vn_id: String,
    title: String,
    nsfw: bool,
) -> Result<(), String> {
    let shared = Arc::clone(&shared);
    blocking(move || {
        download_vn_cover(&shared, &vn_id);
        apply(&shared, &key, vn_selection_fields(&vn_id, &title, nsfw));
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn set_game_release(
    shared: SharedState<'_>,
    key: String,
    vn_id: String,
    title: String,
    release_id: String,
    keep_cover: bool,
) -> Result<(), String> {
    let shared = Arc::clone(&shared);
    blocking(move || {
        let list = shared.vndb.releases(&vn_id)?;
        let release = list
            .releases
            .into_iter()
            .find(|release| release.id == release_id)
            .ok_or_else(|| "The selected release does not belong to this VN.".to_string())?;

        let cover = if keep_cover {
            None
        } else if let Some(image) = release.cover() {
            if shared.vndb.cover_path(&url_cache_key(&image.url), &image.url).is_none() {
                return Err("Couldn't download the selected release cover.".into());
            }
            Some((
                "vndb_release".into(),
                image.url.clone(),
                image.nsfw(),
                Some(crate::cloud::safe_image_scores(image.sexual, image.violence)),
            ))
        } else {
            let vn = shared
                .vndb
                .get(&vn_id)?
                .ok_or_else(|| "Couldn't find the selected VN on VNDB.".to_string())?;
            if !vn.image_url.is_empty()
                && shared.vndb.cover_path(&vn.id, &vn.image_url).is_none()
            {
                return Err("Couldn't download the VN cover.".into());
            }
            Some(("vndb".into(), vn.id, vn.nsfw, None))
        };
        let values = release_selection_fields(
            &vn_id,
            &title,
            &release,
            list.original_language.as_deref(),
            cover,
        );
        {
            let mut cfg = shared.config.lock().unwrap();
            if keep_cover && is_release_cover(&cfg.game(&key)) {
                return Err("The cover changed. Reopen the release list.".into());
            }
            cfg.set_game(&key, values);
        }
        shared.send(Cmd::Reload);
        shared.emit("library-changed", json!({ "key": key }));
        Ok(())
    })
    .await
}

fn clear_release_fields(
    entry: &Map<String, Value>,
    vn_id: &str,
    release_id: &str,
    vn_cover_nsfw: Option<bool>,
) -> Result<Map<String, Value>, String> {
    validate_release_selection(entry, vn_id, release_id)?;
    let mut values = fields(&[
        ("vndb_release_id", ""),
        ("vndb_release_title", ""),
        ("vndb_release_alttitle", ""),
        ("vndb_release_released", ""),
    ]);
    if is_release_cover(entry) {
        let nsfw = vn_cover_nsfw
            .ok_or_else(|| "Couldn't restore the VN cover. Try again.".to_string())?;
        values.extend(fields(&[("cover_source", "vndb"), ("cover_value", vn_id)]));
        values.insert("cover_nsfw".into(), json!(nsfw));
    }
    Ok(values)
}

#[tauri::command]
pub async fn clear_game_release(
    shared: SharedState<'_>,
    key: String,
    vn_id: String,
    release_id: String,
) -> Result<(), String> {
    let shared = Arc::clone(&shared);
    blocking(move || {
        let restore_auto_cover = {
            let cfg = shared.config.lock().unwrap();
            let entry = cfg.game(&key);
            validate_release_selection(&entry, &vn_id, &release_id)?;
            is_release_cover(&entry)
        };
        let vn = if restore_auto_cover {
            let vn = shared
                .vndb
                .get(&vn_id)?
                .ok_or_else(|| "Couldn't find the selected VN on VNDB.".to_string())?;
            if !vn.image_url.is_empty() && shared.vndb.cover_path(&vn.id, &vn.image_url).is_none() {
                return Err("Couldn't download the VN cover.".into());
            }
            Some(vn)
        } else {
            None
        };
        {
            let mut cfg = shared.config.lock().unwrap();
            let entry = cfg.game(&key);
            let values = clear_release_fields(
                &entry,
                &vn_id,
                &release_id,
                vn.as_ref().map(|result| result.nsfw),
            )?;
            cfg.set_game(&key, values);
        }
        shared.send(Cmd::Reload);
        shared.emit("library-changed", json!({ "key": key }));
        Ok(())
    })
    .await
}

fn validate_release_selection(
    entry: &Map<String, Value>,
    vn_id: &str,
    release_id: &str,
) -> Result<(), String> {
    if release_id.is_empty()
        || entry.get("vndb_id").and_then(Value::as_str) != Some(vn_id)
        || entry.get("vndb_release_id").and_then(Value::as_str) != Some(release_id)
    {
        return Err("The selected release has changed. Reopen the release list.".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn set_release_cover(
    shared: SharedState<'_>,
    key: String,
    vn_id: String,
    title: String,
    url: String,
) -> Result<(), String> {
    let shared = Arc::clone(&shared);
    blocking(move || {
        shared.vndb.cover_path(&url_cache_key(&url), &url);
        let pairs = [
            ("vndb_id", vn_id.as_str()),
            ("title", &title),
            ("cover_source", "url"),
            ("cover_value", &url),
        ];
        let mut values = fields(&pairs);
        values.insert("cover_nsfw".into(), json!(false));
        {
            let mut cfg = shared.config.lock().unwrap();
            let entry = cfg.game(&key);
            if entry.get("vndb_id").and_then(Value::as_str) != Some(&vn_id) {
                values.insert("vndb_release_id".into(), json!(""));
                values.insert("vndb_release_title".into(), json!(""));
                values.insert("vndb_release_alttitle".into(), json!(""));
                values.insert("vndb_release_released".into(), json!(""));
            }
            cfg.set_game(&key, values);
        }
        shared.send(Cmd::Reload);
        shared.emit("library-changed", json!({ "key": key }));
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn set_cover_url(
    shared: SharedState<'_>,
    key: String,
    url: String,
) -> Result<(), String> {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("Enter a http(s) image link.".into());
    }
    let shared = Arc::clone(&shared);
    blocking(move || {
        shared.vndb.cover_path(&url_cache_key(&url), &url);
        apply(
            &shared,
            &key,
            Map::from_iter([
                ("cover_source".into(), json!("url")),
                ("cover_value".into(), json!(url)),
                ("cover_nsfw".into(), json!(false)),
            ]),
        );
        Ok(())
    })
    .await
}

#[derive(Serialize)]
pub struct PreparedImage {
    path: String,
    width: u32,
    height: u32,
}

#[tauri::command]
pub async fn prepare_image(
    shared: SharedState<'_>,
    source: String,
) -> Result<PreparedImage, String> {
    let shared = Arc::clone(&shared);
    blocking(move || {
        let downloads = shared.data_dir.join("cache").join("downloads");

        let path: PathBuf = if source.starts_with("http://") || source.starts_with("https://") {
            let bytes = shared
                .vndb
                .download(&source)
                .map_err(|e| format!("couldn't download it: {e}"))?;
            images::store_download(&downloads, &source, &bytes)?
        } else {
            let bytes = std::fs::read(&source).map_err(|e| e.to_string())?;
            images::store_download(&downloads, &source, &bytes)?
        };

        let (width, height) = image::image_dimensions(&path).map_err(|e| e.to_string())?;
        Ok(PreparedImage {
            path: path.to_string_lossy().to_string(),
            width,
            height,
        })
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_release() -> Release {
        serde_json::from_value(json!({
            "id": "r1", "title": "Romanized title", "alttitle": "Alternate",
            "released": "2022-10-28", "official": true, "patch": false,
            "platforms": ["win"], "languages": [{"lang": "ja", "title": "Original title"}],
            "media": [], "vns": [], "images": []
        }))
        .unwrap()
    }

    #[test]
    fn release_selection_saves_main_and_original_titles() {
        let release = sample_release();
        let values = release_title_fields(&release, Some("ja"));
        assert_eq!(values["vndb_release_title"], "Romanized title");
        assert_eq!(values["vndb_release_alttitle"], "Original title");
    }

    #[test]
    fn release_selection_preserves_manual_cover_when_requested() {
        let release = sample_release();
        let mut entry = Map::from_iter([
            ("cover_source".into(), json!("url")),
            ("cover_value".into(), json!("https://example.com/custom.jpg")),
            ("cover_nsfw".into(), json!(false)),
        ]);
        entry.extend(release_selection_fields("v1", "VN", &release, Some("ja"), None));
        assert_eq!(entry["vndb_release_id"], "r1");
        assert_eq!(entry["vndb_release_title"], "Romanized title");
        assert_eq!(entry["vndb_release_released"], "2022-10-28");
        assert_eq!(entry["cover_source"], "url");
        assert_eq!(entry["cover_value"], "https://example.com/custom.jpg");
        assert_eq!(entry["cover_nsfw"], false);
    }

    #[test]
    fn release_selection_uses_release_cover_when_requested() {
        let release = sample_release();
        let values = release_selection_fields(
            "v1",
            "VN",
            &release,
            Some("ja"),
            Some((
                "vndb_release".into(),
                "https://example.com/release.jpg".into(),
                true,
                Some(false),
            )),
        );
        assert_eq!(values["cover_source"], "vndb_release");
        assert_eq!(values["cover_value"], "https://example.com/release.jpg");
        assert_eq!(values["cover_nsfw"], true);
        assert_eq!(values["cover_public_safe"], false);
    }

    #[test]
    fn vn_only_selection_clears_release_and_uses_vn_cover_rating() {
        let mut entry = Map::from_iter([
            ("vndb_release_id".into(), json!("r1")),
            ("vndb_release_title".into(), json!("Old release")),
            ("vndb_release_alttitle".into(), json!("Old alternate title")),
            ("vndb_release_released".into(), json!("2000-01-01")),
            ("cover_nsfw".into(), json!(true)),
        ]);
        entry.extend(vn_selection_fields("v2", "New VN", false));
        assert_eq!(entry["vndb_release_id"], "");
        assert_eq!(entry["vndb_release_title"], "");
        assert_eq!(entry["vndb_release_alttitle"], "");
        assert_eq!(entry["vndb_release_released"], "");
        assert_eq!(entry["cover_value"], "v2");
        assert_eq!(entry["cover_nsfw"], false);
    }

    #[test]
    fn clearing_release_resets_auto_cover_to_vn_and_rejects_stale_selection() {
        let mut entry = Map::from_iter([
            ("vndb_id".into(), json!("v1")),
            ("vndb_release_id".into(), json!("r1")),
            ("vndb_release_title".into(), json!("Release")),
            ("vndb_release_alttitle".into(), json!("Alternate title")),
            ("vndb_release_released".into(), json!("2022-10-28")),
            ("cover_source".into(), json!("vndb_release")),
            ("cover_value".into(), json!("https://example.com/cover.jpg")),
            ("cover_nsfw".into(), json!(true)),
        ]);
        assert!(clear_release_fields(&entry, "v2", "r1", Some(false)).is_err());
        assert!(clear_release_fields(&entry, "v1", "r2", Some(false)).is_err());
        assert!(clear_release_fields(&entry, "v1", "", Some(false)).is_err());
        entry.extend(clear_release_fields(&entry, "v1", "r1", Some(false)).unwrap());
        assert_eq!(entry["vndb_id"], "v1");
        assert_eq!(entry["vndb_release_id"], "");
        assert_eq!(entry["vndb_release_title"], "");
        assert_eq!(entry["vndb_release_alttitle"], "");
        assert_eq!(entry["vndb_release_released"], "");
        assert_eq!(entry["cover_source"], "vndb");
        assert_eq!(entry["cover_value"], "v1");
        assert_eq!(entry["cover_nsfw"], false);
    }

    #[test]
    fn clearing_release_preserves_manually_selected_cover() {
        let mut entry = Map::from_iter([
            ("vndb_id".into(), json!("v1")),
            ("vndb_release_id".into(), json!("r1")),
            ("vndb_release_title".into(), json!("Release")),
            ("vndb_release_alttitle".into(), json!("Alternate title")),
            ("cover_source".into(), json!("url")),
            ("cover_value".into(), json!("https://example.com/cover.jpg")),
            ("cover_nsfw".into(), json!(true)),
        ]);
        entry.extend(clear_release_fields(&entry, "v1", "r1", None).unwrap());
        assert_eq!(entry["vndb_release_id"], "");
        assert_eq!(entry["cover_source"], "url");
        assert_eq!(entry["cover_value"], "https://example.com/cover.jpg");
        assert_eq!(entry["cover_nsfw"], true);
    }

    #[test]
    fn clearing_release_preserves_vn_fallback_cover() {
        let mut entry = Map::from_iter([
            ("vndb_id".into(), json!("v1")),
            ("vndb_release_id".into(), json!("r1")),
            ("cover_source".into(), json!("vndb")),
            ("cover_value".into(), json!("v1")),
        ]);
        entry.extend(clear_release_fields(&entry, "v1", "r1", None).unwrap());
        assert_eq!(entry["cover_source"], "vndb");
        assert_eq!(entry["cover_value"], "v1");
    }
}
