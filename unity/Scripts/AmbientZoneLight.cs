// AmbientZoneLight.cs — 1 ゾーン分のアンビエント照明レンダラ
//
// ホストから届く ECU ラッチ状態（色・輝度・エフェクト・Hz）を保持し、
// エフェクトの時間変化はローカルで毎フレーム計算する。
// docs/src/infrastructure/ecu.js の effectiveColor() の C# 移植。
//
// 使い方: 車内の各位置（足元/ドアトリム/ダッシュボード等）に配置した
// GameObject に付け、zoneId を設定。Light か エミッシブ Renderer の
// どちらか（両方でも可）を割り当てる。未指定なら同じ GameObject から拾う。

using UnityEngine;

namespace CanAiActuatorLab
{
    public class AmbientZoneLight : MonoBehaviour
    {
        [SerializeField] private CanBridgeClient bridge;

        [Tooltip("footwell_fl / footwell_fr / door_fl / door_fr / dashboard / console / cupholder")]
        public string zoneId = "footwell_fl";

        [Header("出力先（未指定なら自 GameObject から取得）")]
        [SerializeField] private Light zoneLight;
        [SerializeField] private Renderer emissiveRenderer;
        [SerializeField] private float maxLightIntensity = 2f;
        [SerializeField] private float emissionIntensity = 3f;

        private static readonly int EmissionColorId = Shader.PropertyToID("_EmissionColor");

        private ZoneState _state;
        private float _localSince; // sinceMs をローカル時計(Time.time)に貼り直した値
        private float _master = 1f;
        private int _zoneIndex;    // WIPE / RAINBOW の位相オフセット（welcome の並び順）
        private MaterialPropertyBlock _mpb;

        // リグ等がコードから出力先を割り当てるための入口（Start より前に呼ぶこと）
        public void SetOutputs(Light light, Renderer renderer)
        {
            zoneLight = light;
            emissiveRenderer = renderer;
        }

        private void Start()
        {
            if (bridge == null) bridge = FindObjectOfType<CanBridgeClient>();
            if (zoneLight == null) zoneLight = GetComponent<Light>();
            if (emissiveRenderer == null) emissiveRenderer = GetComponent<Renderer>();
            _mpb = new MaterialPropertyBlock();

            if (bridge != null)
            {
                bridge.OnWelcome += HandleWelcome;
                bridge.OnZones += HandleZones;
            }
            Apply(new Color(0f, 0f, 0f), 0f); // 接続前は消灯
        }

        private void OnDestroy()
        {
            if (bridge != null)
            {
                bridge.OnWelcome -= HandleWelcome;
                bridge.OnZones -= HandleZones;
            }
        }

        private void HandleWelcome(WelcomeMsg msg)
        {
            for (int i = 0; i < msg.zones.Length; i++)
                if (msg.zones[i].id == zoneId) { _zoneIndex = i; return; }
            Debug.LogWarning($"AmbientZoneLight: unknown zoneId '{zoneId}'", this);
        }

        private void HandleZones(ZonesMsg msg)
        {
            _master = msg.master;
            foreach (var z in msg.zones)
            {
                if (z.id != zoneId) continue;
                // ホスト時計との差分（経過時間）だけを使い、ローカル時計に貼り直す
                _localSince = Time.time - (float)((msg.nowMs - z.sinceMs) / 1000.0);
                _state = z;
                return;
            }
        }

        private void Update()
        {
            if (_state == null) return;
            float level;
            Color color = EffectiveColor(Time.time, out level);
            Apply(color, level);
        }

        private void Apply(Color color, float level)
        {
            if (zoneLight != null)
            {
                zoneLight.color = color;
                zoneLight.intensity = level * maxLightIntensity;
            }
            if (emissiveRenderer != null)
            {
                emissiveRenderer.GetPropertyBlock(_mpb);
                _mpb.SetColor(EmissionColorId, color * (level * emissionIntensity));
                emissiveRenderer.SetPropertyBlock(_mpb);
            }
        }

        // ecu.js effectiveColor() と同じ式（level は 0..1 の実効輝度）
        private Color EffectiveColor(float now, out float level)
        {
            float t = now - _localSince;
            level = _state.brightness / 255f;
            var color = new Color(_state.r / 255f, _state.g / 255f, _state.b / 255f);

            switch ((AmbientEffect)_state.effect)
            {
                case AmbientEffect.Static:
                    break;
                case AmbientEffect.Breathe:
                {
                    float hz = _state.hz > 0f ? _state.hz : 0.4f;
                    float w = 0.5f + 0.5f * Mathf.Sin(2f * Mathf.PI * hz * t);
                    level *= 0.25f + 0.75f * w;
                    break;
                }
                case AmbientEffect.Pulse:
                {
                    float hz = _state.hz > 0f ? _state.hz : 1f;
                    float phase = (hz * t) % 1f;
                    level *= Mathf.Pow(Mathf.Max(0f, 1f - phase), 1.5f);
                    break;
                }
                case AmbientEffect.Wipe:
                {
                    float hz = _state.hz > 0f ? _state.hz : 0.8f;
                    float w = 0.5f + 0.5f * Mathf.Sin(2f * Mathf.PI * hz * t - _zoneIndex);
                    level *= 0.3f + 0.7f * w;
                    break;
                }
                case AmbientEffect.Flash:
                {
                    float hz = _state.hz > 0f ? _state.hz : 2f;
                    level *= Mathf.Sin(2f * Mathf.PI * hz * t) > 0f ? 1f : 0.05f;
                    break;
                }
                case AmbientEffect.Rainbow:
                {
                    float hue = (t * 60f + _zoneIndex * 40f) % 360f;
                    // JS 側は HSL(s=0.9, l=0.55)。HSV へ換算すると概ね S=0.85, V=0.95
                    color = Color.HSVToRGB(hue / 360f, 0.85f, 0.95f);
                    break;
                }
            }

            level = Mathf.Clamp01(level * _master);
            return color;
        }
    }
}
