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

function readRoomFromDisk(code) {
  for (const dir of [TMP_ROOMS_DIR, LOCAL_ROOMS_DIR]) {
    try {
      const filePath = path.join(dir, `${code}.json`);
      if (!fs.existsSync(filePath)) continue;
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
      parsed.connections = new Set();
      return parsed;
    } catch (_) {}
  }
  return null;
}

function cacheRoomKey(code) {
  return "https://seen.local/rooms/" + String(code || "").toUpperCase();
}

function vercelRuntimeCache() {
  try {
    const ctx = globalThis[Symbol.for("@vercel/request-context")];
    const resolved = ctx && typeof ctx.get === "function" ? ctx.get() : ctx;
    const cache = resolved?.cache;
    if (cache && typeof cache.get === "function" && typeof cache.set === "function") return cache;
  } catch (_) {}
  return null;
}

async function readSharedRoom(code) {
  try {
    const cache = vercelRuntimeCache();
    if (!cache) return readRoomFromEdgeCache(code);
    const value = await cache.get("room:" + code);
    if (!value || typeof value !== "object") return readRoomFromEdgeCache(code);
    value.connections = new Set();
    return value;
  } catch (_) {
    return null;
  }
}

async function writeSharedRoom(code, room) {
  const clean = { ...room, connections: undefined };
  try {
    const cache = vercelRuntimeCache();
    if (cache) {
      await cache.set("room:" + code, clean, { ttl: 60 * 60 * 12, tags: ["seen-room"] });
      return;
    }
  } catch (_) {}
  await writeRoomToEdgeCache(code, JSON.stringify(clean));
}

async function readRoomFromEdgeCache(code) {
  try {
    if (typeof caches === "undefined" || !caches?.open) return null;
    const cache = await caches.open("seen-rooms-v1");
    const hit = await cache.match(new Request(cacheRoomKey(code)));
    if (!hit) return null;
    const parsed = await hit.json();
    if (!parsed || typeof parsed !== "object") return null;
    parsed.connections = new Set();
    return parsed;
  } catch (_) {
    return null;
  }
}

async function writeRoomToEdgeCache(code, jsonStr) {
  try {
    if (typeof caches === "undefined" || !caches?.open) return;
    const cache = await caches.open("seen-rooms-v1");
    await cache.put(new Request(cacheRoomKey(code)), new Response(jsonStr, {
      headers: { "content-type": "application/json", "cache-control": "public, s-maxage=43200" },
    }));
  } catch (_) {}
}

async function primeRoom(code) {
  const cached = await readSharedRoom(code);
  const mem = memoryRooms.get(code);
  const disk = readRoomFromDisk(code);
  const sources = [mem, disk, cached].filter(Boolean).sort((a, b) => (Number(a.rev) || 0) - (Number(b.rev) || 0));
  if (!sources.length) return;
  const best = sources[sources.length - 1];
  const players = sources.reduce((acc, source) => unionPlayers(acc, source.players || []), []);
  const room = best === mem ? mem : { ...best };
  room.kicked = [...new Set(sources.flatMap((source) => source.kicked || []))];
  room.players = withoutKicked(room, players);
  room.connections = mem?.connections instanceof Set ? mem.connections : new Set();
  room.code = code;
  memoryRooms.set(code, room);
}

async function saveRoom(code, room) {
  if (!code || !room) return;
  code = code.toUpperCase();
  let working = room;
  for (let attempt = 0; attempt < 3; attempt++) {
    const remote = await readSharedRoom(code);
    if (remote && typeof remote === "object") {
      const kicked = [...new Set([...(remote.kicked || []), ...(working.kicked || [])])];
      const remoteNewer = (Number(remote.rev) || 0) > (Number(working.rev) || 0);
      let players = remoteNewer
        ? unionPlayers(working.players || [], remote.players || [])
        : unionPlayers(remote.players || [], working.players || []);
      players = withoutKicked({ kicked }, players);
      if (remoteNewer) {
        const connections = working.connections;
        Object.assign(working, remote, { code, players, connections, kicked });
      } else {
        working.players = players;
        working.kicked = kicked;
      }
    }
    working.rev = Math.max(Number(working.rev) || 0, Number(remote?.rev) || 0) + 1;
    working.updatedAt = Date.now();
    working.code = code;
    const clean = { ...working, connections: undefined };
    const jsonStr = JSON.stringify(clean);
    try {
      fs.writeFileSync(path.join(TMP_ROOMS_DIR, `${code}.json`), jsonStr, "utf8");
    } catch (_) {}
    try {
      fs.writeFileSync(path.join(LOCAL_ROOMS_DIR, `${code}.json`), jsonStr, "utf8");
    } catch (_) {}
    await writeSharedRoom(code, clean).catch(() => {});
    const seen = await readSharedRoom(code);
    const seenIds = (seen?.players || []).map((p) => p.user_id || p.id).sort().join("|");
    const ourIds = (working.players || []).map((p) => p.user_id || p.id).sort().join("|");
    if (!seen || seen.rev === working.rev || seenIds === ourIds) break;
    working.rev = Number(seen.rev) || working.rev;
  }
  memoryRooms.set(code, working);
  if (working !== room) Object.assign(room, working, { connections: room.connections });
}

function unionPlayers(listA = [], listB = []) {
  const map = new Map();
  const add = (player) => {
    if (!player || typeof player !== "object") return;
    const key = player.user_id || player.id;
    if (!key) return;
    const prev = map.get(key);
    if (!prev) {
      map.set(key, { ...player });
      return;
    }
    map.set(key, {
      ...prev,
      ...player,
      name: player.name && player.name !== "لاعب" ? player.name : prev.name,
      team: player.team || prev.team,
      role: prev.role === "host" || player.role === "host" ? "host" : (player.role || prev.role),
      captain: player.captain !== undefined ? !!player.captain : !!prev.captain,
      ready: player.ready !== undefined ? player.ready : prev.ready,
    });
  };
  listA.forEach(add);
  listB.forEach(add);
  let players = [...map.values()];
  const hosts = players.filter((p) => p.role === "host");
  if (hosts.length > 1) {
    const primary = hosts.find((p) => String(p.id || "").startsWith("p-host-")) || hosts[0];
    players = players.map((p) => {
      if (p.role !== "host") return p;
      if (p.id === primary.id || p.user_id === primary.user_id) return p;
      return { ...p, role: "player", captain: p.team === primary.team ? false : p.captain };
    });
  }
  for (const team of ["red", "green"]) {
    const captains = players.filter((p) => p.team === team && p.captain);
    if (captains.length <= 1) continue;
    const keep = captains[captains.length - 1];
    players = players.map((p) => (
      p.team === team && p.captain && p.id !== keep.id && p.user_id !== keep.user_id
        ? { ...p, captain: false }
        : p
    ));
  }
  return players;
}

async function adoptSnapshot(room, snapshot, code) {
  if (!snapshot || typeof snapshot !== "object") return room;
  const snapCode = String(snapshot.code || snapshot.id || "").toUpperCase();
  if (snapCode && snapCode !== code) return room;
  const snapPlayers = Array.isArray(snapshot.players) ? snapshot.players : [];
  if (!room) {
    if (!snapPlayers.length && !(Array.isArray(snapshot.board) && snapshot.board.length)) return null;
    const created = { ...snapshot, code, players: snapPlayers, connections: new Set(), recovered: false };
    created.players = withoutKicked(created, snapPlayers);
    await saveRoom(code, created);
    return memoryRooms.get(code) || created;
  }
  const snapRev = Number(snapshot.rev) || 0;
  const roomRev = Number(room.rev) || 0;
  const snapNewer = snapRev > roomRev;
  const beforeIds = (room.players || []).map((p) => p.user_id || p.id).sort().join("|");
  room.players = withoutKicked(room, unionPlayers(snapPlayers, room.players || []));
  const afterIds = room.players.map((p) => p.user_id || p.id).sort().join("|");
  let changed = beforeIds !== afterIds;
  const roomIds = beforeIds ? beforeIds.split("|") : [];
  const snapCoversRoom = roomIds.every((id) => snapPlayers.some((p) => (p.user_id || p.id) === id));
  const drifted = snapshot.status !== room.status
    || snapshot.turn !== room.turn
    || (snapshot.current?.cellKey || null) !== (room.current?.cellKey || null)
    || JSON.stringify(snapshot.scores || {}) !== JSON.stringify(room.scores || {})
    || JSON.stringify(snapshot.used || []) !== JSON.stringify(room.used || []);
  if (snapNewer && snapshot.status && snapCoversRoom && drifted) {
    const players = room.players;
    const connections = room.connections instanceof Set ? room.connections : new Set();
    const kicked = room.kicked;
    Object.assign(room, snapshot, { code, players, connections, kicked, recovered: false });
    changed = true;
  }
  if (changed) await saveRoom(code, room);
  return room;
}

function isKicked(room, guestId, guestName, player) {
  const banned = room?.kicked;
  if (!Array.isArray(banned) || !banned.length) return false;
  if (guestId && banned.includes(guestId)) return true;
  if (guestName && guestName !== "لاعب" && banned.includes(guestName)) return true;
  if (player && (banned.includes(player.user_id) || banned.includes(player.id) || (player.name && banned.includes(player.name)))) return true;
  return false;
}

function withoutKicked(room, players) {
  return (players || []).filter((p) => !isKicked(room, p?.user_id, p?.name, p));
}

function findPlayer(room, guestId, guestName, playerId) {
  if (!room || !Array.isArray(room.players)) return null;
  let player = null;
  if (guestId) player = room.players.find((p) => p.user_id === guestId) || null;
  if (!player && playerId) {
    player = room.players.find((p) => p.id === playerId) || null;
    if (player && guestId && !room.players.some((p) => p !== player && p.user_id === guestId)) player.user_id = guestId;
  }
  if (!player && guestId) {
    const stable = "p-" + String(guestId).replace(/[^a-z0-9]/gi, "").slice(0, 8);
    player = room.players.find((p) => p.id === stable) || null;
    if (player && !room.players.some((p) => p !== player && p.user_id === guestId)) player.user_id = guestId;
  }
  if (!player && guestName && guestName !== "لاعب") {
    const matches = room.players.filter((p) => (p.name || "").trim() === guestName.trim() && (!p.user_id || p.user_id === guestId));
    if (matches.length === 1) player = matches[0];
  }
  return player;
}

function isTeamLeader(room, player) {
  if (!player) return false;
  if (player.role === "host" || player.captain) return true;
  const mates = (room.players || []).filter((p) => p.team === player.team);
  return mates.length === 1 || !mates.some((p) => p.captain);
}

async function loadRoom(code, fallbackGuestId = "", fallbackGuestName = "", snapshot = null) {
  if (!code) return null;
  code = code.toUpperCase();
  await primeRoom(code);
  const disk = readRoomFromDisk(code);
  const mem = memoryRooms.get(code);
  let room = null;
  if (mem && disk) {
    const memRev = Number(mem.rev) || 0;
    const diskRev = Number(disk.rev) || 0;
    if (diskRev > memRev) {
      disk.kicked = [...new Set([...(disk.kicked || []), ...(mem.kicked || [])])];
      disk.players = withoutKicked(disk, unionPlayers(mem.players || [], disk.players || []));
      disk.connections = mem.connections instanceof Set ? mem.connections : new Set();
      memoryRooms.set(code, disk);
      room = disk;
    } else {
      room = mem;
    }
  } else if (mem) {
    room = mem;
  } else if (disk) {
    memoryRooms.set(code, disk);
    room = disk;
  }
  if (snapshot) room = await adoptSnapshot(room, snapshot, code);
  ensureRoomLists(room);
  return room;
}


function getAllRooms() {
  const result = new Map(memoryRooms);
  for (const dir of [TMP_ROOMS_DIR, LOCAL_ROOMS_DIR]) {
    try {
      if (fs.existsSync(dir)) {
        const files = fs.readdirSync(dir);
        for (const file of files) {
          if (file.endsWith(".json")) {
            const code = file.replace(".json", "");
            if (!result.has(code)) {
              try {
                const parsed = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
                result.set(code, parsed);
              } catch (_) {}
            }
          }
        }
      }
    } catch (_) {}
  }
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

// مولد أرقام شبه عشوائية حتمي يعتمد على رمز الغرفة لضمان ثبات الفئات والأسئلة عبر حاويات Vercel
function createPrng(seedStr) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < seedStr.length; i++) {
    h = Math.imul(h ^ seedStr.charCodeAt(i), 16777619);
  }
  return function() {
    h += 0x6D2B79F5;
    let t = Math.imul(h ^ (h >>> 15), 1 | h);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// اختيار 6 فئات حتمياً بحسب رمز الغرفة
function getDeterministicCategories(code) {
  const prng = createPrng("cats_" + code);
  const pool = [...allCategories];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(prng() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, 6).map(c => c.id);
}

function questionText(q) {
  return String(q?.question || q?.text || "").replace(/\s+/g, " ").trim();
}

const USED_QUESTIONS_FILE = path.join(__dirname, "data", "used-question-ids.json");
let usedQuestionIds = null;

async function loadUsedQuestionIds() {
  if (usedQuestionIds) return usedQuestionIds;
  const ids = new Set();
  try {
    const cache = vercelRuntimeCache();
    if (cache) {
      const value = await cache.get("seen:used-questions");
      if (Array.isArray(value)) value.forEach((id) => ids.add(id));
    }
  } catch (_) {}
  try {
    if (fs.existsSync(USED_QUESTIONS_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(USED_QUESTIONS_FILE, "utf8"));
      if (Array.isArray(parsed)) parsed.forEach((id) => ids.add(id));
    }
  } catch (_) {}
  usedQuestionIds = ids;
  return ids;
}

async function rememberQuestionIds(ids) {
  const set = await loadUsedQuestionIds();
  let changed = false;
  for (const id of ids || []) {
    if (!id || String(id).startsWith("q-") || set.has(id)) continue;
    set.add(id);
    changed = true;
  }
  if (!changed) return;
  const list = [...set];
  try { fs.writeFileSync(USED_QUESTIONS_FILE, JSON.stringify(list)); } catch (_) {}
  try {
    const cache = vercelRuntimeCache();
    if (cache) await cache.set("seen:used-questions", list, { ttl: 60 * 60 * 24 * 30, tags: ["seen-questions"] });
  } catch (_) {}
}

function boardQuestionIds(board) {
  const ids = [];
  for (const cat of board || []) {
    for (const cell of cat.cells || []) if (cell.questionId) ids.push(cell.questionId);
  }
  return ids;
}

// لوحة بلا تكرار: كل سؤال يتلعب مرة في المباراة، وما يعاودش فالغرف الجاية حتى يخلص المخزون
function buildBoardForCategories(selectedCategories, code = "", blockedIds = new Set()) {
  const usedIds = new Set();
  const usedTexts = new Set();
  const board = [];
  const fresh = (list) => list.filter((q) => {
    if (!q?.id || usedIds.has(q.id)) return false;
    const text = questionText(q);
    if (text && usedTexts.has(text)) return false;
    if (blockedIds.has(q.id)) return false;
    return true;
  });
  for (const catId of selectedCategories) {
    const cells = [];
    const inCat = questions.filter((q) => q.category_id === catId || q.category === catId);
    for (const val of [100, 200, 300, 400, 500]) {
      const cellPrng = code ? createPrng(`q_${code}_${catId}_${val}_v2`) : Math.random;
      let pool = fresh(inCat.filter((q) => q.value === val || q.points === val));
      if (!pool.length) pool = fresh(inCat);
      if (!pool.length) {
        pool = inCat.filter((q) => q?.id && !usedIds.has(q.id) && !usedTexts.has(questionText(q)));
      }
      const roll = typeof cellPrng === "function" ? cellPrng() : Math.random();
      const q = pool.length
        ? pool[Math.floor(roll * pool.length)]
        : { id: `q-${catId}-${val}`, category: catId, value: val };
      if (q.id) usedIds.add(q.id);
      const text = questionText(q);
      if (text) usedTexts.add(text);
      cells.push({
        key: `${catId}:${val}`,
        value: val,
        questionId: q.id,
      });
    }
    board.push({ categoryId: catId, cells });
  }
  return board;
}

async function createRoomInstance(payload = {}, hostGuestId = "", hostName = "", fixedCode = null) {
  const code = (fixedCode || payload.code || Math.random().toString(36).substring(2, 6)).toUpperCase();

  // اختيار الفئات المحددة أو الافتراضية حتمياً بناءً على رمز الغرفة
  let selectedCategories = payload.categories;
  if (!selectedCategories || !Array.isArray(selectedCategories) || selectedCategories.length < 3) {
    selectedCategories = getDeterministicCategories(code);
  }

  // بناء اللوحة حتمياً بناءً على رمز الغرفة، بلا أسئلة سبقات
  const board = buildBoardForCategories(selectedCategories, code, await loadUsedQuestionIds());
  await rememberQuestionIds(boardQuestionIds(board));

  const effectiveHostGuestId = hostGuestId || `g-${Date.now()}`;
  const effectiveHostName = (hostName || payload.name || "المشرف").trim();

  // معرف حتمي للاعب المضيف بناءً على كود الغرفة لضمان الاستقرار عبر invocations
  const hostPlayerId = fixedCode ? `p-host-${code.toLowerCase()}` : "p-" + Math.random().toString(36).slice(2, 8);
  // وقت حتمي للغرفة المُسترجعة لمنع flicker
  const roomTime = fixedCode ? parseInt(code, 36) % 1000000000000 + 1700000000000 : Date.now();

  const hostPlayer = {
    id: hostPlayerId,
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
    status: "lobby",
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
      red: {},
      green: {},
    },
    log: [
      {
        id: `log-init-${code}`,
        reason: "إنشاء الغرفة",
        delta: 0,
        text: `تم إنشاء الغرفة «${payload.name || code}» بنجاح`,
        time: roomTime,
      },
    ],
    messages: [
      {
        id: `msg-init-${code}`,
        name: "النظام",
        content: `مرحباً بكم في «${payload.name || "غرفة " + code}»! 🇲🇦`,
        team: "all",
        kind: "system",
        time: roomTime,
      },
    ],
    players: [hostPlayer],
    connections: new Set(),
    createdAt: roomTime,
  };

  await saveRoom(code, newRoom);
  console.log(`[INFO] تم إنشاء غرفة [${code}] باسم "${newRoom.name}" مع ${selectedCategories.length} فئات.`);
  return newRoom;
}

function turnAfterClose(room) {
  if (room?.current?.awarded) {
    const cell = room.current.cellKey || "";
    if (room.advancedCell !== cell) return room.turn === "red" ? "green" : "red";
  }
  return room.turn;
}

function closeAwardedQuestion(room) {
  if (!room?.current?.awarded) return false;
  const cell = room.current.cellKey || "";
  if (room.advancedCell !== cell) {
    room.turn = room.turn === "red" ? "green" : "red";
    room.advancedCell = cell;
  }
  room.current = null;
  if (Array.isArray(room.players)) room.players.forEach((p) => { p.vote = null; });
  return true;
}

async function restoreCurrentFromPayload(room, payload) {
  if (!room || room.current) return; // current موجود، لا حاجة للاسترجاع
  const cellKey = payload.cellKey || payload.key;
  if (!cellKey) return;
  const [catId, valStr] = cellKey.split(":");
  const val = parseInt(valStr, 10);
  let qId = null;
  for (const cat of room.board || []) {
    if (cat.categoryId === catId) {
      const c = cat.cells?.find(cell => cell.key === cellKey);
      if (c) qId = c.questionId;
    }
  }
  const durationSec = Number(room.settings?.answerTime) || 30;
  room.current = {
    questionId: qId || `q-${catId}-${val}`,
    cellKey,
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
  await saveRoom(room.code, room);
}

// تعريف الـ 20 وسيلة مساعدة المتاحة
const ALL_LIFELINES = [
  { id: "5050",       emoji: "🪄", name: "50:50",               desc: "يحذف خيارين خاطئين", cost: 150 },
  { id: "friend",     emoji: "📞", name: "اتصال بصديق",         desc: "يوقف الوقت 30 ثانية للتشاور", cost: 100 },
  { id: "audience",   emoji: "👥", name: "رأي الجمهور",         desc: "يُظهر نسبة تصويت وهمية للخيارات", cost: 100 },
  { id: "extra30",    emoji: "⏰", name: "+30 ثانية",            desc: "يضيف 30 ثانية للوقت", cost: 100 },
  { id: "hint",       emoji: "💡", name: "تلميح",               desc: "يُظهر تلميحاً إضافياً للسؤال", cost: 75 },
  { id: "double",     emoji: "✌️", name: "جاوب مرتين",          desc: "يسمح بمحاولتين للإجابة", cost: 150 },
  { id: "steal",      emoji: "🎯", name: "خطف النقاط",          desc: "عند الإجابة الصحيحة تُضاعف نقاط الخانة", cost: 250 },
  { id: "freeze",     emoji: "🧊", name: "تجميد الخصم",         desc: "يمنع الخصم من خطف السؤال", cost: 150 },
  { id: "reveal_opt", emoji: "🔍", name: "كشف خيار",            desc: "يكشف حرف الإجابة الصحيحة", cost: 200 },
  { id: "extra15",    emoji: "⌚", name: "+15 ثانية",            desc: "يضيف 15 ثانية للوقت", cost: 50 },
  { id: "no_steal",   emoji: "🛡️", name: "حماية السؤال",        desc: "لا يمكن للخصم خطف السؤال", cost: 150 },
  { id: "bonus50",    emoji: "💰", name: "+50 نقطة بونص",       desc: "يضيف 50 نقطة إضافية لقيمة الخانة", cost: 200 },
  { id: "second_ch",  emoji: "🔁", name: "فرصة ثانية",          desc: "عند الخطأ يمنح فرصة إجابة ثانية", cost: 200 },
  { id: "reduce",     emoji: "✂️", name: "تقليل الخيارات",     desc: "يُقلص الخيارات لـ 3 فقط (يحذف 1)", cost: 50 },
  { id: "time_stop",  emoji: "⏸️", name: "إيقاف الوقت",         desc: "يوقف العداد 20 ثانية", cost: 75 },
  { id: "double_neg", emoji: "💣", name: "مضاعفة الخسارة",      desc: "إذا أخطأ الخصم تضاعفت الخصومة عليه", cost: 200 },
  { id: "all_see",    emoji: "👁️", name: "الكل يرى",            desc: "يُظهر الجواب للجميع لكن يخفي التأكيد", cost: 300 },
];

function chosenLifelineIds(room, team) {
  const raw = room.settings?.chosenLifelines?.[team];
  const ids = (Array.isArray(raw) && raw.length ? raw : ["5050", "friend", "extra30"])
    .filter((id) => ALL_LIFELINES.some((l) => l.id === id));
  return ids.length ? ids : ["5050", "friend", "extra30"];
}

function ensureRoomLists(room) {
  if (!room) return;
  if (!Array.isArray(room.used)) room.used = [];
  if (!Array.isArray(room.log)) room.log = [];
  if (!Array.isArray(room.messages)) room.messages = [];
  if (!Array.isArray(room.kicked)) room.kicked = [];
  if (!Array.isArray(room.players)) room.players = [];
  if (!room.scores) room.scores = { red: 0, green: 0 };
  if (!room.lifelines) room.lifelines = { red: {}, green: {} };
  room.paused = healBool(room.paused, false);
  room.chat_open = healBool(room.chat_open, true);
  if (room.current === 0 || room.current === 1 || room.current === 2 || room.current === 3) room.current = null;
  if (room.current && typeof room.current === "object") {
    room.current.revealed = healBool(room.current.revealed, false);
    room.current.awarded = healBool(room.current.awarded, false);
    room.current.friendCallActive = healBool(room.current.friendCallActive, false);
  }
  if (room.settings) room.settings.voteMode = healBool(room.settings.voteMode, false);
  for (const player of room.players) {
    player.ready = healBool(player.ready, false);
    player.captain = healBool(player.captain, false);
    player.connected = healBool(player.connected, false);
    if (player.vote === 0 || player.vote === 1) player.vote = null;
  }
  const current = room.current;
  if (current && current.friendCallActive && current.friendCallEnd && Date.now() >= current.friendCallEnd) {
    if (current.friendCallRemaining == null) current.deadline = null;
    else {
      const remaining = Number(current.friendCallRemaining) || 0;
      current.deadline = Date.now() + remaining;
      current.total = Math.max(1, Math.ceil(remaining / 1000));
    }
    current.friendCallActive = false;
  }
}

function findQuestionById(qId) {
  let qData = questions.find((q) => q.id === qId);
  if (!qData) {
    try {
      const jsonBank = JSON.parse(fs.readFileSync(path.join(__dirname, "data", "questions_bank_complete.json"), "utf8"));
      qData = (jsonBank.questions || []).find((q) => q.id === qId);
    } catch (_) {}
  }
  return qData || null;
}

function hintFromQuestion(qData) {
  const answer = String(qData?.answer || "").trim();
  let text = String(qData?.explanation || qData?.explain || "").trim();
  if (answer && text.includes(answer)) text = text.split(answer).join("…").replace(/\s+/g, " ").trim();
  const useful = text.replace(/[.…\s]/g, "");
  if (useful.length < 12) {
    const core = answer.replace(/^ال/, "");
    const first = [...core].find((ch) => /[\u0600-\u06FFA-Za-z0-9]/.test(ch)) || "";
    const count = [...core.replace(/\s/g, "")].length;
    text = first ? `الجواب كيبدأ بـ «${first}» وفيه ${count} حرف` : "فكر فالتفاصيل ديال السؤال";
  }
  return text.slice(0, 240);
}

function pauseQuestionClock(current, now, ms, label) {
  const remaining = current.deadline ? Math.max(0, current.deadline - now) : null;
  current.friendCallActive = true;
  current.friendCallEnd = now + ms;
  current.friendCallRemaining = remaining;
  current.friendCallLabel = label;
  current.deadline = null;
}

function getAvailableLifelines(room, team) {
  const chosen = chosenLifelineIds(room, team);
  const used = room.lifelines?.[team] || {};
  return chosen.map(id => {
    const def = ALL_LIFELINES.find(l => l.id === id);
    return { ...def, available: !used[id] };
  });
}

function sanitizeRoom(room) {
  const lifelinesInfo = {};
  for (const team of ["red","green"]) {
    const chosen = chosenLifelineIds(room, team);
    const used = room.lifelines?.[team] || {};
    lifelinesInfo[team] = chosen.map(id => {
      const def = ALL_LIFELINES.find(l=>l.id===id);
      return {...def, available:!used[id]};
    });
  }
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
    lifelines: room.lifelines || { red: {}, green: {} },
    lifelinesInfo,
    allLifelines: ALL_LIFELINES,
    createdAt: room.createdAt,
    rev: room.rev || 0,
  };
}


function parseSerovalNode(node, root) {
  if (node == null) return undefined;
  if (typeof node !== "object") return node;
  if (node.t === 0) return node.s;
  if (node.t === 1) return node.s;
  if (node.t === 2) {
    if (node.s === 0) return null;
    if (node.s === 1) return undefined;
    if (node.s === 2) return true;
    if (node.s === 3) return false;
    if (node.s === 4) return -0;
    if (node.s === 5) return Infinity;
    if (node.s === 6) return -Infinity;
    if (node.s === 7) return NaN;
    return undefined;
  }
  if (node.t === 3 && typeof node.s === "string") {
    try { return BigInt(node.s); } catch (_) { return node.s; }
  }
  if (node.t === 10 && node.p) {
    const obj = {};
    const keys = node.p.k || [];
    const vals = node.p.v || [];
    for (let i = 0; i < keys.length; i++) {
      obj[keys[i]] = parseSerovalNode(vals[i], root);
    }
    return obj;
  }
  if (node.t === 9 && node.a) {
    return node.a.map(item => parseSerovalNode(item, root));
  }
  if (node.s !== undefined && node.t == null) return node.s;
  if (node.n !== undefined) return node.n;
  if (node.b !== undefined) return node.b;
  return undefined;
}

function healBool(value, fallback = false) {
  if (value === true || value === false) return value;
  if (value === 2) return true;
  if (value === 3 || value === 0 || value === 1) return false;
  if (value == null) return fallback;
  return !!value;
}

function unpackPayload(body) {
  if (!body) return {};
  try {
    // تحويل Buffer إلى string إذا لزم (Vercel Serverless يُعطي req.body كـ Buffer أحياناً)
    let str;
    if (Buffer.isBuffer(body)) {
      str = body.toString("utf8");
    } else if (typeof body === "string") {
      str = body;
    } else if (typeof body === "object") {
      // إذا كان object جاهز (Vercel قد يُحلّل body تلقائياً)
      if (body.t && body.f !== undefined) {
        const parsed = parseSerovalNode(body.t, body);
        return parsed?.data || parsed || {};
      }
      return body.data || body;
    } else {
      return {};
    }
    const json = JSON.parse(str);
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
    // تحويل Buffer إلى string لضمان التوافق مع Vercel Serverless
    if (Buffer.isBuffer(req.body)) {
      return req.body.toString("utf8");
    }
    return req.body;
  }
  if (req.readableEnded || req.complete) {
    return "";
  }
  return new Promise((resolve) => {
    let chunks = [];
    req.on("data", chunk => { chunks.push(chunk); });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      req.body = raw;
      resolve(raw);
    });
    req.on("error", () => resolve(""));
  });
}

async function sendFnResponse(res, data, roomToSave = null) {
  // حفظ الغرفة تلقائياً إذا مُررت لضمان الاستمرارية في Vercel
  if (roomToSave && roomToSave.code) {
    await saveRoom(roomToSave.code, roomToSave);
  }
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (!res.headersSent) {
    res.writeHead(200);
  }
  const out = {
    result: data,
    data: data,
    ...(typeof data === "object" && data !== null ? data : {})
  };
  res.end(JSON.stringify(out));
}

// معالج الطلبات العام المتوافق مع Node.js و Vercel Serverless
export async function handleRequest(req, res) {
  try {
    return await _handleRequest(req, res);
  } catch (err) {
    console.error("[UNHANDLED_ERROR]", err?.message || err);
    if (!res.headersSent) {
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.writeHead(500);
      res.end(JSON.stringify({ error: err?.message || "خطأ غير متوقع", ok: false }));
    }
  } finally {
    const jobs = globalThis.__seenWrites || [];
    globalThis.__seenWrites = [];
    if (jobs.length) await Promise.all(jobs);
  }
}

async function _handleRequest(req, res) {
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
  if (req.method === "POST" || req.method === "PUT" || req.method === "PATCH") {
    if (req.body === undefined || req.body === null) {
      req.body = await new Promise((resolve) => {
        let chunks = [];
        req.on("data", chunk => { chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)); });
        req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        req.on("error", () => resolve(""));
      });
    } else if (Buffer.isBuffer(req.body)) {
      // Vercel قد يُعطي req.body كـ Buffer - نحوّله لـ string
      req.body = req.body.toString("utf8");
    }
  }
  // إتاحة CORS للأجهزة والشبكة المحلية
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-seen-guest, x-seen-name, x-tsr-serverFn, accept");
  res.setHeader("Access-Control-Expose-Headers", "Content-Type, x-tss-serialized");
  // ضمان Content-Type مبكراً لتجنب خطأ TanStack "no content-type"
  if (req.method !== "OPTIONS" && pathname !== "/api/proxy-image") {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
  }

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

    const fetchImage = (target, redirectsLeft) => {
      const client = target.startsWith("https") ? https : http;
      const reqImg = client.get(target, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
          "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
        },
      }, (proxyRes) => {
        if (proxyRes.statusCode >= 300 && proxyRes.statusCode < 400 && proxyRes.headers.location && redirectsLeft > 0) {
          proxyRes.resume();
          try {
            fetchImage(new URL(proxyRes.headers.location, target).href, redirectsLeft - 1);
          } catch (_) {
            res.writeHead(502);
            res.end("bad redirect");
          }
          return;
        }
        const chunks = [];
        proxyRes.on("data", (chunk) => chunks.push(chunk));
        proxyRes.on("end", () => {
          const body = Buffer.concat(chunks);
          const mime = String(proxyRes.headers["content-type"] || "image/jpeg").split(";")[0];
          const ok = proxyRes.statusCode === 200 && mime.startsWith("image/");
          if (!ok) {
            res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
            res.end("image unavailable");
            return;
          }
          if (canWriteDisk) {
            try {
              fs.writeFileSync(cachedFilePath, body);
              fs.writeFileSync(metaPath, mime);
            } catch (_) {}
          }
          res.writeHead(200, {
            "Content-Type": mime,
            "Cache-Control": "public, max-age=86400",
            "Access-Control-Allow-Origin": "*",
          });
          res.end(body);
        });
      });
      reqImg.on("error", (err) => {
        console.error("[PROXY_ERROR]", target, err.message);
        if (!res.headersSent) {
          res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
          res.end(err.message);
        }
      });
      reqImg.setTimeout(15000, () => reqImg.destroy(new Error("timeout")));
    };
    fetchImage(imgUrl, 3);
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
    console.log("[INSIDE SERVERFN BODY]");

      // أ) دالة إنشاء غرفة (b6a03d5cb0dea21e320dfac594c299c2c147746c2d6031a29d4ac6455979463a)
      if (fnHash === "b6a03d5cb0dea21e320dfac594c299c2c147746c2d6031a29d4ac6455979463a") {
        const room = await createRoomInstance(payload, guestId, guestName);
        await sendFnResponse(res, {
          code: room.code,
          room: sanitizeRoom(room),
        });
        return;
      }

      // ب) دالة الاستعلام الدوري عن حالة الغرفة (2671d47a3a37cb7e318bc0c7be44c28a742856706a855a0b716a2f45a07f433d)
      if (fnHash === "2671d47a3a37cb7e318bc0c7be44c28a742856706a855a0b716a2f45a07f433d") {
        console.log("[POLL_STATE] req headers:", req.headers["x-seen-guest"], "payload:", JSON.stringify(payload));

        const code = (payload.code || url.searchParams.get("code") || "").toUpperCase();
        const room = await loadRoom(code, guestId, guestName, payload.snapshot || null);
        if (!room) {
          await sendFnResponse(res, null);
          return;
        }
        if (room && room.kicked && (room.kicked.includes(guestId) || (guestName && room.kicked.includes(guestName)))) {
          await sendFnResponse(res, { ok: false, kicked: true, error: "تم طردك من هذه الغرفة بواسطة المشرف" });
          return;
        }

        // تحديث حالة الاتصال - فقط نحدث last_seen بدون saveRoom في كل poll
        let player = findPlayer(room, guestId, guestName, payload.playerId);

        let needsSave = false;
        if (player) {
          player.last_seen = Date.now();
          player.connected = true;
          if (guestName && guestName !== "لاعب" && player.name === "لاعب") {
            player.name = guestName.trim();
            needsSave = true; // نحفظ فقط إذا تغير الاسم
          }
          // لا نُستدعي saveRoom في كل poll - فقط عند تغييرات حقيقية
          if (needsSave) await saveRoom(room.code, room);
        }

        const view = sanitizeRoom(room);
        const snapRev = Number(payload.snapshot?.rev) || 0;
        if (snapRev > (Number(view.rev) || 0)) view.rev = snapRev;
        await sendFnResponse(res, {
          room: view,
          // connected بـ bucket 30 ثانية لمنع التغيير في كل poll
          players: (room.players || []).map(p => {
            // bucket بـ 30 ثانية: true إذا last_seen < 90s، نُقرّب للـ 30s لتقليل التغيير
            const bucket30 = Math.floor(Date.now() / 30000);
            const lastBucket = Math.floor((p.last_seen || 0) / 30000);
            const isConnected = (bucket30 - lastBucket) < 3; // أقل من 3 buckets = أقل من 90 ثانية
            return {
              id: p.id,
              user_id: p.user_id,
              name: p.name,
              role: p.role,
              team: p.team,
              ready: p.ready,
              captain: p.captain,
              connected: isConnected,
              vote: p.vote,
            };
          }),
          messages: room.messages || [],
          kickedIds: room.kicked || [],
        });
        return;
      }

      // ج) دالة الانضمام لغرفة (3f5434af99322857bca8801cb4fceb3939b136bab699d4daef7430f26712449a)
      if (fnHash === "3f5434af99322857bca8801cb4fceb3939b136bab699d4daef7430f26712449a") {
        const code = (payload.code || "").toUpperCase();
        let room = null;
        for (let attempt = 0; attempt < 5 && !room; attempt++) {
          room = await loadRoom(code, guestId, guestName, payload.snapshot || null);
          if (!room && attempt < 4) await new Promise((resolve) => setTimeout(resolve, 300));
        }
        if (!room) {
          await sendFnResponse(res, null);
          return;
        }
        if (isKicked(room, guestId, payload.name || guestName)) {
          await sendFnResponse(res, { ok: false, kicked: true, error: "تم طردك من هذه الغرفة بواسطة المشرف" });
          return;
        }

        let player = findPlayer(room, guestId, payload.name || guestName, payload.playerId);
        if (player) {
          if (payload.name) player.name = payload.name.trim();
          if (payload.team) player.team = payload.team;
          player.last_seen = Date.now();
          player.connected = true;
        } else {
          const isFirst = room.players.length === 0;
          const stableId = guestId ? "p-" + guestId.replace(/[^a-z0-9]/gi, "").slice(0, 8) : "p-" + Math.random().toString(36).slice(2, 8);
          // تحقق بالـ stableId أيضاً
          const existingByStableId = room.players.find(p => p.id === stableId);
          if (existingByStableId) {
            player = existingByStableId;
            if (payload.name) player.name = payload.name.trim();
            if (payload.team) player.team = payload.team;
            player.user_id = guestId || player.user_id;
            player.last_seen = Date.now();
            player.connected = true;
          } else {
            player = {
              id: stableId,
              user_id: guestId || `g-${Date.now()}`,
              name: (payload.name || guestName || "لاعب").trim(),
              role: isFirst ? "host" : "player",
              team: payload.team || "red",
              ready: true,
              captain: isFirst || !room.players.some(p => p.team === (payload.team || "red") && p.captain),
              connected: true,
              last_seen: Date.now(),
              vote: null,
            };
            room.players.push(player);
          }
        }
        await saveRoom(room.code, room);

        await sendFnResponse(res, {
          code: room.code,
          room: sanitizeRoom(room),
          player,
        });
        return;
      }

      // د) دالة تعديل اللاعب لنفسه (a50ea8dede48ff28d2d768225fec7dbfc09e46366be18348629aff803e6c090a)
      if (fnHash === "a50ea8dede48ff28d2d768225fec7dbfc09e46366be18348629aff803e6c090a") {
        const code = (payload.code || "").toUpperCase();
        const room = await loadRoom(code, guestId, guestName);
        if (room) {
          const player = findPlayer(room, guestId, guestName, payload.playerId);
          if (player) {
            if (payload.name !== undefined) player.name = payload.name.trim();
            if (payload.team === "red" || payload.team === "green") {
              if (player.team !== payload.team) {
                player.captain = !room.players.some((p) => p !== player && p.team === payload.team && p.captain);
              }
              player.team = payload.team;
            }
            if (payload.ready !== undefined) player.ready = !!payload.ready;
            player.last_seen = Date.now();
            await saveRoom(room.code, room);  // حفظ تعديلات اللاعب
          }
        }
        await sendFnResponse(res, { ok: true, room: room ? sanitizeRoom(room) : null }, room);
        return;
      }

      // هـ) دالة نبض الاتصال (592dd66f94a3598b050f602f9690b1235e57e7482e9ba93b40db806501485dc7)
      if (fnHash === "592dd66f94a3598b050f602f9690b1235e57e7482e9ba93b40db806501485dc7") {
        const code = (payload.code || "").toUpperCase();
        const room = await loadRoom(code, guestId, guestName);
        if (room) {
          const player = room.players.find(p => p.user_id === guestId);
          if (player) {
            player.last_seen = Date.now();
            player.connected = true;
          }
        }
        await sendFnResponse(res, { ok: true });
        return;
      }

      // و) دالة إدارة المضيف للاعبين (e072b2ac2728ef1c5cff8085d7918c43ea2f449bf174b69c2c3b42b63f1a5b81)
      if (fnHash === "e072b2ac2728ef1c5cff8085d7918c43ea2f449bf174b69c2c3b42b63f1a5b81") {
        const code = (payload.code || "").toUpperCase();
        const room = await loadRoom(code, guestId, guestName);
        if (room) {
          if (payload.kick) {
            const actor = findPlayer(room, guestId, guestName);
            if (!actor || actor.role !== "host") {
              await sendFnResponse(res, { ok: false, error: "فقط صاحب الغرفة يقدر يطرد" });
              return;
            }
            const kickedPlayer = room.players.find(p => p.id === payload.playerId || p.user_id === payload.playerId);
            if (kickedPlayer && kickedPlayer.role !== "host" && kickedPlayer.id !== actor.id) {
              room.kicked = room.kicked || [];
              if (kickedPlayer.user_id && !room.kicked.includes(kickedPlayer.user_id)) {
                room.kicked.push(kickedPlayer.user_id);
              }
              if (kickedPlayer.id && !room.kicked.includes(kickedPlayer.id)) {
                room.kicked.push(kickedPlayer.id);
              }
              if (kickedPlayer.name && !room.kicked.includes(kickedPlayer.name)) {
                room.kicked.push(kickedPlayer.name);
              }
              room.players = withoutKicked(room, room.players.filter(p => p.id !== kickedPlayer.id && p.user_id !== kickedPlayer.user_id));
              if (!Array.isArray(room.messages)) room.messages = [];
              room.messages.push({
                id: "msg-" + Date.now(),
                name: "النظام",
                content: `🚪 تم طرد «${kickedPlayer.name}» من الغرفة`,
                team: "all",
                kind: "system",
                time: Date.now(),
              });
              await saveRoom(room.code, room);
              await sendFnResponse(res, { ok: true, room: sanitizeRoom(room), players: room.players });
              return;
            }
            await sendFnResponse(res, { ok: false, error: "ما قدرناش نطردو هاد اللاعب" });
            return;
          } else {
            const actor = findPlayer(room, guestId, guestName);
            const player = room.players.find(p => p.id === payload.playerId || p.user_id === payload.playerId);
            if (player && actor?.role === "host" && payload.team) player.team = payload.team;
            const sameTeamCaptain = actor && actor.captain && player && actor.team === player.team && actor.id !== player.id;
            if (sameTeamCaptain && payload.captain) {
              room.players.filter(p => p.team === player.team).forEach(p => { p.captain = false; });
              player.captain = true;
            }
            await saveRoom(room.code, room);  // حفظ تغييرات الكابتن والفريق
          }
        }
        await sendFnResponse(res, { ok: true, room: room ? sanitizeRoom(room) : null }, room);
        return;
      }

      // ز) دالة تبديل وضع التصويت (d926873c9e0ff523dfaf922be37122e6dc35ecd7eae5de19e4c9c0abf24be61d)
      if (fnHash === "d926873c9e0ff523dfaf922be37122e6dc35ecd7eae5de19e4c9c0abf24be61d") {
        const code = (payload.code || "").toUpperCase();
        const room = await loadRoom(code, guestId, guestName);
        if (room && payload.settings) {
          room.settings.voteMode = !!payload.settings.voteMode;
          await saveRoom(room.code, room);
        }
        await sendFnResponse(res, { ok: true, room: room ? sanitizeRoom(room) : null }, room);
        return;
      }

      // ح) دالة انطلاق اللعبة (3cf3b624d778237a3ac1ead6fde77274f3c78eb1303ccc65be1cafac0deaf033)
      if (fnHash === "3cf3b624d778237a3ac1ead6fde77274f3c78eb1303ccc65be1cafac0deaf033") {
        const code = (payload.code || "").toUpperCase();
        const room = await loadRoom(code, guestId, guestName);
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
        await sendFnResponse(res, { ok: true, room: room ? sanitizeRoom(room) : null }, room);
        return;
      }

      // ط) دالة اختيار خانة السؤال (b60d9b1fdcaa3c8da56f6950e9d0fe81ea0f41bfcb81c99438b2f2deb108e1cd)
      if (fnHash === "b60d9b1fdcaa3c8da56f6950e9d0fe81ea0f41bfcb81c99438b2f2deb108e1cd") {
        const code = (payload.code || "").toUpperCase();
        const room = await loadRoom(code, guestId, guestName);
        if (room && payload.key) {
          if (!Array.isArray(room.used)) room.used = [];
          if (!Array.isArray(room.board)) room.board = [];
          const player = findPlayer(room, guestId, guestName, payload.playerId);
          if (room.current && !room.current.awarded) {
            await sendFnResponse(res, { ok: false, error: "السؤال الحالي مازال مفتوح. كمّلوه قبل اختيار خانة جديدة." });
            return;
          }
          if (room.used.includes(payload.key)) {
            await sendFnResponse(res, { ok: false, error: "هاد الخانة تلعبات من قبل" });
            return;
          }
          const effectiveTurn = turnAfterClose(room);
          if (player && player.team && player.team !== effectiveTurn) {
            console.log(`[BLOCKED] تم منع اللاعب ${player.name} (${player.team}) من اختيار خانة لأن الدور لـ ${effectiveTurn}`);
            await sendFnResponse(res, { ok: false, error: "ليس دور فريقك لاختيار السؤال" });
            return;
          }
          closeAwardedQuestion(room);
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
          await saveRoom(room.code, room);
        }
        await sendFnResponse(res, { ok: true, room: room ? sanitizeRoom(room) : null }, room);
        return;
      }

      // ي) دالة تصويت اللاعب على خانة (b5f859259799fccfda877d42505508cbf8bb0b008ca29cb1b81567f79e8fcb48)
      if (fnHash === "b5f859259799fccfda877d42505508cbf8bb0b008ca29cb1b81567f79e8fcb48") {
        const code = (payload.code || "").toUpperCase();
        const room = await loadRoom(code, guestId, guestName);
        if (room) {
          const player = room.players.find(p => p.user_id === guestId);
          if (player) player.vote = payload.key;
        }
        await sendFnResponse(res, { ok: true, room: room ? sanitizeRoom(room) : null }, room);
        return;
      }

      // ك) دالة اعتماد تصويت الفريق (8d50640cf1e1965be7c19869bf559c66e691e70c0d56780e8e357c349634e1b2)
      if (fnHash === "8d50640cf1e1965be7c19869bf559c66e691e70c0d56780e8e357c349634e1b2") {
        const code = (payload.code || "").toUpperCase();
        const room = await loadRoom(code, guestId, guestName);
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
            await saveRoom(room.code, room);
          }
          room.players.forEach(p => p.vote = null);
        }
        await sendFnResponse(res, { ok: true, room: room ? sanitizeRoom(room) : null }, room);
        return;
      }

      // ل) دالة كشف الجواب (ed573daface9b83072fecbbfb375251c6b62a091f2df2f939a2428f8ac851162)
      if (fnHash === "ed573daface9b83072fecbbfb375251c6b62a091f2df2f939a2428f8ac851162") {
        const code = (payload.code || "").toUpperCase();
        const room = await loadRoom(code, guestId, guestName);
        if (room) {
          await restoreCurrentFromPayload(room, payload);
          if (room.current) {
            room.current.revealed = true;
            await saveRoom(room.code, room);
          }
        }
        await sendFnResponse(res, { ok: true, room: room ? sanitizeRoom(room) : null }, room);
        return;
      }

      // م) دالة منح النقاط للفائز (c4e7a4b9c4e13c37246b17ca655f2af59319ea9dc9616be7f8eee652a70b3fb2)
      if (fnHash === "c4e7a4b9c4e13c37246b17ca655f2af59319ea9dc9616be7f8eee652a70b3fb2") {
        const code = (payload.code || "").toUpperCase();
        const room = await loadRoom(code, guestId, guestName);
        if (room) {
          await restoreCurrentFromPayload(room, payload);
        }
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
          await saveRoom(room.code, room);
        }
        await sendFnResponse(res, { ok: true, room: room ? sanitizeRoom(room) : null }, room);
        return;
      }

      // ن) دالة تعديل النقاط يدوياً (02ba190985e1193a99b79612702f36124040bde6374079e830fd41471a4f2190)
      if (fnHash === "02ba190985e1193a99b79612702f36124040bde6374079e830fd41471a4f2190") {
        const code = (payload.code || "").toUpperCase();
        const room = await loadRoom(code, guestId, guestName);
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
        await sendFnResponse(res, { ok: true, room: room ? sanitizeRoom(room) : null }, room);
        return;
      }

      // س) دالة الانتقال للسؤال التالي (3384f975f333a274c7046854ffc0ce43371f9ff1c861817d9324dffa6dce3e25)
      if (fnHash === "3384f975f333a274c7046854ffc0ce43371f9ff1c861817d9324dffa6dce3e25") {
        const code = (payload.code || "").toUpperCase();
        const room = await loadRoom(code, guestId, guestName);
        if (room && closeAwardedQuestion(room)) {
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
          await saveRoom(room.code, room);
        }
        await sendFnResponse(res, { ok: true, room: room ? sanitizeRoom(room) : null }, room);
        return;
      }

      // ع) دالة إيقاف/استئناف اللعبة مؤقتاً (cbeec8773419deec8ce7dd97665b2d14934ddf48ba8955d1c61d351b95ca7910)
      if (fnHash === "cbeec8773419deec8ce7dd97665b2d14934ddf48ba8955d1c61d351b95ca7910") {
        const code = (payload.code || "").toUpperCase();
        const room = await loadRoom(code, guestId, guestName);
        if (room) {
          room.paused = !room.paused;
          await saveRoom(room.code, room);
        }
        await sendFnResponse(res, { ok: true, room: room ? sanitizeRoom(room) : null }, room);
        return;
      }

      // ف) دالة إنهاء اللعبة (a187b4d4a19074ed9408afa257c8033d2acb480dfe1c62e0add30d11122c5af9)
      if (fnHash === "a187b4d4a19074ed9408afa257c8033d2acb480dfe1c62e0add30d11122c5af9") {
        const code = (payload.code || "").toUpperCase();
        const room = await loadRoom(code, guestId, guestName);
        if (room) {
          room.status = "finished";
          room.current = null;
        }
        await sendFnResponse(res, { ok: true, room: room ? sanitizeRoom(room) : null }, room);
        return;
      }

      // ص) دالة إعادة ضبط المباراة (7eb9799b85ffdbbdb13165831be0f77419ed446c392448d532da34bdd22a0c85)
      if (fnHash === "7eb9799b85ffdbbdb13165831be0f77419ed446c392448d532da34bdd22a0c85") {
        const code = (payload.code || "").toUpperCase();
        const room = await loadRoom(code, guestId, guestName);
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
        await saveRoom(room.code, room);
        await sendFnResponse(res, { ok: true, room: room ? sanitizeRoom(room) : null }, room);
        return;
      }

      // ق) دالة فتح/إغلاق الدردشة (48e56b7f05656138ec030ecb14269bf296dbccae425713ea6722e07727f6c9de)
      if (fnHash === "48e56b7f05656138ec030ecb14269bf296dbccae425713ea6722e07727f6c9de") {
        const code = (payload.code || "").toUpperCase();
        const room = await loadRoom(code, guestId, guestName);
        if (room) {
          room.chat_open = !!payload.open;
        }
        await sendFnResponse(res, { ok: true, room: room ? sanitizeRoom(room) : null }, room);
        return;
      }

      // ر) دالة إرسال رسالة في الشات (d97e650e4c3026fe1bba7c7a47166e126c58bdca4a7d0bc37757c1cfd33ac7bf)
      if (fnHash === "d97e650e4c3026fe1bba7c7a47166e126c58bdca4a7d0bc37757c1cfd33ac7bf") {
        const code = (payload.code || "").toUpperCase();
        const room = await loadRoom(code, guestId, guestName);
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
        await sendFnResponse(res, { ok: true });
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
        await sendFnResponse(res, roomList);
        return;
      }

      // ت) استجابة عامة لأي طلب serverFn آخر
      await sendFnResponse(res, { success: true, ok: true });
      return;
  }

  // 2. إدارة الغرف المباشرة عبر REST API (/api/rooms/create)
  if (pathname === "/api/rooms/create" && req.method === "POST") {
    const guestId = req.headers["x-seen-guest"] || "";
    const guestName = decodeURIComponent(req.headers["x-seen-name"] || "");
    try {
      const rawBody = await getRawOrParsedBody(req);
      const payload = unpackPayload(rawBody);
      const room = await createRoomInstance(payload, guestId, guestName, payload.code || null);
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
    const guestId = req.headers["x-seen-guest"] || "";
    const guestName = decodeURIComponent(req.headers["x-seen-name"] || "");
    const room = await loadRoom(code, guestId, guestName);
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
      const room = await loadRoom(code, guestId, guestName);

      // استرجاع current من payload إذا كان مفقوداً (Vercel cold start)
      if (room) await restoreCurrentFromPayload(room, payload);

      if (!room || !room.current || room.current.revealed) {
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, message: "لا يوجد سؤال نشط حالياً للإجابة" }));
        return;
      }

      if (payload.cellKey && room.current.cellKey && payload.cellKey !== room.current.cellKey) {
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, message: "هذا ليس السؤال المفتوح الآن" }));
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

      if (room.current.answerBusy === currentAnsweringTeam) {
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, message: "فريقك جاوب دابا على هاد السؤال" }));
        return;
      }
      room.current.answerBusy = currentAnsweringTeam;

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
        let gained = val;
        if (room.current.bonusFor === currentAnsweringTeam) gained += Number(room.current.bonusPoints) || 0;
        if (room.current.doubleOnSteal && room.current.doubleFor === currentAnsweringTeam) gained *= 2;
        room.current.revealed = true;
        room.current.awarded = true;
        room.current.winner = currentAnsweringTeam;
        room.scores[currentAnsweringTeam] = (room.scores[currentAnsweringTeam] || 0) + gained;
        if (!room.used.includes(room.current.cellKey)) {
          room.used.push(room.current.cellKey);
        }
        room.log.unshift({
          id: "log-" + Date.now(),
          reason: "إجابة صحيحة",
          delta: gained,
          text: `+${gained} نقطة لـ${teamLabel} بعد إجابة صحيحة (${selectedOpt})! 🎯`,
          time: Date.now(),
        });
      } else {
        if (!room.current.wrongAnswers.includes(selectedOpt)) {
          room.current.wrongAnswers.push(selectedOpt);
        }
        const extraTry = (room.current.doubleChance || room.current.secondChance) && room.current.extraTryFor !== currentAnsweringTeam;
        if (extraTry) {
          room.current.extraTryFor = currentAnsweringTeam;
          room.current.answerBusy = null;
          room.log.unshift({
            id: "log-" + Date.now(),
            reason: "محاولة ثانية",
            delta: 0,
            text: `إجابة خاطئة (${selectedOpt}) من ${teamLabel}. عندهم محاولة ثانية على نفس السؤال.`,
            time: Date.now(),
          });
        } else if (!room.current.attemptedTeams.includes(currentAnsweringTeam)) {
          room.current.attemptedTeams.push(currentAnsweringTeam);
        }
        if (!extraTry && room.current.doubleNeg === currentAnsweringTeam) {
          const pen = val * 2;
          room.scores[currentAnsweringTeam] = (room.scores[currentAnsweringTeam] || 0) - pen;
          room.log.unshift({
            id: "log-" + Date.now(),
            reason: "مضاعفة الخسارة",
            delta: -pen,
            text: `−${pen} نقطة على ${teamLabel} بسبب مضاعفة الخسارة.`,
            time: Date.now(),
          });
        }
        if (extraTry) {
          await saveRoom(room.code, room);
          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({
            ok: true,
            isCorrect: false,
            room: sanitizeRoom(room),
            players: room.players,
            messages: room.messages,
          }));
          return;
        }

        const opposingTeam = currentAnsweringTeam === "red" ? "green" : "red";
        const opposingTeamLabel = opposingTeam === "red" ? "الفريق الأحمر 🔴" : "الفريق الأخضر 🟢";

        if (!room.current.attemptedTeams.includes(opposingTeam) && !room.current.noSteal && room.current.frozen !== opposingTeam) {
          // نقل فرصة الإجابة للفريق الخصم (خطف السؤال) مع 15 ثانية إضافية
          room.current.answerBusy = null;
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

      await saveRoom(room.code, room);
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
      const room = await loadRoom(code, guestId, guestName);
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
        room.lifelines = { red: {}, green: {} };
      }
      const teamUsed = room.lifelines[currentAnsweringTeam] || {};
      const teamLabel = currentAnsweringTeam === "red" ? "الفريق الأحمر" : "الفريق الأخضر";
      const lifelineType = payload.type;
      const def = ALL_LIFELINES.find(l => l.id === lifelineType);
      if (!def) {
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, message: "هذه الوسيلة ما بقاش متاحة" }));
        return;
      }

      // تحقق من أن الوسيلة مختارة من قِبل الفريق
      const chosen = room.settings?.chosenLifelines?.[currentAnsweringTeam] || ["5050","friend","extra30"];
      if (!chosen.includes(lifelineType)) {
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, message: "هذه الوسيلة ليست مختارة من قِبل فريقك" }));
        return;
      }
      if (teamUsed[lifelineType]) {
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, message: `وسيلة "${def?.name || lifelineType}" مستهلكة مسبقاً` }));
        return;
      }

      // تنفيذ الوسيلة
      teamUsed[lifelineType] = true;
      room.lifelines[currentAnsweringTeam] = teamUsed;
      const cost = Number(def.cost) || 0;
      if (!room.scores) room.scores = { red: 0, green: 0 };
      room.scores[currentAnsweringTeam] = (room.scores[currentAnsweringTeam] || 0) - cost;

      const now = Date.now();
      let logText = `استخدم ${teamLabel} وسيلة "${def?.emoji || "⭐"} ${def?.name || lifelineType}"` + (cost ? ` (−${cost} نقطة)` : "");

      // ===== تنفيذ كل وسيلة =====
      if (lifelineType === "5050" || lifelineType === "reduce") {
        // حذف خيارين/خيار خاطئ
        const qId = room.current.questionId;
        let qData = questions.find(q => q.id === qId);
        if (!qData) {
          try { const jb = JSON.parse(fs.readFileSync(path.join(__dirname,"data","questions_bank_complete.json"),"utf8")); qData=(jb.questions||[]).find(q=>q.id===qId); } catch(_){}
        }
        const correctOpt = String(qData?.correct_answer || "A").toUpperCase();
        const wrongOpts = ["A","B","C","D"].filter(k=>k!==correctOpt).sort(()=>Math.random()-.5);
        room.current.hiddenOptions = lifelineType === "5050" ? wrongOpts.slice(0,2) : wrongOpts.slice(0,1);
        logText += ` (حُذفت ${room.current.hiddenOptions.length} خيارات خاطئة)`;

      } else if (lifelineType === "friend") {
        pauseQuestionClock(room.current, now, 30000, "📞 تشاور");
        logText += ` (الوقت متوقف 30 ثانية للتشاور 📞)`;

      } else if (lifelineType === "extra30") {
        const remaining = Math.max(0, (room.current.deadline||now) - now);
        room.current.deadline = now + remaining + 30000;
        room.current.total = (room.current.total||30) + 30;
        logText += ` (+30 ثانية ⏰)`;

      } else if (lifelineType === "extra15") {
        const remaining = Math.max(0, (room.current.deadline||now) - now);
        room.current.deadline = now + remaining + 15000;
        room.current.total = (room.current.total||30) + 15;
        logText += ` (+15 ثانية)`;

      } else if (lifelineType === "time_stop") {
        pauseQuestionClock(room.current, now, 20000, "⏸️ الوقت واقف");
        logText += ` (العداد واقف 20 ثانية)`;

      } else if (lifelineType === "hint") {
        room.current.hintText = hintFromQuestion(findQuestionById(room.current.questionId));
        logText += ` (بان التلميح)`;

      } else if (lifelineType === "reveal_opt") {
        // كشف حرف الإجابة الصحيحة
        const qId = room.current.questionId;
        let qData = questions.find(q => q.id === qId);
        if (!qData) { try { const jb=JSON.parse(fs.readFileSync(path.join(__dirname,"data","questions_bank_complete.json"),"utf8")); qData=(jb.questions||[]).find(q=>q.id===qId); } catch(_){} }
        room.current.revealedLetter = String(qData?.correct_answer || "A").toUpperCase();
        logText += ` (الجواب يبدأ بـ ${room.current.revealedLetter})`;

      } else if (lifelineType === "double") {
        room.current.doubleChance = true;
        logText += ` (مسموح بمحاولتين)`;

      } else if (lifelineType === "second_ch") {
        room.current.secondChance = true;
        logText += ` (فرصة ثانية عند الخطأ)`;

      } else if (lifelineType === "no_steal") {
        room.current.noSteal = true;
        logText += ` (محمية من الخطف)`;

      } else if (lifelineType === "freeze") {
        room.current.frozen = currentAnsweringTeam === "red" ? "green" : "red";
        logText += ` (الخصم مُجمَّد)`;

      } else if (lifelineType === "bonus50") {
        room.current.bonusPoints = (room.current.bonusPoints||0) + 50;
        room.current.bonusFor = currentAnsweringTeam;
        logText += ` (+50 نقطة بونص على هذه الخانة)`;

      } else if (lifelineType === "steal") {
        room.current.doubleOnSteal = true;
        room.current.doubleFor = currentAnsweringTeam;
        logText += ` (النقاط مضاعفة عند الإجابة الصحيحة)`;

      } else if (lifelineType === "audience") {
        const qId = room.current.questionId;
        let qData = questions.find(q=>q.id===qId);
        if (!qData) { try { const jb=JSON.parse(fs.readFileSync(path.join(__dirname,"data","questions_bank_complete.json"),"utf8")); qData=(jb.questions||[]).find(q=>q.id===qId); } catch(_){} }
        const correctOpt = String(qData?.correct_answer||"A").toUpperCase();
        const opts = ["A","B","C","D"];
        let pcts = {}; let rem = 100;
        opts.forEach((k,i) => {
          if (k === correctOpt) return;
          const p = i < opts.length-1 ? Math.floor(Math.random()*15) : 0;
          pcts[k] = p; rem -= p;
        });
        pcts[correctOpt] = rem;
        room.current.audienceVotes = pcts;
        logText += ` (رأي الجمهور: ${correctOpt}=${pcts[correctOpt]}%)`;

      } else if (lifelineType === "double_neg") {
        room.current.doubleNeg = currentAnsweringTeam === "red" ? "green" : "red";
        logText += ` (خطأ الخصم = ضعف الخصم)`;

      } else if (lifelineType === "all_see") {
        room.current.allSeeActive = true;
        logText += ` (الجواب مرئي للجميع)`;
      }

      room.log.unshift({ id:"log-"+Date.now(), reason:"وسيلة مساعدة", delta: cost ? -cost : 0, text:logText, time:now });
      await saveRoom(room.code, room);
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok:true, room:sanitizeRoom(room), players:room.players, messages:room.messages }));
    } catch (err) {
      res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok:false, error:err.message }));
    }
    return;
  }

  // 5b. مسار اختيار وسائل المساعدة للقائد (/api/rooms/choose-lifelines)
  if (pathname === "/api/rooms/choose-lifelines" && req.method === "POST") {
    const guestId = req.headers["x-seen-guest"] || "";
    try {
      const rawBody = await getRawOrParsedBody(req);
      const payload = unpackPayload(rawBody);
      const code = (payload.code || "").toUpperCase();
      const guestName = decodeURIComponent(req.headers["x-seen-name"] || payload.name || "");
      const room = await loadRoom(code, guestId || payload.userId || "", guestName, payload.snapshot || null);
      if (!room) { res.writeHead(404); res.end(JSON.stringify({ok:false})); return; }
      const player = findPlayer(room, guestId || payload.userId || "", guestName || payload.name || "", payload.playerId);
      if (!isTeamLeader(room, player)) { res.writeHead(200); res.end(JSON.stringify({ok:false,message:"فقط الكابتن يختار الوسائل"})); return; }
      const team = player.team;
      const chosen = (payload.lifelines||[]).filter(id=>ALL_LIFELINES.find(l=>l.id===id)).slice(0,3);
      if (chosen.length < 1) { res.writeHead(200); res.end(JSON.stringify({ok:false,message:"اختر على الأقل وسيلة واحدة"})); return; }
      if (!room.settings) room.settings = {};
      if (!room.settings.chosenLifelines) room.settings.chosenLifelines = {};
      room.settings.chosenLifelines[team] = chosen;
      room.settings.lifelinesPicked = room.settings.lifelinesPicked || {};
      room.settings.lifelinesPicked[team] = true;
      room.log.unshift({ id:"log-"+Date.now(), reason:"اختيار وسائل", delta:0, text:`قائد ${team==="red"?"الأحمر":"الأخضر"} اختار ${chosen.length} وسائل مساعدة`, time:Date.now() });
      await saveRoom(room.code, room);
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok:true, room:sanitizeRoom(room) }));
    } catch(err) {
      res.writeHead(400); res.end(JSON.stringify({ok:false,error:err.message}));
    }
    return;
  }

  // 5c. مسار قائمة الوسائل المتاحة (/api/rooms/lifelines-list)
  if (pathname === "/api/rooms/lifelines-list" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok:true, lifelines:ALL_LIFELINES }));
    return;
  }

  // 5d. مسار انتهاء وقت السؤال (/api/rooms/time-expire)
  if (pathname === "/api/rooms/time-expire" && req.method === "POST") {
    const guestId = req.headers["x-seen-guest"] || "";
    try {
      const rawBody = await getRawOrParsedBody(req);
      const payload = unpackPayload(rawBody);
      const code = (payload.code || "").toUpperCase();
      const room = await loadRoom(code, guestId);
      if (!room || !room.current || room.current.revealed || room.current.awarded) {
        res.writeHead(200); res.end(JSON.stringify({ok:false})); return;
      }
      const currentTeam = room.current.answeringTeam || room.turn;
      const opposingTeam = currentTeam === "red" ? "green" : "red";
      const now = Date.now();
      if (payload.cellKey && room.current.cellKey && payload.cellKey !== room.current.cellKey) {
        res.writeHead(200); res.end(JSON.stringify({ok:false})); return;
      }
      if (!room.current.deadline || (room.current.deadline - now) > 2000) {
        res.writeHead(200); res.end(JSON.stringify({ok:false,message:"الوقت لم ينته بعد"})); return;
      }
      // تحقق هل الخصم جرب مسبقاً
      const attempted = room.current.attemptedTeams || [];
      const noSteal = room.current.noSteal || room.current.frozen === opposingTeam;
      if (!attempted.includes(opposingTeam) && !noSteal) {
        // انتقل السؤال للخصم بدون موقت
        room.current.answerBusy = null;
        room.current.answeringTeam = opposingTeam;
        room.current.deadline = null; // بدون وقت = unlimited
        room.current.total = 999;
        room.current.attemptedTeams = [...attempted, currentTeam];
        room.log.unshift({ id:"log-"+Date.now(), reason:"انتهاء الوقت", delta:0, text:`انتهى وقت ${currentTeam==="red"?"الأحمر":"الأخضر"} — السؤال ينتقل للخصم بدون موقت! ⏰`, time:now });
      } else {
        // كلا الفريقين أخطأ/انتهى وقتهم
        room.current.revealed = true;
        room.current.awarded = true;
        room.current.winner = "none";
        if (!room.used.includes(room.current.cellKey)) room.used.push(room.current.cellKey);
        room.log.unshift({ id:"log-"+Date.now(), reason:"انتهاء الوقت", delta:0, text:`انتهى الوقت — لا نقاط لخانة ${room.current.value}`, time:now });
      }
      await saveRoom(room.code, room);
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok:true, room:sanitizeRoom(room), players:room.players }));
    } catch(err) {
      res.writeHead(400); res.end(JSON.stringify({ok:false,error:err.message}));
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
      const room = await loadRoom(code, guestId, guestName);
      if (!room || !payload.key) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, message: "بيانات غير صالحة" }));
        return;
      }

      const player = room.players.find(p => p.user_id === guestId);
      if (room.current && !room.current.awarded) {
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: "السؤال الحالي مازال مفتوح. كمّلوه قبل اختيار خانة جديدة." }));
        return;
      }
      const effectiveTurn = turnAfterClose(room);
      if (player && player.team && player.team !== effectiveTurn) {
        res.writeHead(403, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: "ليس دور فريقك لاختيار السؤال" }));
        return;
      }
      if (room.used.includes(payload.key)) {
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: "هاد الخانة تلعبات من قبل" }));
        return;
      }
      closeAwardedQuestion(room);

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
      await saveRoom(room.code, room);

      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, room: sanitizeRoom(room) }));
    } catch (err) {
      res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return;
  }

    // مسار تحديث فئات الغرفة (/api/rooms/update-categories)
  if (pathname === "/api/rooms/update-categories" && req.method === "POST") {
    const guestId = req.headers["x-seen-guest"] || "";
    const guestName = decodeURIComponent(req.headers["x-seen-name"] || "");
    try {
      const rawBody = await getRawOrParsedBody(req);
      const payload = unpackPayload(rawBody);
      const code = (payload.code || "").toUpperCase();
      const room = await loadRoom(code, guestId, guestName);
      if (!room) {
        res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: "الغرفة غير موجودة" }));
        return;
      }

      let selectedCategories = payload.categories;
      if (!selectedCategories || !Array.isArray(selectedCategories) || selectedCategories.length < 3) {
        selectedCategories = (mainCategories || []).slice(0, 6).map(c => c.id);
      }

      // إعادة بناء اللوحة بالفئات الجديدة
      room.board = buildBoardForCategories(selectedCategories, code + ":cats:" + Date.now(), await loadUsedQuestionIds());
      await rememberQuestionIds(boardQuestionIds(room.board));
      room.settings = room.settings || {};
      room.settings.categories = selectedCategories;
      room.used = [];
      room.current = null;
      room.log.unshift({
        id: "log-" + Date.now(),
        reason: "تغيير الفئات",
        delta: 0,
        text: `المشرف قام بتحديث فئات الأسئلة (${selectedCategories.length} فئات)`,
        time: Date.now(),
      });
      room.messages.push({
        id: "msg-" + Date.now(),
        name: "النظام",
        content: `🎯 تم تحديث فئات اللوحة (${selectedCategories.length} فئات)`,
        team: "all",
        kind: "system",
        time: Date.now(),
      });

      await saveRoom(room.code, room);
      console.log(`[INFO] تم تحديث فئات الغرفة [${room.code}] إلى:`, selectedCategories);

      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, room: sanitizeRoom(room) }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
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
