import { KIOSK_MS, KIOSK_RETRY_MS } from '../config';
import { el, HOME } from '../lib/dom';
import { worstFeed } from '../lib/net';
import { paintSheet, SHEET_H, SHEET_W } from '../lib/poster';
import { stageOf, WORKS } from '../works';

// Экран iPad mini 2 ровно вдвое плотнее CSS-пикселей, но чипу A7 полная плотность не по силам
const MAX_DPR = 1.5;
const FRAME_MS = 1000 / 30;

// Смена работы перезагружает страницу: так старое устройство каждый раз освобождает память.
// Без сети перезагрузка оставила бы экран с ошибкой навсегда, поэтому постер ждёт, пока сайт снова ответит
async function moveTo(slug: string): Promise<void> {
  const res = await fetch(`${HOME}kiosk/`, { cache: 'no-store' }).catch(() => null);
  if (res?.ok) location.assign(`${HOME}kiosk/?work=${slug}`);
  else setTimeout(() => void moveTo(slug), KIOSK_RETRY_MS);
}

export async function openKiosk(app: HTMLElement): Promise<void> {
  document.body.classList.add('kiosk');
  const works = WORKS.filter((w) => stageOf(w) === 'ready');
  const wanted = new URLSearchParams(location.search).get('work');
  const work = works.find((w) => w.slug === wanted) ?? works[Math.floor(Math.random() * works.length)];
  const next = works[(works.indexOf(work) + 1) % works.length];
  document.title = work.title;

  // Таймер стоит до загрузки работы, чтобы сбой одного постера не останавливал показ
  setTimeout(() => void moveTo(next.slug), KIOSK_MS);

  const canvas = el('canvas', '', app);
  canvas.addEventListener('click', () => void moveTo(next.slug));
  const ctx = canvas.getContext('2d')!;
  const poster = await work.load();
  document.body.style.background = poster.paper();

  const fit = () => {
    const width = Math.min(innerWidth, (innerHeight * SHEET_W) / SHEET_H);
    const dpr = Math.min(devicePixelRatio || 1, MAX_DPR);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${(width * SHEET_H) / SHEET_W}px`;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round((width * SHEET_H * dpr) / SHEET_W);
  };
  addEventListener('resize', fit);
  fit();

  let last = 0;
  const paint = (t: number) => {
    requestAnimationFrame(paint);
    if (t - last < FRAME_MS) return;
    const now = Date.now();
    paintSheet(ctx, poster, now, Math.min(0.25, (t - last) / 1000));
    last = t;
    canvas.dataset.status = worstFeed(poster.feeds, now).status(now);
  };

  void document.fonts.load('700 40px "Jost Variable"', 'Пульс');
  poster.start();
  requestAnimationFrame(paint);
}
