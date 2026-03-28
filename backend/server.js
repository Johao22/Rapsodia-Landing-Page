require("dotenv").config();

const express = require("express");
const http    = require("http");
const fs      = require("fs");
const path    = require("path");
const { Server } = require("socket.io");
const cron    = require("node-cron");
const scrapeComments = require("./scraper");

const app    = express();
const server = http.createServer(app);

const io = new Server(server, { cors: { origin: "*" } });

const POST_URL = process.env.POST_URL;
const PORT     = process.env.PORT || 3000;
const INTERVAL = process.env.INTERVAL_MINUTES || 2;

const DATA_DIR  = path.join(__dirname, "data");
const STORE_FILE = path.join(DATA_DIR, "store.json");
const CSV_FILE   = path.join(DATA_DIR, "ranking.csv");

// ── Estado en memoria ────────────────────────────────────────────────────────
let ranking          = [];
let lastUpdate       = null;
let totalComments    = 0;
let isScrapingActive = false;

// ── Store persistente ────────────────────────────────────────────────────────
let store = { userCounts: {}, lastCursor: null, seenIds: {} };

function loadStore() {
  try {
    const saved = JSON.parse(fs.readFileSync(STORE_FILE, "utf8"));
    store = { userCounts: {}, lastCursor: null, seenIds: {}, ...saved };
    buildRanking();
    console.log(`Store cargado: ${Object.keys(store.userCounts).length} usuarios | cursor: ${store.lastCursor ? "si" : "no"}`);
  } catch (_) {
    console.log("Sin store previo — primer scrape sera completo");
  }
}

function saveStore() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(STORE_FILE, JSON.stringify(store));
  } catch (e) {
    console.error("Error guardando store:", e.message);
  }
}

function saveCSV() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const rows = ["usuario,comentarios", ...ranking.map((r) => `${r.user},${r.count}`)];
    fs.writeFileSync(CSV_FILE, rows.join("\n"), "utf8");
    console.log(`CSV guardado: ${ranking.length} usuarios`);
  } catch (e) {
    console.error("Error guardando CSV:", e.message);
  }
}

function buildRanking() {
  ranking      = Object.entries(store.userCounts)
    .map(([user, count]) => ({ user, count }))
    .sort((a, b) => b.count - a.count);
  totalComments = Object.values(store.userCounts).reduce((s, c) => s + c, 0);
  lastUpdate    = new Date().toISOString();
}

function mergeComments(newComments, isFullScrape) {
  if (isFullScrape) { store.userCounts = {}; store.seenIds = {}; }

  let added = 0;
  let dupes  = 0;

  newComments.forEach((c) => {
    if (!c.user || !c.comment || !c.comment.trim()) return;
    if (c.id) {
      if (store.seenIds[c.id]) { dupes++; return; }
      store.seenIds[c.id] = 1;
    }
    store.userCounts[c.user.trim()] = (store.userCounts[c.user.trim()] || 0) + 1;
    added++;
  });

  console.log(`Procesados: ${added} nuevos | ${dupes} duplicados omitidos | usuarios unicos acumulados: ${Object.keys(store.userCounts).length}`);
  buildRanking();
}

// ── Scrape ───────────────────────────────────────────────────────────────────
async function runScrape() {
  if (isScrapingActive) { console.log("Scrape ya en progreso, omitiendo..."); return; }

  isScrapingActive = true;
  io.emit("scrape_start");

  const isFullScrape = !store.lastCursor;
  const mode = isFullScrape ? "completo" : "incremental";
  console.log(`[${new Date().toLocaleTimeString()}] Scraping ${POST_URL} (${mode})...`);

  try {
    const { comments, lastCursor } = await scrapeComments(POST_URL, store.lastCursor);
    console.log(`Obtenidos ${comments.length} comentarios nuevos`);

    mergeComments(comments, isFullScrape);

    if (lastCursor) store.lastCursor = lastCursor;
    saveStore();
    saveCSV();

    io.emit("ranking_update", { ranking, lastUpdate, total: totalComments });
    console.log(`Ranking listo: ${ranking.length} usuarios | ${totalComments} comentarios acumulados`);
  } catch (err) {
    console.error("Error en scrape:", err.message);
    io.emit("scrape_error", { message: err.message });
  } finally {
    isScrapingActive = false;
  }
}

// ── Arranque ─────────────────────────────────────────────────────────────────
loadStore();
setTimeout(runScrape, 3000);
cron.schedule(`*/${INTERVAL} * * * *`, runScrape);

// ── Sockets ──────────────────────────────────────────────────────────────────
io.on("connection", (socket) => {
  socket.emit("ranking_update", { ranking, lastUpdate, total: totalComments });

  socket.on("manual_refresh", () => {
    console.log("Refresh manual solicitado");
    runScrape();
  });

  socket.on("disconnect", () => {});
});

// ── REST ─────────────────────────────────────────────────────────────────────
app.get("/api/ranking", (_req, res) => {
  res.json({ ranking, lastUpdate, total: totalComments });
});

app.get("/api/status", (_req, res) => {
  res.json({ status: "ok", postUrl: POST_URL, lastUpdate, totalUsers: ranking.length, totalComments, isScrapingActive, mode: store.lastCursor ? "incremental" : "full" });
});

// Descargar CSV del ranking
app.get("/api/ranking.csv", (_req, res) => {
  if (!fs.existsSync(CSV_FILE)) return res.status(404).send("CSV no disponible aun");
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", "attachment; filename=ranking.csv");
  res.sendFile(CSV_FILE);
});

// Forzar scrape completo (resetea cursor)
app.post("/api/reset", (_req, res) => {
  store.lastCursor = null;
  store.userCounts = {};
  saveStore();
  res.json({ ok: true, message: "Store reseteado — proximo scrape sera completo" });
  runScrape();
});

// Frontend estatico
app.use(express.static(path.join(__dirname, "../frontend")));
app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "../frontend/index.html")));

server.listen(PORT, () => {
  console.log(`Servidor activo en http://localhost:${PORT}`);
  console.log(`Post monitoreado: ${POST_URL}`);
  console.log(`Intervalo: cada ${INTERVAL} minutos`);
});
