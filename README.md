# CAN-AI Actuator Lab 🚘💡

**AIが毎回「CAN制御プログラム」を生成 → 安全審査を通過 → 車内アンビエント照明アクチュエータを制御する** デモ／リファレンス実装です。

Physical AI の「AIにプログラムを書かせて物理アクチュエータを制御する」という発想を、車載ドメイン（ECU間の CAN 通信）に落とし込みました。
自然言語の意図から照明制御プログラムをその場で生成し、**安全性を最優先にした多層防御** を通してから仮想 CAN バスへ流します。

👉 **デモ（GitHub Pages）**: `https://togakyo.github.io/scratch-car-interior/`

---

## 🎯 コンセプト

> 「アクチュエータを切り替えるコードを、AIが毎回書く」

固定のハードコードではなく、ユーザーの意図に応じて **制御プログラムそのものをAIが生成** します。
ただし車載では「AIが自由にバイト列を送れる」ことは危険です。そこで **AIの出力を安全な表現に閉じ込め、実行前に必ず検査する** アーキテクチャにしています。

```
① 意図(自然言語)
      │  例）「ドアを開けたら足元を白くゆっくり点灯」
      ▼
② AIプランナー ──►  照明DSL(JSON) だけを生成
      │             ※ CAN ID・生バイト列は構造的に書けない
      ▼
③ 信頼コンパイラ ─►  DSL → CANフレーム へ変換
      │             ※ ここだけがCAN IDを知る。生成先はアンビエント系IDに限定
      ▼
④ セーフティ・スーパーバイザー ─►  1フレームずつ検査
      │             pass / clamp(安全側へ丸める) / reject(破棄)
      │             判定は車両状態(停車/走行)に依存
      ▼
⑤ 仮想CANバス → ECUモデル → 車内イルミ描画
```

### なぜ「多層防御」なのか

| 層 | 役割 | 安全上の意味 |
|----|------|------|
| **DSLサンドボックス** | AIは色/輝度/エフェクト/ゾーンしか表現できない | AIが暴走しても、そもそも**ブレーキやステアのIDを発火できない** |
| **信頼コンパイラ** | DSL→CAN変換を担う唯一の信頼コード | 生成されるIDはアンビエント系 `0x3C0..0x3C6 / 0x3BF` に**構造的に限定** |
| **安全審査** | 実行直前に全フレームを検証・クランプ・破棄 | ID allowlist / 輝度上限 / 点滅周波数 / 走行中ポリシー / ウォッチドッグ |
| **E-STOP** | 全ゾーン即時消灯のフェイルセーフ | いつでも安全状態へ復帰可能 |

---

## 🛡 安全審査ポリシー（実装済み）

`docs/src/safety.js` に集約。判定は **車両状態（速度・ギア）** に依存します。

- **CAN ID allowlist** — 許可外ID（例: パワトレ/ブレーキ系）は無条件 **REJECT**（多層防御の二重チェック）
- **メッセージ完全性** — ローリングカウンタ＋チェックサム不一致は **REJECT**
- **点滅周波数の上限** — 光過敏対策。常時 5Hz、走行中は 3Hz を超えると **CLAMP**
- **前方視野ゾーンの制限（走行中）** — ダッシュボード等はグレア対策で輝度を上限へ **CLAMP**、点滅は「呼吸」へ格下げ
- **赤色点滅の禁止（走行中）** — 警告表示との誤認防止のため全ゾーンで **REJECT**
- **ウォッチドッグ** — プログラム継続時間を上限（30s）へ **CLAMP**、`endState:off` は末尾に全消灯を強制付与

これらは **Node の単体テストで検証** しています → `test/safety.test.mjs`

---

## 🏗 構成

```
docs/                     ← GitHub Pages 公開物（そのままホスト。ビルド不要）
  index.html              コックピットSVG + UI
  styles.css              車載HMI風ダークテーマ
  src/
    signals.js            CANシグナル定義（DBC相当）: ID/エフェクト/エンコード
    can.js                仮想CANバス（購読・スケジュール送信）
    planner.js            AIプランナー(意図→DSL) ＋ 信頼コンパイラ(DSL→フレーム)
    safety.js             セーフティ・スーパーバイザー ★安全上の要
    ecu.js                アンビエント照明ECU（アクチュエータ状態モデル）
    app.js                UI配線 + SVG描画ループ
test/safety.test.mjs      安全審査の単体テスト
scripts/serve.mjs         依存ゼロのローカル静的サーバ
```

### 扱う CAN シグナル（快適系1ノードのみ）

| ID | メッセージ | 内容 |
|----|-----------|------|
| `0x0C0` | `VEHICLE_STATE` | 車両状態（ignition/gear/speed/doors）。**読むだけ** |
| `0x3BF` | `ALM_GLOBAL_CMD` | マスター輝度 / 全消灯(E-STOP) |
| `0x3C0..0x3C6` | `ALM_ZONE_CMD` | 各ゾーン: `[R,G,B,輝度,効果,速度,予約,カウンタ|CRC]` |

ゾーン: 足元L/R・ドアL/R・ダッシュボード・センターコンソール・カップホルダー。

---

## 🚀 使い方

### デモをローカルで動かす
```bash
npm run serve        # → http://localhost:8080
```
ブラウザで開き、プリセットボタンか自然言語（例:「全部レインボーで流れるように」）を入力して
**「⚡ AIで制御プログラムを生成」**。生成DSL・CANフレーム・安全審査結果・バスモニタが順に表示され、
車内イルミが反応します。スライダーで「走行中」にすると安全ポリシーが厳しくなる様子を確認できます。

### テスト
```bash
npm test             # node --test（安全審査の単体テスト）
```

### GitHub Pages で公開する

`docs/` フォルダがそのまま公開物です（ビルド不要・`.nojekyll` 済みなので `src/` の ES Modules がそのまま配信されます）。

**⚠️ このリポジトリのデフォルトブランチは `master` です（`main` ではありません）。** 以下の手順で有効化してください。

1. リポジトリを push する（`git push origin master`）
2. GitHub の **Settings → Pages** を開く
3. **Build and deployment → Source** を **Deploy from a branch** にする
4. **Branch** で **`master`** を選び、フォルダを **`/docs`** にして **Save**
5. 1〜2分待つと `https://togakyo.github.io/scratch-car-interior/` で公開される

> `main` ブランチは存在しないため、`main / docs` を選ぶと何も公開されません。必ず **`master`** を選択してください。

CLI で有効化する場合（`gh auth login` 済みなら）:
```bash
gh api -X POST repos/togakyo/scratch-car-interior/pages \
  -f 'source[branch]=master' -f 'source[path]=/docs'
# 設定確認・URL取得
gh api repos/togakyo/scratch-car-interior/pages --jq '.html_url, .status'
```

---

## 🔌 実機へのスモールスタート

このデモは **抽象化ポイントを差し替えるだけ** で実ハードへ発展できます。

1. **プランナーを実LLMへ** — `planner.js` の `HeuristicPlanner` を `LlmPlanner` に差し替え。
   同ファイルの `LLM_SYSTEM_PROMPT` と `DSL_SCHEMA` を Claude API 等へ渡し、**同一のDSL契約** で出力を得る。
   出力は必ずコンパイラ＋安全審査を通すので、LLMを信頼しなくてよい。
2. **仮想バスを実CANへ** — `can.js` の `VirtualCanBus` を SocketCAN(`can0`) / `python-can` / CAN-USB に置換。
   `send(frame)` の中身を実送信に変えるだけ（安全審査は送信前のまま維持）。
3. **アクチュエータを実ECUへ** — まずは RGB LED ストリップ＋マイコン（例: Raspberry Pi + MCP2515）で
   `ALM_ZONE_CMD` を受けて点灯。**照明という非安全アクチュエータ**から始めるのが安全なスモールスタート。

> ⚠️ 実車両のバスには接続しないでください。ベンチ環境（独立したCANバス＋LED）での検証を前提としています。

---

## ライセンス
MIT
