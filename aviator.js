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

let ws = null;
let reconnectTimeout = null;
let isConnecting = false;

// 🔁 Hàm kết nối WebSocket
function connectWebSocket() {
  if (isConnecting) return;
  isConnecting = true;

  console.log(`🔄 [${new Date().toLocaleTimeString()}] Đang kết nối tới WebSocket...`);
  
  // Khởi tạo kết nối với header giả lập trình duyệt
  ws = new WebSocket(URL, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Origin": "https://b52.vin"
    },
    handshakeTimeout: 15000 // Tăng timeout lên 15s
  });

  ws.on("open", () => {
    isConnecting = false;
    console.log("[✅] WebSocket đã kết nối thành công");

    // SỬA LỖI 1: Delay 500ms trước khi gửi gói tin đầu tiên để tránh bị block
    setTimeout(() => {
      if (ws.readyState !== WebSocket.OPEN) return;
      
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

      // SỬA LỖI 2: Delay giãn cách các gói tin ra (1.5s, 3s, 4.5s) thay vì dồn dập
      setTimeout(() => {
        if (ws.readyState === WebSocket.OPEN) {
          console.log("📤 Gửi gói LobbyPlugin...");
          ws.send(JSON.stringify([6, "MiniGame", "lobbyPlugin", { cmd: 10002 }]));
        }
      }, 1500);
      
      setTimeout(() => {
        if (ws.readyState === WebSocket.OPEN) {
          console.log("📤 Gửi gói AviatorPlugin...");
          ws.send(JSON.stringify([6, "MiniGame", "aviatorPlugin", { cmd: 100000, f: true }]));
        }
      }, 3000);
      
      setTimeout(() => {
        if (ws.readyState === WebSocket.OPEN) {
          console.log("📤 Gửi gói lấy lịch sử...");
          ws.send(JSON.stringify([6, "MiniGame", "aviatorPlugin", { cmd: 100016 }]));
        }
      }, 4500);

    }, 500);
  });

  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data);
      if (!Array.isArray(msg) || msg.length < 2 || typeof msg[1] !== "object" || msg[1] === null) return;

      const payload = msg[1];
      const cmd = payload.cmd;
      const sid = payload.sid;
      const odd = payload.odd;

      // Nhận data phiên
      if (cmd === 100009 && sid && typeof odd === "number") {
        if (!session_odds[sid]) session_odds[sid] = [];
        session_odds[sid].push(odd);
        last_odd_time[sid] = Date.now();
      }
      
      // Nếu có sự kiện pong từ server trả về (nếu có)
      if (cmd === "pong") {
        ws.isAlive = true;
      }
    } catch (e) {
      // Bỏ qua lỗi parse JSON
    }
  });

  ws.on("close", (code, reason) => {
    isConnecting = false;
    const reasonStr = reason ? reason.toString() : "Không có lý do";
    console.log(`🔌 WebSocket ngắt (Code: ${code}, Lý do: ${reasonStr}).`);
    
    // SỬA LỖI 3: Nếu lỗi 1006, chờ lâu hơn một chút (5s) để tránh spam server đích
    const delay = code === 1006 ? 5000 : 3000;
    console.log(`⏳ Chờ ${delay / 1000}s để kết nối lại...`);
    
    if (reconnectTimeout) clearTimeout(reconnectTimeout);
    reconnectTimeout = setTimeout(connectWebSocket, delay);
  });

  ws.on("error", (err) => {
    // Ẩn lỗi ECONNRESET để log đỡ rác
    if (err.code !== 'ECONNRESET') {
      console.log("❌ WebSocket lỗi:", err.message);
    }
  });
}

// 🕒 Interval kiểm tra kết nối sống/chết (Heartbeat nội bộ)
// Thay vì dùng ws.ping() (dễ bị kick), ta kiểm tra bằng cờ isAlive
setInterval(() => {
  if (!ws) return;
  
  if (ws.readyState === WebSocket.OPEN) {
    // Nếu đã 35s không có tin nhắn nào (last_odd_time rỗng) => Server có thể đã treo
    // Tuy nhiên ta ưu tiên dùng KeepAlive bằng JSON bên dưới.
  } else if (ws.readyState === WebSocket.CLOSED) {
    // Tự động gọi kết nối nếu bị đóng mà chưa có lệnh reconnect
    if (!reconnectTimeout && !isConnecting) {
      connectWebSocket();
    }
  }
}, 15000);

// 📶 KeepAlive (Gửi tin nhắn JSON chuẩn của game thay vì Ping/Pong TCP)
setInterval(() => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify(["7", "MiniGame", "1", keep_alive_count++]));
      console.log(`📶 KeepAlive JSON lần ${keep_alive_count} (Giữ kết nối)`);
    } catch (e) {
      console.log("❌ Lỗi gửi KeepAlive:", e.message);
    }
  }
}, 10000); // 10 giây 1 lần

// ⏱ Theo dõi phiên đã nổ (idle > 3s), log & lưu kết quả
setInterval(() => {
  const now = Date.now();
  Object.keys(session_odds).forEach((sid) => {
    // Nếu phiên không có data mới trong 3s => Máy bay đã nổ
    if (!last_logged.has(sid) && now - (last_odd_time[sid] || 0) > 3000) {
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

      // Dọn dẹp bộ nhớ (Memory Leak)
      delete session_odds[sid];
      delete last_odd_time[sid];
      
      // Chỉ giữ lại 50 kết quả gần nhất
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

// 🛡 Anti-sleep (Chống Render tắt app sau 15 phút)
setInterval(() => {
  // Kiểm tra SELF_URL hợp lệ và bắt đầu bằng http (tránh localhost)
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
  const sids = Object.keys(logged_results)
    .map(Number)
    .sort((a, b) => b - a)
    .slice(0, 10);
  const result = sids.map((sid) => logged_results[sid]);
  res.json(result);
});

app.get("/", (req, res) => {
  res.json({
    status: "Aviator đang chạy",
    ws_state: ws ? (ws.readyState === WebSocket.OPEN ? "Đã kết nối" : "Đang ngắt kết nối") : "Chưa khởi tạo",
    tong_phien_dang_theo_doi: Object.keys(session_odds).length,
    da_no: last_logged.size,
    memory: (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2) + " MB"
  });
});

// Tắt server an toàn
process.on('SIGTERM', () => {
  console.log('⚠️ Nhận SIGTERM, đóng server...');
  if (ws) ws.close();
  if (reconnectTimeout) clearTimeout(reconnectTimeout);
  process.exit(0);
});

// 🚀 Start Server
app.listen(PORT, () => {
  console.log(`🚀 Server đang chạy tại port ${PORT}`);
  console.log(`🌐 SELF_URL: ${SELF_URL}`);
  connectWebSocket();
});
