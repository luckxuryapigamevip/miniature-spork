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
let session_odds = {};         // { sid: [odd, odd, ...] }
let last_logged = new Set();   // SID đã in log
let logged_results = {};       // { sid: {Phien, Ket_qua, Thoigian, id} }
let last_odd_time = {};        // { sid: timestamp }
let keep_alive_count = 1;

// Biến quản lý WebSocket
let ws = null;
let pingInterval = null;
let reconnectTimeout = null;
let isConnecting = false;

// 🔁 Kết nối WebSocket
function connectWebSocket() {
  if (isConnecting) return;
  isConnecting = true;

  console.log(`🔄 Đang kết nối tới WebSocket...`);
  
  ws = new WebSocket(URL, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Origin": "https://b52.vin"
    },
    handshakeTimeout: 10000 // Timeout bắt tay 10s
  });

  ws.on("open", () => {
    isConnecting = false;
    console.log("[✅] WebSocket đã kết nối thành công");

    // Thiết lập cơ chế Ping/Pong để giữ kết nối và phát hiện kết nối chết
    if (pingInterval) clearInterval(pingInterval);
    ws.isAlive = true;
    pingInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        if (ws.isAlive === false) {
          console.log("⚠️ Phát hiện kết nối chết (không có Pong). Đang đóng...");
          return ws.terminate(); // Kích hoạt sự kiện close
        }
        ws.isAlive = false;
        ws.ping(); // Gửi ping
      }
    }, 30000); // 30 giây

    // Gửi xác thực + plugin
    try {
      ws.send(JSON.stringify([
        1, "MiniGame", "", "", {
          agentId: "1",
          accessToken: "13-512bfa8983978c7d8d483a35b384ec8e",
          reconnect: false
        }
      ]));

      setTimeout(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify([6, "MiniGame", "lobbyPlugin", { cmd: 10002 }]));
      }, 1000);
      
      setTimeout(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify([6, "MiniGame", "aviatorPlugin", { cmd: 100000, f: true }]));
      }, 2000);
      
      setTimeout(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify([6, "MiniGame", "aviatorPlugin", { cmd: 100016 }]));
      }, 3000);
    } catch (err) {
      console.log("❌ Lỗi khi gửi dữ liệu khởi tạo:", err.message);
    }
  });

  ws.on("pong", () => {
    ws.isAlive = true; // Đánh dấu còn sống khi nhận Pong
  });

  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data);
      // Kiểm tra cấu trúc msg an toàn hơn
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
      // Bỏ qua log rác nếu data không phải JSON
    }
  });

  ws.on("close", (code, reason) => {
    isConnecting = false;
    if (pingInterval) clearInterval(pingInterval);
    console.log(`🔌 WebSocket ngắt (Code: ${code}, Lý do: ${reason || 'Không có'}). Thử kết nối lại sau 3s...`);
    
    if (reconnectTimeout) clearTimeout(reconnectTimeout);
    reconnectTimeout = setTimeout(connectWebSocket, 3000);
  });

  ws.on("error", (err) => {
    // Không log lỗi ECONNRESET liên tục để đỡ rác log
    if (err.code !== 'ECONNRESET') {
      console.log("❌ WebSocket lỗi:", err.message);
    }
  });
}

// ⏱ Theo dõi phiên đã nổ (idle > 2s), log & lưu kết quả
setInterval(() => {
  const now = Date.now();
  Object.keys(session_odds).forEach((sid) => {
    if (!last_logged.has(sid) && now - (last_odd_time[sid] || 0) > 2000) {
      // Sử dụng try/catch phòng hờ mảng rỗng
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

      // 🧹 Dọn dẹp bộ nhớ (Memory Leak) - Chỉ giữ lại 50 phiên gần nhất
      delete session_odds[sid];
      delete last_odd_time[sid];
      if (last_logged.size > 100) {
        const arr = Array.from(last_logged);
        last_logged = new Set(arr.slice(-50));
      }
      
      const resultKeys = Object.keys(logged_results);
      if (resultKeys.length > 50) {
        const sortedKeys = resultKeys.sort((a, b) => Number(a) - Number(b));
        for (let i = 0; i < sortedKeys.length - 50; i++) {
          delete logged_results[sortedKeys[i]];
        }
      }
    }
  });
}, 500);

// 📶 KeepAlive (Dành cho logic game)
setInterval(() => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify(["7", "MiniGame", "1", keep_alive_count++]));
      console.log(`📶 KeepAlive lần ${keep_alive_count}`);
    } catch (e) {
      console.log("Lỗi gửi KeepAlive:", e.message);
    }
  }
}, 10000);

// 🛡 Ngừa sleep khi deploy (Render/Railway) - TỰ PING CHÍNH MÌNH
// Render sẽ tắt app nếu không có HTTP request sau 15 phút. 
// Hàm này tự gọi API của chính mình mỗi 10 phút để giữ app luôn thức.
setInterval(() => {
  if (SELF_URL && SELF_URL.includes("http")) {
    axios.get(`${SELF_URL}/api/latest`)
      .then(() => console.log("🛡 Đã tự ping giữ server thức (Anti-sleep)"))
      .catch((err) => console.log("🛡 Lỗi tự ping Anti-sleep:", err.message));
  }
}, 10 * 60 * 1000); // 10 phút

// 📡 API: /api/latest ➜ phiên đã nổ mới nhất
app.get("/api/latest", (req, res) => {
  const sids = Object.keys(logged_results);
  if (sids.length === 0) return res.json({ message: "Chưa có phiên nào nổ" });

  const latest_sid = Math.max(...sids.map(Number));
  res.json(logged_results[latest_sid]);
});

// 📡 API: /api/history ➜ 10 phiên đã nổ gần nhất
app.get("/api/history", (req, res) => {
  const sids = Object.keys(logged_results)
    .map(Number)
    .sort((a, b) => b - a)
    .slice(0, 10);

  const result = sids.map((sid) => logged_results[sid]);
  res.json(result);
});

// 📡 API: /
app.get("/", (req, res) => {
  res.json({
    status: "Aviator đang chạy",
    tong_phien: Object.keys(session_odds).length,
    da_no: last_logged.size,
    memory: process.memoryUsage().heapUsed / 1024 / 1024 + " MB"
  });
});

// Xử lý tắt server an toàn (SIGTERM từ Render)
process.on('SIGTERM', () => {
  console.log('⚠️ Nhận SIGTERM, đang đóng server an toàn...');
  if (ws) ws.close();
  if (pingInterval) clearInterval(pingInterval);
  if (reconnectTimeout) clearTimeout(reconnectTimeout);
  process.exit(0);
});

// 🚀 Start Server + WebSocket
app.listen(PORT, () => {
  console.log(`🚀 Server đang chạy tại port ${PORT}`);
  console.log(`🌐 SELF_URL: ${SELF_URL}`);
  connectWebSocket();
});
