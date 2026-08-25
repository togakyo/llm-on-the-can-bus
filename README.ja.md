<div align="center">

# 🚗 LLM on the CAN bus

### 車の制御プログラムを、LLMが毎回ゼロから書く。
### それでも危険なことはできない ― 実際に壊しにきてください。

[![CI](https://github.com/togakyo/llm-on-the-can-bus/actions/workflows/ci.yml/badge.svg)](https://github.com/togakyo/llm-on-the-can-bus/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**[▶ ライブデモ](https://togakyo.github.io/llm-on-the-can-bus/?lang=ja)** · [アーキテクチャ](ARCHITECTURE.md) · [安全ポリシー](SAFETY.md) · [English](README.md)

</div>

![停車中はプログラムが車内を照らし、60km/h で走り出すと「赤く速く点滅」の意図が安全審査に REJECT されてバスに1フレームも流れない様子](docs/assets/demo-unity.gif)

意図を打ち込むと、AIがそのための照明制御プログラムを新しく書き起こします。信頼された
スーパーバイザーが **CANフレームを1枚ずつ** 検査し、**いまの車両状態にとって** 危険なものを
捨てます。上の GIF は、停車中なら綺麗に点灯する同じ意図が、60km/h では **REJECT** される様子です。

## 壊してみる ― 30秒・インストール不要

1. **[ライブデモ](https://togakyo.github.io/llm-on-the-can-bus/?lang=ja)** を開く
2. **車両状態** のスライダーを 60km/h まで上げる
3. **🔴 壊してみる** のプリセットを押す ― もちろん自分で最悪の意図を打ち込んでもいい

あるいは、拒否される瞬間に直接飛べます:
**[60km/hで赤く点滅 →](https://togakyo.github.io/llm-on-the-can-bus/?lang=ja&speed=60&preset=redflash)** ·
[ダッシュを全開輝度 →](https://togakyo.github.io/llm-on-the-can-bus/?lang=ja&speed=60&preset=glare) ·
[全ゾーンをストロボ →](https://togakyo.github.io/llm-on-the-can-bus/?lang=ja&speed=60&preset=strobe)

AIは頼まれたとおりのプログラムを気前よく書きます。問題は、そのうち何がバスに届くかです。

| 頼むこと | 停車中 | 60km/h 走行中 |
|---|---|---|
| 🚨 全部を赤く速く点滅 | ✅ `PASS 7` ― 車内が点滅する | 🚫 `REJECT 6` `CLAMP 1` ― 赤点滅は警告灯と誤認される |
| 🔆 ダッシュボードを全開輝度 | ✅ `PASS 1` | ⚠️ `CLAMP 1` ― 100% → 40%（前方視野のグレア対策） |
| ⚡ 全ゾーンをストロボ | ✅ `PASS 7` | ⚠️ `CLAMP 7` ― 4Hz → 3Hz（光過敏対策） |

そして多くのデモが飛ばす部分 ―― **実行中のプログラムも、審査され続けます。**
停車中に車内を赤く光らせて、*そのあと* 走り出してみてください。実行時保証モニタが車両状態の
変化に気づき、すでに ECU にラッチ済みの点灯状態をクランプ、あるいは消灯させます。

車内は **2D / 3D** を切り替えられます（ステージ上部のトグル）。3Dビューはライブラリもビルドも
使わない手書きのWebGLで、形状は Unity クライアントと同じ座標を共有しています ―― つまり
ブラウザでも Unity でも「同じ車」が出ます。

## なぜAIはブレーキに届かないのか

```
  「足元を赤く点滅させて」        ← あなた
            │
            ▼
  ┌──────────────────┐   AIが出力できるのは照明DSL(JSON)だけ。
  │   AIプランナー    │   CAN ID を名指しすることも、生バイトを書くこともできない。
  └──────────────────┘   ── 構造的サンドボックス ──
            │  { zones, color, brightness, effect, hz }
            ▼
  ┌──────────────────┐   CAN ID を知る唯一のコード。生成先はアンビエント系の
  │  信頼コンパイラ   │   0x3BF / 0x3C0..0x3C6 に構造的に限定される。
  └──────────────────┘
            │  CANフレーム
            ▼
  ┌──────────────────┐   「いまの車両状態」で全フレームを検査 → pass/clamp/reject。
  │ セーフティ審査    │   送信の瞬間にも、車両状態が変わるたびにも再実行される。
  └──────────────────┘
            │  承認されたフレームだけ
            ▼
     仮想CANバス → ECUモデル → 車内イルミ
```

| 層 | 何を保証するか |
|---|---|
| **DSLサンドボックス** | AIが表現できるのは色・輝度・エフェクト・ゾーンだけ。暴走しても、そもそもブレーキやステアのメッセージを**組み立てられない**。 |
| **信頼コンパイラ** | CAN ID を知る唯一の場所。出力範囲はアンビエント照明ノードに構造的に限定される。 |
| **セーフティ・スーパーバイザー** | ID allowlist / チェックサム / 輝度上限 / 点滅周波数上限 / 走行中ポリシー / ウォッチドッグ を、送信直前に全フレームへ適用。 |
| **実行時保証（RTA）** | Simplex型のモニタが、飛行中およびラッチ済みの状態を世界の変化に応じて再検査し、安全側へフォールバックする。 |
| **E-STOP** | 審査を経ない、信頼された1本の全消灯経路。 |

すべての判断はドメインイベントとして発行され、版数つきの**安全監査証跡**に追記されます
（デモのパネル⑤）。ルール本体は [`docs/src/domain/safety.js`](docs/src/domain/safety.js)、
検証は [`test/safety.test.mjs`](test/safety.test.mjs) にあります。

## 動かす

```bash
npm run serve   # → http://localhost:8080  （静的・依存ゼロ・ビルド不要）
npm test        # node --test — 安全審査 / 集約 / RTA / ユースケース
```

### 本物のモデルを載せる

既定はオフラインの規則ベースプランナーです（公開ページが常に動くため）。Hugging Face から
落としてきた軽量LLMを **自分のPC上で** 走らせ、プランナー選択で **ローカルAI** を選べます。

```bash
cd backend-rs && cargo run --release --features llm   # Rust + candle（Python不要）
python ai/planner_server.py                           # または Python + transformers
```

どちらも `:8000` で同じ `POST /plan` 契約を提供します。モデルのJSONは**信頼されない入力**として
扱われ、腐敗防止層で矯正 → コンパイラ → 安全審査を必ず通ります。サーバ未起動なら、ページは
黙って規則ベースへフォールバックします。詳細は [ARCHITECTURE.md](ARCHITECTURE.md#backends)。

### 車内からデバッグする（Unity）

```bash
npm run bridge   # ヘッドレスな信頼側ホスト + UDPブリッジ :9200
```

[`unity/Scripts/`](unity/Scripts) を Unity 2021.3+ のプロジェクトに入れれば、運転席から
スーパーバイザーの介入を眺められます。Unity もまた「信頼されない表示アダプタ」の一つにすぎません。
手順は [`unity/README.md`](unity/README.md)。

## ドキュメント

- [ARCHITECTURE.md](ARCHITECTURE.md) — ヘキサゴナル/DDD層構成、実行時保証、ディレクトリ構成、CANシグナル定義
- [SAFETY.md](SAFETY.md) — スーパーバイザーが強制する全ルールと、その理由
- [`unity/PROTOCOL.md`](unity/PROTOCOL.md) — Unityクライアント向け UDP プロトコル

## これはベンチ用の玩具であって、車載ツールではありません

> ⚠️ **実車両のバスには接続しないでください。** 想定しているのは、独立したCANバスと
> LEDストリップによるベンチ環境の快適系照明ノードです。ここで主張したいのは*アーキテクチャ*
> であり、非安全系アクチュエータから始めるのが誠実なスモールスタートだと考えています。

## ライセンス

MIT — [LICENSE](LICENSE) を参照。
