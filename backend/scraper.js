require("dotenv").config();

const puppeteer = require("puppeteer");
const https     = require("https");

const IG_USERNAME = process.env.IG_USERNAME;
const IG_PASSWORD = process.env.IG_PASSWORD;
const DESKTOP_UA  = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const MOBILE_UA   = "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1";

const sleep     = (ms) => new Promise((r) => setTimeout(r, ms));
const sleepRand = (min, max) => sleep(Math.floor(Math.random() * (max - min + 1)) + min);
const MAX_PAGES = parseInt(process.env.MAX_PAGES || "0"); // 0 = sin limite

let browser = null;
let page    = null;

// ── HTTP POST desde Node.js (sin browser, sin limite de memoria) ─────────────
function nodePost(url, headers, body) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const req = https.request(
      {
        hostname: u.hostname,
        path:     u.pathname + (u.search || ""),
        method:   "POST",
        headers:  { ...headers, "content-length": Buffer.byteLength(body) },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
          catch (_) { resolve(null); }
        });
      }
    );
    req.on("error", () => resolve(null));
    req.write(body);
    req.end();
  });
}

// ── Helpers ──────────────────────────────────────────────────────────────────
async function dismissDialogs() {
  try {
    const btns = await page.$$("button");
    for (const btn of btns) {
      const text  = await page.evaluate((el) => el.textContent || "", btn);
      const lower = text.toLowerCase();
      if (lower.includes("not now") || lower.includes("ahora no") || lower.includes("maybe later") || lower.includes("skip")) {
        await btn.click();
        await sleep(600);
      }
    }
  } catch (_) {}
}

async function acceptCookies() {
  try {
    const btns = await page.$$("button");
    for (const btn of btns) {
      const text = await page.evaluate((el) => el.textContent || "", btn);
      if (text.includes("Allow all cookies") || text.includes("Aceptar todas las cookies") || text.includes("Accept")) {
        await btn.click();
        await sleep(1500);
        return;
      }
    }
  } catch (_) {}
}

async function login() {
  console.log("Iniciando sesion en Instagram...");
  await page.goto("https://www.instagram.com/accounts/login/", { waitUntil: "domcontentloaded", timeout: 30000 });
  await sleep(4000);
  await acceptCookies();
  await sleep(2000);

  const selectors = ['input[name="username"]', 'input[aria-label*="username"]', 'form input[type="text"]', 'input[type="text"]'];
  let userInput = null;
  for (const sel of selectors) { userInput = await page.$(sel); if (userInput) break; }
  if (!userInput) throw new Error("No se encontro el input de usuario");

  await userInput.click({ clickCount: 3 });
  await userInput.type(IG_USERNAME, { delay: 80 });
  await sleep(300);

  const passInput = await page.$('input[name="password"]') || await page.$('input[type="password"]');
  if (!passInput) throw new Error("No se encontro el input de password");
  await passInput.click({ clickCount: 3 });
  await passInput.type(IG_PASSWORD, { delay: 80 });
  await sleep(300);

  const clicked = await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button, div[role="button"], [type="submit"]')]
      .find((el) => { const t = (el.textContent || "").trim().toLowerCase(); return t === "log in" || t === "iniciar sesión" || t === "ingresar"; });
    if (btn) { btn.click(); return true; }
    return false;
  });
  if (!clicked) await passInput.press("Enter");

  await page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => {});
  await sleep(3000);
  for (let i = 0; i < 3; i++) { await dismissDialogs(); await sleep(800); }

  const finalUrl = page.url();
  if (finalUrl.includes("/accounts/login") || finalUrl.includes("/challenge") || finalUrl.includes("/suspended")) {
    throw new Error("Login fallido. URL: " + finalUrl);
  }
  console.log("Login completado");
}

async function initBrowser() {
  console.log("Iniciando browser...");
  const headless = process.env.HEADLESS !== "false" ? "new" : false;

  browser = await puppeteer.launch({
    headless,
    executablePath: process.env.CHROME_PATH || puppeteer.executablePath(),
    protocolTimeout: 300_000,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-blink-features=AutomationControlled", "--disable-gpu", "--no-zygote", "--disable-extensions", "--no-first-run"],
  });

  page = await browser.newPage();
  await page.evaluateOnNewDocument(() => { Object.defineProperty(navigator, "webdriver", { get: () => undefined }); });
  await page.setUserAgent(DESKTOP_UA);
  await page.setViewport({ width: 1280, height: 900 });

  if (process.env.IG_COOKIES) {
    try {
      const valid = ["Strict", "Lax", "None"];
      const cookies = JSON.parse(process.env.IG_COOKIES).map(c => { const cl = { ...c }; if (!valid.includes(cl.sameSite)) delete cl.sameSite; return cl; });
      await page.setCookie(...cookies);
      console.log(`Sesion restaurada via cookies (${cookies.length} cookies)`);
    } catch (e) { console.error("Error al cargar IG_COOKIES:", e.message); }
  } else if (IG_USERNAME && IG_PASSWORD) {
    await login();
  }

  await page.setUserAgent(MOBILE_UA);
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });

  browser.on("disconnected", () => { console.log("Browser desconectado"); browser = null; page = null; });
  console.log("Browser listo y sesion activa");
}

// ── Navegar al post y capturar detalles de las APIs GraphQL ──────────────────
async function captureApiDetails(url) {
  let apiDetails   = null;
  let replyApiDetails = null;

  const onResponse = async (response) => {
    if (!response.url().includes("instagram.com/graphql")) return;
    try {
      const data = await response.json().catch(() => null);
      if (!data?.data) return;
      const keys = Object.keys(data.data);
      const req  = response.request();

      // API de comentarios top-level (no replies)
      if (!apiDetails && keys.some((k) => k.includes("comment") && !k.includes("repl"))) {
        apiDetails = { url: response.url(), postData: req.postData() || "", reqHeaders: req.headers(), data };
        console.log("API comentarios capturada:", keys.join(", "));
      }
      // API de replies
      if (!replyApiDetails && keys.some((k) => k.includes("repl"))) {
        replyApiDetails = { url: response.url(), postData: req.postData() || "" };
        console.log("API replies capturada:", keys.join(", "));
      }
    } catch (_) {}
  };

  page.on("response", onResponse);

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await sleep(2000);

    if (!page.url().includes("/p/")) throw new Error(`Sesion invalida — redirigido a ${page.url()}. Renovar IG_COOKIES.`);

    await page.evaluate(() => {
      const dismiss = ["not now", "ahora no", "maybe later", "skip", "cancel", "omitir"];
      document.querySelectorAll("button, [role='button']").forEach((btn) => {
        if (dismiss.some((d) => (btn.textContent || "").toLowerCase().includes(d))) btn.click();
      });
    });
    await sleep(800);

    const clicked = await page.evaluate(() => {
      const btn = [...document.querySelectorAll("a, button, span, [role='button']")].find((el) => {
        const t = (el.textContent || "").toLowerCase();
        return t.includes("ver los") || (t.includes("ver") && t.includes("comentario")) || (t.includes("view") && t.includes("comment"));
      });
      if (btn) { btn.click(); return true; }
      return false;
    });

    if (clicked) {
      await page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 10000 }).catch(() => {});
    } else {
      const cu = url.replace(/\/+$/, "") + "/comments/";
      await page.evaluate((u) => { history.pushState({}, "", u); window.dispatchEvent(new PopStateEvent("popstate")); }, cu);
    }
    await sleep(1500);
    console.log("URL comentarios:", page.url());

    const client   = await page.target().createCDPSession();
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

    if (!apiDetails) { await client.detach().catch(() => {}); throw new Error("No se capturó la API GraphQL de comentarios"); }

    // Si aun no tenemos la API de replies, intentar hacer click en "ver respuestas"
    if (!replyApiDetails) {
      const replyClicked = await page.evaluate(() => {
        const els = [...document.querySelectorAll("span, button, div")];
        const btn = els.find((el) => {
          const t = (el.textContent || "").toLowerCase();
          return (t.includes("respuesta") || t.includes("repl")) && el.offsetParent !== null;
        });
        if (btn) { btn.click(); return true; }
        return false;
      });
      if (replyClicked) {
        await sleep(3000);
        console.log(replyApiDetails ? "API replies capturada via click" : "Click en replies sin resultado");
      }
    }

    // Si aun no tenemos replies, hacer scroll adicional para que Instagram cargue algunas
    if (!replyApiDetails) {
      for (let i = 0; i < 5 && !replyApiDetails; i++) {
        await client.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: 195, y: 600, id: 0 }] });
        for (let s = 1; s <= 8; s++) {
          await client.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: 195, y: 600 - s * 60, id: 0 }] });
          await sleep(25);
        }
        await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        await sleep(1500);
      }
    }

    await client.detach().catch(() => {});

    if (!replyApiDetails) console.log("AVISO: API de replies no capturada — solo se procesaran comentarios top-level");

    const pageCookies = await page.cookies("https://www.instagram.com");
    const cookieStr   = pageCookies.map((c) => `${c.name}=${c.value}`).join("; ");
    const csrftoken   = pageCookies.find((c) => c.name === "csrftoken")?.value || "";

    return { ...apiDetails, cookieStr, csrftoken, replyApiDetails };
  } finally {
    page.off("response", onResponse);
  }
}

// ── Extraer comentarios + metadata de replies pendientes ─────────────────────
function extractEdgesWithMeta(edges) {
  const comments      = [];
  const pendingReplies = [];

  (edges || []).forEach(({ node }) => {
    if (!node) return;
    const username = node?.user?.username || node?.owner?.username;
    const text     = node?.text;
    const id       = node?.id || node?.pk;
    if (username && text && text.trim()) comments.push({ id, user: username, comment: text.trim() });

    // Replies inline que Instagram incluye (normalmente 3-5)
    const repliesConn = node?.edge_media_to_parent_comment || node?.edge_threaded_comments || node?.replies;
    const replyEdges  = repliesConn?.edges || [];
    replyEdges.forEach(({ node: r }) => {
      if (!r) return;
      const ru = r?.user?.username || r?.owner?.username;
      const rt = r?.text;
      const ri = r?.id || r?.pk;
      if (ru && rt && rt.trim()) comments.push({ id: ri, user: ru, comment: rt.trim() });
    });

    // Marcar si hay mas replies a paginar
    const rpi = repliesConn?.page_info;
    if (rpi?.has_next_page && rpi?.end_cursor && id) {
      pendingReplies.push({ commentId: id, cursor: rpi.end_cursor });
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

// ── Paginar todas las replies de un comentario ───────────────────────────────
async function fetchAllReplies(replyApiDetails, nodeHeaders, commentId, startCursor) {
  const baseParams = new URLSearchParams(replyApiDetails.postData);
  const baseVars   = JSON.parse(baseParams.get("variables") || "{}");
  const docId      = baseParams.get("doc_id") || baseParams.get("query_hash");

  const replies  = [];
  let cursor     = startCursor;
  let hasMore    = true;
  let retries    = 0;

  while (hasMore && cursor) {
    const vars = { ...baseVars, comment_id: commentId, after: cursor };
    const body = new URLSearchParams();
    body.set("variables", JSON.stringify(vars));
    if (docId) body.set("doc_id", docId);

    const result = await nodePost(replyApiDetails.url, nodeHeaders, body.toString());

    if (!result?.data) {
      if (retries < 2) { retries++; await sleep(retries * 4000); continue; }
      break;
    }
    retries = 0;

    const conn  = Object.values(result.data)[0];
    if (!conn) break;

    (conn.edges || []).forEach(({ node }) => {
      if (!node) return;
      const username = node?.user?.username || node?.owner?.username;
      const text     = node?.text;
      const id       = node?.id || node?.pk;
      if (username && text && text.trim()) replies.push({ id, user: username, comment: text.trim() });
    });

    hasMore = conn.page_info?.has_next_page ?? false;
    cursor  = conn.page_info?.end_cursor   ?? null;
    await sleepRand(600, 1400);
  }

  return replies;
}

// ── Scrape principal ─────────────────────────────────────────────────────────
async function scrapeComments(url, fromCursor = null) {
  if (!browser || !page || page.isClosed()) await initBrowser();

  const api = await captureApiDetails(url);

  const baseParams = new URLSearchParams(api.postData);
  const baseVars   = JSON.parse(baseParams.get("variables") || "{}");
  const docId      = baseParams.get("doc_id") || baseParams.get("query_hash");

  const nodeHeaders = {
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

  const allComments    = [];
  const allPendingReplies = [];
  let hasNextPage, endCursor, pageNum;

  if (fromCursor) {
    console.log("Modo incremental — reanudando desde cursor guardado");
    hasNextPage = true;
    endCursor   = fromCursor;
    pageNum     = 1;
  } else {
    const first = parsePage(api.data);
    allComments.push(...first.comments);
    allPendingReplies.push(...first.pendingReplies);
    hasNextPage = first.hasNextPage;
    endCursor   = first.endCursor;
    console.log(`Pagina 1: ${first.comments.length} | total ${allComments.length} | replies pendientes: ${allPendingReplies.length} | more: ${hasNextPage}`);
    pageNum = 2;
  }

  let retries      = 0;
  let pagesThisRun = 0;
  const limit      = MAX_PAGES > 0 ? MAX_PAGES : Infinity;

  // ── Fase 1: comentarios top-level ─────────────────────────────────────────
  while (hasNextPage && endCursor && pagesThisRun < limit) {
    const vars = { ...baseVars, after: endCursor };
    const body = new URLSearchParams();
    body.set("variables", JSON.stringify(vars));
    if (docId) body.set("doc_id", docId);

    const result = await nodePost(api.url, nodeHeaders, body.toString());

    if (!result?.data) {
      if (retries < 3) {
        retries++;
        const wait = retries * 5000;
        console.log(`Pagina ${pageNum}: sin datos — reintentando en ${wait / 1000}s (${retries}/3)...`);
        await sleep(wait);
        continue;
      }
      console.log(`Pagina ${pageNum}: sin datos tras 3 reintentos, deteniendo`);
      break;
    }

    retries = 0;
    const pg = parsePage(result);
    allComments.push(...pg.comments);
    allPendingReplies.push(...pg.pendingReplies);
    hasNextPage = pg.hasNextPage;
    endCursor   = pg.endCursor;
    pagesThisRun++;
    console.log(`Pagina ${pageNum}: +${pg.comments.length} | total ${allComments.length} | replies pendientes: ${allPendingReplies.length} | more: ${hasNextPage}`);
    pageNum++;

    if (pagesThisRun % 20 === 0) {
      console.log("Pausa anti-deteccion...");
      await sleepRand(5000, 10000);
    } else {
      await sleepRand(800, 2000);
    }
  }

  if (MAX_PAGES > 0 && pagesThisRun >= MAX_PAGES && hasNextPage) {
    console.log(`Limite de ${MAX_PAGES} paginas — continuara en el proximo intervalo`);
  }

  console.log(`Fase 1 completa: ${allComments.length} comentarios top-level | ${allPendingReplies.length} comentarios con replies pendientes`);

  // ── Fase 2: replies de cada comentario ────────────────────────────────────
  if (api.replyApiDetails && allPendingReplies.length > 0) {
    console.log(`Fase 2: paginando replies de ${allPendingReplies.length} comentarios...`);
    let replyGroupsDone = 0;

    for (const { commentId, cursor } of allPendingReplies) {
      const replies = await fetchAllReplies(api.replyApiDetails, nodeHeaders, commentId, cursor);
      allComments.push(...replies);
      replyGroupsDone++;

      if (replyGroupsDone % 10 === 0) {
        console.log(`Replies: ${replyGroupsDone}/${allPendingReplies.length} comentarios procesados | total acumulado: ${allComments.length}`);
      }
      if (replyGroupsDone % 50 === 0) {
        console.log("Pausa anti-deteccion (replies)...");
        await sleepRand(5000, 10000);
      }
    }

    console.log(`Fase 2 completa: ${allComments.length} comentarios totales (top-level + replies)`);
  }

  console.log(`Total final: ${allComments.length} comentarios | cursor: ${endCursor ? "si" : "no"}`);
  return { comments: allComments, lastCursor: endCursor };
}

module.exports = scrapeComments;
