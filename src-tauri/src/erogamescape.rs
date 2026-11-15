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
static INPUT_TAG: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?is)<input\b([^>]*)>").unwrap());
static ATTRIBUTE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?is)([a-z_:][a-z0-9_:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))"#).unwrap()
});
static BRAND_ROW: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?is)<tr\b(?=[^>]*\bid=["']brand["'])[^>]*>(.*?)</tr>"#).unwrap()
});
static BRAND_ID: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?is)<a\b[^>]*href=["'][^"']*brand\.php\?brand=(\d+)[^"']*["']"#).unwrap()
});

#[derive(Debug, Serialize)]
pub struct GameResult {
    pub id: String,
    pub title: String,
    pub brand: String,
    pub release_date: String,
    pub label: String,
}

#[derive(Debug, Serialize)]
pub struct GameDetails {
    pub erogamescape_id: u64,
    pub erogamescape_name: String,
    pub erogamescape_furigana: String,
    pub erogamescape_brand_id: u64,
}

#[derive(Clone, Debug, serde::Deserialize, Serialize)]
pub struct BrandDetails {
    pub id: u64,
    pub name: String,
    pub furigana: String,
}

pub fn search(query: &str) -> Result<Vec<GameResult>, String> {
    let query = query.trim();
    if query.is_empty() {
        return Ok(Vec::new());
    }

    let client = http_client()?;
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

pub fn fetch_details(id: u64) -> Result<GameDetails, String> {
    if id == 0 {
        return Err("ErogameScape ID must be greater than zero".into());
    }

    let client = http_client()?;
    let game_page = fetch_page(
        &client,
        &format!("https://erogamescape.dyndns.org/~ap2/ero/toukei_kaiseki/game.php?game={id}"),
        "game",
    )?;
    let mod_page = fetch_page(
        &client,
        &format!("https://erogamescape.dyndns.org/~ap2/ero/toukei_kaiseki/mod_game.php?game={id}"),
        "game information",
    )?;

    parse_details(id, &game_page, &mod_page)
}

pub fn fetch_brand_details(id: u64) -> Result<BrandDetails, String> {
    if id == 0 {
        return Err("ErogameScape brand ID must be greater than zero".into());
    }

    let client = http_client()?;
    let page = fetch_page(
        &client,
        &format!(
            "https://erogamescape.dyndns.org/~ap2/ero/toukei_kaiseki/mod_brand.php?brand={id}"
        ),
        "brand information",
    )?;
    parse_brand_details(id, &page)
}

fn http_client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .user_agent(concat!(
            "ShioriRPC/",
            env!("CARGO_PKG_VERSION"),
            " (+https://github.com/ksikou23/shiori)"
        ))
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|error| error.to_string())
}

fn fetch_page(client: &reqwest::blocking::Client, url: &str, page: &str) -> Result<String, String> {
    client
        .get(url)
        .send()
        .and_then(reqwest::blocking::Response::error_for_status)
        .map_err(|error| format!("ErogameScape {page} page request failed: {error}"))?
        .text()
        .map_err(|error| format!("couldn't read ErogameScape {page} page: {error}"))
}

fn parse_details(id: u64, game_page: &str, mod_page: &str) -> Result<GameDetails, String> {
    let mod_id = input_value(mod_page, "game")
        .and_then(|value| value.parse::<u64>().ok())
        .ok_or_else(|| {
            "couldn't find the game ID on ErogameScape's information page".to_string()
        })?;
    if mod_id != id {
        return Err("ErogameScape returned information for a different game ID".into());
    }

    let name = input_value(mod_page, "gamename")
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            "couldn't find the game name on ErogameScape's information page".to_string()
        })?;
    let furigana = input_value(mod_page, "furigana")
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            "couldn't find the furigana on ErogameScape's information page".to_string()
        })?;
    let brand_id = BRAND_ROW
        .captures(game_page)
        .map_err(|error| error.to_string())?
        .and_then(|captures| captures.get(1).map(|capture| capture.as_str()))
        .and_then(|row| BRAND_ID.captures(row).ok().flatten())
        .and_then(|captures| {
            captures
                .get(1)
                .and_then(|capture| capture.as_str().parse().ok())
        })
        .ok_or_else(|| "couldn't find the brand ID on ErogameScape's game page".to_string())?;
    Ok(GameDetails {
        erogamescape_id: id,
        erogamescape_name: clean_text(&name),
        erogamescape_furigana: clean_text(&furigana),
        erogamescape_brand_id: brand_id,
    })
}

fn parse_brand_details(id: u64, page: &str) -> Result<BrandDetails, String> {
    let page_id = input_value(page, "brand")
        .and_then(|value| value.parse::<u64>().ok())
        .ok_or_else(|| "couldn't find the brand ID on ErogameScape's brand page".to_string())?;
    if page_id != id {
        return Err("ErogameScape returned information for a different brand ID".into());
    }

    let name = input_value(page, "brandname")
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "couldn't find the brand name on ErogameScape's brand page".to_string())?;
    let furigana = input_value(page, "brandfurigana").unwrap_or_default();
    Ok(BrandDetails {
        id,
        name: clean_text(&name),
        furigana: clean_text(&furigana),
    })
}

fn input_value(html: &str, name: &str) -> Option<String> {
    for input in INPUT_TAG.captures_iter(html).flatten() {
        let attributes = input.get(1)?.as_str();
        if attribute(attributes, "name").as_deref() == Some(name) {
            return attribute(attributes, "value").map(|value| decode_entities(&value));
        }
    }
    None
}

fn attribute(attributes: &str, name: &str) -> Option<String> {
    ATTRIBUTE
        .captures_iter(attributes)
        .flatten()
        .find(|capture| {
            capture
                .get(1)
                .is_some_and(|key| key.as_str().eq_ignore_ascii_case(name))
        })
        .and_then(|capture| {
            (2..=4).find_map(|index| capture.get(index).map(|value| value.as_str().to_string()))
        })
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
    let text = HTML_TAG.replace_all(html, " ");
    decode_entities(&text)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn decode_entities(text: &str) -> String {
    text.replace("&amp;", "&")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&#039;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
}

#[cfg(test)]
mod tests {
    use super::{parse_brand_details, parse_details, parse_results};

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

    #[test]
    fn parses_requested_game_details() {
        let game_page =
            r#"<tr id="brand"><td><a href="brand.php?brand=114">SAGA PLANETS</a></td></tr>"#;
        let mod_page = r#"
            <input name="game" value="15425">
            <input name="gamename" value="はつゆきさくら">
            <input name="furigana" value="ハツユキサクラ">
        "#;

        let details = parse_details(15425, game_page, mod_page).unwrap();
        assert_eq!(details.erogamescape_name, "はつゆきさくら");
        assert_eq!(details.erogamescape_furigana, "ハツユキサクラ");
        assert_eq!(details.erogamescape_brand_id, 114);
    }

    #[test]
    fn parses_requested_brand_details() {
        let page = r#"
            <input name="brand" value="1171">
            <input name="brandname" value="枕">
            <input name="brandfurigana" value="マクラ">
        "#;
        let brand = parse_brand_details(1171, page).unwrap();
        assert_eq!(brand.id, 1171);
        assert_eq!(brand.name, "枕");
        assert_eq!(brand.furigana, "マクラ");
    }

    #[test]
    fn refuses_brand_details_for_a_different_id() {
        let page = r#"
            <input name="brand" value="1171">
            <input name="brandname" value="枕">
        "#;
        assert!(parse_brand_details(1000, page).is_err());
    }

    #[test]
    fn refuses_details_for_a_different_game_id() {
        let mod_page = r#"
            <input name="game" value="456">
            <input name="gamename" value="Game">
        "#;
        assert!(parse_details(123, "", mod_page).is_err());
    }
}
