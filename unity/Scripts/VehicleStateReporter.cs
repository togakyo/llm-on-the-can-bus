// VehicleStateReporter.cs — 仮想車両の状態（速度/ギア/ドア）をホストへ返送する
//
// これが「帰り」の経路: Unity 内で車を走らせると VEHICLE_STATE (0x0C0) として
// バスに流れ、ホスト側の RuntimeAssuranceMonitor が即座に再保証を行う。
// 停車中に承認された照明が、走り出した瞬間にクランプされる様子を車内から観察できる。
//
// 本格的な車両コントローラを組む場合は keyboardControl を切り、
// 速度・ギア・ドアのフィールドを外部から書き込むだけでよい。

using UnityEngine;

namespace CanAiActuatorLab
{
    public class VehicleStateReporter : MonoBehaviour
    {
        [SerializeField] private CanBridgeClient bridge;

        [Header("車両状態（外部スクリプトから直接書き込み可）")]
        public float speedKmh;
        [Tooltip("0=P 1=R 2=N 3=D")]
        public int gear;
        public bool doorOpen;

        [Header("簡易運転キー: ↑/↓=加減速, G=ギア切替, O=ドア開閉")]
        [SerializeField] private bool keyboardControl = true;
        [SerializeField] private float accelKmhPerSec = 25f;
        [SerializeField] private float brakeKmhPerSec = 50f;

        private const float ChangeSendInterval = 0.1f; // 変化時は最大 10Hz
        private const float HeartbeatInterval = 1f;    // 無変化でも 1Hz で送る

        private float _nextHeartbeat;
        private float _nextChangeSend;
        private int _lastSent = -1;

        private void Start()
        {
            if (bridge == null) bridge = FindObjectOfType<CanBridgeClient>();
        }

        private void Update()
        {
            if (keyboardControl) HandleKeys();

            int snapshot = Mathf.RoundToInt(speedKmh) | (gear << 16) | ((doorOpen ? 1 : 0) << 20);
            bool changed = snapshot != _lastSent;
            float now = Time.unscaledTime;

            if ((changed && now >= _nextChangeSend) || now >= _nextHeartbeat)
            {
                bridge?.SendVehicle(Mathf.RoundToInt(speedKmh), gear, doorOpen);
                _lastSent = snapshot;
                _nextChangeSend = now + ChangeSendInterval;
                _nextHeartbeat = now + HeartbeatInterval;
            }
        }

        private void HandleKeys()
        {
            if (Input.GetKey(KeyCode.UpArrow)) speedKmh += accelKmhPerSec * Time.deltaTime;
            if (Input.GetKey(KeyCode.DownArrow)) speedKmh -= brakeKmhPerSec * Time.deltaTime;
            if (Input.GetKeyDown(KeyCode.G)) gear = (gear + 1) % 4;
            if (Input.GetKeyDown(KeyCode.O)) doorOpen = !doorOpen;

            if (gear == 0) speedKmh = 0f; // P レンジでは走らない
            speedKmh = Mathf.Clamp(speedKmh, 0f, 240f);
        }
    }
}
