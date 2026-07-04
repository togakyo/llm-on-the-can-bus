// ZonePlaceholderRig.cs — 車内モデルなしで即動かすためのプレースホルダー
//
// 起動時に 7 ゾーン分の発光球 + ポイントライトを車内らしい配置で生成し、
// AmbientZoneLight を取り付ける。車の 3D モデルを用意したらこのコンポーネントを
// 外し、モデル内の各位置に AmbientZoneLight を手で配置する。

using UnityEngine;

namespace CanAiActuatorLab
{
    public class ZonePlaceholderRig : MonoBehaviour
    {
        [SerializeField] private CanBridgeClient bridge;
        [SerializeField] private float sphereScale = 0.15f;

        // x=左右(+右) y=上下 z=前後(+前)。運転席まわりのざっくり配置
        private static readonly (string id, Vector3 pos)[] Layout =
        {
            ("footwell_fl", new Vector3(-0.45f, 0.15f, 0.35f)),
            ("footwell_fr", new Vector3(0.45f, 0.15f, 0.35f)),
            ("door_fl",     new Vector3(-0.85f, 0.65f, 0.15f)),
            ("door_fr",     new Vector3(0.85f, 0.65f, 0.15f)),
            ("dashboard",   new Vector3(0f, 0.95f, 0.75f)),
            ("console",     new Vector3(0f, 0.45f, 0.05f)),
            ("cupholder",   new Vector3(0.25f, 0.45f, -0.15f)),
        };

        private void Awake()
        {
            if (bridge == null) bridge = FindObjectOfType<CanBridgeClient>();

            CreateFloor();

            foreach (var (id, pos) in Layout)
            {
                var sphere = GameObject.CreatePrimitive(PrimitiveType.Sphere);
                sphere.name = $"zone_{id}";
                sphere.transform.SetParent(transform, false);
                sphere.transform.localPosition = pos;
                sphere.transform.localScale = Vector3.one * sphereScale;
                Destroy(sphere.GetComponent<Collider>());

                // エミッシブ有効の専用マテリアル（URP → ビルトインの順でシェーダを探す）
                // ベース色は「消灯時でも位置がわかる」薄いグレー
                var renderer = sphere.GetComponent<Renderer>();
                var mat = new Material(FindLitShader()) { color = new Color(0.24f, 0.25f, 0.28f) };
                mat.EnableKeyword("_EMISSION");
                renderer.material = mat;

                var light = sphere.AddComponent<Light>();
                light.type = LightType.Point;
                light.range = 1.6f;
                light.intensity = 0f;

                var zone = sphere.AddComponent<AmbientZoneLight>();
                zone.zoneId = id;
            }
        }

        // 位置関係がわかるように暗い床（フロアマット相当）を敷く
        private void CreateFloor()
        {
            var floor = GameObject.CreatePrimitive(PrimitiveType.Plane);
            floor.name = "cabin_floor";
            floor.transform.SetParent(transform, false);
            floor.transform.localScale = new Vector3(0.3f, 1f, 0.3f); // Plane は 10m 基準 → 3m 四方
            floor.GetComponent<Renderer>().material =
                new Material(FindLitShader()) { color = new Color(0.09f, 0.09f, 0.11f) };
        }

        private static Shader FindLitShader()
        {
            return Shader.Find("Universal Render Pipeline/Lit") ?? Shader.Find("Standard");
        }
    }
}
