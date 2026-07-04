# Unity In-Cabin Debug Environment / Unity 車内デバッグ環境 🎮

Debug the CAN-AI pipeline **from inside a virtual car**: type an intent, watch the AI-generated
lighting program pass safety review and light up the cabin — then start driving and watch the
run-time assurance monitor clamp or kill it in real time.

仮想車内から CAN-AI パイプラインをデバッグします。意図を打ち込むと生成された照明プログラムが
安全審査を通って車内が光り、**そのまま走り出すと実行時保証モニタがリアルタイムに介入**する様子を
車内視点で観察できます。

```
[Node ヘッドレスホスト（信頼側）]                 [Unity（信頼されない表示装置）]
 domain + application そのまま        UDP :9200
 planner→compiler→safety→RTA  ◄──────────────►  CanBridgeClient
        │  frame / zones / event ─────►          ├─ AmbientZoneLight ×7（発光）
        └──◄─ vehicle (速度/ギア/ドア) ──────────┴─ VehicleStateReporter / BridgeDebugHud
```

安全審査と実行時保証は**すべて Node 側**で行われ、Unity は検証済みの ECU 状態を描くだけです
（ブラウザ版 SVG と同じ立ち位置のアダプタ）。プロトコル詳細は [PROTOCOL.md](PROTOCOL.md)。

## Quick start / 最速セットアップ（車モデル不要・5分）

1. **ホストを起動** (Node 18+):
   ```bash
   npm run bridge        # udp://0.0.0.0:9200
   ```
2. **Unity 2021.3 LTS 以降**でプロジェクトを開く。すぐ試すなら同梱の最小プロジェクト
   `unity/Playground/` を Unity Hub の「Add」でそのまま開けばよい（スクリプトはコピー済み。
   git 管理外なので自由に汚してよい）。自分のプロジェクトを使う場合は `unity/Scripts/` の
   `.cs` を `Assets/` 配下へコピーする。
3. メニュー **CAN-AI → Set Up Debug Scene** を実行（エディタ拡張が全部配線する）。
   手動でやる場合は、空の GameObject に次の 4 コンポーネントを追加:
   - `CanBridgeClient` — 接続先（既定 127.0.0.1:9200）
   - `BridgeDebugHud` — 意図入力・E-STOP・監査ログの HUD
   - `VehicleStateReporter` — 速度/ギア/ドアの返送（簡易運転キー付き）
   - `ZonePlaceholderRig` — 7ゾーン分の発光球を自動生成（車モデルなしで絵が出る）
4. **Play** を押し、HUD に「● ブリッジ接続中」と出たら意図を入力して **生成**。

### 試すシナリオ / Things to try

| 操作 | 期待される動き |
|------|--------------|
| 停車中に「足元をシアンでゆっくり呼吸」 | PASS で点灯 |
| そのまま ↑ キーで加速（G で D レンジへ） | `VehicleStateChanged` → 走行ポリシーで再保証 |
| 走行中に「ダッシュボードを白く明るく点滅」 | CLAMP（点滅→呼吸へ格下げ・減光）が HUD に出る |
| 走行中に「足元を赤く速く点滅させて警告」 | REJECT — 1 フレームもバスに流れない |
| E-STOP ボタン | 全ゾーン即消灯（審査を経ない信頼済み経路） |

## 本物の車内モデルを使う / Using a real car-interior model

1. Asset Store 等から車内モデルをシーンに置く。
2. `ZonePlaceholderRig` を外し、モデル内の各位置（足元×2・ドアトリム×2・ダッシュボード・
   センターコンソール・カップホルダー）に GameObject を置いて `AmbientZoneLight` を追加、
   `zoneId` を設定する:
   `footwell_fl` `footwell_fr` `door_fl` `door_fr` `dashboard` `console` `cupholder`
3. 各ゾーンに Point Light を持たせるか、LED ストリップ状のメッシュ（Emission 有効の
   マテリアル）を `emissiveRenderer` に割り当てる。両方使うとそれらしくなる。
4. 運転できる車両コントローラがある場合は `VehicleStateReporter` の `keyboardControl` を
   切り、毎フレーム `speedKmh` / `gear` / `doorOpen` を書き込むだけでよい。

## Local LLM mode / ローカルAIモード

HUD の「生成（ローカルAI :8000）」は、Rust バックエンド（`backend-rs`）または
Python サーバ（`python ai/planner_server.py`）が :8000 で動いているときに本物の
軽量 LLM で DSL を生成します。落ちていればホストがルールプランナーへ自動フォールバックします。

## Notes / 補足

- 入力は旧 Input Manager（`Input.GetKey`）を使用。新 Input System のみのプロジェクトでは
  **Project Settings → Player → Active Input Handling を "Both"** にしてください。
- `unity/Scripts/` はスクリプトのみ配布で、Unity プロジェクト一式はリポジトリに含めません
  （`.meta` 等の生成物はコミット不要）。
- 通信はローカル UDP のみ・外部依存ゼロ。パケットを覗きたいときは
  `sudo tcpdump -A -i lo0 udp port 9200` などで平文 JSON がそのまま見えます。
