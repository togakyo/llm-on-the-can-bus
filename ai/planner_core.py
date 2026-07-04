"""planner_core.py — モデル非依存のロジック（プロンプト生成 / JSON抽出 / 正規化 / 規則フォールバック）。

torch/transformers を import しないので、モデル無しでも単体テストできる。
JS 側の docs/src/planner.js の DSL 契約・正規化と対になる実装。
"""
from __future__ import annotations
import json
import re
from typing import Any

ZONE_IDS = [
    "footwell_fl", "footwell_fr", "door_fl", "door_fr",
    "dashboard", "console", "cupholder",
]
VALID_EFFECTS = {"static", "breathe", "pulse", "wipe", "flash", "rainbow"}

COLORS = {
    "red": (255, 40, 40), "赤": (255, 40, 40),
    "blue": (40, 90, 255), "青": (40, 90, 255),
    "green": (40, 220, 90), "緑": (40, 220, 90),
    "white": (255, 245, 230), "白": (255, 245, 230),
    "purple": (170, 60, 255), "紫": (170, 60, 255),
    "pink": (255, 80, 180), "ピンク": (255, 80, 180),
    "orange": (255, 130, 20), "オレンジ": (255, 130, 20),
    "amber": (255, 170, 30), "アンバー": (255, 170, 30), "琥珀": (255, 170, 30),
    "yellow": (255, 220, 40), "黄": (255, 220, 40),
    "cyan": (40, 220, 235), "シアン": (40, 220, 235), "水色": (40, 220, 235),
}

DSL_SCHEMA_HINT = {
    "title": "string",
    "durationMs": "200-30000",
    "endState": "hold|off",
    "actions": [{
        "zones": "'all' or subset of " + str(ZONE_IDS),
        "color": {"r": "0-255", "g": "0-255", "b": "0-255"},
        "brightness": "0-100",
        "effect": "static|breathe|pulse|wipe|flash|rainbow",
        "hz": "0-8",
        "startMs": "0+",
    }],
}

SYSTEM_PROMPT = (
    "You are an in-car ambient lighting control planner. "
    "Convert the user's intent into a lighting program as STRICT JSON matching this schema:\n"
    + json.dumps(DSL_SCHEMA_HINT, ensure_ascii=False)
    + "\nRules: only ambient lighting (color/brightness/effect/zone). "
    "Never output CAN IDs or raw bytes. "
    f"Allowed zones: {', '.join(ZONE_IDS)}. "
    "Reply with JSON only, no prose, no markdown fences."
)

# 小型モデルを誘導するための few-shot
FEWSHOT = [
    (
        "ドアを開けたら足元とドアを白くゆっくり点灯",
        {
            "title": "welcome",
            "durationMs": 12000,
            "endState": "hold",
            "actions": [{
                "zones": ["footwell_fl", "footwell_fr", "door_fl", "door_fr"],
                "color": {"r": 255, "g": 245, "b": 230},
                "brightness": 70, "effect": "breathe", "hz": 0.4, "startMs": 0,
            }],
        },
    ),
    (
        "全部レインボーで流れるように",
        {
            "title": "party",
            "durationMs": 12000,
            "endState": "hold",
            "actions": [{
                "zones": "all",
                "color": {"r": 255, "g": 80, "b": 180},
                "brightness": 80, "effect": "rainbow", "hz": 1.0, "startMs": 0,
            }],
        },
    ),
]


def build_messages(intent: str) -> list[dict]:
    msgs = [{"role": "system", "content": SYSTEM_PROMPT}]
    for user, dsl in FEWSHOT:
        msgs.append({"role": "user", "content": user})
        msgs.append({"role": "assistant", "content": json.dumps(dsl, ensure_ascii=False)})
    msgs.append({"role": "user", "content": intent})
    return msgs


def extract_json(text: str) -> dict | None:
    """モデル出力から最初のバランスした {...} を取り出して parse する。"""
    if not text:
        return None
    start = text.find("{")
    while start != -1:
        depth = 0
        in_str = False
        esc = False
        for i in range(start, len(text)):
            c = text[i]
            if in_str:
                if esc:
                    esc = False
                elif c == "\\":
                    esc = True
                elif c == '"':
                    in_str = False
            else:
                if c == '"':
                    in_str = True
                elif c == "{":
                    depth += 1
                elif c == "}":
                    depth -= 1
                    if depth == 0:
                        try:
                            return json.loads(text[start:i + 1])
                        except json.JSONDecodeError:
                            break
        start = text.find("{", start + 1)
    return None


def _clamp_int(v: Any, lo: int, hi: int, default: int) -> int:
    try:
        n = int(round(float(v)))
    except (TypeError, ValueError):
        return default
    return max(lo, min(hi, n))


def _clamp_num(v: Any, lo: float, hi: float, default: float) -> float:
    try:
        n = float(v)
    except (TypeError, ValueError):
        return default
    return max(lo, min(hi, n))


def _norm_color(c: Any) -> dict:
    if isinstance(c, str):
        rgb = COLORS.get(c.lower()) or COLORS.get(c) or COLORS["amber"]
        return {"r": rgb[0], "g": rgb[1], "b": rgb[2]}
    if isinstance(c, dict):
        return {
            "r": _clamp_int(c.get("r"), 0, 255, 255),
            "g": _clamp_int(c.get("g"), 0, 255, 170),
            "b": _clamp_int(c.get("b"), 0, 255, 30),
        }
    return {"r": 255, "g": 170, "b": 30}


def _norm_action(a: Any) -> dict | None:
    if not isinstance(a, dict):
        return None
    zones = a.get("zones")
    if zones == "all":
        z = "all"
    elif isinstance(zones, list):
        z = [x for x in zones if x in ZONE_IDS] or "all"
    else:
        z = "all"
    effect = a.get("effect")
    return {
        "zones": z,
        "color": _norm_color(a.get("color")),
        "brightness": _clamp_int(a.get("brightness"), 0, 100, 70),
        "effect": effect if effect in VALID_EFFECTS else "breathe",
        "hz": _clamp_num(a.get("hz"), 0, 8, 0.5),
        "startMs": _clamp_int(a.get("startMs"), 0, 30000, 0),
    }


def normalize_dsl(raw: Any) -> dict:
    """信頼できない入力を安全な DSL に矯正（JS の normalizeDsl と対）。"""
    r = raw if isinstance(raw, dict) else {}
    actions = [x for x in (map(_norm_action, r.get("actions", []))) if x] \
        if isinstance(r.get("actions"), list) else []
    if not actions:
        actions = [{"zones": "all", "color": {"r": 255, "g": 170, "b": 30},
                    "brightness": 60, "effect": "breathe", "hz": 0.5, "startMs": 0}]
    any_flash = any(a["effect"] == "flash" for a in actions)
    end = r.get("endState")
    return {
        "title": str(r.get("title", "ambient"))[:60],
        "rationale": str(r.get("rationale", "")),
        "durationMs": _clamp_int(r.get("durationMs"), 200, 30000, 6000 if any_flash else 12000),
        "endState": "off" if end == "off" else ("off" if any_flash else "hold"),
        "actions": actions,
    }


# ---- 規則ベースのフォールバック（モデル出力が使えない場合）----------------
def heuristic_dsl(intent: str) -> dict:
    t = intent or ""
    color = next((rgb for w, rgb in COLORS.items() if w in t), COLORS["amber"])
    effect = "breathe"
    for pat, name in [
        (r"虹|レインボー|rainbow|カラフル", "rainbow"),
        (r"点滅|フラッシュ|flash|blink", "flash"),
        (r"パルス|pulse|鼓動", "pulse"),
        (r"流れ|ウェーブ|wipe|sweep", "wipe"),
        (r"点灯|つけ|static", "static"),
    ]:
        if re.search(pat, t, re.I):
            effect = name
            break
    zones: Any = []
    for pat, zs in [
        (r"足元|footwell", ["footwell_fl", "footwell_fr"]),
        (r"ドア|door", ["door_fl", "door_fr"]),
        (r"ダッシュ|dash", ["dashboard"]),
        (r"コンソール|console", ["console"]),
        (r"カップ|cup", ["cupholder"]),
    ]:
        if re.search(pat, t, re.I):
            zones += zs
    if re.search(r"全部|ぜんぶ|すべて|全体|all", t, re.I) or not zones:
        zones = "all"
    hz = 4 if re.search(r"速く|はやく|fast", t, re.I) else (0.4 if re.search(r"ゆっくり|slow", t, re.I) else 0.6)
    return normalize_dsl({
        "title": (t[:16] or "ambient"),
        "rationale": "rule-based fallback",
        "durationMs": 6000 if effect == "flash" else 12000,
        "endState": "off" if effect == "flash" else "hold",
        "actions": [{
            "zones": zones,
            "color": {"r": color[0], "g": color[1], "b": color[2]},
            "brightness": 90 if effect == "flash" else 70,
            "effect": effect, "hz": hz, "startMs": 0,
        }],
    })
