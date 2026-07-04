// CanBridgeClient.cs — ヘッドレスホスト（scripts/unity-bridge.mjs）との UDP 接続
//
// 受信は背景スレッドでブロッキング、Update() でメインスレッドに引き渡して
// C# イベントとして配信する。1 秒ごとの hello がキープアライブを兼ねる。
// Unity はあくまで「信頼されない表示装置」: 安全審査は全部ホスト側で行われる。

using System;
using System.Collections.Concurrent;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using UnityEngine;

namespace CanAiActuatorLab
{
    public class CanBridgeClient : MonoBehaviour
    {
        [SerializeField] private string host = "127.0.0.1";
        [SerializeField] private int port = 9200;

        public event Action<WelcomeMsg> OnWelcome;
        public event Action<ZonesMsg> OnZones;
        public event Action<EventMsg> OnEvent;
        public event Action<FrameMsg> OnFrame;
        public event Action<ResultMsg> OnResult;

        public bool Connected { get; private set; }
        public string PolicyVersion { get; private set; } = "";

        private UdpClient _udp;
        private Thread _rx;
        private volatile bool _running;
        private readonly ConcurrentQueue<string> _inbox = new ConcurrentQueue<string>();
        private float _nextHello;

        private void Awake()
        {
            _udp = new UdpClient();
            _udp.Connect(host, port);
            _running = true;
            _rx = new Thread(ReceiveLoop) { IsBackground = true, Name = "CanBridgeRx" };
            _rx.Start();
        }

        private void ReceiveLoop()
        {
            var remote = new IPEndPoint(IPAddress.Any, 0);
            while (_running)
            {
                try
                {
                    byte[] bytes = _udp.Receive(ref remote);
                    _inbox.Enqueue(Encoding.UTF8.GetString(bytes));
                }
                catch (SocketException)
                {
                    // ホスト未起動時の ICMP 到達不能など。接続確立前は正常系なので
                    // 少し待ってから受信を再開する（ビジーループ防止）
                    Thread.Sleep(200);
                }
                catch (ObjectDisposedException)
                {
                    return; // OnDestroy でクローズ済み
                }
            }
        }

        private void Update()
        {
            if (Time.unscaledTime >= _nextHello)
            {
                SendRaw(JsonUtility.ToJson(new HelloMsg()));
                _nextHello = Time.unscaledTime + 1f;
            }
            while (_inbox.TryDequeue(out string json)) Dispatch(json);
        }

        private void Dispatch(string json)
        {
            MsgProbe probe;
            try { probe = JsonUtility.FromJson<MsgProbe>(json); }
            catch { return; }

            switch (probe?.type)
            {
                case "welcome":
                    var welcome = JsonUtility.FromJson<WelcomeMsg>(json);
                    Connected = true;
                    PolicyVersion = welcome.policyVersion;
                    OnWelcome?.Invoke(welcome);
                    break;
                case "zones":
                    OnZones?.Invoke(JsonUtility.FromJson<ZonesMsg>(json));
                    break;
                case "event":
                    OnEvent?.Invoke(JsonUtility.FromJson<EventMsg>(json));
                    break;
                case "frame":
                    OnFrame?.Invoke(JsonUtility.FromJson<FrameMsg>(json));
                    break;
                case "result":
                    OnResult?.Invoke(JsonUtility.FromJson<ResultMsg>(json));
                    break;
            }
        }

        // --- 送信 API ------------------------------------------------------

        public void SendIntent(string text, bool useLlm = false)
        {
            if (string.IsNullOrWhiteSpace(text)) return;
            SendRaw(JsonUtility.ToJson(new IntentMsg { text = text.Trim(), mode = useLlm ? "llm" : "heuristic" }));
        }

        public void SendEstop() => SendRaw(JsonUtility.ToJson(new EstopMsg()));

        public void SendVehicle(int speedKmh, int gear, bool doorOpen, int ignition = 1)
        {
            SendRaw(JsonUtility.ToJson(new VehicleMsg
            {
                speedKmh = speedKmh,
                gear = gear,
                doors = doorOpen ? 1 : 0,
                ignition = ignition,
            }));
        }

        private void SendRaw(string json)
        {
            try
            {
                byte[] bytes = Encoding.UTF8.GetBytes(json);
                _udp.Send(bytes, bytes.Length);
            }
            catch (SocketException) { }
            catch (ObjectDisposedException) { }
        }

        private void OnDestroy()
        {
            _running = false;
            _udp?.Close(); // Receive() をブロック解除して受信スレッドを終わらせる
        }
    }
}
