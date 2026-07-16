import { chromium } from 'playwright-core';
const exe = process.env.CHROME;
const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
for (const [name, path] of [['board','/'], ['company','/company/NVDA'], ['about','/about']]) {
  await page.goto('http://127.0.0.1:8878' + (path === '/' ? '/' : path), { waitUntil: 'networkidle', timeout: 45000 }).catch(e => console.log(name, 'nav:', e.message));
  await page.waitForTimeout(4000);
  await page.screenshot({ path: `/tmp/ceo-${name}.png`, fullPage: false });
  console.log('shot', name);
}
await browser.close();
