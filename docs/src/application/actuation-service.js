// application/actuation-service.js — ユースケース層（アプリケーションサービス）
//
// 「意図から照明を灯すまで」のオーケストレーションだけを担当し、
// ドメイン知識（審査基準・DSL契約・状態遷移）は domain 層に委譲する。
// 依存はすべてコンストラクタ注入（ports & adapters）:
//   planners  … PlannerPort 実装（heuristic / llm）
//   monitor   … RuntimeAssuranceMonitor（TXゲート + 車両状態の供給元）
//   scheduler … scheduleProgram 互換の関数（テストでは同期実行に差し替え可能）

import { LightingProgram, PROGRAM_STATUS } from '../domain/program.js';
import { compile } from '../domain/compiler.js';
import { reviewProgram, buildEstopProgram, POLICY } from '../domain/safety.js';
import { EVT } from '../domain/events.js';

export class ActuationService {
  constructor({ bus, monitor, events, planners, scheduler, policy = POLICY }) {
    this._bus = bus;
    this._monitor = monitor;
    this._events = events;
    this._planners = planners; // { heuristic, llm }
    this._scheduler = scheduler;
    this._policy = policy;
    this._cancel = null;
    this.activeProgram = null;
  }

  // ① 意図 → ② 生成 → ACL → ③ コンパイル → ④ 審査 → ⑤ 送出
  // 返り値はUI表示用: { program, source, review }
  async runIntent(intent, mode = 'heuristic') {
    this._events.publish(EVT.INTENT_RECEIVED, { detail: intent });

    // ② 生成（グレースフル・デグラデーション: llm → ルールへ自動フォールバック）
    let rawDsl;
    let source;
    if (mode === 'llm') {
      try {
        rawDsl = await this._planners.llm.generate(intent);
        const llm = this._planners.llm;
        source = `ローカルAI · ${llm.lastModel ?? 'HF model'}${llm.lastSource === 'fallback' ? '（サーバ側fallback）' : ''}`;
      } catch {
        rawDsl = await this._planners.heuristic.generate(intent);
        source = 'ルール（ローカルAI未接続のためフォールバック）';
      }
    } else {
      rawDsl = await this._planners.heuristic.generate(intent);
      source = 'ルール（オフライン）';
    }

    // 集約の生成（腐敗防止層 normalizeDsl を通過）
    const program = LightingProgram.fromUntrusted({ intent, rawDsl, source });
    this._events.publish(EVT.PROGRAM_GENERATED, {
      programId: program.id, detail: `「${program.dsl.title}」 生成元: ${source}`,
    });

    // ③ 信頼コンパイラ
    program.markCompiled(compile(program.dsl));
    this._events.publish(EVT.PROGRAM_COMPILED, {
      programId: program.id, detail: `${program.compiled.steps.length} フレームへコンパイル`,
    });

    // ④ 安全審査（車両状態はモニタがバスから センシングした最新値）
    const review = reviewProgram(program.compiled, this._monitor.vehicle);
    program.markReviewed(review);
    this._events.publish(EVT.PROGRAM_REVIEWED, {
      programId: program.id,
      policyVersion: this._policy.version,
      detail: `PASS ${review.summary.pass} / CLAMP ${review.summary.clamp} / REJECT ${review.summary.reject}` +
        `（${review.summary.driving ? '走行中' : '停車中'}ポリシー）`,
    });

    // ⑤ 承認ステップのみ、TXゲート（monitor.send）経由でスケジュール送出
    if (program.status === PROGRAM_STATUS.APPROVED) {
      this._replaceActive(program);
      program.markActive();
      this._events.publish(EVT.PROGRAM_DISPATCHED, {
        programId: program.id, detail: `${review.approvedSteps.length} フレームを送出開始`,
      });
      this._cancel = this._scheduler(this._monitor, review.approvedSteps, 'safety', () => {
        program.markCompleted();
        this._events.publish(EVT.PROGRAM_COMPLETED, { programId: program.id });
      });
    } else {
      this._events.publish(EVT.PROGRAM_ABORTED, {
        programId: program.id, detail: '全フレームが安全審査で破棄されたため実行せず',
      });
    }

    return { program, source, review };
  }

  // E-STOP: 審査を経ない信頼済み固定プログラム（フェイルセーフ経路）
  estop() {
    this._replaceActive(null, 'E-STOP');
    const prog = buildEstopProgram();
    for (const s of prog.steps) this._bus.send(s.frame, 'estop');
    this._events.publish(EVT.ESTOP_TRIGGERED, { detail: '全ゾーン消灯・フェイルセーフ状態へ' });
  }

  _replaceActive(next, reason = '新しいプログラムへ差し替え') {
    if (this._cancel) {
      this._cancel();
      this._cancel = null;
    }
    if (this.activeProgram && this.activeProgram.status === PROGRAM_STATUS.ACTIVE) {
      this.activeProgram.markAborted(reason);
      this._events.publish(EVT.PROGRAM_ABORTED, {
        programId: this.activeProgram.id, detail: reason,
      });
    }
    this.activeProgram = next;
  }
}
