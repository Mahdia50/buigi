import fs from "node:fs";
import * as q from "../public/assets/questions-FaeiPOAe.js";

const PHOTO = new Set([
  "food_photos",
  "guess_flag_symbol",
  "guess_monument",
  "guess_person",
  "guess_sports_club",
]);

const letters = ["A", "B", "C", "D"];

function hasImage(it) {
  return String(it.image || "").startsWith("http") || String(it.media?.url || "").startsWith("http");
}

function fold(s) {
  return String(s || "")
    .replace(/\([^)]*\)/g, "")
    .replace(/[إأآا]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/[^\u0600-\u06FFa-z0-9]/gi, "")
    .replace(/ال/g, "");
}

function sameAnswer(a, b, photo) {
  if (!a || !b) return false;
  if (a === b) return true;
  if (!photo) return false;
  const [s, l] = a.length < b.length ? [a, b] : [b, a];
  return s.length >= 8 && l.startsWith(s);
}

function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

function makeQuestion(catId, catName, points, id, question, answer, wrongs, explain, extra = {}) {
  const pool = [...new Set(wrongs.filter((w) => w && fold(w) !== fold(answer)))].slice(0, 3);
  while (pool.length < 3) pool.push(`اختيار ${pool.length + 1}`);
  const items = [answer, pool[0], pool[1], pool[2]];
  const order = [0, 1, 2, 3];
  let h = hash(question + id);
  for (let i = order.length - 1; i > 0; i--) {
    h = (h * 1664525 + 1013904223) >>> 0;
    const j = h % (i + 1);
    [order[i], order[j]] = [order[j], order[i]];
  }
  const options = {};
  order.forEach((src, i) => { options[letters[i]] = items[src]; });
  const correct = letters[order.indexOf(0)];
  const image = extra.image || "";
  return {
    id,
    points,
    value: points,
    difficulty: points <= 200 ? "easy" : points <= 400 ? "medium" : "hard",
    question_type: extra.emoji ? "emoji" : image ? "image" : "text",
    emoji_clue: extra.emoji || undefined,
    media: extra.emoji
      ? { type: "emoji", emoji: extra.emoji }
      : image
        ? { type: "image", url: image, source_url: image, license: "Wikimedia Commons", alt: answer }
        : null,
    question,
    options,
    correct_answer: correct,
    explanation: explain,
    source_title: "سين المغرب",
    source_url: "",
    category: catName,
    category_id: catId,
    text: question,
    image,
    answer,
    explain,
  };
}

const seenAns = new Map();
const seenText = new Set();
const kept = [];
let droppedNoImg = 0;
let droppedAns = 0;
let droppedText = 0;

for (const it of q.r) {
  if (PHOTO.has(it.category_id) && !hasImage(it)) {
    droppedNoImg++;
    continue;
  }
  const text = String(it.question || "").replace(/\s+/g, " ").trim();
  const textKey = `${it.category_id}|${text}`;
  if (seenText.has(textKey)) {
    droppedText++;
    continue;
  }
  const key = fold(it.answer);
  const keys = seenAns.get(it.category_id) || [];
  if (keys.some((prev) => sameAnswer(prev, key, PHOTO.has(it.category_id)))) {
    droppedAns++;
    continue;
  }
  keys.push(key);
  seenAns.set(it.category_id, keys);
  seenText.add(textKey);
  kept.push(it);
}

const ban = [/تكمبون/, /كأس أمم إفريقيا 1976/, /طريق الوحدة الإفريقي/, /أيضاً في زيرو/];
for (let i = kept.length - 1; i >= 0; i--) {
  if (ban.some((re) => re.test(kept[i].question))) kept.splice(i, 1);
}

function already(catId, answer, question) {
  const text = String(question).replace(/\s+/g, " ").trim();
  if (seenText.has(`${catId}|${text}`)) return true;
  const key = fold(answer);
  const keys = seenAns.get(catId) || [];
  return keys.some((prev) => sameAnswer(prev, key, PHOTO.has(catId)));
}

function remember(catId, answer, question) {
  const text = String(question).replace(/\s+/g, " ").trim();
  seenText.add(`${catId}|${text}`);
  const keys = seenAns.get(catId) || [];
  keys.push(fold(answer));
  seenAns.set(catId, keys);
}

const pools = new Map();
for (const it of kept) {
  const list = pools.get(it.category_id) || [];
  list.push(it.answer);
  pools.set(it.category_id, list);
}

let added = 0;
function addOne(catId, catName, question, answer, explain, extra = {}) {
  if (!answer || !question) return;
  if (already(catId, answer, question)) return;
  if (PHOTO.has(catId) && !extra.image && !extra.emoji) return;
  const points = [100, 200, 300, 400, 500][added % 5];
  const wrongs = (pools.get(catId) || []).filter((w) => fold(w) !== fold(answer));
  const id = `uq_${catId}_${added + 1}`;
  const item = makeQuestion(catId, catName, points, id, question, answer, wrongs, explain, extra);
  if (!Object.values(item.options).includes(answer)) return;
  kept.push(item);
  remember(catId, answer, question);
  const list = pools.get(catId) || [];
  list.push(answer);
  pools.set(catId, list);
  added++;
}

const images = [
  ["food_photos", "الأكلات المغربية بالصور", "ما اسم هذا الطبق المغربي من اللحم المشوي على الفحم في الأعراس؟", "المشوي", "المشوي لحم يُشوى ببطء على الفحم ويُقدَّم في المواسم والأعراس.", "https://upload.wikimedia.org/wikipedia/commons/9/96/Mechoui.jpg"],
  ["food_photos", "الأكلات المغربية بالصور", "ما اسم هذا الطبق المغربي المحضّر من الفاصوليا البيضاء بالصلصة؟", "اللوبيا", "اللوبيا طبق منزلي من الفاصوليا البيضاء يُطهى ببطء مع الطماطم والتوابل.", "https://upload.wikimedia.org/wikipedia/commons/f/f5/Loubia.jpg"],
  ["food_photos", "الأكلات المغربية بالصور", "ما اسم هذه الإضافة الحلوة من البصل والزبيب التي ترافق الكسكس؟", "التفاية", "التفاية بصل مكرمل بالزبيب والقرفة يُقدَّم فوق الكسكس في المناسبات.", "https://upload.wikimedia.org/wikipedia/commons/e/eb/Tfaya.jpg"],
  ["guess_monument", "خمن المعلم من الصورة", "ما اسم هذه الحديقة الشهيرة في مراكش بلونها الأزرق؟", "حدائق ماجوريل", "أنشأها الرسام جاك ماجوريل وصارت من أشهر حدائق مراكش.", "https://upload.wikimedia.org/wikipedia/commons/f/f1/Jardin_Majorelle.jpg"],
  ["guess_monument", "خمن المعلم من الصورة", "ما اسم هذه الشلالات في الأطلس المتوسط قرب أزيلال؟", "شلالات أوزود", "أوزود من أشهر الشلالات في المغرب وتقع في إقليم أزيلال.", "https://upload.wikimedia.org/wikipedia/commons/3/36/Cascades_d%27Ouzoud.jpg"],
  ["guess_monument", "خمن المعلم من الصورة", "ما اسم هذه المغارة المطلة على المحيط عند طنجة؟", "مغارة هرقل", "مغارة هرقل تقع قرب رأس سبارتيل ويطل فمها على البحر.", "https://upload.wikimedia.org/wikipedia/commons/6/6b/Caves_of_Hercules.jpg"],
  ["guess_monument", "خمن المعلم من الصورة", "ما اسم هذه القصبة في واحة سكورة بورزازات؟", "قصبة أمريديل", "قصبة أمريديل من القصبات التاريخية في وادي دادس وسكورة.", "https://upload.wikimedia.org/wikipedia/commons/1/11/Kasbah_Amridil.jpg"],
  ["guess_monument", "خمن المعلم من الصورة", "ما اسم هذه الكثبان الرملية قرب مرزوكة؟", "عرق الشبي", "عرق الشبي بحر من الكثبان في الجنوب الشرقي ويُعرف بمرزوكة.", "https://upload.wikimedia.org/wikipedia/commons/3/34/Erg_Chebbi.jpg"],
  ["guess_monument", "خمن المعلم من الصورة", "ما اسم هذه الساحة الشهيرة في قلب مراكش؟", "ساحة جامع الفنا", "جامع الفنا ساحة الفرجة والتراث الشفوي في المدينة الحمراء.", "https://upload.wikimedia.org/wikipedia/commons/d/dc/Jemaa_el-Fnaa.jpg"],
  ["guess_monument", "خمن المعلم من الصورة", "ما اسم هذا المضيق الصخري قرب تنغير؟", "مضيق تودغة", "تودغة خانق في الأطلس الكبير يشتهر بجدرانه العالية.", "https://upload.wikimedia.org/wikipedia/commons/1/12/Todra_Gorge.jpg"],
  ["guess_monument", "خمن المعلم من الصورة", "ما اسم هذا الشاطئ ذي القوس الصخري جنوب سيدي إفني؟", "شاطئ لڭزيرة", "لڭزيرة شاطئ أطلسي عُرف بأقواسه الصخرية الحمراء.", "https://upload.wikimedia.org/wikipedia/commons/4/47/Legzira.jpg"],
  ["guess_monument", "خمن المعلم من الصورة", "ما اسم هذه القمة وهي أعلى جبل في المغرب؟", "جبل توبقال", "توبقال في الأطلس الكبير وارتفاعه 4167 متراً.", "https://upload.wikimedia.org/wikipedia/commons/e/ee/Toubkal.jpg"],
  ["guess_monument", "خمن المعلم من الصورة", "ما اسم هذا الوادي في الأطلس الكبير جنوب مراكش؟", "وادي أوريكا", "أوريكا واد جبلي مقصود للتنزه جنوب مراكش.", "https://upload.wikimedia.org/wikipedia/commons/9/95/Ourika_Valley.jpg"],
  ["guess_monument", "خمن المعلم من الصورة", "ما اسم هذا الميناء الكبير على مضيق جبل طارق؟", "ميناء طنجة المتوسط", "طنجة المتوسط ميناء حاويات رئيسي على الضفة الجنوبية للمضيق.", "https://upload.wikimedia.org/wikipedia/commons/7/7c/Tanger_Med.jpg"],
  ["guess_person", "خمن الشخصية من الصورة", "من هذا الظهير المغربي الذي لعب لبايرن ميونخ ومانشستر يونايتد؟", "نصير مزراوي", "نصير مزراوي ظهر أيمن دولي مغربي من مواليد لايدن بهولندا.", "https://upload.wikimedia.org/wikipedia/commons/d/db/Noussair_Mazraoui.jpg"],
  ["guess_person", "خمن الشخصية من الصورة", "من هذا الجناح المغربي الدولي الذي لمع مع باير ليفركوزن؟", "أمين عدلي", "أمين عدلي لاعب هجومي دولي مغربي.", "https://upload.wikimedia.org/wikipedia/commons/b/b3/Amine_Adli.jpg"],
  ["guess_person", "خمن الشخصية من الصورة", "من هذه الكاتبة المغربية الفرنسية الفائزة بجائزة غونكور؟", "ليلى سليماني", "ليلى سليماني فازت بغونكور سنة 2016 عن رواية «أغنية هادئة».", "https://upload.wikimedia.org/wikipedia/commons/2/2a/Le%C3%AFla_Slimani.jpg"],
];

for (const [catId, catName, question, answer, explain, image] of images) {
  addOne(catId, catName, question, answer, explain, { image });
}

const factFiles = fs.readdirSync(new URL(".", import.meta.url)).filter((name) => name.startsWith("facts-") && name.endsWith(".mjs"));
for (const name of factFiles.sort()) {
  const mod = await import(new URL(name, import.meta.url));
  for (const row of mod.facts) {
    const [catId, catName, question, answer, explain, emoji] = row;
    addOne(catId, catName, question, answer, explain, emoji ? { emoji } : {});
  }
}

const target = new URL("../public/assets/questions-FaeiPOAe.js", import.meta.url);
let src = fs.readFileSync(target, "utf8");
const start = src.indexOf("var i = ");
const end = src.indexOf(";\nvar a = i.length;");
if (start < 0 || end < 0) throw new Error("question array markers missing");
src = src.slice(0, start) + "var i = " + JSON.stringify(kept) + src.slice(end);
fs.writeFileSync(target, src);

const by = {};
for (const it of kept) {
  by[it.category_id] = by[it.category_id] || { n: 0, img: 0, missing: 0 };
  by[it.category_id].n++;
  if (hasImage(it)) by[it.category_id].img++;
  if (PHOTO.has(it.category_id) && !hasImage(it)) by[it.category_id].missing++;
}
console.log(JSON.stringify({
  kept: kept.length,
  added,
  droppedNoImg,
  droppedAns,
  droppedText,
  photoMissing: kept.filter((it) => PHOTO.has(it.category_id) && !hasImage(it)).length,
}, null, 2));
