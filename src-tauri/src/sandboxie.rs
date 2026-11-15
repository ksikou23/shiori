use std::collections::HashMap;
use std::ffi::c_void;
use std::os::windows::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use windows::core::{PCSTR, PCWSTR};
use windows::Win32::Foundation::HANDLE;
use windows::Win32::System::LibraryLoader::{GetProcAddress, LoadLibraryW};
use winreg::enums::HKEY_LOCAL_MACHINE;
use winreg::RegKey;

pub const DEFAULT_BOX: &str = "DefaultBox";

pub fn configured_default_box(configured_name: &str) -> String {
    let name = configured_name.trim();
    if name.is_empty() {
        DEFAULT_BOX.into()
    } else {
        name.to_string()
    }
}

pub fn path_in_box(host_path: &str) -> Option<String> {
    let path = host_path.replace('/', "\\");
    let parts: Vec<&str> = path.split('\\').collect();
    for (index, part) in parts.iter().enumerate() {
        if !part.eq_ignore_ascii_case("drive") {
            continue;
        }
        let Some(drive) = parts
            .get(index + 1)
            .filter(|drive| drive.len() == 1 && drive.as_bytes()[0].is_ascii_alphabetic())
        else {
            continue;
        };
        let rest = parts[index + 2..].join("\\");
        return Some(if rest.is_empty() {
            format!("{drive}:\\")
        } else {
            format!("{drive}:\\{rest}")
        });
    }
    (!path.is_empty()).then_some(path)
}

fn service_exe_from_image_path(value: &str) -> Option<PathBuf> {
    let value = value.trim();
    let path = if let Some(quoted) = value.strip_prefix('"') {
        quoted.split('"').next()?
    } else {
        let end = value.to_ascii_lowercase().find(".exe")? + 4;
        &value[..end]
    };
    let path = path.strip_prefix(r"\??\").unwrap_or(path);
    Some(PathBuf::from(path))
}

fn discover_service_exe() -> Option<PathBuf> {
    let services = RegKey::predef(HKEY_LOCAL_MACHINE)
        .open_subkey(r"SYSTEM\CurrentControlSet\Services\SbieSvc")
        .ok()?;
    let image_path: String = services.get_value("ImagePath").ok()?;
    let exe = service_exe_from_image_path(&image_path)?;
    exe.is_file().then_some(exe)
}

fn service_exe() -> Option<&'static Path> {
    static SERVICE_EXE: OnceLock<Option<PathBuf>> = OnceLock::new();
    SERVICE_EXE.get_or_init(discover_service_exe).as_deref()
}

pub fn configured_install_dir(
    mode: &str,
    configured_path: &str,
) -> Result<Option<PathBuf>, String> {
    match mode {
        "" | "auto" => Ok(None),
        "manual" => {
            let path = PathBuf::from(configured_path.trim());
            if path.as_os_str().is_empty() {
                return Err("Sandboxie installation directory is not set".into());
            }
            if !path.is_dir() {
                return Err(format!(
                    "Sandboxie installation directory not found: {}",
                    path.display()
                ));
            }
            Ok(Some(path))
        }
        mode => Err(format!("Unknown Sandboxie location mode: {mode}")),
    }
}

pub fn start_exe(install_dir: Option<&Path>) -> Option<PathBuf> {
    let directory = match install_dir {
        Some(path) => path.to_path_buf(),
        None => service_exe()?.parent()?.to_path_buf(),
    };
    let path = directory.join("Start.exe");
    path.is_file().then_some(path)
}

fn api_module(dll: &Path) -> Result<windows::Win32::Foundation::HMODULE, String> {
    static MODULES: OnceLock<Mutex<HashMap<PathBuf, usize>>> = OnceLock::new();
    let modules = MODULES.get_or_init(|| Mutex::new(HashMap::new()));
    let mut modules = modules.lock().unwrap();
    let module = if let Some(module) = modules.get(dll) {
        *module
    } else {
        let wide: Vec<u16> = dll.as_os_str().encode_wide().chain([0]).collect();
        let module = unsafe { LoadLibraryW(PCWSTR(wide.as_ptr())) }
            .map(|module| module.0 as usize)
            .map_err(|error| format!("couldn't load Sandboxie API: {error}"))?;
        modules.insert(dll.to_path_buf(), module);
        module
    };
    Ok(windows::Win32::Foundation::HMODULE(module as *mut c_void))
}

pub fn box_for_process(pid: u32, install_dir: Option<&Path>) -> Result<Option<String>, String> {
    let directory = match install_dir {
        Some(path) => path.to_path_buf(),
        None => {
            let Some(service_exe) = service_exe() else {
                return Ok(None);
            };
            service_exe
                .parent()
                .ok_or_else(|| "Sandboxie service path has no parent directory".to_string())?
                .to_path_buf()
        }
    };
    let dll = directory.join("SbieDll.dll");
    if !dll.is_file() {
        return Err(format!("Sandboxie API not found: {}", dll.display()));
    }

    let module = api_module(&dll)?;

    unsafe {
        let function = GetProcAddress(module, PCSTR(b"SbieApi_QueryProcess\0".as_ptr()))
            .ok_or_else(|| "Sandboxie process query API is missing".to_string())?;
        let query: unsafe extern "system" fn(
            HANDLE,
            *mut u16,
            *mut u16,
            *mut u16,
            *mut u32,
        ) -> i32 = std::mem::transmute(function);
        let mut box_name = [0u16; 34];
        let status = query(
            HANDLE(pid as usize as *mut c_void),
            box_name.as_mut_ptr(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        );
        if status != 0 {
            return Ok(None);
        }

        let len = box_name
            .iter()
            .position(|c| *c == 0)
            .unwrap_or(box_name.len());
        let name = String::from_utf16_lossy(&box_name[..len]);
        Ok((!name.is_empty()).then_some(name))
    }
}

pub fn launch_arguments(box_name: &str, exe: &Path) -> [String; 2] {
    [
        format!("/box:{box_name}"),
        exe.to_string_lossy().into_owned(),
    ]
}

pub fn explorer_arguments(box_name: &str, path: &Path) -> [String; 3] {
    let folder = path
        .parent()
        .filter(|folder| !folder.as_os_str().is_empty())
        .unwrap_or(path);
    [
        format!("/box:{box_name}"),
        "explorer.exe".into(),
        folder.to_string_lossy().into_owned(),
    ]
}

pub fn show_in_explorer(
    install_dir: Option<&Path>,
    box_name: &str,
    path: &Path,
) -> Result<(), String> {
    let start = start_exe(install_dir)
        .ok_or_else(|| "Sandboxie Start.exe couldn't be found".to_string())?;
    let args = explorer_arguments(box_name, path);
    crate::shell::start_program_args(&start, &args, Path::new("."))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn configured_default_box_trims_name_and_keeps_the_existing_default() {
        assert_eq!(configured_default_box("  ReadingBox  "), "ReadingBox");
        assert_eq!(configured_default_box("   "), DEFAULT_BOX);
    }

    #[test]
    fn automatic_install_location_ignores_the_manual_path() {
        assert_eq!(
            configured_install_dir("auto", r"C:\NotTheSelectedFolder"),
            Ok(None)
        );
    }

    #[test]
    fn manual_install_location_requires_an_existing_directory() {
        assert!(configured_install_dir("manual", "").is_err());

        let path = std::env::temp_dir();
        assert_eq!(
            configured_install_dir("manual", &path.to_string_lossy()),
            Ok(Some(path))
        );
    }

    #[test]
    fn parses_quoted_and_unquoted_service_paths() {
        assert_eq!(
            service_exe_from_image_path(r#""C:\Program Files\Sandboxie\SbieSvc.exe" -service"#),
            Some(PathBuf::from(r"C:\Program Files\Sandboxie\SbieSvc.exe"))
        );
        assert_eq!(
            service_exe_from_image_path(r#""\??\C:\Sandboxie\SbieSvc.exe" -service"#),
            Some(PathBuf::from(r"C:\Sandboxie\SbieSvc.exe"))
        );
        assert_eq!(
            service_exe_from_image_path(r"\??\C:\Sandboxie\SbieSvc.exe -service"),
            Some(PathBuf::from(r"C:\Sandboxie\SbieSvc.exe"))
        );
    }

    #[test]
    fn keeps_box_and_game_path_as_separate_start_exe_arguments() {
        assert_eq!(
            launch_arguments("My Box", Path::new(r"C:\Games\My Game.exe")),
            ["/box:My Box", r"C:\Games\My Game.exe"].map(String::from)
        );
        assert_eq!(
            launch_arguments("DefaultBox", Path::new(r"C:\Games\Game.exe")),
            ["/box:DefaultBox", r"C:\Games\Game.exe"].map(String::from)
        );
    }

    #[test]
    fn opens_game_location_in_explorer_inside_the_selected_box() {
        assert_eq!(
            explorer_arguments("My Box", Path::new(r"C:\Games\My Game.exe")),
            ["/box:My Box", "explorer.exe", r"C:\Games"].map(String::from)
        );
    }

    #[test]
    fn converts_sandbox_backing_store_path_to_box_path() {
        assert_eq!(
            path_in_box(r"C:\Sandbox\user\box\drive\C\Games\game.exe"),
            Some(r"C:\Games\game.exe".into())
        );
        assert_eq!(
            path_in_box(r"C:\Games\game.exe"),
            Some(r"C:\Games\game.exe".into())
        );
        assert_eq!(path_in_box(""), None);
    }
}
