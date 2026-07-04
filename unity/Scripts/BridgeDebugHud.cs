// BridgeDebugHud.cs — デバッグ HUD（意図の入力・E-STOP・監査イベントのライブ表示）
//
// uGUI のセットアップなしで使えるよう IMGUI(OnGUI) で描く。
// ブラウザ版 UI のパネル①（意図入力）と⑤（監査証跡）に相当する。
// CanBridgeClient と同じ GameObject に付けるだけでよい。

using System.Collections.Generic;
using UnityEngine;

namespace CanAiActuatorLab
{
    public class BridgeDebugHud : MonoBehaviour
    {
        [SerializeField] private CanBridgeClient bridge;
        [SerializeField] private VehicleStateReporter vehicle;
        [SerializeField] private int maxLogLines = 14;

        private struct LogEntry { public string text; public Color color; }

        private static readonly string[] GearNames = { "P", "R", "N", "D" };

        private string _intent = "足元をシアンでゆっくり呼吸";
        private string _resultLine = "";
        private Color _resultColor = Color.white;
        private readonly List<LogEntry> _log = new List<LogEntry>();

        private void Start()
        {
            if (bridge == null) bridge = GetComponent<CanBridgeClient>();
            if (vehicle == null) vehicle = FindObjectOfType<VehicleStateReporter>();
            if (bridge != null)
            {
                bridge.OnEvent += HandleEvent;
                bridge.OnResult += HandleResult;
            }
        }

        private void OnDestroy()
        {
            if (bridge != null)
            {
                bridge.OnEvent -= HandleEvent;
                bridge.OnResult -= HandleResult;
            }
        }

        private void HandleEvent(EventMsg e)
        {
            Color color = Color.white;
            if (e.name == "RuntimeIntervention")
                color = e.verdict == "reject" ? new Color(1f, 0.35f, 0.35f) : new Color(1f, 0.75f, 0.2f);
            else if (e.name == "EstopTriggered" || e.name == "ProgramAborted")
                color = new Color(1f, 0.35f, 0.35f);
            else if (e.name == "ProgramReviewed")
                color = new Color(0.4f, 0.9f, 1f);
            else if (e.name == "VehicleStateChanged")
                color = new Color(0.7f, 0.7f, 0.7f);

            AddLog($"{e.name}  {e.detail}", color);
        }

        private void HandleResult(ResultMsg r)
        {
            if (!r.ok)
            {
                _resultLine = $"エラー: {r.error}";
                _resultColor = new Color(1f, 0.35f, 0.35f);
                return;
            }
            _resultLine = $"「{r.title}」 {r.status}  PASS {r.pass} / CLAMP {r.clamp} / REJECT {r.reject}"
                          + (r.driving ? "（走行中ポリシー）" : "（停車中ポリシー）");
            _resultColor = r.status == "rejected" ? new Color(1f, 0.35f, 0.35f) : new Color(0.5f, 1f, 0.6f);
        }

        private void AddLog(string text, Color color)
        {
            _log.Add(new LogEntry { text = text, color = color });
            if (_log.Count > maxLogLines) _log.RemoveAt(0);
        }

        private void OnGUI()
        {
            GUILayout.BeginArea(new Rect(12, 12, 560, Screen.height - 24), GUI.skin.box);

            // 接続と車両状態
            bool connected = bridge != null && bridge.Connected;
            GUI.color = connected ? new Color(0.5f, 1f, 0.6f) : new Color(1f, 0.75f, 0.2f);
            GUILayout.Label(connected
                ? $"● ブリッジ接続中  safety envelope v{bridge.PolicyVersion}"
                : "○ ブリッジ未接続 — `npm run bridge` を起動してください");
            GUI.color = Color.white;
            if (vehicle != null)
            {
                GUILayout.Label($"車両: {vehicle.speedKmh:0} km/h  ギア {GearNames[Mathf.Clamp(vehicle.gear, 0, 3)]}  ドア{(vehicle.doorOpen ? '開' : '閉')}"
                                + "   （↑↓=加減速  G=ギア  O=ドア）");
            }

            GUILayout.Space(6);

            // 意図の入力
            GUILayout.Label("意図（自然言語）:");
            _intent = GUILayout.TextField(_intent, GUILayout.Height(24));
            GUILayout.BeginHorizontal();
            if (GUILayout.Button("生成（ルール）", GUILayout.Height(28)))
                bridge?.SendIntent(_intent, useLlm: false);
            if (GUILayout.Button("生成（ローカルAI :8000）", GUILayout.Height(28)))
                bridge?.SendIntent(_intent, useLlm: true);
            GUI.backgroundColor = new Color(1f, 0.3f, 0.3f);
            if (GUILayout.Button("E-STOP", GUILayout.Height(28), GUILayout.Width(90)))
                bridge?.SendEstop();
            GUI.backgroundColor = Color.white;
            GUILayout.EndHorizontal();

            if (!string.IsNullOrEmpty(_resultLine))
            {
                GUI.color = _resultColor;
                GUILayout.Label(_resultLine);
                GUI.color = Color.white;
            }

            GUILayout.Space(6);

            // 監査イベントのライブログ
            GUILayout.Label("─ 安全監査イベント ─");
            foreach (var entry in _log)
            {
                GUI.color = entry.color;
                GUILayout.Label(entry.text);
            }
            GUI.color = Color.white;

            GUILayout.EndArea();
        }
    }
}
