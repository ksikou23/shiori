use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::{Map, Value};

use crate::config::Config;
use crate::shell;
use crate::steam;

pub const NORMAL: &str = "";
pub const LOCALE_EMULATOR: &str = "le";
pub const NTLEA: &str = "ntlea";
pub const SANDBOXIE: &str = "sandboxie";

pub fn tool_setting(launcher: &str) -> &'static str {
    match launcher {
        LOCALE_EMULATOR => "locale_emulator_path",
        NTLEA => "ntlea_path",
        _ => "",
    }
}

pub fn tool_path(cfg: &Config, launcher: &str) -> Option<PathBuf> {
    let path = cfg.str(tool_setting(launcher));
    let path = PathBuf::from(path.trim());
    path.is_file().then_some(path)
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind", content = "detail")]
pub enum LaunchError {
    GameMissing,
    ToolMissing(String),
    Failed(String),
}

pub fn launch_exe(entry: &Map<String, Value>) -> String {
    let text = |key: &str| entry.get(key).and_then(Value::as_str).unwrap_or("").to_string();
    let picked = text("launch_path");
    if !picked.is_empty() && Path::new(&picked).is_file() {
        picked
    } else {
        text("path")
    }
}

fn sandboxie_box<'a>(entry: &'a Map<String, Value>, default_box: &'a str) -> &'a str {
    if entry
        .get("sandboxie_use_default_box")
        .and_then(Value::as_bool)
        == Some(true)
    {
        return default_box;
    }

    entry
        .get("sandboxie_box")
        .and_then(Value::as_str)
        .filter(|name| !name.trim().is_empty())
        .unwrap_or(default_box)
}

fn sandboxie_exe<'a>(entry: &'a Map<String, Value>, fallback: &'a Path) -> &'a Path {
    let picked = entry
        .get("launch_path")
        .and_then(Value::as_str)
        .filter(|path| Path::new(path).is_file());
    picked
        .or_else(|| {
            entry
                .get("sandboxie_path")
                .and_then(Value::as_str)
                .filter(|path| !path.trim().is_empty())
        })
        .map(Path::new)
        .unwrap_or(fallback)
}

pub fn show_in_sandboxie(
    entry: &Map<String, Value>,
    install_dir: Option<&Path>,
    default_box: &str,
) -> Result<(), String> {
    let launcher = entry
        .get("launcher")
        .and_then(Value::as_str)
        .unwrap_or(NORMAL);
    let has_sandboxie_metadata = ["sandboxie_box", "sandboxie_path"].iter().any(|field| {
        entry
            .get(*field)
            .and_then(Value::as_str)
            .is_some_and(|value| !value.trim().is_empty())
    });
    if launcher != SANDBOXIE && !has_sandboxie_metadata {
        return Err("This game is not configured to launch in Sandboxie".into());
    }

    let exe = launch_exe(entry);
    let exe = Path::new(&exe);
    let path = sandboxie_exe(entry, exe);
    if path.as_os_str().is_empty() {
        return Err("Game location is unavailable".into());
    }

    crate::sandboxie::show_in_explorer(install_dir, sandboxie_box(entry, default_box), path)
}

pub fn launch(cfg: &Config, entry: &Map<String, Value>) -> Result<(), LaunchError> {
    let exe = launch_exe(entry);
    let exe = Path::new(&exe);
    let launcher = entry
        .get("launcher")
        .and_then(Value::as_str)
        .unwrap_or(NORMAL);
    let has_sandboxie_path = launcher == SANDBOXIE
        && entry
            .get("sandboxie_path")
            .and_then(Value::as_str)
            .is_some_and(|path| !path.trim().is_empty());
    if (exe.as_os_str().is_empty() || !exe.is_file()) && !has_sandboxie_path {
        return Err(LaunchError::GameMissing);
    }
    let folder = exe
        .parent()
        .filter(|path| path.is_dir())
        .unwrap_or(Path::new("."));
    if launcher == SANDBOXIE {
        let install_dir = crate::sandboxie::configured_install_dir(
            &cfg.str("sandboxie_location_mode"),
            &cfg.str("sandboxie_install_dir"),
        )
        .map_err(LaunchError::Failed)?;
        let default_box =
            crate::sandboxie::configured_default_box(&cfg.str("sandboxie_default_box"));
        let start = crate::sandboxie::start_exe(install_dir.as_deref())
            .ok_or_else(|| LaunchError::Failed("Sandboxie Start.exe couldn't be found".into()))?;
        let args =
            crate::sandboxie::launch_arguments(
                sandboxie_box(entry, &default_box),
                sandboxie_exe(entry, exe),
            );
        return shell::start_program_args(&start, &args, folder).map_err(LaunchError::Failed);
    }
    if launcher != LOCALE_EMULATOR && launcher != NTLEA {
        if let Some(id) = steam::launch_id_for_exe(&exe.to_string_lossy()) {
            return shell::open(&format!("steam://rungameid/{id}")).map_err(LaunchError::Failed);
        }
        return shell::start_program(exe, "", folder).map_err(LaunchError::Failed);
    }

    let Some(tool) = tool_path(cfg, launcher) else {
        return Err(LaunchError::ToolMissing(launcher.to_string()));
    };

    let params = if launcher == LOCALE_EMULATOR {
        format!("\"{}\"", exe.display())
    } else {
        format!("\"{}\" C932 L1041", exe.display())
    };
    shell::start_program(&tool, &params, folder).map_err(LaunchError::Failed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_picked_launcher_wins_over_the_detected_exe() {
        let launcher = std::env::current_exe().unwrap().to_string_lossy().to_string();
        let entry = |picked: &str| {
            Map::from_iter([
                ("path".into(), Value::from(r"C:\Games\Iroseka\engine\engine.exe")),
                ("launch_path".into(), Value::from(picked)),
            ])
        };
        assert_eq!(launch_exe(&entry(&launcher)), launcher);
        assert_eq!(launch_exe(&entry("")), r"C:\Games\Iroseka\engine\engine.exe");
        assert_eq!(launch_exe(&entry(r"C:\gone\launcher.exe")), r"C:\Games\Iroseka\engine\engine.exe");
    }

    #[test]
    fn sandboxie_uses_default_box_when_no_box_was_detected() {
        assert_eq!(sandboxie_box(&Map::new(), "ConfiguredBox"), "ConfiguredBox");
        assert_eq!(
            sandboxie_box(
                &Map::from_iter([(
                    "sandboxie_box".into(),
                    Value::from("ReadingBox")
                )]),
                "ConfiguredBox"
            ),
            "ReadingBox"
        );
    }

    #[test]
    fn sandboxie_default_setting_overrides_a_game_box() {
        let entry = Map::from_iter([
            ("sandboxie_box".into(), Value::from("CustomBox")),
            ("sandboxie_use_default_box".into(), Value::from(true)),
        ]);
        assert_eq!(sandboxie_box(&entry, "ConfiguredBox"), "ConfiguredBox");
    }

    #[test]
    fn sandboxie_prefers_the_box_path_over_the_host_path() {
        let entry = Map::from_iter([
            (
                "path".into(),
                Value::from(r"C:\Sandbox\user\box\drive\C\Games\game.exe"),
            ),
            ("sandboxie_path".into(), Value::from(r"C:\Games\game.exe")),
        ]);
        assert_eq!(
            sandboxie_exe(
                &entry,
                Path::new(r"C:\Sandbox\user\box\drive\C\Games\game.exe")
            ),
            Path::new(r"C:\Games\game.exe")
        );
    }
}
