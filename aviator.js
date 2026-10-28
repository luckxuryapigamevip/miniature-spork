const express = require("express");
const WebSocket = require("ws");
const cors = require("cors");
const axios = require("axios");

const app = express();
app.use(cors());

const PORT = process.env.PORT || 5000;
const SELF_URL = process.env.SELF_URL || `http://localhost:${PORT}`;
const URL = "wss://minybordergs.weskb5gams.net/websocket";

// Dữ liệu chính
let session_odds = {};         
let last_logged = new Set();   
let logged_results = {};       
let last_odd_time = {};        
let keep_alive_count = 1;

// Quản lý WebSocket
let ws = null;
let reconnectTimeout = null;
let isConnecting = false;
let isAuthenticated = false; // Cờ xác nhận đã đăng nhập thành công
let reconnectAttempts = 0;   // Đếm số lần thử lại

// Hàm hỗ trợ delay
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// 🔁 Hàm kết nối WebSocket
function connectWebSocket() {
  if (isConnecting) return;
  isConnecting = true;
  isAuthenticated = false; // Reset cờ xác thực mỗi lần kết nối

  console.log(`\n🔄 [${new Date().toLocaleTimeString()}] Đang kết nối tới WebSocket... (Lần thử: ${reconnectAttempts + 1})`);
  
  // Thêm Header giả lập trình duyệt để lừa server B52
  ws = new WebSocket(URL, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Origin": "https://b52.vin",
      "Referer": "https://b52.vin/",
      "Accept-Language": "vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7",
      "Pragma": "no-cache",
      "Cache-Control": "no-cache"
    },
    handshakeTimeout: 15000
  });

  ws.on("open", async () => {
    isConnecting = false;
    console.log("[✅] WebSocket đã kết nối thành công. Đang chờ 1s...");
    
    // Chờ 1 giây cho ổn định mạng
    await sleep(1000);
    if (ws.readyState !== WebSocket.OPEN) return;

    // Gửi gói xác thực
    console.log("📤 Gửi gói xác thực (Auth)...");
    try {
      ws.send(JSON.stringify([
        1, "MiniGame", "", "", {
          agentId: "1",
          accessToken: "13-512bfa8983978c7d8d483a35b384ec8e",
          reconnect: false
        }
      ]));
    } catch (e) {
      console.log("❌ Lỗi gửi Auth:", e.message);
    }

    // Chờ tiếp 1.5s mới gửi các gói khác để tránh dồn dập
    await sleep(1500);
    if (ws.readyState !== WebSocket.OPEN) return;

    console.log("📤 Gửi gói LobbyPlugin...");
    ws.send(JSON.stringify([6, "MiniGame", "lobbyPlugin", { cmd: 10002 }]));

    await sleep(1000);
    if (ws.readyState !== WebSocket.OPEN) return;

    console.log("📤 Gửi gói AviatorPlugin...");
    ws.send(JSON.stringify([6, "MiniGame", "aviatorPlugin", { cmd: 100000, f: true }]));

    await sleep(1000);
    if (ws.readyState !== WebSocket.OPEN) return;

    console.log("📤 Gửi gói lấy lịch sử...");
    ws.send(JSON.stringify([6, "MiniGame", "aviatorPlugin", { cmd: 100016 }]));

    // Đánh dấu đã vào phòng thành công, bắt đầu cho phép KeepAlive
    isAuthenticated = true;
    reconnectAttempts = 0; // Kết nối thành công thì reset bộ đếm
    console.log("✅ Đã gửi xong toàn bộ gói tin khởi tạo. Chuyển sang trạng thái nhận data.");
  });

  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data);
      if (!Array.isArray(msg) || msg.length < 2 || typeof msg[1] !== "object" || msg[1] === null) return;

      const payload = msg[1];
      const cmd = payload.cmd;
      const sid = payload.sid;
      const odd = payload.odd;

      if (cmd === 100009 && sid && typeof odd === "number") {
        if (!session_odds[sid]) session_odds[sid] = [];
        session_odds[sid].push(odd);
        last_odd_time[sid] = Date.now();
      }
    } catch (e) {
      // Bỏ qua lỗi parse
    }
  });

  ws.on("close", (code, reason) => {
    isConnecting = false;
    isAuthenticated = false;
    const reasonStr = reason ? reason.toString() : "Không có lý do";
    console.log(`🔌 WebSocket ngắt (Code: ${code}, Lý do: ${reasonStr}).`);
    
    reconnectAttempts++;
    // Nếu lỗi 1006 liên tục, tăng thời gian chờ (tối đa 30s) để tránh spam
    const delay = Math.min(5000 * reconnectAttempts, 30000);
    console.log(`⏳ Chờ ${delay / 1000}s để kết nối lại (Tránh spam IP)...`);
    
    if (reconnectTimeout) clearTimeout(reconnectTimeout);
    reconnectTimeout = setTimeout(connectWebSocket, delay);
  });

  ws.on("error", (err) => {
    if (err.code !== 'ECONNRESET') {
      console.log("❌ WebSocket lỗi:", err.message);
    }
  });
}

// 📶 KeepAlive (Chỉ gửi khi ĐÃ XÁC THỰC THÀNH CÔNG)
setInterval(() => {
  if (ws && ws.readyState === WebSocket.OPEN && isAuthenticated) {
    try {
      ws.send(JSON.stringify(["7", "MiniGame", "1", keep_alive_count++]));
      console.log(`📶 KeepAlive JSON lần ${keep_alive_count}`);
    } catch (e) {
      console.log("❌ Lỗi gửi KeepAlive:", e.message);
    }
  }
}, 10000);

// ⏱ Theo dõi phiên đã nổ (idle > 2s)
setInterval(() => {
  const now = Date.now();
  Object.keys(session_odds).forEach((sid) => {
    if (!last_logged.has(sid) && now - (last_odd_time[sid] || 0) > 2000) {
      if (!session_odds[sid] || session_odds[sid].length === 0) return;
      
      const max_odd = Math.max(...session_odds[sid]);
      const time_str = new Date(now).toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" });

      console.log(`[✈️💥] Máy bay NỔ ➜ SID: ${sid} | ODD: ${max_odd.toFixed(2)}x | ${time_str}`);
      last_logged.add(sid);

      logged_results[sid] = {
        Phien: parseInt(sid),
        Ket_qua: max_odd.toFixed(2),
        Thoigian: time_str,
        id: "hknamvip"
      };

      // Dọn dẹp bộ nhớ
      delete session_odds[sid];
      delete last_odd_time[sid];
      
      const resultKeys = Object.keys(logged_results);
      if (resultKeys.length > 50) {
        const sortedKeys = resultKeys.map(Number).sort((a, b) => a - b);
        for (let i = 0; i < sortedKeys.length - 50; i++) {
          delete logged_results[sortedKeys[i]];
        }
      }
    }
  });
}, 1000);

// 🛡 Chống Render sleep
setInterval(() => {
  if (SELF_URL && SELF_URL.startsWith("http") && !SELF_URL.includes("localhost")) {
    axios.get(`${SELF_URL}/api/latest`)
      .then(() => console.log("🛡 Anti-sleep: Đã tự ping giữ Render thức"))
      .catch((err) => console.log("🛡 Anti-sleep Lỗi:", err.message));
  }
}, 10 * 60 * 1000); // 10 phút

// 📡 API Endpoints
app.get("/api/latest", (req, res) => {
  const sids = Object.keys(logged_results);
  if (sids.length === 0) return res.json({ message: "Chưa có phiên nào nổ" });
  const latest_sid = Math.max(...sids.map(Number));
  res.json(logged_results[latest_sid]);
});

app.get("/api/history", (req, res) => {
  const sids = Object.keys(logged_results).map(Number).sort((a, b) => b - a).slice(0, 10);
  res.json(sids.map((sid) => logged_results[sid]));
});

app.get("/", (req, res) => {
  res.json({
    status: "Aviator đang chạy",
    ws_state: ws ? (ws.readyState === WebSocket.OPEN ? (isAuthenticated ? "Đã kết nối & Xác thực" : "Đang xác thực...") : "Đang ngắt kết nối") : "Chưa khởi tạo",
    da_no: last_logged.size,
    memory: (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2) + " MB"
  });
});

// Tắt server an toàn
process.on('SIGTERM', () => {
  if (ws) ws.close();
  if (reconnectTimeout) clearTimeout(reconnectTimeout);
  process.exit(0);
});

// 🚀 Start Server
app.listen(PORT, () => {
  console.log(`🚀 Server đang chạy tại port ${PORT}`);
  connectWebSocket();
});
