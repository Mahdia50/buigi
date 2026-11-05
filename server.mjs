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
// تخزين الغرف المباشرة في الذاكرة مع استمرارية على القرص لبيئة Vercel Serverless
const memoryRooms = new Map();
const TMP_ROOMS_DIR = path.join("/tmp", "seen_maghrib_rooms");

try {
  if (!fs.existsSync(TMP_ROOMS_DIR)) {
    fs.mkdirSync(TMP_ROOMS_DIR, { recursive: true });
  }
} catch (_) {}

const LOCAL_ROOMS_DIR = path.join(__dirname, "data", "rooms");
try {
  if (!fs.existsSync(LOCAL_ROOMS_DIR)) fs.mkdirSync(LOCAL_ROOMS_DIR, { recursive: true });
} catch (_) {}

function saveRoom(code, room) {
  if (!code || !room) return;
  code = code.toUpperCase();
  memoryRooms.set(code, room);
  const clean = { ...room, connections: undefined };
  const jsonStr = JSON.stringify(clean);
  try {
    fs.writeFileSync(path.join(TMP_ROOMS_DIR, `${code}.json`), jsonStr, "utf8");
  } catch (_) {}
  try {
    fs.writeFileSync(path.join(LOCAL_ROOMS_DIR, `${code}.json`), jsonStr, "utf8");
  } catch (_) {}
}

function loadRoom(code, fallbackGuestId = "", fallbackGuestName = "") {
  if (!code) return null;
  code = code.toUpperCase();
  if (memoryRooms.has(code)) {
    return memoryRooms.get(code);
  }
  try {
    const p1 = path.join(TMP_ROOMS_DIR, `${code}.json`);
    if (fs.existsSync(p1)) {
      const parsed = JSON.parse(fs.readFileSync(p1, "utf8"));
      parsed.connections = new Set();
      memoryRooms.set(code, parsed);
      return parsed;
    }
  } catch (_) {}
  try {
    const p2 = path.join(LOCAL_ROOMS_DIR, `${code}.json`);
    if (fs.existsSync(p2)) {
      const parsed = JSON.parse(fs.readFileSync(p2, "utf8"));
      parsed.connections = new Set();
      memoryRooms.set(code, parsed);
      return parsed;
    }
  } catch (_) {}

  // Auto-recovery: If room does not exist, recreate cleanly with requested code
  if (code.length >= 3) {
    console.log(`[INFO] استرجاع وتجديد تلقائي للغرفة ${code} لضمان استمرارية اللعب.`);
    const recovered = createRoomInstance({ name: `غرفة ${code}` }, fallbackGuestId, fallbackGuestName, code);
    return recovered;
  }
  return null;
}

function getAllRooms() {
  const result = new Map(memoryRooms);
  try {
    if (fs.existsSync(TMP_ROOMS_DIR)) {
      const files = fs.readdirSync(TMP_ROOMS_DIR);
      for (const file of files) {
        if (file.endsWith(".json")) {
          const code = file.replace(".json", "");
          if (!result.has(code)) {
            try {
              const parsed = JSON.parse(fs.readFileSync(path.join(TMP_ROOMS_DIR, file), "utf8"));
              result.set(code, parsed);
            } catch (_) {}
          }
        }
      }
    }
  } catch (_) {}
  return Array.from(result.values());
}

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
function createRoomInstance(payload = {}, hostGuestId = "", hostName = "", fixedCode = null) {
  const code = (fixedCode || payload.code || Math.random().toString(36).substring(2, 6)).toUpperCase();

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
    lifelines: {
      red: { fiftyFifty: true, friend: true },
      green: { fiftyFifty: true, friend: true },
    },
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

  saveRoom(code, newRoom);
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
    lifelines: room.lifelines || {
      red: { fiftyFifty: true, friend: true },
      green: { fiftyFifty: true, friend: true },
    },
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

async function getRawOrParsedBody(req) {
  if (req.body !== undefined && req.body !== null) {
    return req.body;
  }
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", chunk => { raw += chunk; });
    req.on("end", () => resolve(raw));
    req.on("error", () => resolve(""));
  });
}

function sendFnResponse(res, data) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.writeHead(200);
  const out = {
    result: data,
    data: data,
    ...(typeof data === "object" && data !== null ? data : {})
  };
  res.end(JSON.stringify(out));
}

// معالج الطلبات العام المتوافق مع Node.js و Vercel Serverless
export async function handleRequest(req, res) {
  const host = req.headers?.host || "localhost";
  const url = new URL(req.url, `http://${host}`);
  
  let pathname = url.searchParams.get("__path")
              || req.headers["x-matched-path"]?.split("?")[0]
              || req.headers["x-forwarded-uri"]?.split("?")[0]
              || url.pathname;

  if (pathname === "/api/index.js" || pathname === "/api" || pathname === "/api/" || pathname.includes("[...all]")) {
    const vPath = url.searchParams.get("__path")
               || req.headers["x-matched-path"]
               || req.headers["x-forwarded-uri"];
    if (vPath) {
      pathname = vPath.split("?")[0];
    }
  }

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
  if (pathname.startsWith("/_serverFn/") || pathname.startsWith("/api/_serverFn/")) {
    const fnHash = pathname.replace(/^\/(api\/)?_serverFn\//, "");
    const guestId = req.headers["x-seen-guest"] || "";
    const guestName = decodeURIComponent(req.headers["x-seen-name"] || "");

    const rawBody = await getRawOrParsedBody(req);
    let body = typeof rawBody === "string" ? rawBody : JSON.stringify(rawBody);
    const payload = unpackPayload(rawBody);
    if (!payload.code) {
      const m = typeof body === "string" ? (body.match(/"code"[^}]*?"s":"([A-Za-z0-9]+)"/) || body.match(/"code"\s*:\s*"([A-Za-z0-9]+)"/)) : null;
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
        const room = loadRoom(code, guestId, guestName);
        if (!room) {
          sendFnResponse(res, null);
          return;
        }

        // تحديث حالة الاتصال والحفاظ على اللاعبين دون الكتابة فوق المشرف
        let player = room.players.find(p => p.user_id === guestId);
        if (player) {
          player.last_seen = Date.now();
          player.connected = true;
          if (guestName && guestName !== "لاعب" && player.name === "لاعب") {
            player.name = guestName.trim();
          }
        } else if (guestId && guestName) {
          const isHost = room.players.length === 0;
          const redCount = room.players.filter(p => p.team === "red").length;
          const greenCount = room.players.filter(p => p.team === "green").length;
          player = {
            id: "p-" + Math.random().toString(36).slice(2, 8),
            user_id: guestId,
            name: guestName.trim(),
            role: isHost ? "host" : "player",
            team: greenCount < redCount ? "green" : "red",
            ready: true,
            captain: isHost,
            connected: true,
            last_seen: Date.now(),
            vote: null,
          };
          room.players.push(player);
          saveRoom(room.code, room);
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
        const room = loadRoom(code, guestId, guestName);
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
        saveRoom(room.code, room);

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
        const room = loadRoom(code, guestId, guestName);
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
        const room = loadRoom(code, guestId, guestName);
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
        const room = loadRoom(code, guestId, guestName);
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
        const room = loadRoom(code, guestId, guestName);
        if (room && payload.settings) {
          room.settings.voteMode = !!payload.settings.voteMode;
        }
        sendFnResponse(res, { ok: true, room: room ? sanitizeRoom(room) : null });
        return;
      }

      // ح) دالة انطلاق اللعبة (3cf3b624d778237a3ac1ead6fde77274f3c78eb1303ccc65be1cafac0deaf033)
      if (fnHash === "3cf3b624d778237a3ac1ead6fde77274f3c78eb1303ccc65be1cafac0deaf033") {
        const code = (payload.code || "").toUpperCase();
        const room = loadRoom(code, guestId, guestName);
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
        const room = loadRoom(code, guestId, guestName);
        if (room && payload.key) {
          const player = room.players.find(p => p.user_id === guestId);
          if (player && player.team && player.team !== room.turn) {
            sendFnResponse(res, { error: "ليس دور فريقك لاختيار السؤال" });
            return;
          }
          const [catId, valStr] = payload.key.split(":");
          const val = parseInt(valStr, 10);
          let qId = null;
          for (const cat of room.board) {
            if (cat.categoryId === catId) {
              const c = cat.cells.find(cell => cell.key === payload.key);
              if (c) qId = c.questionId;
            }
          }
          const durationSec = Number(room.settings?.answerTime) || 30;
          room.current = {
            questionId: qId || `q-${catId}-${val}`,
            cellKey: payload.key,
            categoryId: catId,
            value: val,
            startedAt: Date.now(),
            total: durationSec,
            duration: durationSec,
            deadline: durationSec > 0 ? Date.now() + (durationSec * 1000) : null,
            revealed: false,
            awarded: false,
            winner: null,
            team: room.turn,
            answeringTeam: room.turn,
            attemptedTeams: [],
            wrongAnswers: [],
            hiddenOptions: [],
          };
          room.players.forEach(p => p.vote = null);
          saveRoom(room.code, room);
        }
        sendFnResponse(res, { ok: true, room: room ? sanitizeRoom(room) : null });
        return;
      }

      // ي) دالة تصويت اللاعب على خانة (b5f859259799fccfda877d42505508cbf8bb0b008ca29cb1b81567f79e8fcb48)
      if (fnHash === "b5f859259799fccfda877d42505508cbf8bb0b008ca29cb1b81567f79e8fcb48") {
        const code = (payload.code || "").toUpperCase();
        const room = loadRoom(code, guestId, guestName);
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
        const room = loadRoom(code, guestId, guestName);
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
            const durationSec = Number(room.settings?.answerTime) || 30;
            room.current = {
              questionId: qId || `q-${catId}-${val}`,
              cellKey: bestKey,
              categoryId: catId,
              value: val,
              startedAt: Date.now(),
              total: durationSec,
              duration: durationSec,
              deadline: durationSec > 0 ? Date.now() + (durationSec * 1000) : null,
              revealed: false,
              awarded: false,
              winner: null,
              team: room.turn,
              answeringTeam: room.turn,
              attemptedTeams: [],
              wrongAnswers: [],
              hiddenOptions: [],
            };
            saveRoom(room.code, room);
          }
          room.players.forEach(p => p.vote = null);
        }
        sendFnResponse(res, { ok: true, room: room ? sanitizeRoom(room) : null });
        return;
      }

      // ل) دالة كشف الجواب (ed573daface9b83072fecbbfb375251c6b62a091f2df2f939a2428f8ac851162)
      if (fnHash === "ed573daface9b83072fecbbfb375251c6b62a091f2df2f939a2428f8ac851162") {
        const code = (payload.code || "").toUpperCase();
        const room = loadRoom(code, guestId, guestName);
        if (room && room.current) {
          room.current.revealed = true;
          saveRoom(room.code, room);
        }
        sendFnResponse(res, { ok: true, room: room ? sanitizeRoom(room) : null });
        return;
      }

      // م) دالة منح النقاط للفائز (c4e7a4b9c4e13c37246b17ca655f2af59319ea9dc9616be7f8eee652a70b3fb2)
      if (fnHash === "c4e7a4b9c4e13c37246b17ca655f2af59319ea9dc9616be7f8eee652a70b3fb2") {
        const code = (payload.code || "").toUpperCase();
        const room = loadRoom(code, guestId, guestName);
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
          saveRoom(room.code, room);
        }
        sendFnResponse(res, { ok: true, room: room ? sanitizeRoom(room) : null });
        return;
      }

      // ن) دالة تعديل النقاط يدوياً (02ba190985e1193a99b79612702f36124040bde6374079e830fd41471a4f2190)
      if (fnHash === "02ba190985e1193a99b79612702f36124040bde6374079e830fd41471a4f2190") {
        const code = (payload.code || "").toUpperCase();
        const room = loadRoom(code, guestId, guestName);
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
        const room = loadRoom(code, guestId, guestName);
        if (room) {
          room.current = null;
          room.turn = room.turn === "red" ? "green" : "red";
          room.players.forEach(p => p.vote = null);
          if (room.used.length >= (room.board.length * 5)) {
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
          saveRoom(room.code, room);
        }
        sendFnResponse(res, { ok: true, room: room ? sanitizeRoom(room) : null });
        return;
      }

      // ع) دالة إيقاف/استئناف اللعبة مؤقتاً (cbeec8773419deec8ce7dd97665b2d14934ddf48ba8955d1c61d351b95ca7910)
      if (fnHash === "cbeec8773419deec8ce7dd97665b2d14934ddf48ba8955d1c61d351b95ca7910") {
        const code = (payload.code || "").toUpperCase();
        const room = loadRoom(code, guestId, guestName);
        if (room) {
          room.paused = !room.paused;
          saveRoom(room.code, room);
        }
        sendFnResponse(res, { ok: true, room: room ? sanitizeRoom(room) : null });
        return;
      }

      // ف) دالة إنهاء اللعبة (a187b4d4a19074ed9408afa257c8033d2acb480dfe1c62e0add30d11122c5af9)
      if (fnHash === "a187b4d4a19074ed9408afa257c8033d2acb480dfe1c62e0add30d11122c5af9") {
        const code = (payload.code || "").toUpperCase();
        const room = loadRoom(code, guestId, guestName);
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
        const room = loadRoom(code, guestId, guestName);
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
        const room = loadRoom(code, guestId, guestName);
        if (room) {
          room.chat_open = !!payload.open;
        }
        sendFnResponse(res, { ok: true, room: room ? sanitizeRoom(room) : null });
        return;
      }

      // ر) دالة إرسال رسالة في الشات (d97e650e4c3026fe1bba7c7a47166e126c58bdca4a7d0bc37757c1cfd33ac7bf)
      if (fnHash === "d97e650e4c3026fe1bba7c7a47166e126c58bdca4a7d0bc37757c1cfd33ac7bf") {
        const code = (payload.code || "").toUpperCase();
        const room = loadRoom(code, guestId, guestName);
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
        const roomList = getAllRooms()
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
      return;
  }

  // 2. إدارة الغرف المباشرة عبر REST API (/api/rooms/create)
  if (pathname === "/api/rooms/create" && req.method === "POST") {
    const guestId = req.headers["x-seen-guest"] || "";
    const guestName = decodeURIComponent(req.headers["x-seen-name"] || "");
    try {
      const rawBody = await getRawOrParsedBody(req);
      const payload = unpackPayload(rawBody);
      const room = createRoomInstance(payload, guestId, guestName, payload.code || null);
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.writeHead(200);
      res.end(JSON.stringify({
        success: true,
        ok: true,
        code: room.code,
        room: sanitizeRoom(room),
        data: { code: room.code, room: sanitizeRoom(room) },
        result: { code: room.code, room: sanitizeRoom(room) }
      }));
    } catch (err) {
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.writeHead(400);
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // 3. استرجاع تفاصيل الغرفة عبر REST API
  const roomMatch = pathname.match(/^\/api\/rooms\/([A-Za-z0-9]+)$/);
  if (roomMatch && req.method === "GET") {
    const code = roomMatch[1].toUpperCase();
    const room = loadRoom(code, guestId, guestName);
    if (!room) {
      res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "الغرفة غير موجودة" }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ success: true, room: sanitizeRoom(room) }));
    return;
  }

  // 4. مسار الإجابة المباشرة على السؤال (/api/rooms/answer)
  if (pathname === "/api/rooms/answer" && req.method === "POST") {
    const guestId = req.headers["x-seen-guest"] || "";
    const guestName = decodeURIComponent(req.headers["x-seen-name"] || "");
    try {
      const rawBody = await getRawOrParsedBody(req);
      const payload = unpackPayload(rawBody);
      const code = (payload.code || "").toUpperCase();
      const room = loadRoom(code, guestId, guestName);
      if (!room || !room.current || room.current.revealed) {
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, message: "لا يوجد سؤال نشط حالياً للإجابة" }));
        return;
      }

      const player = room.players.find(p => p.user_id === guestId);
      const currentAnsweringTeam = room.current.answeringTeam || room.turn;

      if (player && player.team && player.team !== currentAnsweringTeam) {
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({
          ok: false,
          message: `ليس دور فريقك للإجابة! الدور حالياً لـ${currentAnsweringTeam === "red" ? "الفريق الأحمر 🔴" : "الفريق الأخضر 🟢"}`
        }));
        return;
      }

      const qId = room.current.questionId;
      let qData = questions.find(q => q.id === qId);
      if (!qData) {
        try {
          const jsonBank = JSON.parse(fs.readFileSync(path.join(__dirname, "data", "questions_bank_complete.json"), "utf8"));
          qData = (jsonBank.questions || []).find(q => q.id === qId);
        } catch (_) {}
      }

      const selectedOpt = String(payload.optionKey || "").toUpperCase();
      const correctOpt = String(qData?.correct_answer || (qData?.answer ? Object.entries(qData?.options || {}).find(([k,v]) => v === qData?.answer)?.[0] : "A")).toUpperCase();
      const isCorrect = selectedOpt === correctOpt;

      if (!room.current.wrongAnswers) room.current.wrongAnswers = [];
      if (!room.current.attemptedTeams) room.current.attemptedTeams = [];

      const val = room.current.value || 100;
      const teamLabel = currentAnsweringTeam === "red" ? "الفريق الأحمر 🔴" : "الفريق الأخضر 🟢";

      if (isCorrect) {
        room.current.revealed = true;
        room.current.awarded = true;
        room.current.winner = currentAnsweringTeam;
        room.scores[currentAnsweringTeam] = (room.scores[currentAnsweringTeam] || 0) + val;
        if (!room.used.includes(room.current.cellKey)) {
          room.used.push(room.current.cellKey);
        }
        room.log.unshift({
          id: "log-" + Date.now(),
          reason: "إجابة صحيحة",
          delta: val,
          text: `+${val} نقطة لـ${teamLabel} بعد إجابة صحيحة (${selectedOpt})! 🎯`,
          time: Date.now(),
        });
      } else {
        if (!room.current.wrongAnswers.includes(selectedOpt)) {
          room.current.wrongAnswers.push(selectedOpt);
        }
        if (!room.current.attemptedTeams.includes(currentAnsweringTeam)) {
          room.current.attemptedTeams.push(currentAnsweringTeam);
        }

        const opposingTeam = currentAnsweringTeam === "red" ? "green" : "red";
        const opposingTeamLabel = opposingTeam === "red" ? "الفريق الأحمر 🔴" : "الفريق الأخضر 🟢";

        if (!room.current.attemptedTeams.includes(opposingTeam)) {
          // نقل فرصة الإجابة للفريق الخصم (خطف السؤال) مع 15 ثانية إضافية
          room.current.answeringTeam = opposingTeam;
          room.current.total = 15;
          room.current.duration = 15;
          room.current.deadline = Date.now() + 15000;
          room.log.unshift({
            id: "log-" + Date.now(),
            reason: "إجابة خاطئة - خطف السؤال",
            delta: 0,
            text: `إجابة خاطئة (${selectedOpt}) من ${teamLabel}! فرصة خطف السؤال انتقلت إلى ${opposingTeamLabel}! ⚡`,
            time: Date.now(),
          });
        } else {
          // كلا الفريقين أخطآ
          room.current.revealed = true;
          room.current.awarded = true;
          room.current.winner = "none";
          if (!room.used.includes(room.current.cellKey)) {
            room.used.push(room.current.cellKey);
          }
          room.log.unshift({
            id: "log-" + Date.now(),
            reason: "أخطأ الفريقان",
            delta: 0,
            text: `أخطأ كِلا الفريقين في الإجابة! لم تُمنح أي نقطة لخانة ${val}.`,
            time: Date.now(),
          });
        }
      }

      saveRoom(room.code, room);
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({
        ok: true,
        isCorrect,
        room: sanitizeRoom(room),
        players: room.players,
        messages: room.messages,
      }));
    } catch (err) {
      res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return;
  }

  // 5. مسار وسائل المساعدة في الغرف الأونلاين (/api/rooms/lifeline)
  if (pathname === "/api/rooms/lifeline" && req.method === "POST") {
    const guestId = req.headers["x-seen-guest"] || "";
    const guestName = decodeURIComponent(req.headers["x-seen-name"] || "");
    try {
      const rawBody = await getRawOrParsedBody(req);
      const payload = unpackPayload(rawBody);
      const code = (payload.code || "").toUpperCase();
      const room = loadRoom(code, guestId, guestName);
      if (!room || !room.current || room.current.revealed) {
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, message: "لا يوجد سؤال نشط لاستخدام وسيلة مساعدة" }));
        return;
      }

      const player = room.players.find(p => p.user_id === guestId);
      const currentAnsweringTeam = room.current.answeringTeam || room.turn;

      if (player && player.team && player.team !== currentAnsweringTeam) {
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, message: "فقط الفريق صاحب الدور يمكنه استخدام وسيلة مساعدة" }));
        return;
      }

      if (!room.lifelines) {
        room.lifelines = {
          red: { fiftyFifty: true, friend: true },
          green: { fiftyFifty: true, friend: true },
        };
      }
      const teamLifelines = room.lifelines[currentAnsweringTeam] || { fiftyFifty: true, friend: true };
      const teamLabel = currentAnsweringTeam === "red" ? "الفريق الأحمر" : "الفريق الأخضر";

      if (payload.type === "5050") {
        if (!teamLifelines.fiftyFifty) {
          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: false, message: "تم استهلاك وسيلة 50:50 مسبقاً لهذا الفريق" }));
          return;
        }
        teamLifelines.fiftyFifty = false;
        room.lifelines[currentAnsweringTeam] = teamLifelines;

        const qId = room.current.questionId;
        let qData = questions.find(q => q.id === qId);
        if (!qData) {
          try {
            const jsonBank = JSON.parse(fs.readFileSync(path.join(__dirname, "data", "questions_bank_complete.json"), "utf8"));
            qData = (jsonBank.questions || []).find(q => q.id === qId);
          } catch (_) {}
        }
        const correctOpt = String(qData?.correct_answer || (qData?.answer ? Object.entries(qData?.options || {}).find(([k,v]) => v === qData?.answer)?.[0] : "A")).toUpperCase();
        const wrongOpts = ["A", "B", "C", "D"].filter(k => k !== correctOpt).sort(() => Math.random() - 0.5);
        room.current.hiddenOptions = wrongOpts.slice(0, 2);

        room.log.unshift({
          id: "log-" + Date.now(),
          reason: "وسيلة مساعدة",
          delta: 0,
          text: `استخدم ${teamLabel} وسيلة 50:50 (حذف خيارين خاطئين)! 🪄`,
          time: Date.now(),
        });
      } else if (payload.type === "friend") {
        if (!teamLifelines.friend) {
          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: false, message: "تم استهلاك وسيلة الاتصال بصديق مسبقاً لهذا الفريق" }));
          return;
        }
        teamLifelines.friend = false;
        room.lifelines[currentAnsweringTeam] = teamLifelines;

        const now = Date.now();
        const currentRemaining = Math.max(0, (room.current.deadline || (now + 30000)) - now);
        room.current.deadline = now + currentRemaining + 30000;
        room.current.total = (room.current.total || 30) + 30;

        room.log.unshift({
          id: "log-" + Date.now(),
          reason: "وسيلة مساعدة",
          delta: 0,
          text: `استخدم ${teamLabel} وسيلة اتصال بصديق (+30 ثانية وقت إضافي)! ⏱️`,
          time: Date.now(),
        });
      }

      saveRoom(room.code, room);
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({
        ok: true,
        room: sanitizeRoom(room),
        players: room.players,
        messages: room.messages,
      }));
    } catch (err) {
      res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return;
  }

  // 6. مسار اختيار خانة السؤال عبر REST (/api/rooms/select-cell)
  if (pathname === "/api/rooms/select-cell" && req.method === "POST") {
    const guestId = req.headers["x-seen-guest"] || "";
    const guestName = decodeURIComponent(req.headers["x-seen-name"] || "");
    try {
      const rawBody = await getRawOrParsedBody(req);
      const payload = unpackPayload(rawBody);
      const code = (payload.code || "").toUpperCase();
      const room = loadRoom(code, guestId, guestName);
      if (!room || !payload.key) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, message: "بيانات غير صالحة" }));
        return;
      }

      const player = room.players.find(p => p.user_id === guestId);
      if (player && player.team && player.team !== room.turn) {
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, message: "ليس دور فريقك لاختيار السؤال" }));
        return;
      }

      const [catId, valStr] = payload.key.split(":");
      const val = parseInt(valStr, 10);
      let qId = null;
      for (const cat of room.board) {
        if (cat.categoryId === catId) {
          const c = cat.cells.find(cell => cell.key === payload.key);
          if (c) qId = c.questionId;
        }
      }
      const durationSec = Number(room.settings?.answerTime) || 30;
      room.current = {
        questionId: qId || `q-${catId}-${val}`,
        cellKey: payload.key,
        categoryId: catId,
        value: val,
        startedAt: Date.now(),
        total: durationSec,
        duration: durationSec,
        deadline: durationSec > 0 ? Date.now() + (durationSec * 1000) : null,
        revealed: false,
        awarded: false,
        winner: null,
        team: room.turn,
        answeringTeam: room.turn,
        attemptedTeams: [],
        wrongAnswers: [],
        hiddenOptions: [],
      };
      room.players.forEach(p => p.vote = null);
      saveRoom(room.code, room);

      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, room: sanitizeRoom(room) }));
    } catch (err) {
      res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return;
  }

  // 7. تقديم الملفات الثابتة للواجهة الأمامية (Static File Serving)
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
