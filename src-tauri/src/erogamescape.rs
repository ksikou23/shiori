use std::sync::LazyLock;
use std::time::Duration;

use fancy_regex::Regex;
use serde::Serialize;

const SEARCH_URL: &str = "https://erogamescape.dyndns.org/~ap2/ero/toukei_kaiseki/kensaku.php";

static GAME_LINK: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?is)<a\b[^>]*href=["'][^"']*game\.php\?game=(\d+)[^"']*["'][^>]*>(.*?)</a>"#)
        .unwrap()
});
static TABLE_ROW: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?is)<tr\b[^>]*>(.*?)</tr>").unwrap());
static BRAND_LINK: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?is)<a\b[^>]*href=["'][^"']*brand\.php\?brand=\d+[^"']*["'][^>]*>(.*?)</a>"#)
        .unwrap()
});
static GAME_LABEL: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?is)^\s*((?:<span\b[^>]*>.*?</span>\s*)+)").unwrap());
static RELEASE_DATE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\b\d{4}-\d{2}-\d{2}\b").unwrap());
static HTML_TAG: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?s)<[^>]*>").unwrap());

#[derive(Debug, Serialize)]
pub struct GameResult {
    pub id: String,
    pub title: String,
    pub brand: String,
    pub release_date: String,
    pub label: String,
}

pub fn search(query: &str) -> Result<Vec<GameResult>, String> {
    let query = query.trim();
    if query.is_empty() {
        return Ok(Vec::new());
    }

    let client = reqwest::blocking::Client::builder()
        .user_agent(concat!(
            "ShioriRPC/",
            env!("CARGO_PKG_VERSION"),
            " (+https://github.com/ksikou23/shiori)"
        ))
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|error| error.to_string())?;
    let mut url = reqwest::Url::parse(SEARCH_URL).map_err(|error| error.to_string())?;
    url.query_pairs_mut()
        .append_pair("mode", "normal")
        .append_pair("category", "game")
        .append_pair("word_category", "name")
        .append_pair("word", query);
    let html = client
        .get(url)
        .send()
        .and_then(reqwest::blocking::Response::error_for_status)
        .map_err(|error| format!("ErogameScape search failed: {error}"))?
        .text()
        .map_err(|error| format!("couldn't read ErogameScape search results: {error}"))?;

    parse_results(&html)
}

fn parse_results(html: &str) -> Result<Vec<GameResult>, String> {
    let mut results = Vec::new();
    for row_captures in TABLE_ROW.captures_iter(html) {
        let row_captures = row_captures.map_err(|error| error.to_string())?;
        let Some(row) = row_captures.get(1).map(|capture| capture.as_str()) else {
            continue;
        };
        let Some(captures) = GAME_LINK.captures(row).map_err(|error| error.to_string())? else {
            continue;
        };
        let Some(game_link) = captures.get(0) else {
            continue;
        };
        let id = captures
            .get(1)
            .map(|capture| capture.as_str())
            .unwrap_or("");
        let title = clean_text(
            captures
                .get(2)
                .map(|capture| capture.as_str())
                .unwrap_or(""),
        );
        if title.is_empty() || results.iter().any(|result: &GameResult| result.id == id) {
            continue;
        }
        let brand = BRAND_LINK
            .captures(row)
            .map_err(|error| error.to_string())?
            .and_then(|captures| captures.get(1).map(|capture| clean_text(capture.as_str())))
            .unwrap_or_default();
        let release_date = RELEASE_DATE
            .find(row)
            .map_err(|error| error.to_string())?
            .map(|date| date.as_str().to_string())
            .unwrap_or_default();
        let label = GAME_LABEL
            .captures(&row[game_link.end()..])
            .map_err(|error| error.to_string())?
            .and_then(|captures| captures.get(1).map(|capture| clean_text(capture.as_str())))
            .unwrap_or_default();
        results.push(GameResult {
            id: id.to_string(),
            title,
            brand,
            release_date,
            label,
        });
        if results.len() == 50 {
            break;
        }
    }

    Ok(results)
}

fn clean_text(html: &str) -> String {
    HTML_TAG
        .replace_all(html, " ")
        .replace("&amp;", "&")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use super::parse_results;

    #[test]
    fn parses_game_results_with_disambiguating_details() {
        let html = r#"
            <tr>
              <td><a href="game.php?game=123#ad" class="tooltip">Game <span>One</span></a><span style="font-weight:bold;">(PS3)</span></td>
              <td><a href="brand.php?brand=7">Studio</a></td><td>2001-02-03</td>
            </tr>
            <tr>
              <td><a href="game.php?game=456#ad">Game &amp; Two</a></td>
              <td><a href="brand.php?brand=8">Other Studio</a></td><td>2004-05-06</td>
            </tr>
        "#;
        let results = parse_results(html).unwrap();
        assert_eq!(results.len(), 2);
        assert_eq!(results[0].id, "123");
        assert_eq!(results[0].title, "Game One");
        assert_eq!(results[0].brand, "Studio");
        assert_eq!(results[0].release_date, "2001-02-03");
        assert_eq!(results[0].label, "(PS3)");
        assert_eq!(results[1].title, "Game & Two");
        assert!(results[1].label.is_empty());
    }

    #[test]
    fn preserves_non_platform_game_labels() {
        let html = r#"
            <tr>
              <td><a href="game.php?game=789#ad">Game</a><span>(非18禁)</span></td>
              <td><a href="brand.php?brand=9">Studio</a></td><td>2010-01-02</td>
            </tr>
        "#;
        let results = parse_results(html).unwrap();
        assert_eq!(results[0].label, "(非18禁)");
    }
}
