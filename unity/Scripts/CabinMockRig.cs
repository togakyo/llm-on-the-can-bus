// CabinMockRig.cs — プリミティブだけで組む簡易車内モック
//
// 外部アセット不要で「車内らしい絵」を出すためのリグ。起動時に
//   - キャビン: 床 / ダッシュボード / センターコンソール / シート×2 / ドアパネル×2
//   - 7ゾーンの LEDストリップ（薄い発光ボックス）+ ポイントライト
// を生成し、各ストリップに AmbientZoneLight を取り付ける。
// Asset Store の車内モデルを使う場合はこのリグを外して手配置する（unity/README.md 参照）。

using UnityEngine;

namespace CanAiActuatorLab
{
    public class CabinMockRig : MonoBehaviour
    {
        [SerializeField] private float lightRange = 1.3f;

        // x=左右(+右) y=上下 z=前後(+前)
        private struct Strip
        {
            public string id;
            public Vector3 pos, scale, lightOffset;
            public Strip(string id, Vector3 pos, Vector3 scale, Vector3 lightOffset)
            { this.id = id; this.pos = pos; this.scale = scale; this.lightOffset = lightOffset; }
        }

        private static readonly Strip[] Strips =
        {
            new Strip("footwell_fl", new Vector3(-0.45f, 0.28f, 0.55f), new Vector3(0.50f, 0.02f, 0.05f), new Vector3(0f, -0.12f, -0.1f)),
            new Strip("footwell_fr", new Vector3(0.45f, 0.28f, 0.55f),  new Vector3(0.50f, 0.02f, 0.05f), new Vector3(0f, -0.12f, -0.1f)),
            new Strip("door_fl",     new Vector3(-0.94f, 0.78f, 0.10f), new Vector3(0.03f, 0.02f, 1.40f), new Vector3(0.12f, 0.05f, 0f)),
            new Strip("door_fr",     new Vector3(0.94f, 0.78f, 0.10f),  new Vector3(0.03f, 0.02f, 1.40f), new Vector3(-0.12f, 0.05f, 0f)),
            new Strip("dashboard",   new Vector3(0f, 1.04f, 0.80f),     new Vector3(1.70f, 0.02f, 0.05f), new Vector3(0f, 0.08f, -0.15f)),
            new Strip("console",     new Vector3(0f, 0.64f, 0.15f),     new Vector3(0.06f, 0.02f, 0.90f), new Vector3(0f, 0.12f, 0f)),
            new Strip("cupholder",   new Vector3(0.22f, 0.64f, -0.25f), new Vector3(0.12f, 0.02f, 0.12f), new Vector3(0f, 0.10f, 0f)),
        };

        private Material _trim;

        private void Awake()
        {
            _trim = new Material(FindLitShader()) { color = new Color(0.13f, 0.13f, 0.15f) };
            BuildCabin();
            BuildZones();
        }

        private void BuildCabin()
        {
            Block("floor",        new Vector3(0f, 0.10f, 0f),     new Vector3(2.1f, 0.05f, 3.0f), new Color(0.09f, 0.09f, 0.11f));
            Block("dashboard",    new Vector3(0f, 0.85f, 0.95f),  new Vector3(1.9f, 0.38f, 0.45f), null);
            Block("console",      new Vector3(0f, 0.42f, 0.10f),  new Vector3(0.34f, 0.42f, 1.20f), null);
            Block("door_l",       new Vector3(-1.02f, 0.70f, 0.1f), new Vector3(0.08f, 1.10f, 2.6f), null);
            Block("door_r",       new Vector3(1.02f, 0.70f, 0.1f),  new Vector3(0.08f, 1.10f, 2.6f), null);
            foreach (float x in new[] { -0.45f, 0.45f })
            {
                Block($"seat_base_{x}", new Vector3(x, 0.42f, -0.55f), new Vector3(0.55f, 0.24f, 0.60f), new Color(0.16f, 0.16f, 0.19f));
                Block($"seat_back_{x}", new Vector3(x, 0.82f, -0.86f), new Vector3(0.55f, 0.80f, 0.18f), new Color(0.16f, 0.16f, 0.19f));
            }
        }

        private void BuildZones()
        {
            foreach (var s in Strips)
            {
                var strip = GameObject.CreatePrimitive(PrimitiveType.Cube);
                strip.name = $"led_{s.id}";
                strip.transform.SetParent(transform, false);
                strip.transform.localPosition = s.pos;
                strip.transform.localScale = s.scale;
                Destroy(strip.GetComponent<Collider>());

                var renderer = strip.GetComponent<Renderer>();
                var mat = new Material(FindLitShader()) { color = new Color(0.05f, 0.05f, 0.06f) };
                mat.EnableKeyword("_EMISSION");
                renderer.material = mat;

                // 光源はストリップ本体から少し離す（幾何の内側に埋もれないように）
                var lightGo = new GameObject($"light_{s.id}");
                lightGo.transform.SetParent(transform, false);
                lightGo.transform.localPosition = s.pos + s.lightOffset;
                var light = lightGo.AddComponent<Light>();
                light.type = LightType.Point;
                light.range = lightRange;
                light.intensity = 0f;

                var zone = strip.AddComponent<AmbientZoneLight>();
                zone.zoneId = s.id;
                zone.SetOutputs(light, renderer);
            }
        }

        private void Block(string name, Vector3 pos, Vector3 scale, Color? color)
        {
            var block = GameObject.CreatePrimitive(PrimitiveType.Cube);
            block.name = name;
            block.transform.SetParent(transform, false);
            block.transform.localPosition = pos;
            block.transform.localScale = scale;
            Destroy(block.GetComponent<Collider>());
            block.GetComponent<Renderer>().material =
                color is Color c ? new Material(FindLitShader()) { color = c } : _trim;
        }

        private static Shader FindLitShader()
        {
            return Shader.Find("Universal Render Pipeline/Lit") ?? Shader.Find("Standard");
        }
    }
}
