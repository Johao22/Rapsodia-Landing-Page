require("dotenv").config();

const puppeteer = require("puppeteer");
const https     = require("https");

const IG_USERNAME = process.env.IG_USERNAME;
const IG_PASSWORD = process.env.IG_PASSWORD;
const DESKTOP_UA  = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const MOBILE_UA   = "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1";

const sleep     = (ms) => new Promise((r) => setTimeout(r, ms));
const sleepRand = (min, max) => sleep(Math.floor(Math.random() * (max - min + 1)) + min);
const MAX_PAGES = parseInt(process.env.MAX_PAGES || "0");

let browser = null;
let page    = null;

// ── HTTP POST ─────────────────────────────────────────────────────────────────
function nodePost(url, headers, body) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const req = https.request(
      { hostname: u.hostname, path: u.pathname + (u.search || ""), method: "POST",
        headers: { ...headers, "content-length": Buffer.byteLength(body) } },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString())); } catch (_) { resolve(null); } });
      }
    );
    req.on("error", () => resolve(null));
    req.write(body);
    req.end();
  });
}

// ── HTTP GET con seguimiento de redireccion ───────────────────────────────────
function nodeGet(hostname, path, headers) {
  return new Promise((resolve) => {
    const req = https.request({ hostname, path, method: "GET", headers }, (res) => {
      // Seguir un nivel de redireccion
      if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location) {
        try {
          const loc = new URL(res.headers.location);
          return nodeGet(loc.hostname, loc.pathname + (loc.search || ""), headers).then(resolve);
        } catch (_) { return resolve(null); }
      }
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        try { resolve({ _status: res.statusCode, ...JSON.parse(Buffer.concat(chunks).toString()) }); }
        catch (_) { resolve({ _status: res.statusCode }); }
      });
    });
    req.on("error", () => resolve(null));
    req.end();
  });
}

// ── Browser helpers ───────────────────────────────────────────────────────────
async function dismissDialogs() {
  try {
    for (const btn of await page.$$("button")) {
      const t = (await page.evaluate((el) => el.textContent || "", btn)).toLowerCase();
      if (["not now","ahora no","maybe later","skip"].some((d) => t.includes(d))) { await btn.click(); await sleep(600); }
    }
  } catch (_) {}
}

async function acceptCookies() {
  try {
    for (const btn of await page.$$("button")) {
      const t = await page.evaluate((el) => el.textContent || "", btn);
      if (["Allow all cookies","Aceptar todas las cookies","Accept"].some((d) => t.includes(d))) { await btn.click(); await sleep(1500); return; }
    }
  } catch (_) {}
}

async function login() {
  console.log("Iniciando sesion...");
  await page.goto("https://www.instagram.com/accounts/login/", { waitUntil: "domcontentloaded", timeout: 30000 });
  await sleep(4000);
  await acceptCookies();
  await sleep(2000);
  const selectors = ['input[name="username"]','input[aria-label*="username"]','form input[type="text"]'];
  let userInput = null;
  for (const sel of selectors) { userInput = await page.$(sel); if (userInput) break; }
  if (!userInput) throw new Error("No se encontro input de usuario");
  await userInput.click({ clickCount: 3 });
  await userInput.type(IG_USERNAME, { delay: 80 });
  await sleep(300);
  const passInput = await page.$('input[name="password"]') || await page.$('input[type="password"]');
  if (!passInput) throw new Error("No se encontro input de password");
  await passInput.click({ clickCount: 3 });
  await passInput.type(IG_PASSWORD, { delay: 80 });
  await sleep(300);
  const clicked = await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button,div[role="button"],[type="submit"]')]
      .find((el) => { const t=(el.textContent||"").trim().toLowerCase(); return t==="log in"||t==="iniciar sesión"||t==="ingresar"; });
    if (btn) { btn.click(); return true; } return false;
  });
  if (!clicked) await passInput.press("Enter");
  await page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => {});
  await sleep(3000);
  for (let i = 0; i < 3; i++) { await dismissDialogs(); await sleep(800); }
  const u = page.url();
  if (u.includes("/accounts/login") || u.includes("/challenge") || u.includes("/suspended"))
    throw new Error("Login fallido. URL: " + u);
  console.log("Login completado");
}

async function initBrowser() {
  console.log("Iniciando browser...");
  browser = await puppeteer.launch({
    headless: process.env.HEADLESS !== "false" ? "new" : false,
    executablePath: process.env.CHROME_PATH || puppeteer.executablePath(),
    protocolTimeout: 300_000,
    args: ["--no-sandbox","--disable-setuid-sandbox","--disable-dev-shm-usage","--disable-blink-features=AutomationControlled","--disable-gpu","--no-zygote","--disable-extensions","--no-first-run"],
  });
  page = await browser.newPage();
  await page.evaluateOnNewDocument(() => { Object.defineProperty(navigator, "webdriver", { get: () => undefined }); });
  await page.setUserAgent(DESKTOP_UA);
  await page.setViewport({ width: 1280, height: 900 });
  if (process.env.IG_COOKIES) {
    try {
      const valid = ["Strict","Lax","None"];
      const cookies = JSON.parse(process.env.IG_COOKIES).map(c => { const cl={...c}; if(!valid.includes(cl.sameSite)) delete cl.sameSite; return cl; });
      await page.setCookie(...cookies);
      console.log(`Sesion restaurada via cookies (${cookies.length} cookies)`);
    } catch (e) { console.error("Error cargando IG_COOKIES:", e.message); }
  } else if (IG_USERNAME && IG_PASSWORD) {
    await login();
  }
  await page.setUserAgent(MOBILE_UA);
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  browser.on("disconnected", () => { console.log("Browser desconectado"); browser = null; page = null; });
  console.log("Browser listo y sesion activa");
}

// ── Capturar API GraphQL ──────────────────────────────────────────────────────
async function captureApiDetails(url) {
  let apiDetails = null;
  const onResponse = async (response) => {
    if (apiDetails || !response.url().includes("instagram.com/graphql")) return;
    try {
      const data = await response.json().catch(() => null);
      if (!data?.data) return;
      const keys = Object.keys(data.data);
      if (!keys.some((k) => k.includes("comment") && !k.includes("repl"))) return;
      const req = response.request();
      apiDetails = { url: response.url(), postData: req.postData() || "", reqHeaders: req.headers(), data };
      console.log("API capturada:", keys.join(", "));
    } catch (_) {}
  };
  page.on("response", onResponse);
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await sleep(2000);
    if (!page.url().includes("/p/")) throw new Error(`Sesion invalida — redirigido a ${page.url()}. Renovar IG_COOKIES.`);
    await page.evaluate(() => {
      ["not now","ahora no","maybe later","skip","cancel","omitir"].forEach((d) => {
        document.querySelectorAll("button,[role='button']").forEach((b) => { if ((b.textContent||"").toLowerCase().includes(d)) b.click(); });
      });
    }).catch(() => {});
    await sleep(800);
    const clicked = await page.evaluate(() => {
      const btn = [...document.querySelectorAll("a,button,span,[role='button']")].find((el) => {
        const t = (el.textContent||"").toLowerCase();
        return t.includes("ver los") || (t.includes("ver")&&t.includes("comentario")) || (t.includes("view")&&t.includes("comment"));
      });
      if (btn) { btn.click(); return true; } return false;
    });
    if (clicked) {
      await page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 10000 }).catch(() => {});
    } else {
      const cu = url.replace(/\/+$/, "") + "/comments/";
      await page.evaluate((u) => { history.pushState({}, "", u); window.dispatchEvent(new PopStateEvent("popstate")); }, cu);
    }
    await sleep(1500);
    console.log("URL comentarios:", page.url());
    const client = await page.target().createCDPSession();
    const deadline = Date.now() + 20000;
    while (!apiDetails && Date.now() < deadline) {
      await client.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: 195, y: 600, id: 0 }] });
      for (let s = 1; s <= 8; s++) {
        await client.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: 195, y: 600 - s * 60, id: 0 }] });
        await sleep(25);
      }
      await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await sleep(1200);
    }
    await client.detach().catch(() => {});
    if (!apiDetails) throw new Error("No se capturó la API GraphQL de comentarios");
    const pageCookies = await page.cookies("https://www.instagram.com");
    const cookieStr   = pageCookies.map((c) => `${c.name}=${c.value}`).join("; ");
    const csrftoken   = pageCookies.find((c) => c.name === "csrftoken")?.value || "";
    return { ...apiDetails, cookieStr, csrftoken };
  } finally {
    page.off("response", onResponse);
  }
}

// ── Extraer comentarios e IDs con replies ────────────────────────────────────
// child_comment_count es el campo correcto en xdt_api__v1
function extractEdgesWithMeta(edges) {
  const comments       = [];
  const pendingReplies = [];
  (edges || []).forEach(({ node }) => {
    if (!node) return;
    const username = node?.user?.username || node?.owner?.username;
    const text     = node?.text;
    const pk       = node?.pk || node?.id;
    if (username && text && text.trim()) comments.push({ id: String(pk), user: username, comment: text.trim() });

    // Replies inline (varios formatos posibles)
    const repliesConn = node?.edge_media_to_parent_comment || node?.edge_threaded_comments || node?.replies;
    (repliesConn?.edges || []).forEach(({ node: r }) => {
      if (!r) return;
      const ru = r?.user?.username || r?.owner?.username;
      const rt = r?.text;
      const ri = r?.pk || r?.id;
      if (ru && rt && rt.trim()) comments.push({ id: String(ri), user: ru, comment: rt.trim() });
    });
    (node?.preview_child_comments || []).forEach((r) => {
      if (!r) return;
      const ru = r?.user?.username;
      const rt = r?.text;
      const ri = r?.pk || r?.id;
      if (ru && rt && rt.trim()) comments.push({ id: String(ri), user: ru, comment: rt.trim() });
    });

    // child_comment_count = campo confirmado en xdt_api__v1
    const replyCount =
      (node?.child_comment_count  > 0 ? node.child_comment_count  : 0) +
      (node?.reply_count          > 0 ? node.reply_count          : 0) +
      (repliesConn?.page_info?.has_next_page ? 1 : 0);

    if (replyCount > 0 && pk) pendingReplies.push(String(pk));
  });
  return { comments, pendingReplies };
}

function parsePage(data) {
  const conn = data?.data ? Object.values(data.data)[0] : null;
  if (!conn) return { comments: [], pendingReplies: [], hasNextPage: false, endCursor: null };
  const { comments, pendingReplies } = extractEdgesWithMeta(conn.edges || []);
  return { comments, pendingReplies, hasNextPage: conn.page_info?.has_next_page ?? false, endCursor: conn.page_info?.end_cursor ?? null };
}

// ── Probar endpoints de replies ───────────────────────────────────────────────
// Instagram tiene la API en www y en i, probamos ambos
async function probeReplyEndpoint(headers, sampleCommentId) {
  const candidates = [
    { host: "www.instagram.com", path: `/api/v1/media/${sampleCommentId}/replies/?can_support_threading=true` },
    { host: "i.instagram.com",   path: `/api/v1/media/${sampleCommentId}/replies/?can_support_threading=true` },
  ];
  for (const { host, path } of candidates) {
    console.log(`Probando endpoint replies: ${host}${path.split("?")[0]}`);
    const res = await nodeGet(host, path, headers);
    if (res && res._status < 400) {
      console.log(`Endpoint replies OK: ${host} | status=${res._status} | comments=${res.comments?.length ?? "N/A"}`);
      return { host, works: true };
    }
    console.log(`Endpoint ${host}: status=${res?._status ?? "null"}`);
  }
  return { host: null, works: false };
}

// ── Fetch replies para un comentario ─────────────────────────────────────────
async function fetchAllReplies(headers, replyHost, commentId) {
  const replies = [];
  let cursor  = null;
  let hasMore = true;
  let retries = 0;

  while (hasMore) {
    const qs   = `can_support_threading=true${cursor ? `&min_id=${encodeURIComponent(cursor)}` : ""}`;
    const path = `/api/v1/media/${commentId}/replies/?${qs}`;
    const res  = await nodeGet(replyHost, path, headers);

    if (!res || res._status >= 400) {
      if (retries < 2) { retries++; await sleep(retries * 4000); continue; }
      break;
    }
    retries = 0;

    (res.comments || []).forEach((c) => {
      const u = c?.user?.username;
      const t = c?.text?.trim();
      const i = c?.pk || c?.id;
      if (u && t) replies.push({ id: String(i), user: u, comment: t });
    });

    cursor  = res.next_min_id || null;
    hasMore = !!(res.has_more_tail_comments && cursor);
    if (hasMore) await sleepRand(400, 900);
  }
  return replies;
}

// ── Scrape principal ──────────────────────────────────────────────────────────
// onBatch(comments, cursor) se llama cada CHECKPOINT_PAGES páginas con comentarios nuevos
// Permite guardar progreso sin esperar al final del scrape completo
const CHECKPOINT_PAGES = 50;

async function scrapeComments(url, fromCursor = null, onBatch = null) {
  if (!browser || !page || page.isClosed()) await initBrowser();

  const api = await captureApiDetails(url);

  const baseParams = new URLSearchParams(api.postData);
  const baseVars   = JSON.parse(baseParams.get("variables") || "{}");
  const docId      = baseParams.get("doc_id") || baseParams.get("query_hash");

  const gqlHeaders = {
    "content-type":     "application/x-www-form-urlencoded",
    "cookie":           api.cookieStr,
    "x-ig-app-id":      api.reqHeaders["x-ig-app-id"] || "936619743392459",
    "x-csrftoken":      api.csrftoken,
    "x-ig-www-claim":   api.reqHeaders["x-ig-www-claim"] || "0",
    "x-instagram-ajax": api.reqHeaders["x-instagram-ajax"] || "1",
    "x-requested-with": "XMLHttpRequest",
    "user-agent":       MOBILE_UA,
    "referer":          url.trim().replace(/[\r\n\t]/g, ""),
  };

  const restHeaders = {
    "user-agent":     MOBILE_UA,
    "cookie":         api.cookieStr,
    "x-ig-app-id":    gqlHeaders["x-ig-app-id"],
    "x-csrftoken":    api.csrftoken,
    "x-ig-www-claim": gqlHeaders["x-ig-www-claim"],
    "accept":         "application/json",
    "accept-language":"en-US,en;q=0.9",
    "referer":        "https://www.instagram.com/",
  };

  const allComments       = [];
  const batchBuffer       = [];
  const pendingRepliesSet = new Set();
  let hasNextPage, endCursor, pageNum;
  let pagesSinceCheckpoint = 0;

  // Adds to batchBuffer (onBatch mode) or allComments (direct mode)
  const stash = (cmts) => { if (onBatch) batchBuffer.push(...cmts); else allComments.push(...cmts); };

  // Flush batchBuffer via onBatch callback
  const flush = async (cursor) => {
    if (!onBatch || batchBuffer.length === 0) return;
    await onBatch([...batchBuffer], cursor);
    batchBuffer.length = 0;
    pagesSinceCheckpoint = 0;
  };

  if (fromCursor) {
    console.log("Modo incremental — reanudando desde cursor guardado");
    hasNextPage = true; endCursor = fromCursor; pageNum = 1;
  } else {
    const first = parsePage(api.data);
    stash(first.comments);
    first.pendingReplies.forEach((id) => pendingRepliesSet.add(id));
    hasNextPage = first.hasNextPage;
    endCursor   = first.endCursor;
    console.log(`Pag 1: +${first.comments.length} | total ${onBatch ? batchBuffer.length : allComments.length} | con replies: ${pendingRepliesSet.size} | more: ${hasNextPage}`);
    pageNum = 2;
    pagesSinceCheckpoint++;
    if (pagesSinceCheckpoint >= CHECKPOINT_PAGES) await flush(endCursor);
  }

  let retries      = 0;
  let pagesThisRun = 0;
  const limit      = MAX_PAGES > 0 ? MAX_PAGES : Infinity;

  // ── Fase 1: top-level via GraphQL ─────────────────────────────────────────
  while (hasNextPage && endCursor && pagesThisRun < limit) {
    const body = new URLSearchParams();
    body.set("variables", JSON.stringify({ ...baseVars, after: endCursor }));
    if (docId) body.set("doc_id", docId);

    const result = await nodePost(api.url, gqlHeaders, body.toString());

    if (!result?.data) {
      if (retries < 3) { retries++; console.log(`Pag ${pageNum}: sin datos — retry ${retries}/3 en ${retries*5}s`); await sleep(retries * 5000); continue; }
      console.log(`Pag ${pageNum}: 3 reintentos fallidos — deteniendo Fase 1`);
      break;
    }
    retries = 0;
    const pg = parsePage(result);
    stash(pg.comments);
    pg.pendingReplies.forEach((id) => pendingRepliesSet.add(id));
    hasNextPage = pg.hasNextPage;
    endCursor   = pg.endCursor;
    pagesThisRun++;
    pagesSinceCheckpoint++;

    if (pagesThisRun % 50 === 0 || !hasNextPage)
      console.log(`Pag ${pageNum}: +${pg.comments.length} | acum: ${onBatch ? "(batched)" : allComments.length} | con replies: ${pendingRepliesSet.size} | more: ${hasNextPage}`);
    pageNum++;

    if (pagesSinceCheckpoint >= CHECKPOINT_PAGES) await flush(endCursor);

    await (pagesThisRun % 20 === 0 ? sleepRand(5000, 9000) : sleepRand(700, 1600));
  }

  // Flush any remaining top-level comments before Phase 2
  await flush(endCursor);

  const pendingArray = [...pendingRepliesSet];
  console.log(`\nFase 1 completa | ${pendingArray.length} con replies (child_comment_count > 0)`);

  // ── Fase 2: replies (solo si hay comentarios con replies) ─────────────────
  if (pendingArray.length > 0) {
    const { host: replyHost, works } = await probeReplyEndpoint(restHeaders, pendingArray[0]);

    if (!works) {
      console.log("AVISO: Ningún endpoint de replies responde. Las replies no pueden ser obtenidas con la sesión actual.");
      console.log("Sugerencia: Renovar IG_COOKIES y reintentar.");
    } else {
      console.log(`Fase 2: obteniendo replies de ${pendingArray.length} comentarios via ${replyHost}...`);
      let done = 0; let totalReplies = 0;

      for (const commentId of pendingArray) {
        const replies = await fetchAllReplies(restHeaders, replyHost, commentId);
        stash(replies);
        totalReplies += replies.length;
        done++;
        if (done % 25 === 0 || done === pendingArray.length)
          console.log(`Replies: ${done}/${pendingArray.length} | replies: ${totalReplies}`);
        if (done % 100 === 0) await sleepRand(8000, 15000);
        else await sleepRand(300, 700);
      }
      // Flush remaining replies
      await flush(endCursor);
      console.log(`Fase 2 completa: ${totalReplies} replies`);
    }
  }

  const total = onBatch ? "(guardado via checkpoints)" : allComments.length;
  console.log(`\n=== TOTAL FINAL: ${total} comentarios | cursor: ${endCursor ? "si" : "no"} ===`);
  return { comments: onBatch ? [] : allComments, lastCursor: endCursor };
}

module.exports = scrapeComments;
