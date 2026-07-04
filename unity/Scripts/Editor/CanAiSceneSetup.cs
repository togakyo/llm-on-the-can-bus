// CanAiSceneSetup.cs — メニュー一発でデバッグシーンを構築するエディタ拡張
//
// メニュー「CAN-AI → Set Up Debug Scene」で、
//   - CanBridge（CanBridgeClient + BridgeDebugHud + VehicleStateReporter + ZonePlaceholderRig）
//   - 車内らしい暗めの環境光とカメラ位置（運転席の少し後ろ）
// を現在のシーンにセットアップする。Play を押せばそのまま動く。

using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.Rendering;

namespace CanAiActuatorLab
{
    public static class CanAiSceneSetup
    {
        [MenuItem("CAN-AI/Set Up Debug Scene")]
        public static void SetUp()
        {
            ApplyEnvironment();

            if (Object.FindObjectOfType<CanBridgeClient>() == null)
            {
                var go = new GameObject("CanBridge");
                go.AddComponent<CanBridgeClient>();
                go.AddComponent<BridgeDebugHud>();
                go.AddComponent<VehicleStateReporter>();
                go.AddComponent<ZonePlaceholderRig>();
                Undo.RegisterCreatedObjectUndo(go, "Set Up CAN-AI Debug Scene");
            }

            EditorSceneManager.MarkSceneDirty(EditorSceneManager.GetActiveScene());
            Debug.Log("CAN-AI: セットアップ完了。`npm run bridge` を起動して Play してください" +
                      "（発光ゾーンは Play 時に生成されます）");
        }

        // 環境光とカメラは再実行時も毎回適用する（設定調整をメニューで反映できるように）
        private static void ApplyEnvironment()
        {
            // 夜の車内らしく: 環境光を落とし、ゾーン照明が映えるようにする
            // （真っ黒だと動作しているのか分からないので、輪郭が見える程度は残す）
            RenderSettings.ambientMode = AmbientMode.Flat;
            RenderSettings.ambientLight = new Color(0.13f, 0.14f, 0.17f);
            var sun = Object.FindObjectOfType<Light>();
            if (sun != null && sun.type == LightType.Directional) sun.intensity = 0.15f;

            // 運転席の少し後ろからダッシュボード方向を見るカメラ
            var cam = Camera.main;
            if (cam != null)
            {
                cam.transform.position = new Vector3(0f, 1.15f, -1.3f);
                cam.transform.LookAt(new Vector3(0f, 0.55f, 0.5f));
                cam.clearFlags = CameraClearFlags.SolidColor;
                cam.backgroundColor = new Color(0.03f, 0.03f, 0.05f);
            }
        }
    }
}
