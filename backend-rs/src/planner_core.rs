//! planner_core — モデル非依存のロジック（プロンプト生成 / JSON抽出 / 正規化 / 規則フォールバック）。
//!
//! ML クレートを一切使わないので単体テスト可能。JS 側 docs/src/planner.js /
//! Python 側 ai/planner_core.py と対になる DSL 契約・正規化を Rust で再実装したもの。

use serde_json::{json, Value};

pub const ZONE_IDS: [&str; 7] = [
    "footwell_fl", "footwell_fr", "door_fl", "door_fr", "dashboard", "console", "cupholder",
];
const VALID_EFFECTS: [&str; 6] = ["static", "breathe", "pulse", "wipe", "flash", "rainbow"];

/// 色名 → RGB。日本語・英語の両方に対応。
fn color_lookup(name: &str) -> Option<(i64, i64, i64)> {
    let n = name.to_lowercase();
    const MAP: &[(&str, (i64, i64, i64))] = &[
        ("red", (255, 40, 40)), ("赤", (255, 40, 40)),
        ("blue", (40, 90, 255)), ("青", (40, 90, 255)),
        ("green", (40, 220, 90)), ("緑", (40, 220, 90)),
        ("white", (255, 245, 230)), ("白", (255, 245, 230)),
        ("purple", (170, 60, 255)), ("紫", (170, 60, 255)),
        ("pink", (255, 80, 180)), ("ピンク", (255, 80, 180)),
        ("orange", (255, 130, 20)), ("オレンジ", (255, 130, 20)),
        ("amber", (255, 170, 30)), ("アンバー", (255, 170, 30)), ("琥珀", (255, 170, 30)),
        ("yellow", (255, 220, 40)), ("黄", (255, 220, 40)),
        ("cyan", (40, 220, 235)), ("シアン", (40, 220, 235)), ("水色", (40, 220, 235)),
    ];
    MAP.iter()
        .find(|(k, _)| *k == name || *k == n.as_str())
        .map(|(_, v)| *v)
}

const AMBER: (i64, i64, i64) = (255, 170, 30);

/// モデルに渡すシステムプロンプト（DSLスキーマ + 制約）。
#[allow(dead_code)] // llm feature でのみ使用
pub fn system_prompt() -> String {
    format!(
        "You are an in-car ambient lighting control planner. \
Convert the user's intent into a lighting program as STRICT JSON with keys: \
title(string), durationMs(200-30000), endState('hold'|'off'), \
actions[{{ zones('all' or subset of [{zones}]), color{{r,g,b:0-255}}, \
brightness(0-100), effect('static'|'breathe'|'pulse'|'wipe'|'flash'|'rainbow'), hz(0-8), startMs }}]. \
Rules: only ambient lighting; never output CAN IDs or raw bytes. \
Reply with JSON only, no prose, no markdown fences.",
        zones = ZONE_IDS.join(", ")
    )
}

/// few-shot（小型モデルの誘導用）。(user, assistant_json) の列。
#[allow(dead_code)] // llm feature でのみ使用
pub fn fewshot() -> Vec<(String, String)> {
    let welcome = json!({
        "title":"welcome","durationMs":12000,"endState":"hold",
        "actions":[{"zones":["footwell_fl","footwell_fr","door_fl","door_fr"],
            "color":{"r":255,"g":245,"b":230},"brightness":70,"effect":"breathe","hz":0.4,"startMs":0}]
    });
    let party = json!({
        "title":"party","durationMs":12000,"endState":"hold",
        "actions":[{"zones":"all","color":{"r":255,"g":80,"b":180},
            "brightness":80,"effect":"rainbow","hz":1.0,"startMs":0}]
    });
    vec![
        ("ドアを開けたら足元とドアを白くゆっくり点灯".into(), welcome.to_string()),
        ("全部レインボーで流れるように".into(), party.to_string()),
    ]
}

/// モデル出力から最初のバランスした {...} を取り出して parse する。
/// 構造文字( {} " \ )はすべてASCIIなのでバイト走査で安全（日本語=多バイトは誤検出しない）。
#[allow(dead_code)] // llm feature でのみ使用
pub fn extract_json(text: &str) -> Option<Value> {
    let bytes = text.as_bytes();
    let mut search_from = 0usize;
    while let Some(rel) = text[search_from..].find('{') {
        let start = search_from + rel;
        let mut depth = 0i32;
        let mut in_str = false;
        let mut esc = false;
        for i in start..bytes.len() {
            let c = bytes[i];
            if in_str {
                if esc {
                    esc = false;
                } else if c == b'\\' {
                    esc = true;
                } else if c == b'"' {
                    in_str = false;
                }
            } else {
                match c {
                    b'"' => in_str = true,
                    b'{' => depth += 1,
                    b'}' => {
                        depth -= 1;
                        if depth == 0 {
                            if let Ok(v) = serde_json::from_str::<Value>(&text[start..=i]) {
                                return Some(v);
                            }
                            break;
                        }
                    }
                    _ => {}
                }
            }
        }
        search_from = start + 1;
    }
    None
}

fn clamp_i(v: &Value, lo: i64, hi: i64, default: i64) -> i64 {
    let n = match v {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.trim().parse::<f64>().ok(),
        _ => None,
    };
    match n {
        Some(x) if x.is_finite() => (x.round() as i64).clamp(lo, hi),
        _ => default,
    }
}

fn clamp_f(v: &Value, lo: f64, hi: f64, default: f64) -> f64 {
    let n = match v {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.trim().parse::<f64>().ok(),
        _ => None,
    };
    match n {
        Some(x) if x.is_finite() => x.clamp(lo, hi),
        _ => default,
    }
}

fn norm_color(c: &Value) -> Value {
    if let Some(s) = c.as_str() {
        let (r, g, b) = color_lookup(s).unwrap_or(AMBER);
        return json!({"r": r, "g": g, "b": b});
    }
    if c.is_object() {
        return json!({
            "r": clamp_i(&c["r"], 0, 255, 255),
            "g": clamp_i(&c["g"], 0, 255, 170),
            "b": clamp_i(&c["b"], 0, 255, 30),
        });
    }
    json!({"r": AMBER.0, "g": AMBER.1, "b": AMBER.2})
}

fn norm_action(a: &Value) -> Option<Value> {
    if !a.is_object() {
        return None;
    }
    let zones = match &a["zones"] {
        Value::String(s) if s == "all" => json!("all"),
        Value::Array(arr) => {
            let kept: Vec<Value> = arr
                .iter()
                .filter(|z| z.as_str().map_or(false, |s| ZONE_IDS.contains(&s)))
                .cloned()
                .collect();
            if kept.is_empty() { json!("all") } else { Value::Array(kept) }
        }
        _ => json!("all"),
    };
    let effect = a["effect"].as_str().filter(|e| VALID_EFFECTS.contains(e)).unwrap_or("breathe");
    Some(json!({
        "zones": zones,
        "color": norm_color(&a["color"]),
        "brightness": clamp_i(&a["brightness"], 0, 100, 70),
        "effect": effect,
        "hz": clamp_f(&a["hz"], 0.0, 8.0, 0.5),
        "startMs": clamp_i(&a["startMs"], 0, 30000, 0),
    }))
}

/// 信頼できない入力(LLM出力)を安全な DSL へ矯正。ここで失敗しない＝後段が必ず動く。
pub fn normalize_dsl(raw: &Value) -> Value {
    let empty = vec![];
    let actions_in = raw.get("actions").and_then(Value::as_array).unwrap_or(&empty);
    let mut actions: Vec<Value> = actions_in.iter().filter_map(norm_action).collect();
    if actions.is_empty() {
        actions.push(json!({
            "zones":"all","color":{"r":255,"g":170,"b":30},
            "brightness":60,"effect":"breathe","hz":0.5,"startMs":0
        }));
    }
    let any_flash = actions.iter().any(|a| a["effect"] == "flash");
    let end = if raw.get("endState").and_then(Value::as_str) == Some("off") || any_flash {
        "off"
    } else {
        "hold"
    };
    let title = raw.get("title").and_then(Value::as_str).unwrap_or("ambient");
    let title: String = title.chars().take(60).collect();
    json!({
        "title": title,
        "rationale": raw.get("rationale").and_then(Value::as_str).unwrap_or(""),
        "durationMs": clamp_i(raw.get("durationMs").unwrap_or(&Value::Null), 200, 30000, if any_flash {6000} else {12000}),
        "endState": end,
        "actions": actions,
    })
}

/// 規則ベースのフォールバック（モデル出力が使えない/未使用のとき）。
pub fn heuristic_dsl(intent: &str) -> Value {
    let t = intent;
    let color = ["red","赤","blue","青","green","緑","white","白","purple","紫","pink","ピンク",
        "orange","オレンジ","amber","アンバー","yellow","黄","cyan","シアン","水色"]
        .iter()
        .find(|w| t.contains(**w))
        .and_then(|w| color_lookup(w))
        .unwrap_or(AMBER);

    let effect = if has_any(t, &["虹", "レインボー", "rainbow", "カラフル"]) { "rainbow" }
        else if has_any(t, &["点滅", "フラッシュ", "flash", "blink"]) { "flash" }
        else if has_any(t, &["パルス", "pulse", "鼓動"]) { "pulse" }
        else if has_any(t, &["流れ", "ウェーブ", "wipe", "sweep"]) { "wipe" }
        else if has_any(t, &["点灯", "つけ", "static"]) { "static" }
        else { "breathe" };

    let mut zones: Vec<&str> = vec![];
    if has_any(t, &["足元", "footwell"]) { zones.extend(["footwell_fl", "footwell_fr"]); }
    if has_any(t, &["ドア", "door"]) { zones.extend(["door_fl", "door_fr"]); }
    if has_any(t, &["ダッシュ", "dash"]) { zones.push("dashboard"); }
    if has_any(t, &["コンソール", "console"]) { zones.push("console"); }
    if has_any(t, &["カップ", "cup"]) { zones.push("cupholder"); }
    let zones_val = if has_any(t, &["全部", "ぜんぶ", "すべて", "全体", "all"]) || zones.is_empty() {
        json!("all")
    } else {
        json!(zones)
    };

    let hz = if has_any(t, &["速く", "はやく", "fast"]) { 4.0 }
        else if has_any(t, &["ゆっくり", "slow"]) { 0.4 }
        else { 0.6 };

    normalize_dsl(&json!({
        "title": t.chars().take(16).collect::<String>(),
        "rationale": "rule-based fallback",
        "durationMs": if effect == "flash" { 6000 } else { 12000 },
        "endState": if effect == "flash" { "off" } else { "hold" },
        "actions": [{
            "zones": zones_val,
            "color": {"r": color.0, "g": color.1, "b": color.2},
            "brightness": if effect == "flash" { 90 } else { 70 },
            "effect": effect, "hz": hz, "startMs": 0
        }]
    }))
}

fn has_any(t: &str, words: &[&str]) -> bool {
    words.iter().any(|w| t.contains(w))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_from_noise() {
        let raw = "ok:\n```json\n{\"title\":\"x\",\"actions\":[]}\n```\nbye";
        assert_eq!(extract_json(raw).unwrap()["title"], "x");
    }

    #[test]
    fn extract_none_on_garbage() {
        assert!(extract_json("no json here").is_none());
    }

    #[test]
    fn normalize_drops_unknown_zone_and_clamps() {
        let n = normalize_dsl(&json!({"actions":[{
            "zones":["footwell_fl","bogus"],"color":"cyan",
            "brightness":300,"effect":"strobe","hz":99,"startMs":-5
        }]}));
        let a = &n["actions"][0];
        assert_eq!(a["zones"], json!(["footwell_fl"]));
        assert_eq!(a["brightness"], 100);
        assert_eq!(a["effect"], "breathe");
        assert_eq!(a["hz"], 8.0);
        assert_eq!(a["startMs"], 0);
        assert_eq!(a["color"], json!({"r":40,"g":220,"b":235}));
    }

    #[test]
    fn normalize_empty_gives_default() {
        let n = normalize_dsl(&json!({}));
        assert!(n["actions"].as_array().unwrap().len() >= 1);
        assert!(n["durationMs"].as_i64().unwrap() >= 200);
    }

    #[test]
    fn heuristic_flash_endstate_off() {
        let n = heuristic_dsl("全部を赤く速く点滅させて警告");
        assert_eq!(n["actions"][0]["effect"], "flash");
        assert_eq!(n["endState"], "off");
        assert_eq!(n["actions"][0]["color"], json!({"r":255,"g":40,"b":40}));
    }

    #[test]
    fn heuristic_zone_selection() {
        let n = heuristic_dsl("足元をシアンで点灯");
        let zones = n["actions"][0]["zones"].as_array().unwrap();
        assert_eq!(zones.len(), 2);
        assert!(zones.contains(&json!("footwell_fl")));
    }
}
