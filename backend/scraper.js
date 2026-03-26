require("dotenv").config();

const puppeteer = require("puppeteer");

const IG_USERNAME = process.env.IG_USERNAME;
const IG_PASSWORD = process.env.IG_PASSWORD;
const DESKTOP_UA  = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const MOBILE_UA   = "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1";
const EXCLUDED    = new Set(["explore","accounts","reels","stories","direct","p","tv","meta","help","reel","about","privacy","terms"]);

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
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-blink-features=AutomationControlled"],
  });

  page = await browser.newPage();

  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });

  // Login con desktop UA
  await page.setUserAgent(DESKTOP_UA);
  await page.setViewport({ width: 1280, height: 900 });

  if (IG_USERNAME && IG_PASSWORD) await login();

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
  // Inicializar solo si no hay browser activo
  if (!browser || !page || page.isClosed()) {
    await initBrowser();
  }

  const allComments = []; // acumula comentarios via GraphQL

  // Interceptor GraphQL — se registra por scrape y se limpia al terminar
  const onResponse = async (response) => {
    if (!response.url().includes("instagram.com/graphql")) return;
    try {
      const data = await response.json().catch(() => null);
      if (!data?.data || typeof data.data !== "object") return;

      console.log("GraphQL data.data keys:", Object.keys(data.data).join(", "));

      function extractFromObj(obj) {
        if (!obj || typeof obj !== "object") return;
        if (typeof obj.text === "string" && obj.text.length > 0) {
          const username = obj.user?.username || obj.owner?.username || obj.from?.username;
          if (username) { allComments.push({ user: username, comment: obj.text }); return; }
        }
        if (Array.isArray(obj)) obj.forEach(extractFromObj);
        else Object.values(obj).forEach(extractFromObj);
      }

      const before = allComments.length;
      extractFromObj(data.data);
      const found = allComments.length - before;
      if (found > 0) console.log(`GraphQL +${found} | total ${allComments.length}`);
      else console.log("GraphQL sin comentarios. Preview:", JSON.stringify(data.data).slice(0, 300));
    } catch (_) {}
  };

  page.on("response", onResponse);

  try {
    // Navegar al post (sesion ya activa, no hace falta login)
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await sleep(2000);

    // Descartar dialogs ocasionales
    await page.evaluate(() => {
      const dismiss = ["not now", "ahora no", "maybe later", "skip", "cancel", "omitir"];
      document.querySelectorAll("button, [role='button']").forEach((btn) => {
        if (dismiss.some((d) => (btn.textContent || "").toLowerCase().includes(d))) btn.click();
      });
    });
    await sleep(1500);

    // Click "Ver los X comentarios"
    const clicked = await page.evaluate(() => {
      const btn = [...document.querySelectorAll("a, button, span, [role='button']")].find((el) => {
        const t = (el.textContent || "").toLowerCase();
        return t.includes("ver los") || (t.includes("ver") && t.includes("comentario")) || (t.includes("view") && t.includes("comment"));
      });
      if (btn) { btn.click(); return true; }
      return false;
    });
    console.log("Click comentarios:", clicked);

    await page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 8000 }).catch(() => {});
    await sleep(2000);
    console.log("URL comentarios:", page.url());
    await page.screenshot({ path: "post_debug.png" });

    // ── Scroll + acumulacion DOM ─────────────────────────────────────────────
    const domAccumulated = new Map();
    let domPrevKeys = new Set();
    let domStable   = 0;
    const client    = await page.target().createCDPSession();

    for (let i = 0; i < 80; i++) {
      // Extraer comentarios visibles
      const batch = await page.evaluate((excl) => {
        const results = [];
        document.querySelectorAll('span[dir="auto"]').forEach((span) => {
          const link  = span.querySelector('a[href]');
          if (!link) return;
          const match = (link.getAttribute("href") || "").match(/^\/([a-zA-Z0-9._]+)\/?$/);
          if (!match || excl.includes(match[1])) return;
          const username = match[1];
          const full     = span.textContent.trim();
          const comment  = full.startsWith(username) ? full.slice(username.length).trim() : full;
          results.push({ user: username, comment: comment || "tagged" });
        });
        return results;
      }, [...EXCLUDED]);

      const currentKeys = new Set(batch.map(({ user, comment }) => `${user}::${comment}`));
      let newFound = 0;
      batch.forEach(({ user, comment }) => {
        const key = `${user}::${comment}`;
        if (!domPrevKeys.has(key)) { domAccumulated.set(key, { user, comment }); newFound++; }
      });
      domPrevKeys = currentKeys;

      const spansBefore = await page.evaluate(() => document.querySelectorAll('span[dir="auto"]').length);

      // Touch swipe
      await client.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: 195, y: 600, id: 0 }] });
      for (let s = 1; s <= 8; s++) {
        await client.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: 195, y: 600 - s * 60, id: 0 }] });
        await sleep(25);
      }
      await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await sleep(2000);

      const spansAfter = await page.evaluate(() => document.querySelectorAll('span[dir="auto"]').length);
      console.log(`Scroll ${i + 1}: +${newFound} | acum ${domAccumulated.size} | spans ${spansBefore}→${spansAfter}`);

      if (spansAfter <= spansBefore && newFound === 0) { domStable++; if (domStable >= 6) break; } else domStable = 0;
    }

    await client.detach().catch(() => {});

    // Combinar GraphQL + DOM
    const domComments = Array.from(domAccumulated.values());
    const combined    = [...allComments];
    domComments.forEach(({ user, comment }) => {
      if (!combined.some((c) => c.user === user && c.comment === comment)) combined.push({ user, comment });
    });

    console.log(`Total: ${combined.length} (GraphQL: ${allComments.length} + DOM: ${domComments.length})`);
    return combined;

  } finally {
    // Quitar el listener para que no se acumule en el proximo scrape
    page.off("response", onResponse);
  }
  // NO se cierra el browser — se reutiliza en el siguiente scrape
}

module.exports = scrapeComments;
