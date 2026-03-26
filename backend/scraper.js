require("dotenv").config();

const puppeteer = require("puppeteer");

const IG_USERNAME = process.env.IG_USERNAME;
const IG_PASSWORD = process.env.IG_PASSWORD;
const DESKTOP_UA  = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const MOBILE_UA   = "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Estado persistente del browser ──────────────────────────────────────────
let browser = null;
let page    = null;

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
      if (
        text.includes("Allow all cookies") ||
        text.includes("Aceptar todas las cookies") ||
        text.includes("Allow essential and optional cookies") ||
        text.includes("Accept")
      ) {
        await btn.click();
        await sleep(1500);
        return;
      }
    }
  } catch (_) {}
}

async function login() {
  console.log("Iniciando sesion en Instagram...");
  await page.goto("https://www.instagram.com/accounts/login/", {
    waitUntil: "domcontentloaded",
    timeout: 30000,
  });

  await sleep(4000);
  await acceptCookies();
  await sleep(2000);

  const USERNAME_SELECTORS = [
    'input[name="username"]',
    'input[aria-label="Mobile number, username or email"]',
    'input[aria-label*="username"]',
    'input[aria-label*="phone"]',
    'form input[type="text"]',
    'input[type="text"]',
  ];

  let userInput = null;
  for (const sel of USERNAME_SELECTORS) {
    userInput = await page.$(sel);
    if (userInput) { console.log("Username input:", sel); break; }
  }

  if (!userInput) {
    await page.screenshot({ path: "login_debug.png", fullPage: true });
    throw new Error("No se encontro el input de usuario. Ver login_debug.png");
  }

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
      .find((el) => {
        const t = (el.textContent || "").trim().toLowerCase();
        return t === "log in" || t === "iniciar sesión" || t === "ingresar";
      });
    if (btn) { btn.click(); return true; }
    return false;
  });

  if (!clicked) await passInput.press("Enter");

  await page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => {});
  await sleep(3000);

  for (let i = 0; i < 3; i++) { await dismissDialogs(); await sleep(800); }

  const finalUrl = page.url();
  console.log("URL post-login:", finalUrl);

  if (finalUrl.includes("/accounts/login") || finalUrl.includes("/challenge") || finalUrl.includes("/suspended")) {
    await page.screenshot({ path: "login_failed.png", fullPage: true });
    throw new Error("Login fallido. URL: " + finalUrl);
  }

  console.log("Login completado");
}

// ── Inicializar browser una sola vez ────────────────────────────────────────
async function initBrowser() {
  console.log("Iniciando browser...");

  const headless = process.env.HEADLESS !== "false" ? "new" : false;

  browser = await puppeteer.launch({
    headless,
    executablePath: process.env.CHROME_PATH || puppeteer.executablePath(),
    protocolTimeout: 300_000,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-blink-features=AutomationControlled",
      "--disable-gpu",
      "--no-zygote",
      "--disable-extensions",
      "--no-first-run",
    ],
  });

  page = await browser.newPage();

  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });

  // Login con desktop UA
  await page.setUserAgent(DESKTOP_UA);
  await page.setViewport({ width: 1280, height: 900 });

  if (process.env.IG_COOKIES) {
    try {
      const valid = ["Strict", "Lax", "None"];
      const cookies = JSON.parse(process.env.IG_COOKIES).map(c => {
        const clean = { ...c };
        if (!valid.includes(clean.sameSite)) delete clean.sameSite;
        return clean;
      });
      await page.setCookie(...cookies);
      console.log(`Sesion restaurada via cookies (${cookies.length} cookies)`);
    } catch (e) {
      console.error("Error al cargar IG_COOKIES:", e.message);
    }
  } else if (IG_USERNAME && IG_PASSWORD) {
    await login();
  }

  // Cambiar a mobile para scraping
  await page.setUserAgent(MOBILE_UA);
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });

  // Detectar si el browser se cierra inesperadamente para reinicializar
  browser.on("disconnected", () => {
    console.log("Browser desconectado — se reinicializara en el proximo scrape");
    browser = null;
    page    = null;
  });

  console.log("Browser listo y sesion activa");
}

// ── Scrape (reutiliza el browser abierto) ───────────────────────────────────
async function scrapeComments(url) {
  if (!browser || !page || page.isClosed()) await initBrowser();

  let apiDetails = null; // captura del primer response GraphQL

  // Interceptor — solo para capturar la primera respuesta de comentarios
  const onResponse = async (response) => {
    if (apiDetails) return;
    if (!response.url().includes("instagram.com/graphql")) return;
    try {
      const data = await response.json().catch(() => null);
      if (!data?.data) return;
      if (!Object.keys(data.data).some((k) => k.includes("comment"))) return;
      const req = response.request();
      apiDetails = {
        url:        response.url(),
        postData:   req.postData() || "",
        reqHeaders: req.headers(),
        data,
      };
    } catch (_) {}
  };

  page.on("response", onResponse);

  try {
    // Navegar directo a la URL de comentarios
    const commentsUrl = url.replace(/\/+$/, "") + "/comments/";
    await page.goto(commentsUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    await sleep(2000);

    // Descartar dialogs ocasionales
    await page.evaluate(() => {
      const dismiss = ["not now", "ahora no", "maybe later", "skip", "cancel", "omitir"];
      document.querySelectorAll("button, [role='button']").forEach((btn) => {
        if (dismiss.some((d) => (btn.textContent || "").toLowerCase().includes(d))) btn.click();
      });
    });
    await sleep(1000);

    const currentUrl = page.url();
    console.log("URL comentarios:", currentUrl);
    if (!currentUrl.includes("/p/")) {
      throw new Error(`Sesion invalida — redirigido a ${currentUrl}. Renovar IG_COOKIES.`);
    }

    // Scrollear hasta capturar la primera llamada GraphQL (max 20s)
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

    if (!apiDetails) {
      console.log("URL actual:", page.url());
      throw new Error("No se capturó la API GraphQL de comentarios");
    }

    // ── Extraer comentarios y cursor de un response ──────────────────────────
    function extractPage(data) {
      const conn     = data?.data ? Object.values(data.data)[0] : null;
      const comments = [];
      let hasNextPage = false;
      let endCursor   = null;

      if (conn) {
        (conn.edges || []).forEach(({ node }) => {
          const username = node?.user?.username || node?.owner?.username;
          const text     = node?.text;
          if (username && text) comments.push({ user: username, comment: text });
        });
        hasNextPage = conn.page_info?.has_next_page ?? false;
        endCursor   = conn.page_info?.end_cursor   ?? null;
      }
      return { comments, hasNextPage, endCursor };
    }

    const allComments = [];
    let { comments, hasNextPage, endCursor } = extractPage(apiDetails.data);
    allComments.push(...comments);
    console.log(`Pagina 1: ${comments.length} | total ${allComments.length} | more: ${hasNextPage}`);

    // Datos del request original para reutilizar
    const baseParams = new URLSearchParams(apiDetails.postData);
    const baseVars   = JSON.parse(baseParams.get("variables") || "{}");
    const docId      = baseParams.get("doc_id") || baseParams.get("query_hash");
    const appId      = apiDetails.reqHeaders["x-ig-app-id"]      || "936619743392459";
    const wwwClaim   = apiDetails.reqHeaders["x-ig-www-claim"]   || "0";
    const ajaxHeader = apiDetails.reqHeaders["x-instagram-ajax"] || "1";

    // ── Paginar via fetch directo desde el contexto del browser ─────────────
    let pageNum = 2;
    while (hasNextPage && endCursor) {
      const vars = { ...baseVars, after: endCursor };
      const body = new URLSearchParams();
      body.set("variables", JSON.stringify(vars));
      if (docId) body.set("doc_id", docId);

      const result = await page.evaluate(async (fetchUrl, bodyStr, appId, wwwClaim, ajax) => {
        const csrftoken = (document.cookie.split(";").find((c) => c.trim().startsWith("csrftoken=")) || "").split("=")[1] || "";
        try {
          const res = await fetch(fetchUrl, {
            method: "POST",
            headers: {
              "content-type":     "application/x-www-form-urlencoded",
              "x-ig-app-id":      appId,
              "x-csrftoken":      csrftoken,
              "x-ig-www-claim":   wwwClaim,
              "x-instagram-ajax": ajax,
              "x-requested-with": "XMLHttpRequest",
            },
            body: bodyStr,
            credentials: "include",
          });
          return res.json();
        } catch (_) { return null; }
      }, apiDetails.url, body.toString(), appId, wwwClaim, ajaxHeader);

      if (!result?.data) {
        console.log(`Pagina ${pageNum}: sin datos, deteniendo`);
        break;
      }

      ({ comments, hasNextPage, endCursor } = extractPage(result));
      allComments.push(...comments);
      console.log(`Pagina ${pageNum}: +${comments.length} | total ${allComments.length} | more: ${hasNextPage}`);
      pageNum++;

      await sleep(300);
    }

    console.log(`Total final: ${allComments.length} comentarios`);
    return allComments;

  } finally {
    page.off("response", onResponse);
    // NO se cierra el browser — se reutiliza en el siguiente scrape
  }
}

module.exports = scrapeComments;
