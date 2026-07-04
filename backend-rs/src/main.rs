//! planner-server (Rust) — AIプランナーのバックエンド。
//!
//! フロント(docs/src/planner.js の LlmPlanner)が叩く HTTP API をそのまま提供する
//! ドロップイン置換。Python版(ai/planner_server.py)と同じ契約:
//!
//!   POST /plan   {"intent":"..."} -> {"dsl":{...},"source":"llm"|"fallback","model":"..."}
//!   GET  /health                  -> {"status":"ok","model":"...","device":"..."}
//!
//! ベース(既定)は規則ベースのみで軽量。実LLM推論は `--features llm`(candleでQwen2実行)。

mod planner_core;
#[cfg(feature = "llm")]
mod model;

use serde_json::{json, Value};
use tiny_http::{Header, Method, Response, Server};

struct Args {
    model: String,
    host: String,
    port: u16,
    mock: bool,
}

fn parse_args() -> Args {
    let mut a = Args {
        model: "Qwen/Qwen2.5-0.5B-Instruct".to_string(),
        host: "127.0.0.1".to_string(),
        port: 8000,
        mock: false,
    };
    let mut it = std::env::args().skip(1);
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--model" => a.model = it.next().unwrap_or(a.model),
            "--host" => a.host = it.next().unwrap_or(a.host),
            "--port" => a.port = it.next().and_then(|p| p.parse().ok()).unwrap_or(a.port),
            "--mock" => a.mock = true,
            "-h" | "--help" => {
                println!("planner-server [--model ID] [--host H] [--port N] [--mock]");
                std::process::exit(0);
            }
            _ => {}
        }
    }
    a
}

/// バックエンド: モデル無し(規則ベース) or candleモデル。
enum Backend {
    Mock,
    #[cfg(feature = "llm")]
    Llm(model::QwenPlanner),
}

impl Backend {
    /// 返り値: (dsl, source, model_label)
    fn plan(&mut self, intent: &str) -> (Value, &'static str, String) {
        match self {
            Backend::Mock => (planner_core::heuristic_dsl(intent), "fallback", "rule-based".into()),
            #[cfg(feature = "llm")]
            Backend::Llm(m) => match m.generate(intent) {
                Ok(dsl) => (dsl, "llm", m.model_id.clone()),
                Err(e) => {
                    eprintln!("[planner] generation error: {e:#}");
                    (planner_core::heuristic_dsl(intent), "fallback", m.model_id.clone())
                }
            },
        }
    }

    fn model_label(&self) -> String {
        match self {
            Backend::Mock => "rule-based".into(),
            #[cfg(feature = "llm")]
            Backend::Llm(m) => m.model_id.clone(),
        }
    }

    fn device_label(&self) -> String {
        match self {
            Backend::Mock => "cpu".into(),
            #[cfg(feature = "llm")]
            Backend::Llm(m) => m.device_label.clone(),
        }
    }

    fn is_mock(&self) -> bool {
        matches!(self, Backend::Mock)
    }
}

fn cors_headers() -> Vec<Header> {
    vec![
        Header::from_bytes(&b"Access-Control-Allow-Origin"[..], &b"*"[..]).unwrap(),
        Header::from_bytes(&b"Access-Control-Allow-Methods"[..], &b"GET, POST, OPTIONS"[..]).unwrap(),
        Header::from_bytes(&b"Access-Control-Allow-Headers"[..], &b"Content-Type"[..]).unwrap(),
    ]
}

fn json_response(code: u16, payload: &Value) -> Response<std::io::Cursor<Vec<u8>>> {
    let body = payload.to_string().into_bytes();
    let mut resp = Response::from_data(body).with_status_code(code);
    resp.add_header(
        Header::from_bytes(&b"Content-Type"[..], &b"application/json; charset=utf-8"[..]).unwrap(),
    );
    for h in cors_headers() {
        resp.add_header(h);
    }
    resp
}

fn build_backend(args: &Args) -> Backend {
    #[cfg(feature = "llm")]
    {
        if args.mock {
            println!("[planner] --mock: 規則ベースのみで起動（モデル未使用）");
            return Backend::Mock;
        }
        println!("[planner] loading {} …", args.model);
        match model::QwenPlanner::load(&args.model) {
            Ok(m) => {
                println!("[planner] model ready on {}", m.device_label);
                return Backend::Llm(m);
            }
            Err(e) => {
                eprintln!("[planner] model load failed ({e:#}); 規則ベースにフォールバック");
                return Backend::Mock;
            }
        }
    }
    #[cfg(not(feature = "llm"))]
    {
        if !args.mock {
            println!("[planner] このビルドは 'llm' feature 無効（規則ベースのみ）。");
            println!("[planner] 実モデルを使うには: cargo run --release --features llm");
        }
        let _ = args;
        Backend::Mock
    }
}

fn main() {
    let args = parse_args();
    let mut backend = build_backend(&args);

    let addr = format!("{}:{}", args.host, args.port);
    let server = Server::http(&addr).unwrap_or_else(|e| {
        eprintln!("[planner] bind {addr} 失敗: {e}");
        std::process::exit(1);
    });
    println!("[planner] listening on http://{addr}  (POST /plan, GET /health)");

    for mut request in server.incoming_requests() {
        let method = request.method().clone();
        let url = request.url().to_string();

        // CORS preflight
        if method == Method::Options {
            let mut resp = Response::empty(204);
            for h in cors_headers() {
                resp.add_header(h);
            }
            let _ = request.respond(resp);
            continue;
        }

        if method == Method::Get && url.starts_with("/health") {
            let payload = json!({
                "status":"ok",
                "model": backend.model_label(),
                "device": backend.device_label(),
                "mock": backend.is_mock(),
            });
            let _ = request.respond(json_response(200, &payload));
            continue;
        }

        if method == Method::Post && url.starts_with("/plan") {
            let mut body = String::new();
            if request.as_reader().read_to_string(&mut body).is_err() {
                let _ = request.respond(json_response(400, &json!({"error":"read error"})));
                continue;
            }
            let intent = serde_json::from_str::<Value>(&body)
                .ok()
                .and_then(|v| v.get("intent").and_then(Value::as_str).map(str::to_string))
                .unwrap_or_default();
            let (dsl, source, model_label) = backend.plan(&intent);
            let payload = json!({"dsl": dsl, "source": source, "model": model_label});
            let _ = request.respond(json_response(200, &payload));
            continue;
        }

        let _ = request.respond(json_response(404, &json!({"error":"not found"})));
    }
}
