"""planner_server.py — 自分のPCで動く軽量LLMプランナーのHTTPサーバ。

Hugging Face から軽量モデル（既定: Qwen/Qwen2.5-0.5B-Instruct, Apache-2.0, CPU可）を
ダウンロード＆ロードし、意図(自然言語)から照明DSL(JSON)を生成して返す。

  POST /plan  {"intent": "..."} -> {"dsl": {...}, "source": "llm"|"fallback", "model": "..."}
  GET  /health                  -> {"status": "ok", "model": "...", "device": "..."}

モデル出力は信頼しない: 抽出したJSONは normalize_dsl() で矯正し、さらにブラウザ側の
コンパイラ＋安全審査を必ず通る。JSON抽出に失敗したら規則ベースへフォールバック。

使い方:
  pip install -r ai/requirements.txt
  python ai/planner_server.py                 # 既定モデルをDLして起動(:8000)
  python ai/planner_server.py --mock          # モデルを読まず規則ベースだけで起動(動作確認用)
  python ai/planner_server.py --model Qwen/Qwen2.5-1.5B-Instruct --port 8000
"""
from __future__ import annotations
import argparse
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from planner_core import (
    build_messages, extract_json, normalize_dsl, heuristic_dsl,
)

_STATE = {"model_name": None, "device": "cpu", "tok": None, "model": None, "mock": True}


def pick_device():
    import torch
    if torch.cuda.is_available():
        return "cuda"
    if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
        return "mps"
    return "cpu"


def load_model(model_name: str):
    """初回のみモデルをロード（Hugging Face から自動ダウンロード）。"""
    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer

    device = pick_device()
    dtype = torch.float16 if device in ("cuda", "mps") else torch.float32
    print(f"[planner] loading {model_name} on {device} ({dtype}) …", flush=True)
    tok = AutoTokenizer.from_pretrained(model_name)
    model = AutoModelForCausalLM.from_pretrained(model_name, torch_dtype=dtype)
    model.to(device)
    model.eval()
    _STATE.update(model_name=model_name, device=device, tok=tok, model=model, mock=False)
    print("[planner] model ready", flush=True)


def generate_with_model(intent: str) -> tuple[dict, str]:
    """モデルでDSLを生成。抽出/parse に失敗したら規則ベースへ。"""
    import torch

    tok, model = _STATE["tok"], _STATE["model"]
    messages = build_messages(intent)
    inputs = tok.apply_chat_template(
        messages, add_generation_prompt=True, return_tensors="pt",
    ).to(_STATE["device"])
    with torch.no_grad():
        out = model.generate(
            inputs, max_new_tokens=320, do_sample=False,
            temperature=None, top_p=None, top_k=None,
            pad_token_id=tok.eos_token_id,
        )
    text = tok.decode(out[0][inputs.shape[1]:], skip_special_tokens=True)
    parsed = extract_json(text)
    if parsed is None:
        return heuristic_dsl(intent), "fallback"
    return normalize_dsl(parsed), "llm"


def plan(intent: str) -> dict:
    if _STATE["mock"] or _STATE["model"] is None:
        return {"dsl": heuristic_dsl(intent), "source": "fallback",
                "model": _STATE["model_name"] or "rule-based"}
    try:
        dsl, source = generate_with_model(intent)
    except Exception as e:  # 生成失敗時も必ず何か返す（フェイルセーフ）
        print(f"[planner] generation error: {e}", flush=True)
        dsl, source = heuristic_dsl(intent), "fallback"
    return {"dsl": dsl, "source": source, "model": _STATE["model_name"]}


class Handler(BaseHTTPRequestHandler):
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def _json(self, code: int, payload: dict):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        if self.path.startswith("/health"):
            self._json(200, {"status": "ok", "model": _STATE["model_name"] or "rule-based",
                             "device": _STATE["device"], "mock": _STATE["mock"]})
        else:
            self._json(404, {"error": "not found"})

    def do_POST(self):
        if not self.path.startswith("/plan"):
            self._json(404, {"error": "not found"})
            return
        try:
            length = int(self.headers.get("Content-Length", 0))
            data = json.loads(self.rfile.read(length) or b"{}")
            intent = str(data.get("intent", ""))
        except (ValueError, json.JSONDecodeError):
            self._json(400, {"error": "invalid json"})
            return
        self._json(200, plan(intent))

    def log_message(self, *args):  # 静かに
        pass


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="Qwen/Qwen2.5-0.5B-Instruct")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--mock", action="store_true", help="モデルを読み込まず規則ベースのみで起動")
    args = ap.parse_args()

    if args.mock:
        _STATE.update(model_name="mock", mock=True)
        print("[planner] --mock: 規則ベースのみで起動（モデル未使用）", flush=True)
    else:
        load_model(args.model)

    srv = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"[planner] listening on http://{args.host}:{args.port}  (POST /plan, GET /health)", flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\n[planner] bye")


if __name__ == "__main__":
    main()
