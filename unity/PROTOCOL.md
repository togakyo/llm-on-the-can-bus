# Unity Bridge Protocol / Unity ブリッジプロトコル

Transport: **UDP, one JSON message per datagram**, default port **9200** (`BRIDGE_PORT` to change).
The Node host (`scripts/unity-bridge.mjs`) is the **trusted side** — planning, compilation,
safety review and run-time assurance all happen there. Unity is an *untrusted renderer + sensor*:
it draws whatever latched ECU state it is told, and reports vehicle state back.

トランスポートは **UDP・データグラム1通=JSONメッセージ1個**。既定ポート **9200**（`BRIDGE_PORT` で変更）。
Node ホストが**信頼側**（生成・コンパイル・安全審査・実行時保証はすべてホスト）で、
Unity は「信頼されない表示装置 + センサ」です。

Message builders / parser: [`scripts/bridge-protocol.mjs`](../scripts/bridge-protocol.mjs) ⇄ C# DTOs: [`Scripts/BridgeMessages.cs`](Scripts/BridgeMessages.cs).
All host→Unity messages avoid JSON maps (arrays only) so Unity's `JsonUtility` can parse them.

## Handshake

Unity sends `hello` every second (keepalive). The host remembers the most recent sender and
streams to it; 10 s without any datagram drops the client. Commands from unknown addresses are
ignored until they `hello` first.

## Unity → Host

### `hello`
```json
{"type":"hello","client":"unity"}
```

### `intent` — generate & run a lighting program
```json
{"type":"intent","text":"足元をシアンでゆっくり呼吸","mode":"heuristic"}
```
`mode`: `"heuristic"` (offline rule planner) or `"llm"` (local model server on :8000; the host
falls back to the rule planner automatically if it is down). Reply: one `result` message,
plus the usual `event` / `frame` / `zones` stream.

### `estop` — trusted fail-safe path (no review, all zones off)
```json
{"type":"estop"}
```

### `vehicle` — vehicle state, encoded by the host as CAN `VEHICLE_STATE (0x0C0)`
```json
{"type":"vehicle","ignition":1,"gear":3,"speedKmh":60,"doors":0}
```
`gear`: 0=P 1=R 2=N 3=D. Out-of-range values are clamped by the host.
Send at ~10 Hz on change + 1 Hz heartbeat (`VehicleStateReporter.cs` does this).

## Host → Unity

### `welcome` — reply to every `hello`
```json
{"type":"welcome","policyVersion":"1.1.0",
 "zones":[{"id":"footwell_fl","canId":960,"label":"足元 左前","forwardField":false}, ...]}
```
The **array order defines `zoneIndex`** used as the phase offset of WIPE/RAINBOW effects.

### `zones` — latched ECU state snapshot (sent after every bus frame, and with `welcome`)
```json
{"type":"zones","master":1.0,"nowMs":12345.6,
 "zones":[{"id":"footwell_fl","r":0,"g":255,"b":255,"brightness":200,
           "effect":1,"effectName":"BREATHE","hz":0.4,"sinceMs":11000.0}, ...]}
```
Effects are animated **client-side**: re-anchor host time to the local clock via
`localSince = Time.time - (nowMs - sinceMs)/1000` and evaluate the effect formulas
(port of `docs/src/infrastructure/ecu.js effectiveColor()`, see `AmbientZoneLight.cs`).
`effect`: 0=STATIC 1=BREATHE 2=PULSE 3=WIPE 4=FLASH 5=RAINBOW.

### `frame` — every frame on the virtual CAN bus (for a bus-monitor panel)
```json
{"type":"frame","seq":42,"tag":"safety","id":960,"idHex":"0x3C0","dlc":8,
 "data":[0,255,255,200,1,13,0,166],"zone":"footwell_fl"}
```
`tag`: `planner` / `safety` (passed TX gate) / `monitor` (run-time intervention) /
`estop` / `vehicle`.

### `event` — domain events = the safety audit trail, live
```json
{"type":"event","name":"RuntimeIntervention","at":1751690000000,
 "detail":"[tx-gate] CLAMP ダッシュボード: ...","verdict":"clamp","phase":"tx-gate",
 "policyVersion":"1.1.0","programId":"p-3"}
```
`name` is one of the `EVT` values in `docs/src/domain/events.js`
(IntentReceived, ProgramGenerated, ProgramCompiled, ProgramReviewed, ProgramDispatched,
ProgramCompleted, ProgramAborted, VehicleStateChanged, RuntimeIntervention, EstopTriggered).
`verdict`/`phase` are filled for `RuntimeIntervention` only. Missing fields are empty strings
(never `null` / absent) for `JsonUtility` compatibility.

### `result` — reply to `intent`
```json
{"type":"result","ok":true,"programId":"p-3","status":"completed",
 "title":"足元をシアンでゆっくり呼吸…(breathe)","source":"ルール（オフライン）",
 "pass":2,"clamp":0,"reject":0,"driving":false,"error":""}
```
`status`: `active` / `completed` / `rejected` (all frames rejected by review) / `error`.
