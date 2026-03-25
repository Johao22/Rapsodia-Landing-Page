require("dotenv").config();

const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");
const cron = require("node-cron");
const scrapeComments = require("./scraper");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: "*" }
});

let ranking = [];
let lastUpdate = null;
let totalComments = 0;
let isScrapingActive = false;

const POST_URL = process.env.POST_URL;
const PORT = process.env.PORT || 3000;
const INTERVAL = process.env.INTERVAL_MINUTES || 2;

// Cuenta cuantas veces comenta cada usuario y ordena de mayor a menor
function processComments(comments) {
  const map = new Map();

  comments.forEach(c => {
    if (!c.user || !c.comment || c.comment.trim().length < 3) return;

    const user = c.user.trim();
    if (!map.has(user)) {
      map.set(user, { user, count: 0, lastComment: c.comment.trim() });
    }
    const entry = map.get(user);
    entry.count++;
    entry.lastComment = c.comment.trim();
  });

  ranking = Array.from(map.values()).sort((a, b) => b.count - a.count);
  totalComments = comments.length;
  lastUpdate = new Date().toISOString();
}

async function runScrape() {
  if (isScrapingActive) {
    console.log("Scrape ya en progreso, omitiendo...");
    return;
  }

  isScrapingActive = true;
  io.emit("scrape_start");
  console.log(`[${new Date().toLocaleTimeString()}] Scraping ${POST_URL}...`);

  try {
    const comments = await scrapeComments(POST_URL);
    console.log(`Obtenidos ${comments.length} comentarios`);
    processComments(comments);
    io.emit("ranking_update", { ranking, lastUpdate, total: totalComments });
    console.log(`Ranking listo: ${ranking.length} usuarios unicos`);
  } catch (err) {
    console.error("Error en scrape:", err.message);
    io.emit("scrape_error", { message: err.message });
  } finally {
    isScrapingActive = false;
  }
}

// Primer scrape al arrancar (con delay para que el cliente conecte primero)
setTimeout(runScrape, 3000);

// Cron cada N minutos
cron.schedule(`*/${INTERVAL} * * * *`, runScrape);

io.on("connection", (socket) => {
  console.log(`Cliente conectado: ${socket.id}`);
  // Enviar estado actual al nuevo cliente
  socket.emit("ranking_update", { ranking, lastUpdate, total: totalComments });

  socket.on("manual_refresh", () => {
    console.log("Refresh manual solicitado");
    runScrape();
  });

  socket.on("disconnect", () => {
    console.log(`Cliente desconectado: ${socket.id}`);
  });
});

// REST endpoints como fallback
app.get("/api/ranking", (_req, res) => {
  res.json({ ranking, lastUpdate, total: totalComments });
});

app.get("/api/status", (_req, res) => {
  res.json({
    status: "ok",
    postUrl: POST_URL,
    lastUpdate,
    totalUsers: ranking.length,
    totalComments,
    isScrapingActive
  });
});

// Servir frontend estatico
app.use(express.static(path.join(__dirname, "../frontend")));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "../frontend/index.html"));
});

server.listen(PORT, () => {
  console.log(`Servidor activo en http://localhost:${PORT}`);
  console.log(`Post monitoreado: ${POST_URL}`);
  console.log(`Intervalo: cada ${INTERVAL} minutos`);
});
