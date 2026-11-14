use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::time::{Duration, Instant};

use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

use crate::backup;
use crate::state::Shared;

const SITE: &str = "https://shiori.maia.moe";
const TOKEN: &str = "sync_token";
const USER: &str = "sync_user";
const AUTO_SAVE: &str = "sync_auto_save";
const MAX_BACKUP: usize = 25 * 1024 * 1024;
const LOGIN_WAIT: Duration = Duration::from_secs(300);
const USER_AGENT: &str = concat!("ShioriRPC/", env!("CARGO_PKG_VERSION"));

fn site() -> String {
    let site = std::env::var("SHIORI_SYNC_SITE").unwrap_or_else(|_| SITE.to_string());
    site.trim_end_matches('/').to_string()
}

fn api() -> String {
    format!("{}/api/sync", site())
}

fn client(timeout: u64) -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .user_agent(USER_AGENT)
        .timeout(Duration::from_secs(timeout))
        .build()
        .map_err(|e| e.to_string())
}

fn token(shared: &Shared) -> Option<String> {
    Some(shared.config.lock().unwrap().str(TOKEN)).filter(|t| !t.is_empty())
}

fn remember(shared: &Shared, token: &str, name: &str) {
    let changes = Map::from_iter([(TOKEN.to_string(), json!(token)), (USER.to_string(), json!(name))]);
    let _ = shared.config.lock().unwrap().update(changes);
}

fn signed_out(shared: &Shared) {
    remember(shared, "", "");
}

fn nonce() -> String {
    use std::hash::{BuildHasher, RandomState};
    let mut hasher = Sha256::new();
    for n in 0..4u64 {
        hasher.update(RandomState::new().hash_one(n).to_le_bytes());
    }
    hasher.update(format!("{:?}{}", Instant::now(), std::process::id()));
    hasher.finalize().iter().take(16).map(|b| format!("{b:02x}")).collect()
}

fn unescape(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'+' => out.push(b' '),
            b'%' if i + 2 < bytes.len() => {
                let digit = |b: u8| (b as char).to_digit(16);
                match (digit(bytes[i + 1]), digit(bytes[i + 2])) {
                    (Some(high), Some(low)) => {
                        out.push((high * 16 + low) as u8);
                        i += 2;
                    }
                    _ => out.push(b'%'),
                }
            }
            byte => out.push(byte),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn query(path: &str) -> Map<String, Value> {
    let Some((_, query)) = path.split_once('?') else {
        return Map::new();
    };
    query
        .split('&')
        .filter_map(|pair| pair.split_once('='))
        .map(|(k, v)| (unescape(k), json!(unescape(v))))
        .collect()
}

fn reply(stream: &mut TcpStream, status: &str, title: &str, text: &str) {
    let body = format!(
        "<!doctype html><meta charset=\"utf-8\"><title>{title}</title>\
         <body style=\"font-family:system-ui,sans-serif;background:#0b0816;color:#f2f3f5;display:grid;\
         place-items:center;min-height:100vh;margin:0\"><div style=\"text-align:center\">\
         <h1 style=\"font-size:22px\">{title}</h1><p style=\"color:#a3a7b0\">{text}</p></div>"
    );
    let head = format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    let _ = stream.write_all(head.as_bytes());
    let _ = stream.write_all(body.as_bytes());
}

fn read_path(stream: &mut TcpStream) -> Option<String> {
    stream.set_read_timeout(Some(Duration::from_secs(5))).ok()?;
    let mut buffer = [0u8; 8192];
    let mut head = Vec::new();
    while !head.windows(4).any(|w| w == b"\r\n\r\n") && head.len() < buffer.len() {
        let n = stream.read(&mut buffer).ok()?;
        if n == 0 {
            break;
        }
        head.extend_from_slice(&buffer[..n]);
    }
    let line = String::from_utf8_lossy(&head).lines().next()?.to_string();
    let mut parts = line.split_whitespace();
    (parts.next()? == "GET").then(|| parts.next().map(str::to_string))?
}

pub fn login(shared: &Shared) -> Result<String, String> {
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    let state = nonce();
    crate::shell::open(&format!("{}/login?port={port}&state={state}", api()))?;
    let (token, name) = wait_for_login(&listener, &state, LOGIN_WAIT, exchange)?;
    remember(shared, &token, &name);
    Ok(name)
}

fn exchange(code: &str) -> Result<(String, String), String> {
    let answer: Value = client(15)?
        .post(format!("{}/exchange", api()))
        .json(&json!({ "code": code }))
        .send()
        .and_then(|r| r.error_for_status())
        .and_then(|r| r.json())
        .map_err(|e| e.to_string())?;
    let text = |key: &str| answer[key].as_str().unwrap_or("").to_string();
    if text("token").is_empty() {
        return Err("The login expired. Try again.".into());
    }
    Ok((text("token"), text("name")))
}

fn send_to(stream: &mut TcpStream, location: &str) {
    let head = format!("HTTP/1.1 302 Found\r\nLocation: {location}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    let _ = stream.write_all(head.as_bytes());
}

fn wait_for_login<T>(
    listener: &TcpListener,
    state: &str,
    wait: Duration,
    finish: impl Fn(&str) -> Result<T, String>,
) -> Result<T, String> {
    let started = Instant::now();
    while started.elapsed() < wait {
        let mut stream = match listener.accept() {
            Ok((stream, _)) => stream,
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(150));
                continue;
            }
            Err(e) => return Err(e.to_string()),
        };
        let _ = stream.set_nonblocking(false);
        let Some(path) = read_path(&mut stream) else {
            continue;
        };
        if !path.starts_with("/done?") {
            reply(&mut stream, "404 Not Found", "Shiori RPC", "Nothing here.");
            continue;
        }
        let answer = query(&path);
        let text = |key: &str| answer.get(key).and_then(Value::as_str).unwrap_or("").to_string();
        if text("state") != state || text("code").is_empty() {
            reply(&mut stream, "400 Bad Request", "Login didn't match", "Start again from Shiori RPC.");
            continue;
        }
        return match finish(&text("code")) {
            Ok(done) => {
                send_to(&mut stream, &format!("{}/signed-in", site()));
                Ok(done)
            }
            Err(error) => {
                reply(&mut stream, "400 Bad Request", "Login failed", "Start again from Shiori RPC.");
                Err(error)
            }
        };
    }
    Err("The Discord login took too long. Try again.".into())
}

pub fn status(shared: &Shared) -> Result<Value, String> {
    let Some(token) = token(shared) else {
        return Ok(json!({ "signed_in": false }));
    };
    let reply = client(10)?
        .get(format!("{}/me", api()))
        .bearer_auth(&token)
        .send()
        .map_err(|e| e.to_string())?;
    if reply.status().as_u16() == 401 {
        signed_out(shared);
        return Ok(json!({ "signed_in": false }));
    }
    let me: Value = reply.error_for_status().and_then(|r| r.json()).map_err(|e| e.to_string())?;
    let name = me["name"].as_str().unwrap_or("").to_string();
    if !name.is_empty() {
        remember(shared, &token, &name);
    }
    Ok(json!({
        "signed_in": true,
        "name": name,
        "id": me["id"],
        "avatar": me["avatar"],
        "avatar_url": me["avatar_url"],
        "backup": me["backup"],
    }))
}

fn check(reply: reqwest::blocking::Response, shared: &Shared) -> Result<reqwest::blocking::Response, String> {
    match reply.status().as_u16() {
        401 => {
            signed_out(shared);
            Err("You were signed out. Sign in with Discord again.".into())
        }
        413 => Err("Your backup is too big for the cloud (25 MB max).".into()),
        429 => Err("Too many saves in a short time. Try again in a while.".into()),
        404 => Err("There's no backup in the cloud yet.".into()),
        _ => reply.error_for_status().map_err(|e| e.to_string()),
    }
}

pub fn upload(shared: &Shared, timeout: u64) -> Result<Value, String> {
    let token = token(shared).ok_or("Sign in with Discord first.")?;
    let file = shared.data_dir.join("cache").join("cloud-backup.zip");
    backup::export_for_cloud(&shared.config.lock().unwrap(), &file)?;
    let bytes = std::fs::read(&file).map_err(|e| e.to_string());
    let _ = std::fs::remove_file(&file);
    let bytes = bytes?;
    if bytes.len() > MAX_BACKUP {
        return Err("Your backup is too big for the cloud (25 MB max).".into());
    }
    let reply = client(timeout)?
        .put(format!("{}/backup", api()))
        .bearer_auth(&token)
        .header("Content-Type", "application/zip")
        .body(bytes)
        .send()
        .map_err(|e| e.to_string())?;
    check(reply, shared)?.json().map_err(|e| e.to_string())
}

pub fn download(shared: &Shared) -> Result<usize, String> {
    let token = token(shared).ok_or("Sign in with Discord first.")?;
    let reply = client(60)?
        .get(format!("{}/backup", api()))
        .bearer_auth(&token)
        .send()
        .map_err(|e| e.to_string())?;
    let bytes = check(reply, shared)?.bytes().map_err(|e| e.to_string())?;
    let file = shared.data_dir.join("cache").join("cloud-restore.zip");
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    std::fs::write(&file, &bytes).map_err(|e| e.to_string())?;
    let result = backup::import_from_cloud(&mut shared.config.lock().unwrap(), &file);
    let _ = std::fs::remove_file(&file);
    result
}

pub fn delete(shared: &Shared) -> Result<(), String> {
    let token = token(shared).ok_or("Sign in with Discord first.")?;
    let reply = client(15)?
        .delete(format!("{}/backup", api()))
        .bearer_auth(&token)
        .send()
        .map_err(|e| e.to_string())?;
    if reply.status().as_u16() != 401 {
        reply.error_for_status().map_err(|e| e.to_string())?;
    }
    signed_out(shared);
    Ok(())
}

pub fn logout(shared: &Shared) {
    if let Some(token) = token(shared) {
        if let Ok(client) = client(8) {
            let _ = client.post(format!("{}/logout", api())).bearer_auth(&token).send();
        }
    }
    signed_out(shared);
}

pub fn save_on_exit(shared: &Shared) {
    let wanted = shared.config.lock().unwrap().bool(AUTO_SAVE);
    if wanted && token(shared).is_some() {
        if let Err(error) = upload(shared, 10) {
            crate::crash::note(format!("cloud save on exit: {error}"));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn login_answers_are_read() {
        let answer = query("/done?state=ab12&token=x-Y_z&name=Len%20%E3%81%97%2B1");
        assert_eq!(answer["state"], "ab12");
        assert_eq!(answer["token"], "x-Y_z");
        assert_eq!(answer["name"], "Len し+1");
        assert_eq!(nonce().len(), 32);
        assert_ne!(nonce(), nonce());
    }

    fn visit(port: u16, path: &str) -> String {
        let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
        stream.write_all(format!("GET {path} HTTP/1.1\r\nHost: x\r\n\r\n").as_bytes()).unwrap();
        let mut answer = String::new();
        stream.read_to_string(&mut answer).unwrap();
        answer
    }

    #[test]
    fn the_browser_hands_the_token_back() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        listener.set_nonblocking(true).unwrap();
        let browser = std::thread::spawn(move || {
            let lost = visit(port, "/favicon.ico");
            let wrong = visit(port, "/done?state=other&code=evil");
            let right = visit(port, "/done?state=abc123&code=one-time");
            (lost, wrong, right)
        });
        let got = wait_for_login(&listener, "abc123", Duration::from_secs(10), |code| Ok(code.to_string())).unwrap();
        let (lost, wrong, right) = browser.join().unwrap();
        assert_eq!(got, "one-time");
        assert!(lost.starts_with("HTTP/1.1 404"));
        assert!(wrong.starts_with("HTTP/1.1 400"));
        assert!(right.starts_with("HTTP/1.1 302") && right.contains("/signed-in"));
    }
}
