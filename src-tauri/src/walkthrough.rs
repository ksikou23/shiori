use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::state::Shared;

const INDEX_URL: &str = "https://seiya-saiga.com/game/kouryaku.html";
const INDEX_BASE: &str = "https://seiya-saiga.com/game/";
const INDEX_DAYS: i64 = 7;
const NOOK_API: &str = "https://www.nookgaming.com/wp-json/wp/v2/posts";
const USER_AGENT: &str = concat!("ShioriRPC/", env!("CARGO_PKG_VERSION"));
const TRANSLATE_URL: &str = "https://translate.googleapis.com/translate_a/t?client=gtx&sl=ja&tl=en";
const BATCH_CHARS: usize = 3000;
const BATCH_LINES: usize = 80;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Entry {
    pub title: String,
    pub url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Step {
    pub kind: String,
    pub text: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub hint: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Route {
    pub name: String,
    pub steps: Vec<Step>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Saved {
    pub url: String,
    pub title: String,
    pub fetched: i64,
    pub routes: Vec<Route>,
    #[serde(default)]
    pub done: Vec<String>,
    #[serde(default)]
    pub route: usize,
    #[serde(default)]
    pub english: BTreeMap<String, String>,
    #[serde(default)]
    pub translated: bool,
    #[serde(default)]
    pub source: String,
}

#[derive(Serialize, Deserialize)]
struct Index {
    fetched: i64,
    entries: Vec<Entry>,
}

fn http() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .user_agent(USER_AGENT)
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())
}

fn charset_of(bytes: &[u8]) -> Option<&'static encoding_rs::Encoding> {
    let head = String::from_utf8_lossy(&bytes[..bytes.len().min(2048)]).to_lowercase();
    let start = head.find("charset=")? + 8;
    let name: String = head[start..]
        .trim_start_matches(['"', '\''])
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .collect();
    encoding_rs::Encoding::for_label(name.as_bytes())
}

fn decode(bytes: &[u8], fallback: &'static encoding_rs::Encoding) -> String {
    let encoding = charset_of(bytes).unwrap_or(fallback);
    encoding.decode(bytes).0.into_owned()
}

fn redirect_of(html: &str) -> Option<String> {
    let lower = html.to_lowercase();
    let at = lower.find("http-equiv=\"refresh\"")?;
    let url = lower[at..].find("url=")? + at + 4;
    let end = html[url..].find(['"', '\'', '>']).map(|e| url + e)?;
    Some(html[url..end].trim().to_string())
}

fn fetch(url: &str) -> Result<String, String> {
    let client = http()?;
    let mut url = url.to_string();
    for _ in 0..3 {
        let bytes = client
            .get(&url)
            .send()
            .and_then(|r| r.error_for_status())
            .and_then(|r| r.bytes())
            .map_err(|e| e.to_string())?;
        let html = decode(&bytes, encoding_rs::EUC_JP);
        match redirect_of(&html) {
            Some(next) => url = absolute(&url, &next),
            None => return Ok(html),
        }
    }
    Err("too many redirects".into())
}

fn absolute(base: &str, link: &str) -> String {
    if link.starts_with("http://") || link.starts_with("https://") {
        return link.replacen("http://", "https://", 1);
    }
    let folder = &base[..base.rfind('/').map_or(base.len(), |i| i + 1)];
    format!("{folder}{link}")
}

#[derive(Clone, Copy)]
enum Token<'a> {
    Tag(&'a str),
    Text(&'a str),
}

fn tokens(html: &str) -> Vec<Token<'_>> {
    let mut out = Vec::new();
    let mut rest = html;
    while !rest.is_empty() {
        match rest.find('<') {
            Some(0) => {
                let end = rest.find('>').map_or(rest.len(), |e| e + 1);
                out.push(Token::Tag(&rest[..end]));
                rest = &rest[end..];
            }
            Some(at) => {
                out.push(Token::Text(&rest[..at]));
                rest = &rest[at..];
            }
            None => {
                out.push(Token::Text(rest));
                rest = "";
            }
        }
    }
    out
}

fn tag_name(tag: &str) -> String {
    tag.trim_start_matches('<')
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric() || *c == '/')
        .collect::<String>()
        .to_lowercase()
}

fn attr(tag: &str, name: &str) -> Option<String> {
    let lower = tag.to_lowercase();
    let at = lower.find(&format!("{name}="))? + name.len() + 1;
    let value = &tag[at..];
    let value = value.trim_start_matches(['"', '\'']);
    let end = value.find(['"', '\'', ' ', '>']).unwrap_or(value.len());
    Some(value[..end].to_lowercase())
}

fn entities(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find('&') {
        out.push_str(&rest[..at]);
        rest = &rest[at..];
        let Some(end) = rest.char_indices().take(10).find(|(_, c)| *c == ';').map(|(i, _)| i) else {
            out.push('&');
            rest = &rest[1..];
            continue;
        };
        let name = &rest[1..end];
        let decoded = match name {
            "amp" => Some('&'),
            "lt" => Some('<'),
            "gt" => Some('>'),
            "quot" => Some('"'),
            "apos" => Some('\''),
            "nbsp" => Some(' '),
            _ => name
                .strip_prefix("#x")
                .or_else(|| name.strip_prefix("#X"))
                .and_then(|hex| u32::from_str_radix(hex, 16).ok())
                .or_else(|| name.strip_prefix('#').and_then(|n| n.parse().ok()))
                .and_then(char::from_u32),
        };
        match decoded {
            Some(c) => {
                out.push(c);
                rest = &rest[end + 1..];
            }
            None => {
                out.push('&');
                rest = &rest[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

fn clean(text: &str) -> String {
    let text = entities(text);
    let mut out = String::new();
    for word in text.split(|c: char| c.is_whitespace()).filter(|w| !w.is_empty()) {
        if !out.is_empty() {
            out.push(' ');
        }
        out.push_str(word);
    }
    out
}

fn is_red(color: &str) -> bool {
    let hex = color.trim_start_matches('#');
    if hex.len() != 6 {
        return color == "red";
    }
    let part = |i: usize| u8::from_str_radix(&hex[i..i + 2], 16).unwrap_or(0);
    part(0) >= 0xc0 && part(2) <= 0x40 && part(4) <= 0x40
}

fn is_blue(color: &str) -> bool {
    matches!(color, "#0000ff" | "#0000cc" | "#0033ff" | "blue")
}

#[derive(Default)]
struct Line {
    plain: String,
    colored: Vec<String>,
    first_color: Option<Option<String>>,
    checkbox: bool,
    continues: bool,
}

impl Line {
    fn add(&mut self, text: &str, color: Option<&String>) {
        if clean(text).is_empty() {
            if color.is_none() {
                self.plain.push_str(text);
            }
            return;
        }
        if self.first_color.is_none() {
            self.first_color = Some(color.cloned());
        }
        match color {
            Some(_) if !clean(&self.plain).is_empty() => self.colored.push(text.to_string()),
            _ => self.plain.push_str(text),
        }
    }

    fn main(&self) -> String {
        clean(&self.plain)
    }

    fn hint(&self) -> String {
        clean(&self.colored.join(" "))
    }

    fn text(&self) -> String {
        [self.main(), self.hint()].into_iter().filter(|t| !t.is_empty()).collect::<Vec<_>>().join(" ")
    }
}

fn trim_marks(text: &str) -> String {
    text.trim_matches(|c: char| c.is_whitespace() || "：:│|⇒━".contains(c))
        .to_string()
}

fn finish(line: Line, steps: &mut Vec<Step>) {
    let text = line.text();
    if text.is_empty() {
        return;
    }
    if line.continues && !line.checkbox {
        if let Some(last) = steps.last_mut().filter(|s| s.kind == "choice") {
            if !last.hint.is_empty() {
                last.hint.push(' ');
            }
            last.hint.push_str(&trim_marks(&text));
            return;
        }
    }
    let color = line.first_color.clone().flatten().unwrap_or_default();
    let step = if line.checkbox {
        let main = trim_marks(&line.main());
        let hint = trim_marks(&line.hint());
        if main.is_empty() {
            Step { kind: "choice".into(), text: hint, hint: String::new() }
        } else {
            Step { kind: "choice".into(), text: main, hint }
        }
    } else if is_blue(&color) {
        Step { kind: "ending".into(), text: trim_marks(&text), hint: String::new() }
    } else if is_red(&color) || text.starts_with('◆') {
        Step { kind: "save".into(), text: trim_marks(&text), hint: String::new() }
    } else if !color.is_empty() && text.starts_with('★') {
        Step { kind: "choice".into(), text: trim_marks(&text), hint: String::new() }
    } else if color.is_empty() && text.starts_with('■') {
        Step { kind: "heading".into(), text: trim_marks(&text), hint: String::new() }
    } else {
        Step { kind: "note".into(), text: trim_marks(&text), hint: String::new() }
    };
    if !step.text.is_empty() {
        steps.push(step);
    }
}

fn steps_of(cell: &[Token]) -> Vec<Step> {
    let mut steps = Vec::new();
    let mut colors: Vec<Option<String>> = Vec::new();
    let mut label = false;
    let mut line = Line::default();
    for token in cell {
        match token {
            Token::Text(text) => {
                let color = colors.iter().rev().flatten().next();
                line.add(text, color);
            }
            Token::Tag(tag) => match tag_name(tag).as_str() {
                "br" | "hr" | "p" | "/p" | "div" | "/div" | "tr" | "/tr" | "td" | "/td" | "th" | "/th" | "table"
                | "/table" => {
                    finish(std::mem::take(&mut line), &mut steps);
                    line.continues = label;
                }
                "font" | "span" => colors.push(attr(tag, "color")),
                "/font" | "/span" => {
                    colors.pop();
                }
                "input" if attr(tag, "type").as_deref() == Some("checkbox") => line.checkbox = true,
                "label" => label = true,
                "/label" => label = false,
                _ => {}
            },
        }
    }
    finish(line, &mut steps);
    steps
}

struct Cell<'a> {
    header: bool,
    depth: usize,
    tokens: Vec<Token<'a>>,
}

struct Row<'a> {
    depth: usize,
    cells: Vec<Cell<'a>>,
}

fn close_cells<'a>(open: &mut Vec<Cell<'a>>, rows: &mut [Row<'a>], depth: usize) {
    while open.last().is_some_and(|c| c.depth >= depth) {
        let cell = open.pop().unwrap();
        if let Some(row) = rows.iter_mut().rev().find(|r| r.depth == cell.depth) {
            row.cells.push(cell);
        }
    }
}

fn rows(html: &str) -> Vec<Row<'_>> {
    let mut rows: Vec<Row> = Vec::new();
    let mut open: Vec<Cell> = Vec::new();
    let mut depth = 0;
    for token in tokens(html) {
        if let Token::Tag(tag) = token {
            match tag_name(tag).as_str() {
                "table" => depth += 1,
                "/table" => {
                    close_cells(&mut open, &mut rows, depth);
                    depth = depth.saturating_sub(1);
                }
                "tr" => {
                    close_cells(&mut open, &mut rows, depth);
                    rows.push(Row { depth, cells: Vec::new() });
                }
                "td" | "th" => {
                    close_cells(&mut open, &mut rows, depth);
                    let header = attr(tag, "bgcolor").as_deref() == Some("#ccffff");
                    open.push(Cell { header, depth, tokens: Vec::new() });
                    continue;
                }
                "/td" | "/th" => {
                    close_cells(&mut open, &mut rows, depth);
                    continue;
                }
                _ => {}
            }
        }
        for cell in open.iter_mut() {
            cell.tokens.push(token);
        }
    }
    rows
}

pub fn parse(html: &str) -> Vec<Route> {
    let mut routes = Vec::new();
    let mut pending: Vec<(usize, Vec<String>)> = Vec::new();
    for row in rows(html) {
        let depth = row.depth;
        let row = row.cells;
        if row.is_empty() {
            continue;
        }
        if row.iter().all(|c| c.header) {
            let text = |c: &Cell| {
                let raw: String = c
                    .tokens
                    .iter()
                    .map(|t| match t {
                        Token::Text(text) => *text,
                        Token::Tag(_) => " ",
                    })
                    .collect();
                clean(&raw)
            };
            pending.retain(|(d, _)| *d != depth);
            pending.push((depth, row.iter().map(text).collect()));
            continue;
        }
        let Some(at) = pending.iter().position(|(d, _)| *d == depth) else {
            continue;
        };
        let heads = pending.remove(at).1;
        for (name, cell) in heads.into_iter().zip(row.iter()) {
            let steps = steps_of(&cell.tokens);
            if steps.iter().any(|s| s.kind == "choice" || s.kind == "ending") {
                let name = if name.is_empty() { format!("{}", routes.len() + 1) } else { name };
                routes.push(Route { name, steps });
            }
        }
    }
    routes
}

pub fn parse_index(html: &str) -> Vec<Entry> {
    let mut out: Vec<Entry> = Vec::new();
    let mut link: Option<String> = None;
    let mut title = String::new();
    for token in tokens(html) {
        match token {
            Token::Tag(tag) if tag_name(tag) == "a" => {
                let lower = tag.to_lowercase();
                link = lower.find("href=").map(|at| {
                    let value = tag[at + 5..].trim_start_matches(['"', '\'']);
                    let end = value.find(['"', '\'', ' ', '>']).unwrap_or(value.len());
                    value[..end].to_string()
                });
                title.clear();
            }
            Token::Tag(tag) if tag_name(tag) == "/a" => {
                if let Some(href) = link.take() {
                    let name = clean(&title);
                    let page = href.ends_with(".html") && href.contains('/') && !href.contains("kouryaku");
                    if page && !name.is_empty() {
                        let url = absolute(INDEX_BASE, &href);
                        if !out.iter().any(|e| e.url == url) {
                            out.push(Entry { title: name, url });
                        }
                    }
                }
            }
            Token::Text(text) if link.is_some() => title.push_str(text),
            _ => {}
        }
    }
    out
}

const NOISE: [&str; 9] = [
    "pc版",
    "steam版対応",
    "steam版",
    "forwindowspc",
    "windows版",
    "dl版",
    "パッケージ版",
    "通常版",
    "完全版",
];

fn fold(text: &str) -> String {
    let mut out = String::new();
    let mut depth = 0;
    for c in text.chars() {
        let c = match c as u32 {
            0xFF01..=0xFF5E => char::from_u32(c as u32 - 0xFEE0).unwrap_or(c),
            _ => c,
        };
        match c {
            '(' | '（' | '【' | '［' | '[' => depth += 1,
            ')' | '）' | '】' | '］' | ']' => depth = (depth - 1).max(0),
            _ if depth > 0 => {}
            _ if c.is_alphanumeric() => out.extend(c.to_lowercase()),
            _ => {}
        }
    }
    for noise in NOISE {
        if let Some(stripped) = out.strip_suffix(noise) {
            out = stripped.to_string();
        }
    }
    out
}

fn head(text: &str) -> String {
    let cut = text
        .find(['〜', '～', '―', '~'])
        .or_else(|| text.find(" -"))
        .unwrap_or(text.len());
    fold(&text[..cut])
}

fn score(names: &[String], title: &str) -> u32 {
    let (full, short) = (fold(title), head(title));
    if full.is_empty() {
        return 0;
    }
    let mut best = 0;
    for name in names {
        let (mine, mine_short) = (fold(name), head(name));
        if mine.chars().count() < 2 {
            continue;
        }
        let points = if mine == full {
            100
        } else if mine_short == short && mine_short.chars().count() >= 2 {
            90
        } else if full.starts_with(&mine) && mine.chars().count() >= 4 {
            70
        } else if mine.starts_with(&full) && full.chars().count() >= 4 {
            60
        } else {
            0
        };
        best = best.max(points);
    }
    best
}

pub fn best_match(entries: &[Entry], names: &[String]) -> Option<Entry> {
    entries
        .iter()
        .map(|e| (score(names, &e.title), e))
        .filter(|(s, _)| *s >= 60)
        .max_by(|(a, x), (b, y)| a.cmp(b).then(y.title.len().cmp(&x.title.len())))
        .map(|(_, e)| e.clone())
}

pub fn search(entries: &[Entry], query: &str) -> Vec<Entry> {
    let wanted = fold(query);
    if wanted.is_empty() {
        return Vec::new();
    }
    let mut hits: Vec<&Entry> = entries.iter().filter(|e| fold(&e.title).contains(&wanted)).collect();
    hits.sort_by_key(|e| (!fold(&e.title).starts_with(&wanted), e.title.len()));
    let mut seen = HashSet::new();
    hits.into_iter().filter(|e| seen.insert(e.url.clone())).take(30).cloned().collect()
}

fn folder(shared: &Shared) -> PathBuf {
    shared.data_dir.join("walkthroughs")
}

fn file_for(shared: &Shared, key: &str) -> PathBuf {
    let id = sha1_smol::Sha1::from(key).digest().to_string();
    folder(shared).join(format!("{}.json", &id[..16]))
}

fn read<T: for<'de> Deserialize<'de>>(path: &Path) -> Option<T> {
    serde_json::from_slice(&std::fs::read(path).ok()?).ok()
}

fn write<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let bytes = serde_json::to_vec(value).map_err(|e| e.to_string())?;
    std::fs::write(path, bytes).map_err(|e| e.to_string())
}

pub fn index(shared: &Shared, fresh: bool) -> Result<Vec<Entry>, String> {
    cached_index(shared, "walkthrough-index.json", fresh, || fetch(INDEX_URL).map(|html| parse_index(&html)))
}

pub fn nook_index(shared: &Shared, fresh: bool) -> Result<Vec<Entry>, String> {
    cached_index(shared, "walkthrough-index-nook.json", fresh, fetch_nook_index)
}

pub fn all_entries(shared: &Shared) -> Result<Vec<Entry>, String> {
    let nook = nook_index(shared, false);
    let seiya = index(shared, false);
    if let (Err(error), Err(_)) = (&nook, &seiya) {
        return Err(error.clone());
    }
    Ok(nook.unwrap_or_default().into_iter().chain(seiya.unwrap_or_default()).collect())
}

fn cached_index(
    shared: &Shared,
    name: &str,
    fresh: bool,
    fetcher: impl FnOnce() -> Result<Vec<Entry>, String>,
) -> Result<Vec<Entry>, String> {
    let path = shared.data_dir.join("cache").join(name);
    let cached: Option<Index> = read(&path);
    let now = crate::config::now();
    if let Some(cached) = &cached {
        let age = now - cached.fetched;
        if age < INDEX_DAYS * 86_400 && !(fresh && age > 86_400) {
            return Ok(cached.entries.clone());
        }
    }
    match fetcher() {
        Ok(entries) if !entries.is_empty() => {
            let _ = write(&path, &Index { fetched: now, entries: entries.clone() });
            Ok(entries)
        }
        Ok(_) => cached.map(|c| c.entries).ok_or_else(|| "empty index".into()),
        Err(error) => cached.map(|c| c.entries).ok_or(error),
    }
}

fn names_for(shared: &Shared, key: &str) -> Vec<String> {
    let cfg = shared.config.lock().unwrap();
    let entry = cfg.game(key);
    let title_priority = cfg.display_title_priority();
    drop(cfg);
    let text = |f: &str| entry.get(f).and_then(Value::as_str).unwrap_or("").to_string();
    let mut names = Vec::new();
    let vn = [text("vndb_id"), text("matched_vndb_id")]
        .into_iter()
        .find(|id| !id.is_empty())
        .and_then(|id| shared.vndb.get(&id).ok().flatten());
    if let Some(vn) = vn {
        names.push(vn.alt_title);
        names.push(vn.title);
        names.extend(vn.other_titles);
    }
    names.push(text("title"));
    names.push(crate::screenshots::display_name(
        key,
        &entry,
        &title_priority,
    ));
    names.retain(|n| !n.trim().is_empty());
    names.dedup();
    names
}

pub fn load(shared: &Shared, key: &str) -> Option<Saved> {
    read(&file_for(shared, key))
}

fn save(shared: &Shared, key: &str, saved: &Saved) -> Result<(), String> {
    write(&file_for(shared, key), saved)
}

fn download(shared: &Shared, key: &str, entry: &Entry, old: Option<Saved>) -> Result<Saved, String> {
    let nook = is_nook(&entry.url);
    let routes = if nook { parse_nook(&nook_content(&entry.url)?) } else { parse(&fetch(&entry.url)?) };
    if routes.is_empty() {
        return Err("no choices on that page".into());
    }
    let keep = old.filter(|o| o.url == entry.url);
    let saved = Saved {
        url: entry.url.clone(),
        title: entry.title.clone(),
        fetched: crate::config::now(),
        done: keep.as_ref().map(|o| o.done.clone()).unwrap_or_default(),
        route: keep.as_ref().map_or(0, |o| o.route.min(routes.len() - 1)),
        english: keep.as_ref().map(|o| o.english.clone()).unwrap_or_default(),
        translated: nook,
        source: if nook { "nook" } else { "seiya" }.into(),
        routes,
    };
    save(shared, key, &saved)?;
    Ok(saved)
}

pub fn get(shared: &Shared, key: &str, refresh: bool) -> Result<Option<Saved>, String> {
    let old = load(shared, key);
    if let Some(saved) = &old {
        if !refresh {
            return Ok(Some(saved.clone()));
        }
        let entry = Entry { title: saved.title.clone(), url: saved.url.clone() };
        return download(shared, key, &entry, old).map(Some);
    }
    let picked = {
        let entry = shared.config.lock().unwrap().game(key);
        entry.get("walkthrough_url").and_then(Value::as_str).map(str::to_string)
    };
    if let Some(url) = picked.filter(|u| !u.is_empty()) {
        let title = all_entries(shared)
            .ok()
            .and_then(|all| all.into_iter().find(|e| e.url == url))
            .map_or_else(|| url.clone(), |e| e.title);
        return download(shared, key, &Entry { title, url }, None).map(Some);
    }
    let names = names_for(shared, key);
    let mut failure = None;
    for english in [true, false] {
        let lookup = |fresh| if english { nook_index(shared, fresh) } else { index(shared, fresh) };
        let mut found = lookup(false).ok().and_then(|entries| best_match(&entries, &names));
        if found.is_none() {
            found = lookup(true).ok().and_then(|entries| best_match(&entries, &names));
        }
        let Some(entry) = found else {
            continue;
        };
        match download(shared, key, &entry, None) {
            Ok(saved) => return Ok(Some(saved)),
            Err(error) => failure = Some(error),
        }
    }
    match failure {
        Some(error) => Err(error),
        None => index(shared, false).map(|_| None),
    }
}

pub fn find_in(shared: &Shared, key: &str, source: &str) -> Result<Option<Entry>, String> {
    let names = names_for(shared, key);
    let lookup = |fresh| if source == "nook" { nook_index(shared, fresh) } else { index(shared, fresh) };
    if let Some(found) = best_match(&lookup(false)?, &names) {
        return Ok(Some(found));
    }
    Ok(best_match(&lookup(true)?, &names))
}

fn is_nook(url: &str) -> bool {
    url.contains("nookgaming.com")
}

fn nook_titles(rendered: &str) -> Vec<String> {
    let title = clean(rendered);
    let (head, tail) = match title.find("Walkthrough") {
        Some(at) => (&title[..at], &title[at..]),
        None => (title.as_str(), ""),
    };
    let mut out = Vec::new();
    let head = head.trim_end_matches(|c: char| c.is_whitespace() || "–—-|:".contains(c));
    if !head.is_empty() {
        out.push(head.to_string());
    }
    if let Some(at) = tail.find('|') {
        let alt = tail[at + 1..].trim();
        if !alt.is_empty() {
            out.push(alt.to_string());
        }
    }
    out
}

fn fetch_nook_index() -> Result<Vec<Entry>, String> {
    let client = http()?;
    let mut out = Vec::new();
    for page in 1..=20 {
        let url = format!("{NOOK_API}?search=walkthrough&_fields=link,title&per_page=100&page={page}");
        let reply = client.get(&url).send().map_err(|e| e.to_string())?;
        if reply.status().as_u16() == 400 {
            break;
        }
        let reply = reply.error_for_status().map_err(|e| e.to_string())?;
        let pages: usize = reply
            .headers()
            .get("X-WP-TotalPages")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse().ok())
            .unwrap_or(1);
        let posts: Vec<Value> = reply.json().map_err(|e| e.to_string())?;
        for post in posts {
            let link = post["link"].as_str().unwrap_or("").to_string();
            if !link.contains("walkthrough") {
                continue;
            }
            for title in nook_titles(post["title"]["rendered"].as_str().unwrap_or("")) {
                out.push(Entry { title, url: link.clone() });
            }
        }
        if page >= pages {
            break;
        }
    }
    Ok(out)
}

fn nook_content(url: &str) -> Result<String, String> {
    let slug = url.trim_end_matches('/').rsplit('/').next().unwrap_or("");
    let posts: Vec<Value> = http()?
        .get(format!("{NOOK_API}?slug={slug}&_fields=content"))
        .send()
        .and_then(|r| r.error_for_status())
        .and_then(|r| r.json())
        .map_err(|e| e.to_string())?;
    posts
        .first()
        .and_then(|p| p["content"]["rendered"].as_str())
        .map(str::to_string)
        .ok_or_else(|| "walkthrough not found".into())
}

fn is_prompt(text: &str) -> bool {
    text.ends_with(':') && text.chars().count() <= 12
}

fn ends_route(text: &str) -> bool {
    let lower = text.trim_end_matches(':').trim().to_lowercase();
    ["ending", " end", "route"].iter().any(|word| lower.ends_with(word))
}

fn finish_nook(mode: Option<&str>, text: &mut String, current: &mut Option<Route>) {
    let line = clean(text);
    text.clear();
    let (Some(kind), Some(route)) = (mode, current.as_mut()) else {
        return;
    };
    if kind == "heading" || line.is_empty() || (kind == "note" && is_prompt(&line)) {
        return;
    }
    let bracket = line.starts_with('[') && line.ends_with(']');
    let kind = match kind {
        "choice" if bracket && line.to_lowercase().contains("save") => "save",
        "choice" | "note" if bracket => "heading",
        "bold" => "heading",
        other => other,
    };
    route.steps.push(Step { kind: kind.into(), text: line, hint: String::new() });
}

fn finish_bold(text: &mut String, current: &mut Option<Route>) {
    let line = clean(text);
    let short = line.chars().count() <= 60 && !is_prompt(&line);
    finish_nook(Some(if short { "bold" } else { "note" }), text, current);
}

fn close_nook(current: &mut Option<Route>, routes: &mut Vec<Route>) {
    if let Some(route) = current.take() {
        if route.steps.iter().any(|s| s.kind == "choice") {
            routes.push(route);
        }
    }
}

pub fn parse_nook(html: &str) -> Vec<Route> {
    let mut routes: Vec<Route> = Vec::new();
    let mut current: Option<Route> = None;
    let mut text = String::new();
    let mut mode: Option<&str> = None;
    let mut bold = 0;
    let mut plain = false;
    let html = html.find("data-nook-review-card").map_or(html, |end| &html[..end]);
    for token in tokens(html) {
        match token {
            Token::Text(part) => {
                if mode.is_some() {
                    text.push_str(part);
                    if bold == 0 && !clean(part).is_empty() {
                        plain = true;
                    }
                }
            }
            Token::Tag(tag) => match tag_name(tag).as_str() {
                "strong" | "b" => bold += 1,
                "/strong" | "/b" => bold = (bold - 1).max(0),
                "/p" if mode == Some("note") && !plain && current.is_some() => {
                    let line = clean(&text);
                    mode = None;
                    if ends_route(&line) && line.chars().count() <= 60 {
                        text.clear();
                        let unused = current.as_ref().is_some_and(|r| !r.steps.iter().any(|s| s.kind == "choice"));
                        if !unused {
                            close_nook(&mut current, &mut routes);
                        }
                        current = Some(Route { name: line.trim_end_matches(':').trim().to_string(), steps: Vec::new() });
                    } else {
                        finish_bold(&mut text, &mut current);
                    }
                }
                "h2" | "h3" | "h4" | "h5" => {
                    finish_nook(mode, &mut text, &mut current);
                    mode = Some("heading");
                }
                "/h2" | "/h3" | "/h4" | "/h5" => {
                    let name = clean(&text);
                    text.clear();
                    mode = None;
                    if !name.is_empty() {
                        close_nook(&mut current, &mut routes);
                        current = Some(Route { name, steps: Vec::new() });
                    }
                }
                "li" => {
                    finish_nook(mode, &mut text, &mut current);
                    mode = Some("choice");
                }
                "/li" | "ul" | "ol" | "/ul" | "/ol" | "/p" => {
                    finish_nook(mode, &mut text, &mut current);
                    mode = None;
                }
                "p" => {
                    finish_nook(mode, &mut text, &mut current);
                    mode = Some("note");
                    plain = false;
                }
                "br" => text.push(' '),
                _ => {}
            },
        }
    }
    finish_nook(mode, &mut text, &mut current);
    close_nook(&mut current, &mut routes);
    routes
}

pub fn pick(shared: &Shared, key: &str, entry: &Entry) -> Result<Saved, String> {
    let mut fields = serde_json::Map::new();
    fields.insert("walkthrough_url".into(), json!(entry.url));
    shared.config.lock().unwrap().set_game(key, fields);
    download(shared, key, entry, load(shared, key))
}

fn form(texts: &[&str]) -> String {
    let mut out = String::new();
    for text in texts {
        if !out.is_empty() {
            out.push('&');
        }
        out.push_str("q=");
        for byte in text.bytes() {
            match byte {
                b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(byte as char),
                _ => out.push_str(&format!("%{byte:02X}")),
            }
        }
    }
    out
}

fn translate_batch(client: &reqwest::blocking::Client, texts: &[&str]) -> Result<Vec<String>, String> {
    let reply: Value = client
        .post(TRANSLATE_URL)
        .header("Content-Type", "application/x-www-form-urlencoded;charset=utf-8")
        .body(form(texts))
        .send()
        .and_then(|r| r.error_for_status())
        .and_then(|r| r.json())
        .map_err(|e| e.to_string())?;
    let items = reply.as_array().ok_or("unexpected translation reply")?;
    let out: Vec<String> = items
        .iter()
        .map(|item| match item {
            Value::String(text) => text.clone(),
            Value::Array(parts) => parts.first().and_then(Value::as_str).unwrap_or("").to_string(),
            _ => String::new(),
        })
        .collect();
    if out.len() != texts.len() {
        return Err("translation reply doesn't match".into());
    }
    Ok(out)
}

fn texts_of(saved: &Saved) -> BTreeSet<String> {
    let mut texts = BTreeSet::new();
    for route in &saved.routes {
        texts.insert(route.name.clone());
        for step in &route.steps {
            texts.insert(step.text.clone());
            texts.insert(step.hint.clone());
        }
    }
    texts.retain(|t| !t.is_ascii() && !saved.english.contains_key(t));
    texts
}

static TRANSLATING: Mutex<Option<HashSet<String>>> = Mutex::new(None);

pub fn translate(shared: &Shared, key: &str) -> Result<Option<Saved>, String> {
    let first = TRANSLATING.lock().unwrap().get_or_insert_with(HashSet::new).insert(key.to_string());
    if !first {
        return Ok(load(shared, key));
    }
    let result = translate_now(shared, key);
    if let Some(set) = TRANSLATING.lock().unwrap().as_mut() {
        set.remove(key);
    }
    result
}

fn translate_now(shared: &Shared, key: &str) -> Result<Option<Saved>, String> {
    let Some(saved) = load(shared, key) else {
        return Ok(None);
    };
    if saved.translated {
        return Ok(Some(saved));
    }
    let missing: Vec<String> = texts_of(&saved).into_iter().collect();
    let client = http()?;
    let mut batch: Vec<&str> = Vec::new();
    let mut size = 0;
    for (i, text) in missing.iter().enumerate() {
        batch.push(text);
        size += text.len();
        let last = i + 1 == missing.len();
        if size < BATCH_CHARS && batch.len() < BATCH_LINES && !last {
            continue;
        }
        let english = translate_batch(&client, &batch)?;
        let mut current = load(shared, key).ok_or("no walkthrough")?;
        for (original, english) in batch.iter().zip(english) {
            if !english.trim().is_empty() {
                current.english.insert(original.to_string(), english.trim().to_string());
            }
        }
        save(shared, key, &current)?;
        batch.clear();
        size = 0;
    }
    let mut current = load(shared, key).ok_or("no walkthrough")?;
    current.translated = true;
    save(shared, key, &current)?;
    Ok(Some(current))
}

pub fn mark(shared: &Shared, key: &str, id: &str, done: bool) -> Result<Saved, String> {
    let mut saved = load(shared, key).ok_or("no walkthrough")?;
    saved.done.retain(|d| d != id);
    if done {
        saved.done.push(id.to_string());
    }
    save(shared, key, &saved)?;
    Ok(saved)
}

pub fn set_route(shared: &Shared, key: &str, route: usize) -> Result<Saved, String> {
    let mut saved = load(shared, key).ok_or("no walkthrough")?;
    saved.route = route.min(saved.routes.len().saturating_sub(1));
    save(shared, key, &saved)?;
    Ok(saved)
}

pub fn clear(shared: &Shared, key: &str) -> Result<Saved, String> {
    let mut saved = load(shared, key).ok_or("no walkthrough")?;
    let route = saved.route;
    saved.done.retain(|d| !d.starts_with(&format!("{route}-")));
    save(shared, key, &saved)?;
    Ok(saved)
}
