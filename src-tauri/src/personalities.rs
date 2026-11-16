use serde::Serialize;
use serde_json::Value;

use crate::lang;

pub const DEFAULT: &str = "cheerful";
pub const CUSTOM: &str = "custom";
pub const PRESET: &str = "preset-";

#[derive(Serialize)]
pub struct Lines {
    pub start: Vec<String>,
    pub stop: Vec<String>,
    pub idle: Vec<String>,
    pub back: Vec<String>,
    pub section: Vec<String>,
    pub screenshot: Vec<String>,
    pub pokes: Vec<String>,
    pub chatter: Vec<String>,
    pub reading: Vec<String>,
}

fn personality(id: &str, language: &str) -> &'static Value {
    let all = &lang::data(language)["personalities"];
    let english = &lang::data("en")["personalities"];
    [&all[id], &english[id], &english[DEFAULT]]
        .into_iter()
        .find(|p| p.is_object())
        .unwrap_or(&english[DEFAULT])
}

pub fn lines(id: &str, language: &str) -> Lines {
    let own = personality(id, language);
    let english = personality(id, "en");
    let list = |key: &str| {
        let found = [&own[key], &english[key]].into_iter().map(listed).find(|lines| !lines.is_empty());
        found.unwrap_or_default()
    };

    Lines {
        start: list("start"),
        stop: list("stop"),
        idle: list("idle"),
        back: list("back"),
        section: list("section"),
        screenshot: list("screenshot"),
        pokes: list("pokes"),
        chatter: list("chatter"),
        reading: list("reading"),
    }
}

fn listed(value: &Value) -> Vec<String> {
    let lines: Vec<&str> = match value {
        Value::String(text) => vec![text.as_str()],
        Value::Array(items) => items.iter().filter_map(Value::as_str).collect(),
        _ => Vec::new(),
    };
    lines.into_iter().map(str::trim).filter(|t| !t.is_empty()).map(String::from).collect()
}

pub fn custom(mut base: Lines, own: &Value) -> Lines {
    for (key, lines) in [
        ("start", &mut base.start),
        ("stop", &mut base.stop),
        ("idle", &mut base.idle),
        ("back", &mut base.back),
        ("section", &mut base.section),
        ("screenshot", &mut base.screenshot),
        ("pokes", &mut base.pokes),
        ("chatter", &mut base.chatter),
        ("reading", &mut base.reading),
    ] {
        let own = listed(&own[key]);
        if !own.is_empty() {
            *lines = own;
        }
    }
    base
}

pub fn exists(id: &str) -> bool {
    id == CUSTOM || lang::data("en")["personalities"].get(id).is_some()
}

#[derive(Serialize)]
pub struct Choice {
    id: &'static str,
    name: &'static str,
}

pub fn choices(language: &str) -> Vec<Choice> {
    let english = lang::data("en")["personalities"].as_object();
    english
        .into_iter()
        .flatten()
        .map(|(id, _)| Choice {
            id: id.as_str(),
            name: personality(id, language)["name"].as_str().unwrap_or(id),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_language_has_every_personality() {
        for language in lang::list().iter().map(|l| serde_json::to_value(l).unwrap()) {
            let code = language["code"].as_str().unwrap().to_string();
            for choice in choices("en") {
                let own = &lang::data(&code)["personalities"][choice.id];
                assert!(own.is_object(), "{code}: {}", choice.id);
                let lines = lines(choice.id, &code);
                assert!(lines.start.iter().all(|l| l.contains("{name}")), "{code} {} start", choice.id);
                assert!(lines.section.iter().all(|l| l.contains("{section}")), "{code} {} section", choice.id);
                assert_eq!(lines.pokes.len(), 3, "{code} {} pokes", choice.id);
                assert_eq!(lines.chatter.len(), 3, "{code} {} chatter", choice.id);
                assert_eq!(lines.reading.len(), 3, "{code} {} reading", choice.id);
                assert!(lines.reading.iter().all(|l| l.contains("{name}") || l.contains("{total}") || l.contains("{session}")));
                for line in [&lines.stop, &lines.idle, &lines.back, &lines.screenshot] {
                    assert!(!line.is_empty() && line.iter().all(|l| !l.is_empty()), "{code} {}", choice.id);
                }
            }
        }
    }

    #[test]
    fn custom_lines_fall_back_when_empty() {
        let own = serde_json::json!({"start": " Hi {name} ", "stop": "", "idle": ["x", "", "y"], "pokes": ["a", " ", "b"], "chatter": []});
        let lines = custom(lines(DEFAULT, "en"), &own);
        assert_eq!(lines.start, ["Hi {name}"]);
        assert_eq!(lines.idle, ["x", "y"]);
        assert_eq!(lines.stop, super::lines(DEFAULT, "en").stop);
        assert_eq!(lines.pokes, ["a", "b"]);
        assert_eq!(lines.chatter, super::lines(DEFAULT, "en").chatter);
    }
}
