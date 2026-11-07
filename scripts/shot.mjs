// Снимает работу и проверяет её страницу: node scripts/shot.mjs <slug> [секунды ожидания]
// Сервер должен быть запущен без прокси, иначе проверка не отражает маршрут из России
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright-core';

const [slug, waitSec = '12'] = process.argv.slice(2);
if (!slug) throw new Error('Нужен slug работы');
const base = process.env.PULS_URL ?? 'http://localhost:5173';
const url = `${base}/work/${slug}/`;
const problems = [];
const notes = [];

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--no-proxy-server'] });
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 }, deviceScaleFactor: 1.5 });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text().slice(0, 160)));

await page.goto(url);
await page.waitForSelector('canvas[data-status]');
await page
  .waitForFunction(() => document.querySelector('canvas').dataset.status === 'live', null, { timeout: 30_000 })
  .catch(() => problems.push('источник не вышел в эфир за 30 секунд'));
await page.waitForTimeout(Number(waitSec) * 1000);

const frame = page.locator('canvas');
const first = await frame.screenshot({ type: 'jpeg', quality: 86 });
await page.waitForTimeout(4000);
const second = await frame.screenshot({ type: 'jpeg', quality: 86 });
if (first.equals(second)) notes.push('за 4 секунды картинка не изменилась: проверь, что так и задумано');

mkdirSync('public/previews', { recursive: true });
writeFileSync(`public/previews/${slug}.jpg`, second);
if (existsSync(`releases/${slug}`)) {
  writeFileSync(`releases/${slug}/frame-1.jpg`, first);
  writeFileSync(`releases/${slug}/frame-2.jpg`, second);
}

const fps = await page.evaluate(
  () =>
    new Promise((done) => {
      let n = 0;
      const t0 = performance.now();
      const tick = () => (++n, performance.now() - t0 < 2000 ? requestAnimationFrame(tick) : done(n / 2));
      requestAnimationFrame(tick);
    }),
);
if (fps < 40) problems.push(`низкая частота кадров: ${fps}`);

await page.setViewportSize({ width: 1280, height: 720 });
await page.waitForTimeout(400);
const note = await page.evaluate(() => {
  const n = document.querySelector('.note');
  return n.scrollHeight - n.clientHeight;
});
if (note > 0) problems.push(`экспликация не влезает в 1280×720 на ${note} px`);

const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
await phone.goto(url);
await phone.waitForTimeout(1500);
if (await phone.evaluate(() => document.documentElement.scrollWidth > innerWidth)) problems.push('на телефоне есть горизонтальная прокрутка');

const label = await page.locator('canvas').getAttribute('aria-label');
await browser.close();

problems.push(...new Set(errors));
console.log(label);
console.log(`fps ${fps}, превью public/previews/${slug}.jpg`);
for (const text of notes) console.log(`Внимание: ${text}`);
console.log(problems.length ? `ПРОБЛЕМЫ:\n- ${problems.join('\n- ')}` : 'Проверки пройдены');
process.exit(problems.length ? 1 : 0);
