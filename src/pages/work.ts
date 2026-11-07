import { TOUR_MS } from '../config';
import { button, el, langSwitch, link, setText, toggleFullscreen } from '../lib/dom';
import { fmtDay } from '../lib/format';
import { tr } from '../lib/i18n';
import { mapLink, mapPreview } from '../lib/locate';
import { worstFeed } from '../lib/net';
import { paintSheet, SHEET_W } from '../lib/poster';
import { neighbours, workPath, type Work } from '../works';

const MAX_DPR = 2;

export async function openWork(app: HTMLElement, work: Work): Promise<void> {
  document.body.classList.add('focused');
  document.title = `${tr('№', 'No.')} ${work.no} ${work.title} — ${tr('Пульс', 'Pulse')}`;
  const { previous, next } = neighbours(work);
  const poster = await work.load();

  const bar = el('header', 'bar', app);
  link(tr('Пульс', 'Pulse'), '/', el('h1', 'brand', bar), 'home');
  const controls = el('nav', 'controls', bar);
  link(tr('Все работы', 'All works'), '/', controls);

  const wall = el('main', 'wall', app);
  const root = el('figure', 'hung active', wall);
  const frame = el('div', 'frame', root);
  const canvas = el('canvas', '', frame);
  canvas.setAttribute('role', 'img');
  const ctx = canvas.getContext('2d')!;

  const note = el('aside', 'note', app);
  setText(el('p', 'note-service', note), `${tr('№', 'No.')} ${work.no} · ${poster.service} · ${poster.source} · ${fmtDay(work.date)}`);
  const noteTitle = el('h2', '', note);
  const map = link('', '#', note, 'note-map');
  map.target = '_blank';
  map.rel = 'noopener';
  const mapImage = el('img', '', map);
  mapImage.alt = '';
  setText(el('span', '', map), tr('На Яндекс Картах', 'On Yandex Maps'));
  const noteList = el('dl', '', note);
  for (const [term, text] of [
    [tr('Цвет', 'Colour'), poster.encoding.color],
    [tr('Форма', 'Form'), poster.encoding.form],
    [tr('Скорость', 'Speed'), poster.encoding.speed],
  ]) {
    setText(el('dt', '', noteList), term);
    setText(el('dd', '', noteList), text);
  }
  const actions = el('div', 'note-actions', note);
  const tip = el('div', 'tip', app);
  const tipValue = el('strong', '', tip);
  const tipLabel = el('span', '', tip);

  const updateChrome = () => {
    const now = Date.now();
    const label = poster.label(now);
    setText(noteTitle, label.title);
    const spot = poster.where?.();
    map.hidden = !spot;
    if (spot && map.href !== mapLink(spot)) {
      map.href = mapLink(spot);
      mapImage.src = mapPreview(spot);
    }
    canvas.setAttribute('aria-label', `${poster.service}: ${label.title}. ${label.print}`);
    canvas.dataset.status = worstFeed(poster.feeds, now).status(now);
  };

  const reshuffle = () => {
    poster.shuffle();
    updateChrome();
  };
  button(`${tr('Случайно', 'Random')}: ${poster.kind}`, actions, reshuffle);
  link(tr('← Предыдущая', '← Previous'), workPath(previous), actions);
  link(tr('Следующая →', 'Next →'), workPath(next), actions);

  let tourTimer = 0;
  const tourButton = button(tr('Тур', 'Tour'), controls, () => toggleTour());
  button(tr('Весь экран', 'Fullscreen'), controls, () => void toggleFullscreen());
  langSwitch(controls);

  const startTour = () => {
    tourButton.setAttribute('aria-pressed', 'true');
    tourTimer = window.setTimeout(() => location.assign(`${workPath(next)}?tour`), TOUR_MS);
  };
  const toggleTour = () => {
    if (!tourTimer) return startTour();
    clearTimeout(tourTimer);
    tourTimer = 0;
    tourButton.setAttribute('aria-pressed', 'false');
  };

  const fit = () => {
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(devicePixelRatio || 1, MAX_DPR);
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
  };
  new ResizeObserver(fit).observe(canvas);

  const sheetPoint = (e: MouseEvent): [number, number] => {
    const rect = canvas.getBoundingClientRect();
    const k = SHEET_W / rect.width;
    return [(e.clientX - rect.left) * k, (e.clientY - rect.top) * k];
  };

  canvas.addEventListener('click', (e) => {
    const url = poster.open?.(...sheetPoint(e), Date.now());
    if (url) window.open(url, '_blank', 'noopener');
  });

  canvas.addEventListener('pointermove', (e) => {
    const [x, y] = sheetPoint(e);
    const found = poster.pick(x, y, Date.now());
    canvas.style.cursor = poster.open?.(x, y, Date.now()) ? 'pointer' : '';
    if (!found) return tip.classList.remove('open');
    setText(tipValue, found.value);
    setText(tipLabel, found.label);
    tip.classList.add('open');
    const left = Math.min(e.clientX + 14, innerWidth - tip.offsetWidth - 8);
    const top = Math.min(e.clientY + 14, innerHeight - tip.offsetHeight - 8);
    tip.style.transform = `translate(${left}px, ${top}px)`;
  });
  canvas.addEventListener('pointerleave', () => tip.classList.remove('open'));

  addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'Escape') location.assign('/');
    else if (e.key === 'ArrowRight') location.assign(workPath(next));
    else if (e.key === 'ArrowLeft') location.assign(workPath(previous));
    else if (e.key === 'a' || e.key === 'ф') toggleTour();
    else if (e.key === 'r' || e.key === 'к') reshuffle();
    else if (e.key === 'f' || e.key === 'а') void toggleFullscreen();
  });

  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  let lastDraw = 0;
  let lastPaint = 0;
  const paint = (t: number) => {
    requestAnimationFrame(paint);
    if (!canvas.width || (reducedMotion.matches && t - lastDraw < 1000)) return;
    lastDraw = t;
    const dt = Math.min(0.25, (t - lastPaint) / 1000);
    lastPaint = t;
    paintSheet(ctx, poster, Date.now(), dt);
  };

  void document.fonts.load('700 40px "Jost Variable"', 'Пульс');
  poster.start();
  updateChrome();
  setInterval(updateChrome, 1000);
  requestAnimationFrame(paint);
  if (new URLSearchParams(location.search).has('tour')) startTour();
}
