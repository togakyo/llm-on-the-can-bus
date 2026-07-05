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

            var client = Object.FindObjectOfType<CanBridgeClient>();
            var go = client != null ? client.gameObject : new GameObject("CanBridge");
            if (client == null)
            {
                go.AddComponent<CanBridgeClient>();
                Undo.RegisterCreatedObjectUndo(go, "Set Up CAN-AI Debug Scene");
            }
            Ensure<BridgeDebugHud>(go);
            Ensure<VehicleStateReporter>(go);

            // 車内リグ: 旧プレースホルダー（球のみ）は CabinMockRig に置き換える
            var placeholder = go.GetComponent<ZonePlaceholderRig>();
            if (placeholder != null) Undo.DestroyObjectImmediate(placeholder);
            Ensure<CabinMockRig>(go);

            EditorSceneManager.MarkSceneDirty(EditorSceneManager.GetActiveScene());
            Debug.Log("CAN-AI: セットアップ完了。`npm run bridge` を起動して Play してください" +
                      "（車内モックと発光ゾーンは Play 時に生成されます）");
        }

        // プロモ/README 用: 自動デモ進行 + フレーム録画（DemoDirector）を追加する
        [MenuItem("CAN-AI/Set Up Demo Recording")]
        public static void SetUpDemoRecording()
        {
            SetUp();
            var go = Object.FindObjectOfType<CanBridgeClient>().gameObject;
            Ensure<DemoDirector>(go);
            EditorSceneManager.MarkSceneDirty(EditorSceneManager.GetActiveScene());
            Debug.Log("CAN-AI: 録画準備完了。Game ビューの解像度を 1280x720 等に固定し、" +
                      "`npm run bridge` を起動してから Play すると Recordings/ に連番PNGが出ます");
        }

        private static void Ensure<T>(GameObject go) where T : Component
        {
            if (go.GetComponent<T>() == null) Undo.AddComponent<T>(go);
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

            // 後席上方からダッシュボード方向を見下ろすカメラ
            // （シート背もたれ(高さ~1.2m)より上に置かないと車内が遮られる）
            var cam = Camera.main;
            if (cam != null)
            {
                cam.transform.position = new Vector3(0f, 1.65f, -1.95f);
                cam.transform.LookAt(new Vector3(0f, 0.45f, 0.6f));
                cam.fieldOfView = 55f;
                cam.clearFlags = CameraClearFlags.SolidColor;
                cam.backgroundColor = new Color(0.03f, 0.03f, 0.05f);
            }
        }
    }
}
