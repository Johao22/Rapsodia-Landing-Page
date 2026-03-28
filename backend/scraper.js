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

// ── HTTP helpers ──────────────────────────────────────────────────────────────
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

function nodeGet(hostname, path, headers) {
  return new Promise((resolve) => {
    const req = https.request(
      { hostname, path, method: "GET", headers },
      (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) return resolve(null);
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => { try { resolve({ _status: res.statusCode, ...JSON.parse(Buffer.concat(chunks).toString()) }); } catch (_) { resolve(null); } });
      }
    );
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

  const selectors = ['input[name="username"]','input[aria-label*="username"]','form input[type="text"]','input[type="text"]'];
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
      .find((el) => { const t = (el.textContent||"").trim().toLowerCase(); return t==="log in"||t==="iniciar sesión"||t==="ingresar"; });
    if (btn) { btn.click(); return true; } return false;
  });
  if (!clicked) await passInput.press("Enter");
  await page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => {});
  await sleep(3000);
  for (let i = 0; i < 3; i++) { await dismissDialogs(); await sleep(800); }
  const finalUrl = page.url();
  if (finalUrl.includes("/accounts/login") || finalUrl.includes("/challenge") || finalUrl.includes("/suspended"))
    throw new Error("Login fallido. URL: " + finalUrl);
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

// ── Capturar API GraphQL de comentarios ───────────────────────────────────────
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
    });
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

// ── Extraer comentarios e IDs con replies del nodo GraphQL ───────────────────
// Soporta múltiples formatos del API v1 de Instagram
let _firstNodeLogged = false;

function extractEdgesWithMeta(edges) {
  const comments       = [];
  const pendingReplies = [];

  (edges || []).forEach(({ node }) => {
    if (!node) return;

    // Loguear estructura del primer nodo para diagnóstico
    if (!_firstNodeLogged) {
      _firstNodeLogged = true;
      const allKeys = Object.keys(node);
      const replyKeys = allKeys.filter((k) => /repl|child|thread/i.test(k));
      console.log(`[DIAG] Campos del nodo: [${allKeys.join(", ")}]`);
      console.log(`[DIAG] Campos de replies: [${replyKeys.join(", ") || "ninguno"}]`);
      if (node.reply_count !== undefined)   console.log(`[DIAG] reply_count = ${node.reply_count}`);
      if (node.child_comment_count !== undefined) console.log(`[DIAG] child_comment_count = ${node.child_comment_count}`);
    }

    const username = node?.user?.username || node?.owner?.username;
    const text     = node?.text;
    const pk       = node?.pk || node?.id; // pk es el ID numérico para REST
    if (username && text && text.trim()) comments.push({ id: pk, user: username, comment: text.trim() });

    // Replies inline (formatos varios)
    const repliesConn  = node?.edge_media_to_parent_comment || node?.edge_threaded_comments || node?.replies;
    const inlineEdges  = repliesConn?.edges || [];
    const inlineArr    = node?.preview_child_comments || []; // v1 REST format

    inlineEdges.forEach(({ node: r }) => {
      if (!r) return;
      const ru = r?.user?.username || r?.owner?.username;
      const rt = r?.text;
      const ri = r?.pk || r?.id;
      if (ru && rt && rt.trim()) comments.push({ id: ri, user: ru, comment: rt.trim() });
    });
    inlineArr.forEach((r) => {
      if (!r) return;
      const ru = r?.user?.username;
      const rt = r?.text;
      const ri = r?.pk || r?.id;
      if (ru && rt && rt.trim()) comments.push({ id: ri, user: ru, comment: rt.trim() });
    });

    // Detectar si hay replies que paginar — cubrir TODOS los formatos posibles
    const explicitCount =
      (typeof node?.reply_count        === "number" ? node.reply_count        : 0) +
      (typeof node?.child_comment_count === "number" ? node.child_comment_count : 0);
    const hasInline     = inlineEdges.length > 0 || inlineArr.length > 0;
    const hasNextPage   = repliesConn?.page_info?.has_next_page ?? false;

    if ((explicitCount > 0 || hasInline || hasNextPage) && pk) {
      pendingReplies.push(pk);
    }
  });

  return { comments, pendingReplies };
}

function parsePage(data) {
  const conn = data?.data ? Object.values(data.data)[0] : null;
  if (!conn) return { comments: [], pendingReplies: [], hasNextPage: false, endCursor: null };
  const { comments, pendingReplies } = extractEdgesWithMeta(conn.edges || []);
  return {
    comments,
    pendingReplies,
    hasNextPage: conn.page_info?.has_next_page ?? false,
    endCursor:   conn.page_info?.end_cursor   ?? null,
  };
}

// ── Fetch de replies via REST — sin doc_id ───────────────────────────────────
// Prueba dos endpoints conocidos de Instagram para replies
let _firstReplyLogged = false;

async function fetchAllReplies(restHeaders, commentId) {
  const replies = [];
  let cursor   = null;
  let hasMore  = true;
  let retries  = 0;
  let pageNum  = 0;

  while (hasMore) {
    const qs   = `can_support_threading=true${cursor ? `&min_id=${encodeURIComponent(cursor)}` : ""}`;
    const path = `/api/v1/media/${commentId}/replies/?${qs}`;
    const res  = await nodeGet("i.instagram.com", path, restHeaders);

    // Loguear primera respuesta para diagnóstico
    if (!_firstReplyLogged) {
      _firstReplyLogged = true;
      if (res) {
        const keys = Object.keys(res).filter((k) => k !== "_status");
        console.log(`[DIAG] REST replies status=${res._status} keys=[${keys.join(", ")}] comments=${res.comments?.length ?? "N/A"}`);
      } else {
        console.log(`[DIAG] REST replies: null (endpoint no responde)`);
      }
    }

    if (!res || res._status >= 400) {
      if (retries < 2) { retries++; await sleep(retries * 5000); continue; }
      break;
    }
    retries = 0;
    pageNum++;

    (res.comments || []).forEach((c) => {
      const u = c?.user?.username;
      const t = c?.text;
      const i = c?.pk || c?.id;
      if (u && t && t.trim()) replies.push({ id: i, user: u, comment: t.trim() });
    });

    cursor  = res.next_min_id || null;
    hasMore = !!(cursor || res.has_more_tail_comments);
    if (!cursor) hasMore = false;

    if (hasMore) await sleepRand(400, 900);
  }

  return replies;
}

// ── Scrape principal ──────────────────────────────────────────────────────────
async function scrapeComments(url, fromCursor = null) {
  if (!browser || !page || page.isClosed()) await initBrowser();

  _firstNodeLogged  = false; // reset diagnóstico por run
  _firstReplyLogged = false;

  const api = await captureApiDetails(url);

  const baseParams = new URLSearchParams(api.postData);
  const baseVars   = JSON.parse(baseParams.get("variables") || "{}");
  const docId      = baseParams.get("doc_id") || baseParams.get("query_hash");

  // Headers GraphQL (top-level)
  const gqlHeaders = {
    "content-type":     "application/x-www-form-urlencoded",
    "cookie":           api.cookieStr,
    "x-ig-app-id":      api.reqHeaders["x-ig-app-id"]      || "936619743392459",
    "x-csrftoken":      api.csrftoken,
    "x-ig-www-claim":   api.reqHeaders["x-ig-www-claim"]   || "0",
    "x-instagram-ajax": api.reqHeaders["x-instagram-ajax"] || "1",
    "x-requested-with": "XMLHttpRequest",
    "user-agent":       MOBILE_UA,
    "referer":          url.trim().replace(/[\r\n\t]/g, ""),
  };

  // Headers REST (replies) — mismo app-id, sin referer ni ajax
  const restHeaders = {
    "x-ig-app-id":    gqlHeaders["x-ig-app-id"],
    "x-csrftoken":    api.csrftoken,
    "x-ig-www-claim": gqlHeaders["x-ig-www-claim"],
    "user-agent":     MOBILE_UA,
    "cookie":         api.cookieStr,
    "accept":         "application/json",
    "accept-language":"en-US,en;q=0.9",
  };

  const allComments       = [];
  const pendingRepliesSet = new Set();
  let hasNextPage, endCursor, pageNum;

  if (fromCursor) {
    console.log("Modo incremental — reanudando desde cursor guardado");
    hasNextPage = true;
    endCursor   = fromCursor;
    pageNum     = 1;
  } else {
    const first = parsePage(api.data);
    allComments.push(...first.comments);
    first.pendingReplies.forEach((id) => pendingRepliesSet.add(String(id)));
    hasNextPage = first.hasNextPage;
    endCursor   = first.endCursor;
    console.log(`Pag 1: +${first.comments.length} | total ${allComments.length} | con replies: ${pendingRepliesSet.size} | more: ${hasNextPage}`);
    pageNum = 2;
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
    allComments.push(...pg.comments);
    pg.pendingReplies.forEach((id) => pendingRepliesSet.add(String(id)));
    hasNextPage = pg.hasNextPage;
    endCursor   = pg.endCursor;
    pagesThisRun++;

    if (pagesThisRun % 50 === 0 || !hasNextPage) {
      console.log(`Pag ${pageNum}: +${pg.comments.length} | total ${allComments.length} | con replies: ${pendingRepliesSet.size} | more: ${hasNextPage}`);
    }
    pageNum++;

    await (pagesThisRun % 20 === 0 ? sleepRand(5000, 10000) : sleepRand(700, 1800));
  }

  const pendingArray = [...pendingRepliesSet];
  console.log(`\nFase 1 completa: ${allComments.length} top-level | ${pendingArray.length} comentarios con replies pendientes`);

  if (MAX_PAGES > 0 && pagesThisRun >= MAX_PAGES && hasNextPage)
    console.log(`Limite MAX_PAGES=${MAX_PAGES} alcanzado — reanudar en proximo intervalo`);

  // ── Fase 2: replies via REST ───────────────────────────────────────────────
  if (pendingArray.length > 0) {
    console.log(`Fase 2: obteniendo replies de ${pendingArray.length} comentarios...`);
    let done       = 0;
    let totalFound = 0;

    for (const commentId of pendingArray) {
      const replies = await fetchAllReplies(restHeaders, commentId);
      allComments.push(...replies);
      totalFound += replies.length;
      done++;

      if (done % 25 === 0 || done === pendingArray.length) {
        console.log(`Replies: ${done}/${pendingArray.length} | replies encontradas: ${totalFound} | total acumulado: ${allComments.length}`);
      }
      if (done % 100 === 0) await sleepRand(8000, 15000);
      else if (done % 20 === 0) await sleepRand(4000, 8000);
    }

    console.log(`Fase 2 completa: ${totalFound} replies obtenidas | total final: ${allComments.length}`);
  }

  console.log(`\n=== TOTAL FINAL: ${allComments.length} comentarios | cursor: ${endCursor ? "si" : "no"} ===`);
  return { comments: allComments, lastCursor: endCursor };
}

module.exports = scrapeComments;
