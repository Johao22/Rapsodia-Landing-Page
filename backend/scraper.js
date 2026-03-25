const puppeteer = require("puppeteer");

async function scrapeComments(url) {
  const browser = await puppeteer.launch({
    headless: true
  });

  const page = await browser.newPage();
  await page.goto(url, { waitUntil: "networkidle2" });

  await page.waitForTimeout(5000);

  const comments = await page.evaluate(() => {
    return Array.from(document.querySelectorAll("ul li"))
      .map(n => ({
        user: n.querySelector("h3")?.innerText,
        comment: n.querySelector("span")?.innerText
      }))
      .filter(x => x.user && x.comment);
  });

  await browser.close();
  return comments;
}

module.exports = scrapeComments;