// Сборщик цен: читает страницы заправок из scraper/stations.json,
// вытаскивает цены и обновляет prices.json в корне проекта.
// Запуск: node scraper/scrape.mjs   (нужен Node 18+, пакеты не нужны)
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PRICES_FILE = path.join(ROOT, "prices.json");
const STATIONS_FILE = path.join(ROOT, "scraper", "stations.json");

// Название топлива на странице -> наш id и допустимый диапазон цены (zł/л).
const FUELS = [
  { id: "pb98", label: "Pb\\s?98|benzyna\\s?98", flags: "i", min: 3, max: 15 },
  { id: "pb95", label: "Pb\\s?95|benzyna\\s?95", flags: "i", min: 3, max: 15 },
  { id: "on", label: "\\bON\\b|olej\\s+napędowy|diesel", flags: "", min: 3, max: 15 },
  { id: "lpg", label: "LPG|autogaz", flags: "i", min: 1, max: 8 },
];

export function htmlToText(html) {
  let t = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/&oacute;/g, "ó")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, " ");
  // Блок «Stacje paliw w pobliżu» относится к соседним заправкам, его отбрасываем.
  const cut = t.search(/Stacje paliw w pobliżu/i);
  if (cut > 0) t = t.slice(0, cut);
  return t;
}

export function parsePrices(html) {
  const text = htmlToText(html);
  const found = {};
  for (const f of FUELS) {
    // Регистр для ON учитываем, чтобы не ловить обычное слово «on».
    const re = new RegExp(`(?:${f.label})\\D{0,40}?(\\d{1,2}[.,]\\d{2})\\s*(?:zł|pln)`, f.flags);
    const m = text.match(re);
    if (!m) continue;
    const p = Number(m[1].replace(",", "."));
    if (p >= f.min && p <= f.max) found[f.id] = p;
  }
  return found;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; FuelChelmBot/1.0; personal non-commercial)",
      "Accept-Language": "pl,en;q=0.8",
    },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error("HTTP " + res.status);
  return res.text();
}

async function main() {
  const stations = JSON.parse(await readFile(STATIONS_FILE, "utf8"));
  let feed = { updated: null, prices: {} };
  try { feed = JSON.parse(await readFile(PRICES_FILE, "utf8")); } catch {}
  feed.prices = feed.prices || {};

  const now = new Date().toISOString();
  let changed = 0;

  for (const st of stations) {
    try {
      const html = await fetchHtml(st.url);
      const prices = parsePrices(html);
      const ids = Object.keys(prices);
      if (!ids.length) { console.log(`- ${st.id}: цен на странице нет, оставляю прежние`); }
      for (const fuel of ids) {
        const old = feed.prices[st.id]?.[fuel];
        if (!old || old.p !== prices[fuel]) {
          feed.prices[st.id] = { ...(feed.prices[st.id] || {}), [fuel]: { p: prices[fuel], t: now } };
          changed++;
          console.log(`+ ${st.id} ${fuel}: ${old ? old.p + " -> " : ""}${prices[fuel]}`);
        }
      }
    } catch (e) {
      console.log(`! ${st.id}: ${e.message}`);
    }
    await sleep(1500);
  }

  if (changed > 0 || !feed.updated) {
    feed.updated = now;
    await writeFile(PRICES_FILE, JSON.stringify(feed, null, 2) + "\n");
    console.log(`Записано изменений: ${changed}`);
  } else {
    console.log("Изменений нет, файл не трогаю");
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
