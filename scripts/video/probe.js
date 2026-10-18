// 用系统 Edge 跑 Playwright（playwright-core 不自带浏览器）
const path = require('path');
const PW = 'C:/Users/Administrator/.workbuddy/binaries/node/workspace/node_modules/playwright-core';
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const { chromium } = require(PW);

(async () => {
  const browser = await chromium.launch({ executablePath: EDGE, headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.goto('https://trendsift.site/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  const title = await page.title();
  const h1 = await page.locator('h1').first().innerText();
  console.log('title:', title);
  console.log('h1:', h1.replace(/\n/g, ' ').slice(0, 80));
  await browser.close();
  console.log('Edge + Playwright OK');
})().catch((e) => {
  console.error('FAIL:', e.message);
  process.exit(1);
});
