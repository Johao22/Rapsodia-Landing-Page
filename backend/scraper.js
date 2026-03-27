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

// ── Navegar al post y capturar detalles de la API GraphQL ────────────────────
async function captureApiDetails(url) {
  let apiDetails = null;

  const onResponse = async (response) => {
    if (apiDetails || !response.url().includes("instagram.com/graphql")) return;
    try {
      const data = await response.json().catch(() => null);
      if (!data?.data) return;
      const keys = Object.keys(data.data);
      if (!keys.some((k) => k.includes("comment"))) return;
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
    await client.detach().catch(() => {});

    if (!apiDetails) throw new Error("No se capturó la API GraphQL de comentarios");

    // Extraer cookies del browser para usarlas en Node.js
    const pageCookies  = await page.cookies("https://www.instagram.com");
    const cookieStr    = pageCookies.map((c) => `${c.name}=${c.value}`).join("; ");
    const csrftoken    = pageCookies.find((c) => c.name === "csrftoken")?.value || "";

    return { ...apiDetails, cookieStr, csrftoken };
  } finally {
    page.off("response", onResponse);
  }
}

// ── Extraer comentarios + replies de los edges ───────────────────────────────
function extractEdges(edges) {
  const comments = [];
  (edges || []).forEach(({ node }) => {
    if (!node) return;
    const username = node?.user?.username || node?.owner?.username;
    const text     = node?.text;
    const id       = node?.id || node?.pk;
    if (username && text && text.trim()) comments.push({ id, user: username, comment: text.trim() });

    // Replies inline si las incluye Instagram
    const replyEdges = node?.edge_media_to_parent_comment?.edges || node?.edge_threaded_comments?.edges || node?.replies?.edges || [];
    replyEdges.forEach(({ node: r }) => {
      if (!r) return;
      const ru = r?.user?.username || r?.owner?.username;
      const rt = r?.text;
      const ri = r?.id || r?.pk;
      if (ru && rt && rt.trim()) comments.push({ id: ri, user: ru, comment: rt.trim() });
    });
  });
  return comments;
}

function parsePage(data) {
  const conn = data?.data ? Object.values(data.data)[0] : null;
  if (!conn) return { comments: [], hasNextPage: false, endCursor: null };
  return {
    comments:    extractEdges(conn.edges || []),
    hasNextPage: conn.page_info?.has_next_page ?? false,
    endCursor:   conn.page_info?.end_cursor   ?? null,
  };
}

// ── Scrape principal ─────────────────────────────────────────────────────────
async function scrapeComments(url, fromCursor = null) {
  if (!browser || !page || page.isClosed()) await initBrowser();

  // Capturar detalles de la API (browser solo se usa aqui)
  const api = await captureApiDetails(url);

  const baseParams = new URLSearchParams(api.postData);
  const baseVars   = JSON.parse(baseParams.get("variables") || "{}");
  const docId      = baseParams.get("doc_id") || baseParams.get("query_hash");

  // Headers para llamadas Node.js (no browser)
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

  const allComments = [];
  let hasNextPage, endCursor, pageNum;

  if (fromCursor) {
    console.log("Modo incremental — reanudando desde cursor guardado");
    hasNextPage = true;
    endCursor   = fromCursor;
    pageNum     = 1;
  } else {
    const first = parsePage(api.data);
    allComments.push(...first.comments);
    hasNextPage = first.hasNextPage;
    endCursor   = first.endCursor;
    console.log(`Pagina 1: ${first.comments.length} | total ${allComments.length} | more: ${hasNextPage}`);
    pageNum = 2;
  }

  let retries      = 0;
  let pagesThisRun = 0;
  const limit      = MAX_PAGES > 0 ? MAX_PAGES : Infinity;

  while (hasNextPage && endCursor && pagesThisRun < limit) {
    const vars = { ...baseVars, after: endCursor };
    const body = new URLSearchParams();
    body.set("variables", JSON.stringify(vars));
    if (docId) body.set("doc_id", docId);

    // Llamada desde Node.js — sin browser, sin limite de memoria
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
    hasNextPage = pg.hasNextPage;
    endCursor   = pg.endCursor;
    pagesThisRun++;
    console.log(`Pagina ${pageNum}: +${pg.comments.length} | total ${allComments.length} | more: ${hasNextPage}`);
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

  console.log(`Total final: ${allComments.length} comentarios | cursor: ${endCursor ? "si" : "no"}`);
  return { comments: allComments, lastCursor: endCursor };
}

module.exports = scrapeComments;
