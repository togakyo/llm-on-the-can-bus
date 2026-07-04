// DemoDirector.cs — プロモ/README 用のデモ進行の自動化 + フレーム録画
//
// Play すると次のシナリオを無人で進行し、Game ビューを PNG 連番で書き出す:
//   0.5s  停車中に「足元とドアをシアンでゆっくり呼吸」→ PASS で点灯
//   4.0s  D レンジに入れて 60km/h まで加速 → 走行ポリシーへ切替
//   7.5s  「足元を赤く速く点滅させて警告」→ REJECT（1フレームも流れない）
//  11.5s  「ダッシュボードを白く明るく点滅」→ CLAMP（点滅→呼吸へ格下げ・減光）
//  16.0s  録画終了
//
// 出力: プロジェクト直下の Recordings/frame_0000.png ...
// GIF 化はリポジトリ側の scripts/make-demo-gif.sh で行う。
// 録画せずシナリオ進行だけ見たい場合は record を外す。

using System.IO;
using UnityEngine;

namespace CanAiActuatorLab
{
    public class DemoDirector : MonoBehaviour
    {
        [SerializeField] private CanBridgeClient bridge;
        [SerializeField] private VehicleStateReporter vehicle;

        [Header("録画")]
        public bool record = true;
        [SerializeField] private int captureFps = 15;
        [SerializeField] private string outputDir = "Recordings";
        [SerializeField] private float endTime = 16f;

        private float _t;
        private float _nextCapture;
        private int _frame;
        private int _step;
        private bool _done;

        private void Start()
        {
            if (bridge == null) bridge = FindObjectOfType<CanBridgeClient>();
            if (vehicle == null) vehicle = FindObjectOfType<VehicleStateReporter>();
            if (vehicle != null) vehicle.keyboardControl = false; // 手入力とデモ進行の競合を防ぐ
            if (record) Directory.CreateDirectory(outputDir);
            Application.targetFrameRate = 30;
        }

        private void Update()
        {
            if (_done) return;
            _t += Time.deltaTime;

            // --- シナリオ進行 ---------------------------------------------
            if (_step == 0 && _t >= 0.5f)
            {
                bridge.SendIntent("足元とドアをシアンでゆっくり呼吸");
                _step = 1;
            }
            if (_step == 1 && _t >= 4f) { vehicle.gear = 3; _step = 2; }
            if (_step == 2)
            {
                vehicle.speedKmh = Mathf.Lerp(0f, 60f, (_t - 4f) / 2.5f);
                if (_t >= 6.5f) _step = 3;
            }
            if (_step == 3 && _t >= 7.5f)
            {
                bridge.SendIntent("足元を赤く速く点滅させて警告"); // → REJECT
                _step = 4;
            }
            if (_step == 4 && _t >= 11.5f)
            {
                bridge.SendIntent("ダッシュボードを白く明るく点滅"); // → CLAMP
                _step = 5;
            }

            // --- フレームキャプチャ -----------------------------------------
            if (record && _t >= _nextCapture)
            {
                _nextCapture = _t + 1f / captureFps;
                CaptureFrame();
            }

            if (_t >= endTime)
            {
                _done = true;
                Debug.Log(record
                    ? $"DemoDirector: 録画完了（{_frame} フレーム → {outputDir}/）。" +
                      "リポジトリの scripts/make-demo-gif.sh で GIF 化できます"
                    : "DemoDirector: シナリオ完了");
            }
        }

        // 同期キャプチャ（CaptureScreenshot は書き出しタイミングが不定なため Texture 経由で確実に）
        private void CaptureFrame()
        {
            var tex = ScreenCapture.CaptureScreenshotAsTexture();
            File.WriteAllBytes(Path.Combine(outputDir, $"frame_{_frame:D4}.png"), tex.EncodeToPNG());
            Destroy(tex);
            _frame++;
        }
    }
}
