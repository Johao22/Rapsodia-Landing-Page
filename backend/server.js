require("dotenv").config();

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cron = require("node-cron");
const scrapeComments = require("./scraper");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: "*" }
});

let ranking = [];

const POST_URL = process.env.POST_URL;

function processComments(comments) {
  const map = new Map();

  comments.forEach(c => {
    if (!c.comment || c.comment.length < 3) return;

    if (!map.has(c.user)) {
      map.set(c.user, c);
    }
  });

  ranking = Array.from(map.values());
}

// ejecutar cada 2 minutos
cron.schedule("*/2 * * * *", async () => {
  console.log("Scraping...");
  const comments = await scrapeComments(POST_URL);

  processComments(comments);
  io.emit("ranking_update", ranking);
});

io.on("connection", (socket) => {
  console.log("Cliente conectado");
  socket.emit("ranking_update", ranking);
});

app.get("/", (req, res) => {
  res.send("Servidor activo 🚀");
});

server.listen(3000, () => {
  console.log("http://localhost:3000");
});