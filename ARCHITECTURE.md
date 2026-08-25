# Architecture

> [README](README.md) · [Safety policy](SAFETY.md)

The whole point of this project is that **an untrusted program generator can be given a real
actuator, provided the layer boundaries are drawn so that unsafe output cannot be expressed,
cannot be compiled, and cannot be transmitted.** This document describes how those boundaries
are drawn.

## Hexagonal / DDD layering

The simulation is a lightweight ports-and-adapters stack in plain ES modules — no build step,
no bundler, dependencies point inward only (`infrastructure/ui → application → domain`).

### `domain/` — pure, zero I/O, unit-testable in Node

| Module | Role |
|---|---|
| `safety.js` | ★ **Core domain.** The safety supervisor and the versioned *safety envelope*. Verdicts are returned as language-neutral `{ code, ...params }` data. |
| `program.js` | `LightingProgram` aggregate root + the DSL contract. `normalizeDsl()` is the **anti-corruption layer** for untrusted LLM output. |
| `compiler.js` | The trusted compiler. The only code in the system that knows CAN IDs. |
| `signals.js` | CAN signal catalog (a DBC in code): IDs, zones, effects, encode/decode, checksum. |
| `vehicle.js` | `VehicleState` value object. |
| `events.js` | Domain events + an in-process event bus. |
| `audit.js` | Append-only safety audit trail. |

`LightingProgram` has an explicit lifecycle — `generated → compiled → approved/rejected →
active → completed/aborted` — and illegal transitions throw rather than silently proceeding.

### `application/` — use-case orchestration

- `actuation-service.js` — the one use case: intent → plan → compile → review → dispatch.
- `runtime-monitor.js` — `RuntimeAssuranceMonitor`, a Simplex-style decision module (below).

### `infrastructure/` — swappable adapters

- `can.js` — virtual CAN bus (the seam where SocketCAN goes)
- `planners.js` — `HeuristicPlanner` (offline rules) and `LlmPlanner` (HTTP `:8000`)
- `ecu.js` — ambient-lighting ECU simulator

The UI (`app.js`, and the Unity client) is *also* just an adapter: an untrusted display.

## Run-time assurance (Simplex)

Reviewing a generated program once is not enough for a physical system, because the world keeps
changing while actuation is in flight. Two additional trusted checkpoints close that gap:

1. **TX gate** — every scheduled frame is re-inspected against the vehicle state *at the moment
   of transmission*. Approved while parked ≠ safe to send three seconds later while driving.
2. **Continuous re-assurance** — the monitor senses `VEHICLE_STATE` from the bus and, whenever
   it changes, re-inspects the lighting state currently **latched in the ECU**. Violations are
   clamped to a safe value, or the zone is switched off (fallback controller).

Sensing happens over the bus rather than by reading UI variables, so the same monitor keeps
working when `VirtualCanBus` is replaced with SocketCAN.

Every decision — generation, review verdicts, interventions, E-STOP — is published as a domain
event and recorded in an append-only audit trail stamped with the safety-envelope version.

## Localization boundary

The domain layer knows no human language. `inspectFrame()` returns reasons as
`{ code, zoneId, from, to }` structures; `docs/src/i18n.js` turns them into English or Japanese
prose at render time. That is why the demo's EN/JA toggle re-renders instantly without re-running
a single safety check — and why the audit trail can be pinned to English while the UI is Japanese.

<a id="backends"></a>
## Backends — Rust (default) or Python, same API

The frontend only speaks a two-endpoint HTTP contract, so the backend is swappable:

```
POST /plan    {"intent": "..."} → {"dsl": {...}, "source": "llm"|"fallback", "model": "..."}
GET  /health                    → {"status":"ok","model":"...","device":"cpu|mps|cuda"}
```

| Backend | Inference engine | Run |
|---|---|---|
| **Rust** (`backend-rs/`) | [candle](https://github.com/huggingface/candle) — native, no Python | `cd backend-rs && cargo run --release --features llm` |
| **Python** (`ai/`) | transformers / PyTorch | `python ai/planner_server.py` |

```bash
cd backend-rs && cargo run                      # rules only: fast build, no ML deps, no download
cargo run --release --features llm              # real model (downloads Qwen2.5-0.5B to the HF cache)
cargo run --release --features metal            # Apple Silicon GPU  (or --features cuda)
cargo test                                      # planner_core unit tests

pip install -r ai/requirements.txt
python ai/planner_server.py                     # downloads the model on first run, serves on :8000
python ai/planner_server.py --mock              # rule-based only, no download
cd ai && python -m unittest -q
```

Default model: `Qwen/Qwen2.5-0.5B-Instruct` (Apache-2.0, runs on CPU; auto-uses CUDA or Apple
Silicon MPS when present). Measured on Apple Silicon: ~60 s first load, then 1–6 s per generation.

Both backends share the same JSON contract, the same DSL normalization and the same rule-based
fallback, so the page behaves identically regardless of which one is listening on `:8000`.

## CAN signals — a single comfort-domain node

| ID | Message | Contents |
|---|---|---|
| `0x0C0` | `VEHICLE_STATE` | ignition / gear / speed / doors — **read only** |
| `0x3BF` | `ALM_GLOBAL_CMD` | master brightness / all-off (E-STOP) |
| `0x3C0..0x3C6` | `ALM_ZONE_CMD` | per zone: `[R,G,B,brightness,effect,speed,reserved,counter|CRC]` |

Zones: footwell L/R, door trim L/R, dashboard, center console, cupholder.
`dashboard` is flagged `forwardField` — it sits in the driver's forward field of view and is
policed harder while driving.

## Project layout

```
docs/                       GitHub Pages content (served as-is, no build)
  index.html                cockpit SVG + UI
  styles.css                automotive-HMI dark theme
  src/
    i18n.js                 presentation-layer EN/JA dictionary + reason formatting
    domain/                 pure domain layer (see table above)
    application/            actuation-service.js, runtime-monitor.js
    infrastructure/         can.js, planners.js, ecu.js
    app.js                  composition root + UI wiring + SVG render loop
backend-rs/                 Rust backend (default) — candle-native inference
ai/                         Python backend (alternative) — transformers/PyTorch
test/                       node --test: safety, program, runtime-monitor, actuation, bridge
unity/                      Unity in-cabin debug client (C# scripts + docs, no project files)
scripts/serve.mjs           zero-dependency static server
scripts/unity-bridge.mjs    headless trusted host + UDP bridge for the Unity client
```

## Toward real hardware

1. **Planner → real LLM** — done. Point `LlmPlanner` at any service honouring the DSL contract,
   or pass `--model` to use something bigger.
2. **Virtual bus → real CAN** — replace `VirtualCanBus` with SocketCAN (`can0`) / `python-can` /
   a CAN-USB adapter. Only the body of `send(frame)` changes; keep the review before TX.
3. **Actuator → real ECU** — drive an RGB LED strip from a microcontroller (e.g. Raspberry Pi +
   MCP2515) that consumes `ALM_ZONE_CMD`.

Starting from a **non-safety actuator** is the point, not a limitation.

## Publishing the demo

`docs/` is the published content as-is (no build; `.nojekyll` is present so `src/` ES modules are
served). Settings → Pages → Deploy from a branch → **branch `master`, folder `/docs`**.

> ⚠️ The default branch of this repository is `master`, not `main`. Selecting `main / docs`
> publishes nothing.

```bash
gh api -X POST repos/togakyo/llm-on-the-can-bus/pages \
  -f 'source[branch]=master' -f 'source[path]=/docs'
```
