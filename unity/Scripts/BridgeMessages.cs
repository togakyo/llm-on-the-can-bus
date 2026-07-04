// BridgeMessages.cs — UDP ブリッジのメッセージ DTO（unity/PROTOCOL.md と対）
//
// JsonUtility でシリアライズするため、全フィールドは public + [Serializable]、
// マップは使わず配列で受ける。ホスト側の対は scripts/bridge-protocol.mjs。

using System;

namespace CanAiActuatorLab
{
    // docs/src/domain/signals.js の EFFECT と同値
    public enum AmbientEffect
    {
        Static = 0,
        Breathe = 1,
        Pulse = 2,
        Wipe = 3,
        Flash = 4,
        Rainbow = 5,
    }

    // 受信メッセージの type だけ先読みするためのプローブ
    [Serializable] public class MsgProbe { public string type; }

    // --- ホスト → Unity ---------------------------------------------------

    [Serializable]
    public class ZoneInfo
    {
        public string id;
        public int canId;
        public string label;
        public bool forwardField;
    }

    [Serializable]
    public class WelcomeMsg
    {
        public string policyVersion;
        public ZoneInfo[] zones; // 並び順がエフェクト位相用の zoneIndex になる
    }

    [Serializable]
    public class ZoneState
    {
        public string id;
        public int r, g, b;
        public int brightness; // 0..255
        public int effect;     // AmbientEffect
        public string effectName;
        public float hz;
        public double sinceMs; // ホスト時計。nowMs との差分で経過時間を得る
    }

    [Serializable]
    public class ZonesMsg
    {
        public float master;   // マスター輝度 0..1
        public double nowMs;   // ホスト時計の現在時刻
        public ZoneState[] zones;
    }

    [Serializable]
    public class FrameMsg
    {
        public int seq;
        public string tag;   // planner / safety / estop / vehicle / monitor
        public int id;
        public string idHex;
        public int dlc;
        public int[] data;
        public string zone;  // ゾーン指令なら zoneId、それ以外は空
    }

    [Serializable]
    public class EventMsg
    {
        public string name;    // ドメインイベント名（例: RuntimeIntervention）
        public long at;
        public string detail;
        public string verdict; // pass / clamp / reject（介入イベントのみ）
        public string phase;   // tx-gate / reassure
        public string policyVersion;
        public string programId;
    }

    [Serializable]
    public class ResultMsg
    {
        public bool ok;
        public string programId;
        public string status;  // active / completed / rejected / error ...
        public string title;
        public string source;
        public int pass, clamp, reject;
        public bool driving;
        public string error;
    }

    // --- Unity → ホスト ---------------------------------------------------

    [Serializable] public class HelloMsg { public string type = "hello"; public string client = "unity"; }

    [Serializable]
    public class IntentMsg
    {
        public string type = "intent";
        public string text;
        public string mode = "heuristic"; // "heuristic" | "llm"
    }

    [Serializable] public class EstopMsg { public string type = "estop"; }

    [Serializable]
    public class VehicleMsg
    {
        public string type = "vehicle";
        public int ignition = 1;
        public int gear;     // 0=P 1=R 2=N 3=D
        public int speedKmh;
        public int doors;    // 開いているドアのビットマスク（デモでは 0/1 で十分）
    }
}
