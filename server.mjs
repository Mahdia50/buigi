import crypto from "node:crypto";
import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import dns from "node:dns";
import { fileURLToPath } from "node:url";

dns.setDefaultResultOrder("ipv4first");

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, "public");
const QUESTIONS_MODULE = path.join(__dirname, "public", "assets", "questions-FaeiPOAe.js");

// تحميل الأسئلة والفئات من موديول التطبيق
let questions = [];
let mainCategories = [];
let allCategories = [];

try {
  const qMod = await import(QUESTIONS_MODULE);
  questions = qMod.r || [];
  mainCategories = qMod.n || [];
  allCategories = qMod.t || [];
  console.log(`[INFO] تم تحميل بنك الأسئلة المدمج: ${questions.length} سؤال، ${allCategories.length} فئة.`);
} catch (e) {
  console.warn("[WARN] تعذر قراءة موديول الأسئلة من JS، جاري محاولة التحميل من JSON:", e.message);
  try {
    const jsonBank = JSON.parse(fs.readFileSync(path.join(__dirname, "data", "questions_bank_complete.json"), "utf8"));
    const jsonManifest = JSON.parse(fs.readFileSync(path.join(__dirname, "data", "categories_manifest.json"), "utf8"));
    questions = jsonBank.questions || [];
    allCategories = (jsonManifest.categories || []).map(c => ({
      id: c.category_id,
      name: c.category_name,
      emoji: c.emoji
    }));
    mainCategories = allCategories.slice(0, 6);
    console.log(`[INFO] تم تحميل بنك الأسئلة من JSON بنجاح: ${questions.length} سؤال، ${allCategories.length} فئة.`);
  } catch (err2) {
    console.error("[ERROR] تعذر تحميل بنك الأسئلة من JSON أيضاً:", err2.message);
  }
}

// تخزين الغرف المباشرة في الذاكرة
const rooms = new Map();

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
};

// إنشاء غرفة جديدة مع لوحة الأسئلة والمضيف
function createRoomInstance(payload = {}, hostGuestId = "", hostName = "") {
  const code = Math.random().toString(36).substring(2, 6).toUpperCase();

  // اختيار الفئات المحددة أو الافتراضية (6 فئات)
  let selectedCategories = payload.categories;
  if (!selectedCategories || !Array.isArray(selectedCategories) || selectedCategories.length < 3) {
    selectedCategories = (mainCategories || []).slice(0, 6).map(c => c.id);
  }

  // بناء اللوحة: الفئات المحددة × 5 مستويات صعوبة (100، 200، 300، 400، 500)
  const board = [];
  for (const catId of selectedCategories) {
    const cells = [];
    for (const val of [100, 200, 300, 400, 500]) {
      let matching = questions.filter(q => (q.category === catId || q.category_id === catId) && (q.value === val || q.points === val));
      if (matching.length === 0) {
        matching = questions.filter(q => q.category === catId || q.category_id === catId);
      }
      const q = matching.length > 0
        ? matching[Math.floor(Math.random() * matching.length)]
        : { id: `q-${catId}-${val}`, category: catId, value: val };

      cells.push({
        key: `${catId}:${val}`,
        value: val,
        questionId: q.id,
      });
    }
    board.push({
      categoryId: catId,
      cells,
    });
  }

  const effectiveHostGuestId = hostGuestId || `g-${Date.now()}`;
  const effectiveHostName = (hostName || payload.name || "المشرف").trim();

  const hostPlayer = {
    id: "p-" + Math.random().toString(36).slice(2, 8),
    user_id: effectiveHostGuestId,
    name: effectiveHostName,
    role: "host",
    team: "red",
    ready: true,
    captain: true,
    connected: true,
    last_seen: Date.now(),
    vote: null,
  };

  const newRoom = {
    code,
    name: payload.name || `غرفة ${code}`,
    status: "lobby", // "lobby" | "playing" | "finished"
    visibility: payload.visibility || "public",
    passcode: payload.passcode || "",
    max_players: Number(payload.maxPlayers) || 8,
    settings: {
      answerTime: Number(payload.settings?.answerTime) || 30,
      voteMode: !!payload.settings?.voteMode,
      lifelineUses: Number(payload.settings?.lifelineUses) || 1,
      lifelines: payload.settings?.lifelines || { double: true, call: true, pit: true, rest: false },
      categories: selectedCategories,
    },
    turn: "red",
    scores: { red: 0, green: 0 },
    board,
    used: [],
    current: null,
    paused: false,
    chat_open: true,
    log: [
      {
        id: "log-" + Date.now(),
        reason: "إنشاء الغرفة",
        delta: 0,
        text: `تم إنشاء الغرفة «${payload.name || code}» بنجاح`,
        time: Date.now(),
      },
    ],
    messages: [
      {
        id: "msg-" + Date.now(),
        name: "النظام",
        content: `مرحباً بكم في «${payload.name || "غرفة " + code}»! 🇲🇦`,
        team: "all",
        kind: "system",
        time: Date.now(),
      },
    ],
    players: [hostPlayer],
    connections: new Set(),
    createdAt: Date.now(),
  };

  rooms.set(code, newRoom);
  console.log(`[INFO] تم إنشاء غرفة [${code}] باسم "${newRoom.name}" مع ${selectedCategories.length} فئات.`);
  return newRoom;
}

function sanitizeRoom(room) {
  return {
    id: room.code,
    code: room.code,
    name: room.name,
    status: room.status,
    visibility: room.visibility,
    passcode: room.passcode,
    max_players: room.max_players,
    settings: room.settings,
    turn: room.turn,
    scores: room.scores,
    board: room.board,
    used: room.used,
    current: room.current,
    paused: room.paused,
    chat_open: room.chat_open,
    log: room.log,
    createdAt: room.createdAt,
  };
}


function parseSerovalNode(node, root) {
  if (!node) return undefined;
  if (node.s !== undefined) return node.s;
  if (node.n !== undefined) return node.n;
  if (node.b !== undefined) return node.b;
  if (node.t === 10 && node.p) { // object
    const obj = {};
    const keys = node.p.k || [];
    const vals = node.p.v || [];
    for (let i = 0; i < keys.length; i++) {
      obj[keys[i]] = parseSerovalNode(vals[i], root);
    }
    return obj;
  }
  if (node.t === 9 && node.a) { // array
    return node.a.map(item => parseSerovalNode(item, root));
  }
  if (node.t === 1) return node.s;
  if (node.t === 2) return node.n;
  if (node.t === 3) return true;
  if (node.t === 4) return false;
  if (node.t === 5) return null;
  return undefined;
}

function unpackPayload(body) {
  if (!body) return {};
  try {
    const json = typeof body === "string" ? JSON.parse(body) : body;
    if (json.t && json.f !== undefined) {
      const parsed = parseSerovalNode(json.t, json);
      return parsed?.data || parsed || {};
    }
    return json.data || json;
  } catch (e) {
    return {};
  }
}

function sendFnResponse(res, data) {
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({
    result: data,
    data: data,
  }));
}

// معالج الطلبات العام المتوافق مع Node.js و Vercel Serverless
export async function handleRequest(req, res) {
  const host = req.headers?.host || "localhost";
  const url = new URL(req.url, `http://${host}`);
  const pathname = url.pathname;

  console.log(`[REQ] ${req.method} ${pathname}`);
  // إتاحة CORS للأجهزة والشبكة المحلية
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-seen-guest, x-seen-name, x-tsr-serverFn");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // سجلات التتبع التحليلية
  if (pathname.startsWith("/api/app-logs/") || pathname.startsWith("/api/apps/")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, success: true }));
    return;
  }

  // بروكسي الصور لضمان التحميل السريع والموثوق وتجاوز قيود Referrer وCORS مع تخزين مؤقت آمن
  if (pathname === "/api/proxy-image") {
    const imgUrl = url.searchParams.get("url");
    if (!imgUrl || !imgUrl.startsWith("http")) {
      res.writeHead(400);
      res.end("Missing url parameter");
      return;
    }
    const cacheKey = crypto.createHash('md5').update(imgUrl).digest('hex');
    let cacheDir = path.join(PUBLIC_DIR, 'image-cache-proxy');
    let canWriteDisk = true;
    try {
      if (!fs.existsSync(cacheDir)) {
        fs.mkdirSync(cacheDir, { recursive: true });
      }
    } catch (_) {
      cacheDir = path.join('/tmp', 'image-cache-proxy');
      try {
        if (!fs.existsSync(cacheDir)) {
          fs.mkdirSync(cacheDir, { recursive: true });
        }
      } catch (__) {
        canWriteDisk = false;
      }
    }
    const cachedFilePath = path.join(cacheDir, cacheKey);
    const metaPath = path.join(cacheDir, cacheKey + '.meta');

    if (canWriteDisk && fs.existsSync(cachedFilePath) && fs.existsSync(metaPath)) {
      try {
        const mime = fs.readFileSync(metaPath, 'utf8') || 'image/jpeg';
        res.writeHead(200, {
          "Content-Type": mime,
          "Cache-Control": "public, max-age=86400",
          "Access-Control-Allow-Origin": "*"
        });
        fs.createReadStream(cachedFilePath).pipe(res);
        return;
      } catch (_) {}
    }

    const client = imgUrl.startsWith("https") ? https : http;
    client.get(imgUrl, {
      headers: { "User-Agent": "SeenMaghribBot/1.0 (info@seenmaghrib.ma)" }
    }, (proxyRes) => {
      if (proxyRes.statusCode >= 300 && proxyRes.statusCode < 400 && proxyRes.headers.location) {
        res.writeHead(302, { Location: "/api/proxy-image?url=" + encodeURIComponent(proxyRes.headers.location) });
        res.end();
        return;
      }
      const mime = proxyRes.headers["content-type"] || "image/jpeg";
      res.writeHead(proxyRes.statusCode || 200, {
        "Content-Type": mime,
        "Cache-Control": "public, max-age=86400",
        "Access-Control-Allow-Origin": "*"
      });
      if (canWriteDisk && proxyRes.statusCode === 200) {
        try {
          const fileStream = fs.createWriteStream(cachedFilePath);
          proxyRes.pipe(fileStream);
          fs.writeFileSync(metaPath, mime);
        } catch (_) {}
      }
      proxyRes.pipe(res);
    }).on("error", (err) => {
      console.error("[PROXY_ERROR]", imgUrl, err.message);
      res.writeHead(502);
      res.end(err.message);
    });
    return;
  }

  // واجهة برمجية لاسترجاع فئات بنك الأسئلة (25 فئة)
  if (pathname === "/api/categories") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: true, total: allCategories.length, categories: allCategories }));
    return;
  }

  // واجهة برمجية لاسترجاع أسئلة بنك الأسئلة (625 سؤالاً مع دعم التصفية)
  if (pathname === "/api/questions") {
    const cat = url.searchParams.get("category");
    const diff = url.searchParams.get("difficulty");
    const pts = url.searchParams.get("points");
    let filtered = questions;
    if (cat) filtered = filtered.filter(q => q.category === cat || q.category_id === cat);
    if (diff) filtered = filtered.filter(q => q.difficulty === diff);
    if (pts) filtered = filtered.filter(q => q.points === parseInt(pts, 10) || q.value === parseInt(pts, 10));

    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({
      ok: true,
      total: filtered.length,
      questions: filtered
    }));
    return;
  }

  // 1. معالجة دوال الخادم التوافقية (TanStack Start Server Functions /_serverFn/*)
  if (pathname.startsWith("/_serverFn/")) {
    const fnHash = pathname.replace("/_serverFn/", "");
    const guestId = req.headers["x-seen-guest"] || "";
    const guestName = decodeURIComponent(req.headers["x-seen-name"] || "");

    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      const payload = unpackPayload(body);
      if (!payload.code) {
        const m = body.match(/"code"[^}]*?"s":"([A-Za-z0-9]+)"/) || body.match(/"code"\s*:\s*"([A-Za-z0-9]+)"/);
        if (m) payload.code = m[1];
      }

      // أ) دالة إنشاء غرفة (b6a03d5cb0dea21e320dfac594c299c2c147746c2d6031a29d4ac6455979463a)
      if (fnHash === "b6a03d5cb0dea21e320dfac594c299c2c147746c2d6031a29d4ac6455979463a") {
        const room = createRoomInstance(payload, guestId, guestName);
        sendFnResponse(res, {
          code: room.code,
          room: sanitizeRoom(room),
        });
        return;
      }

      // ب) دالة الاستعلام الدوري عن حالة الغرفة (2671d47a3a37cb7e318bc0c7be44c28a742856706a855a0b716a2f45a07f433d)
      if (fnHash === "2671d47a3a37cb7e318bc0c7be44c28a742856706a855a0b716a2f45a07f433d") {
        console.log("[POLL_STATE] req headers:", req.headers["x-seen-guest"], "payload:", JSON.stringify(payload));

        const code = (payload.code || url.searchParams.get("code") || "").toUpperCase();
        const room = rooms.get(code);
        if (!room) {
          sendFnResponse(res, null);
          return;
        }

        // إلحاق المنشئ كمشرف تلقائياً إذا كانت الغرفة حديثة
        if (guestId && room.players.length === 1 && room.players[0].role === "host" && room.players[0].user_id !== guestId) {
          if (Date.now() - room.createdAt < 60000) {
            room.players[0].user_id = guestId;
            if (guestName) room.players[0].name = guestName;
          }
        }

        sendFnResponse(res, {
          room: sanitizeRoom(room),
          players: room.players || [],
          messages: room.messages || [],
        });
        return;
      }

      // ج) دالة الانضمام لغرفة (3f5434af99322857bca8801cb4fceb3939b136bab699d4daef7430f26712449a)
      if (fnHash === "3f5434af99322857bca8801cb4fceb3939b136bab699d4daef7430f26712449a") {
        const code = (payload.code || "").toUpperCase();
        const room = rooms.get(code);
        if (!room) {
          sendFnResponse(res, null);
          return;
        }

        let player = room.players.find(p => p.user_id === guestId);
        if (player) {
          if (payload.name) player.name = payload.name.trim();
          if (payload.team) player.team = payload.team;
          player.last_seen = Date.now();
          player.connected = true;
        } else {
          const isFirst = room.players.length === 0;
          player = {
            id: "p-" + Math.random().toString(36).slice(2, 8),
            user_id: guestId || `g-${Date.now()}`,
            name: (payload.name || guestName || "لاعب").trim(),
            role: isFirst ? "host" : "player",
            team: payload.team || "red",
            ready: true,
            captain: isFirst,
            connected: true,
            last_seen: Date.now(),
            vote: null,
          };
          room.players.push(player);
        }

        sendFnResponse(res, {
          code: room.code,
          room: sanitizeRoom(room),
          player,
        });
        return;
      }

      // د) دالة تعديل اللاعب لنفسه (a50ea8dede48ff28d2d768225fec7dbfc09e46366be18348629aff803e6c090a)
      if (fnHash === "a50ea8dede48ff28d2d768225fec7dbfc09e46366be18348629aff803e6c090a") {
        const code = (payload.code || "").toUpperCase();
        const room = rooms.get(code);
        if (room) {
          const player = room.players.find(p => p.user_id === guestId);
          if (player) {
            if (payload.name !== undefined) player.name = payload.name.trim();
            if (payload.team !== undefined) player.team = payload.team;
            if (payload.ready !== undefined) player.ready = !!payload.ready;
            if (payload.captain !== undefined) player.captain = !!payload.captain;
            player.last_seen = Date.now();
          }
        }
        sendFnResponse(res, { ok: true, room: room ? sanitizeRoom(room) : null });
        return;
      }

      // هـ) دالة نبض الاتصال (592dd66f94a3598b050f602f9690b1235e57e7482e9ba93b40db806501485dc7)
      if (fnHash === "592dd66f94a3598b050f602f9690b1235e57e7482e9ba93b40db806501485dc7") {
        const code = (payload.code || "").toUpperCase();
        const room = rooms.get(code);
        if (room) {
          const player = room.players.find(p => p.user_id === guestId);
          if (player) {
            player.last_seen = Date.now();
            player.connected = true;
          }
        }
        sendFnResponse(res, { ok: true });
        return;
      }

      // و) دالة إدارة المضيف للاعبين (e072b2ac2728ef1c5cff8085d7918c43ea2f449bf174b69c2c3b42b63f1a5b81)
      if (fnHash === "e072b2ac2728ef1c5cff8085d7918c43ea2f449bf174b69c2c3b42b63f1a5b81") {
        const code = (payload.code || "").toUpperCase();
        const room = rooms.get(code);
        if (room) {
          if (payload.kick) {
            room.players = room.players.filter(p => p.id !== payload.playerId);
          } else {
            const player = room.players.find(p => p.id === payload.playerId);
            if (player) {
              if (payload.team) player.team = payload.team;
              if (payload.captain !== undefined) {
                room.players.filter(p => p.team === player.team).forEach(p => p.captain = false);
                player.captain = !!payload.captain;
              }
            }
          }
        }
        sendFnResponse(res, { ok: true, room: room ? sanitizeRoom(room) : null });
        return;
      }

      // ز) دالة تبديل وضع التصويت (d926873c9e0ff523dfaf922be37122e6dc35ecd7eae5de19e4c9c0abf24be61d)
      if (fnHash === "d926873c9e0ff523dfaf922be37122e6dc35ecd7eae5de19e4c9c0abf24be61d") {
        const code = (payload.code || "").toUpperCase();
        const room = rooms.get(code);
        if (room && payload.settings) {
          room.settings.voteMode = !!payload.settings.voteMode;
        }
        sendFnResponse(res, { ok: true, room: room ? sanitizeRoom(room) : null });
        return;
      }

      // ح) دالة انطلاق اللعبة (3cf3b624d778237a3ac1ead6fde77274f3c78eb1303ccc65be1cafac0deaf033)
      if (fnHash === "3cf3b624d778237a3ac1ead6fde77274f3c78eb1303ccc65be1cafac0deaf033") {
        const code = (payload.code || "").toUpperCase();
        const room = rooms.get(code);
        if (room) {
          room.status = "playing";
          room.turn = "red";
          room.log.unshift({
            id: "log-" + Date.now(),
            reason: "انطلاق المباراة",
            delta: 0,
            text: "انطلقت المباراة! بالتوفيق للفريقين 🇲🇦",
            time: Date.now(),
          });
        }
        sendFnResponse(res, { ok: true, room: room ? sanitizeRoom(room) : null });
        return;
      }

      // ط) دالة اختيار خانة السؤال (b60d9b1fdcaa3c8da56f6950e9d0fe81ea0f41bfcb81c99438b2f2deb108e1cd)
      if (fnHash === "b60d9b1fdcaa3c8da56f6950e9d0fe81ea0f41bfcb81c99438b2f2deb108e1cd") {
        const code = (payload.code || "").toUpperCase();
        const room = rooms.get(code);
        if (room && payload.key) {
          const [catId, valStr] = payload.key.split(":");
          const val = parseInt(valStr, 10);
          let qId = null;
          for (const cat of room.board) {
            if (cat.categoryId === catId) {
              const c = cat.cells.find(cell => cell.key === payload.key);
              if (c) qId = c.questionId;
            }
          }
          room.current = {
            questionId: qId || `q-${catId}-${val}`,
            cellKey: payload.key,
            categoryId: catId,
            value: val,
            startedAt: Date.now(),
            duration: room.settings.answerTime || 30,
            revealed: false,
            awarded: false,
            winner: null,
            team: room.turn,
          };
          room.players.forEach(p => p.vote = null);
        }
        sendFnResponse(res, { ok: true, room: room ? sanitizeRoom(room) : null });
        return;
      }

      // ي) دالة تصويت اللاعب على خانة (b5f859259799fccfda877d42505508cbf8bb0b008ca29cb1b81567f79e8fcb48)
      if (fnHash === "b5f859259799fccfda877d42505508cbf8bb0b008ca29cb1b81567f79e8fcb48") {
        const code = (payload.code || "").toUpperCase();
        const room = rooms.get(code);
        if (room) {
          const player = room.players.find(p => p.user_id === guestId);
          if (player) player.vote = payload.key;
        }
        sendFnResponse(res, { ok: true, room: room ? sanitizeRoom(room) : null });
        return;
      }

      // ك) دالة اعتماد تصويت الفريق (8d50640cf1e1965be7c19869bf559c66e691e70c0d56780e8e357c349634e1b2)
      if (fnHash === "8d50640cf1e1965be7c19869bf559c66e691e70c0d56780e8e357c349634e1b2") {
        const code = (payload.code || "").toUpperCase();
        const room = rooms.get(code);
        if (room) {
          const counts = {};
          room.players.filter(p => p.team === room.turn && p.vote).forEach(p => {
            counts[p.vote] = (counts[p.vote] || 0) + 1;
          });
          const bestKey = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
          if (bestKey) {
            const [catId, valStr] = bestKey.split(":");
            const val = parseInt(valStr, 10);
            let qId = null;
            for (const cat of room.board) {
              if (cat.categoryId === catId) {
                const c = cat.cells.find(cell => cell.key === bestKey);
                if (c) qId = c.questionId;
              }
            }
            room.current = {
              questionId: qId || `q-${catId}-${val}`,
              cellKey: bestKey,
              categoryId: catId,
              value: val,
              startedAt: Date.now(),
              duration: room.settings.answerTime || 30,
              revealed: false,
              awarded: false,
              winner: null,
              team: room.turn,
            };
          }
          room.players.forEach(p => p.vote = null);
        }
        sendFnResponse(res, { ok: true, room: room ? sanitizeRoom(room) : null });
        return;
      }

      // ل) دالة كشف الجواب (ed573daface9b83072fecbbfb375251c6b62a091f2df2f939a2428f8ac851162)
      if (fnHash === "ed573daface9b83072fecbbfb375251c6b62a091f2df2f939a2428f8ac851162") {
        const code = (payload.code || "").toUpperCase();
        const room = rooms.get(code);
        if (room && room.current) {
          room.current.revealed = true;
        }
        sendFnResponse(res, { ok: true, room: room ? sanitizeRoom(room) : null });
        return;
      }

      // م) دالة منح النقاط للفائز (c4e7a4b9c4e13c37246b17ca655f2af59319ea9dc9616be7f8eee652a70b3fb2)
      if (fnHash === "c4e7a4b9c4e13c37246b17ca655f2af59319ea9dc9616be7f8eee652a70b3fb2") {
        const code = (payload.code || "").toUpperCase();
        const room = rooms.get(code);
        if (room && room.current) {
          const winner = payload.winner; // "red" | "green" | "none"
          const val = room.current.value || 200;
          room.current.awarded = true;
          room.current.winner = winner;
          if (!room.used.includes(room.current.cellKey)) {
            room.used.push(room.current.cellKey);
          }
          if (winner === "red") {
            room.scores.red = (room.scores.red || 0) + val;
            room.log.unshift({
              id: "log-" + Date.now(),
              reason: "إجابة صحيحة",
              delta: val,
              text: `+${val} نقطة للفريق الأحمر 🔴`,
              time: Date.now(),
            });
          } else if (winner === "green") {
            room.scores.green = (room.scores.green || 0) + val;
            room.log.unshift({
              id: "log-" + Date.now(),
              reason: "إجابة صحيحة",
              delta: val,
              text: `+${val} نقطة للفريق الأخضر 🟢`,
              time: Date.now(),
            });
          } else {
            room.log.unshift({
              id: "log-" + Date.now(),
              reason: "بلا نقاط",
              delta: 0,
              text: `لم تُمنح نقاط لخانة ${val}`,
              time: Date.now(),
            });
          }
        }
        sendFnResponse(res, { ok: true, room: room ? sanitizeRoom(room) : null });
        return;
      }

      // ن) دالة تعديل النقاط يدوياً (02ba190985e1193a99b79612702f36124040bde6374079e830fd41471a4f2190)
      if (fnHash === "02ba190985e1193a99b79612702f36124040bde6374079e830fd41471a4f2190") {
        const code = (payload.code || "").toUpperCase();
        const room = rooms.get(code);
        if (room && payload.team) {
          const delta = Number(payload.delta) || 0;
          room.scores[payload.team] = Math.max(0, (room.scores[payload.team] || 0) + delta);
          room.log.unshift({
            id: "log-" + Date.now(),
            reason: "تعديل يدوي",
            delta,
            text: `تعديل يدوي ${delta > 0 ? "+" : ""}${delta} لـ${payload.team === "red" ? "الأحمر" : "الأخضر"}`,
            time: Date.now(),
          });
        }
        sendFnResponse(res, { ok: true, room: room ? sanitizeRoom(room) : null });
        return;
      }

      // س) دالة الانتقال للسؤال التالي (3384f975f333a274c7046854ffc0ce43371f9ff1c861817d9324dffa6dce3e25)
      if (fnHash === "3384f975f333a274c7046854ffc0ce43371f9ff1c861817d9324dffa6dce3e25") {
        const code = (payload.code || "").toUpperCase();
        const room = rooms.get(code);
        if (room) {
          room.current = null;
          room.turn = room.turn === "red" ? "green" : "red";
          room.players.forEach(p => p.vote = null);
          if (room.used.length >= (room.board.length * 3)) {
            room.status = "finished";
            const winner = room.scores.red > room.scores.green ? "الفريق الأحمر" :
                           room.scores.green > room.scores.red ? "الفريق الأخضر" : "تعادل";
            room.log.unshift({
              id: "log-" + Date.now(),
              reason: "نهاية المباراة",
              delta: 0,
              text: `انتهت المباراة! الفائز: ${winner} 🏆`,
              time: Date.now(),
            });
          }
        }
        sendFnResponse(res, { ok: true, room: room ? sanitizeRoom(room) : null });
        return;
      }

      // ع) دالة إيقاف/استئناف اللعبة مؤقتاً (cbeec8773419deec8ce7dd97665b2d14934ddf48ba8955d1c61d351b95ca7910)
      if (fnHash === "cbeec8773419deec8ce7dd97665b2d14934ddf48ba8955d1c61d351b95ca7910") {
        const code = (payload.code || "").toUpperCase();
        const room = rooms.get(code);
        if (room) {
          room.paused = !room.paused;
        }
        sendFnResponse(res, { ok: true, room: room ? sanitizeRoom(room) : null });
        return;
      }

      // ف) دالة إنهاء اللعبة (a187b4d4a19074ed9408afa257c8033d2acb480dfe1c62e0add30d11122c5af9)
      if (fnHash === "a187b4d4a19074ed9408afa257c8033d2acb480dfe1c62e0add30d11122c5af9") {
        const code = (payload.code || "").toUpperCase();
        const room = rooms.get(code);
        if (room) {
          room.status = "finished";
          room.current = null;
        }
        sendFnResponse(res, { ok: true, room: room ? sanitizeRoom(room) : null });
        return;
      }

      // ص) دالة إعادة ضبط المباراة (7eb9799b85ffdbbdb13165831be0f77419ed446c392448d532da34bdd22a0c85)
      if (fnHash === "7eb9799b85ffdbbdb13165831be0f77419ed446c392448d532da34bdd22a0c85") {
        const code = (payload.code || "").toUpperCase();
        const room = rooms.get(code);
        if (room) {
          room.status = "lobby";
          room.scores = { red: 0, green: 0 };
          room.used = [];
          room.current = null;
          room.paused = false;
          room.turn = "red";
          room.players.forEach(p => { p.vote = null; p.ready = false; });
          room.log.unshift({
            id: "log-" + Date.now(),
            reason: "إعادة ضبط المباراة",
            delta: 0,
            text: "تمت إعادة ضبط المباراة للمرة القادمة.",
            time: Date.now(),
          });
        }
        sendFnResponse(res, { ok: true, room: room ? sanitizeRoom(room) : null });
        return;
      }

      // ق) دالة فتح/إغلاق الدردشة (48e56b7f05656138ec030ecb14269bf296dbccae425713ea6722e07727f6c9de)
      if (fnHash === "48e56b7f05656138ec030ecb14269bf296dbccae425713ea6722e07727f6c9de") {
        const code = (payload.code || "").toUpperCase();
        const room = rooms.get(code);
        if (room) {
          room.chat_open = !!payload.open;
        }
        sendFnResponse(res, { ok: true, room: room ? sanitizeRoom(room) : null });
        return;
      }

      // ر) دالة إرسال رسالة في الشات (d97e650e4c3026fe1bba7c7a47166e126c58bdca4a7d0bc37757c1cfd33ac7bf)
      if (fnHash === "d97e650e4c3026fe1bba7c7a47166e126c58bdca4a7d0bc37757c1cfd33ac7bf") {
        const code = (payload.code || "").toUpperCase();
        const room = rooms.get(code);
        if (room && payload.content) {
          const player = room.players.find(p => p.user_id === guestId);
          const senderName = player ? player.name : (guestName || "مشارك");
          room.messages.push({
            id: "msg-" + Date.now(),
            name: senderName,
            content: payload.content,
            team: payload.team || "all",
            kind: "user",
            time: Date.now(),
          });
        }
        sendFnResponse(res, { ok: true });
        return;
      }

      // ش) دالة سرد الغرف العامة (1c0b34a3d5285fc03fcc7aa9e66c66743a43f77755ca85689bad7eb6a72fa99f)
      if (fnHash === "1c0b34a3d5285fc03fcc7aa9e66c66743a43f77755ca85689bad7eb6a72fa99f") {
        const roomList = Array.from(rooms.values())
          .filter(r => r.visibility === "public")
          .map(r => ({
            id: r.code,
            code: r.code,
            name: r.name,
            status: r.status,
            players: r.players ? r.players.length : 0,
            maxPlayers: r.max_players || 8,
          }));
        sendFnResponse(res, roomList);
        return;
      }

      // ت) استجابة عامة لأي طلب serverFn آخر
      sendFnResponse(res, { success: true, ok: true });
    });
    return;
  }

  // 2. إدارة الغرف المباشرة عبر REST API (/api/rooms/create)
  if (pathname === "/api/rooms/create" && req.method === "POST") {
    const guestId = req.headers["x-seen-guest"] || "";
    const guestName = decodeURIComponent(req.headers["x-seen-name"] || "");
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      try {
        const payload = JSON.parse(body || "{}");
        const room = createRoomInstance(payload, guestId, guestName);
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({
          success: true,
          code: room.code,
          room: sanitizeRoom(room),
          data: { code: room.code, room: sanitizeRoom(room) },
          result: { code: room.code, room: sanitizeRoom(room) }
        }));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // 3. استرجاع تفاصيل الغرفة عبر REST API
  const roomMatch = pathname.match(/^\/api\/rooms\/([A-Za-z0-9]+)$/);
  if (roomMatch && req.method === "GET") {
    const code = roomMatch[1].toUpperCase();
    const room = rooms.get(code);
    if (!room) {
      res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "الغرفة غير موجودة" }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ success: true, room: sanitizeRoom(room) }));
    return;
  }

  // 4. تقديم الملفات الثابتة للواجهة الأمامية (Static File Serving)
  let filePath = path.join(PUBLIC_DIR, pathname === "/" ? "index.html" : pathname);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end("Forbidden");
    return;
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      if (pathname.startsWith("/assets/") || pathname.startsWith("/static/") || pathname.startsWith("/api/")) {
        console.warn(`[404] ملف غير موجود: ${pathname}`);
        res.writeHead(404, { "Content-Type": "text/plain" }).end("Not Found");
        return;
      }
      filePath = path.join(PUBLIC_DIR, "index.html");
    }
    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || "application/octet-stream";

    fs.readFile(filePath, (readErr, data) => {
      if (readErr) {
        res.writeHead(404).end("Not Found");
        return;
      }
      res.writeHead(200, { "Content-Type": contentType });
      res.end(data);
    });
  });
}

// إنشاء خادم HTTP
export const server = http.createServer(handleRequest);

// تشغيل الاستماع فقط عند التشغيل المباشر كخادم محلي (وليس داخل بيئة Vercel Serverless)
const isDirectRun = process.argv[1] && (
  process.argv[1].endsWith("server.mjs") || 
  process.argv[1].endsWith("server.js")
);

if (isDirectRun && !process.env.VERCEL) {
  server.listen(PORT, "0.0.0.0", () => {
    console.log(`=======================================================`);
    console.log(`  🌟 منصة سين المغرب (SEEN MAGHRIB) تعمل بنجاح!`);
    console.log(`  🔗 الرابط المحلي: http://localhost:${PORT}`);
    console.log(`=======================================================`);
  });
}

export default handleRequest;
