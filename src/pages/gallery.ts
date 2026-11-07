import { button, el, langSwitch, link, setText } from '../lib/dom';
import { fmtDay, word } from '../lib/format';
import { tr } from '../lib/i18n';
import { newestFirst, previewPath, stageOf, workPath, WORKS, type Stage, type Work } from '../works';

const SHELVES: { stage: Stage; title: string; move: string; to: Stage }[] = [
  { stage: 'ready', title: tr('Готовы к публикации', 'Ready to publish'), move: tr('Вернуть в идеи', 'Back to ideas'), to: 'idea' },
  { stage: 'idea', title: tr('Идеи', 'Ideas'), move: tr('Отметить готовой', 'Mark as ready'), to: 'ready' },
];

const go = (work: Work, query = '') => location.assign(workPath(work) + query);

async function moveWork(work: Work, stage: Stage, control: HTMLButtonElement): Promise<void> {
  control.disabled = true;
  const res = await fetch('/admin/stage', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ slug: work.slug, stage }),
  }).catch(() => null);
  if (res?.ok) return location.reload();
  control.disabled = false;
  setText(control, tr('Не сохранилось: нужен npm run dev', 'Not saved: npm run dev is needed'));
}

function card(work: Work, shelf: (typeof SHELVES)[number], parent: HTMLElement): void {
  const root = el('figure', 'card', parent);
  const frame = link('', workPath(work), root, 'frame');
  const image = el('img', '', frame);
  image.src = previewPath(work);
  image.alt = work.title;
  image.loading = 'lazy';
  const plate = el('figcaption', 'plate', root);
  setText(el('span', 'plate-title', plate), `${tr('№', 'No.')} ${work.no} · ${work.title}`);
  setText(el('span', 'plate-source', plate), fmtDay(work.date));
  if (!import.meta.env.DEV) return;
  const control = button(shelf.move, root, () => void moveWork(work, shelf.to, control));
}

export function openGallery(app: HTMLElement): void {
  document.title = tr('Пульс — мастерская', 'Pulse — studio');
  document.body.classList.add('studio');
  const order = newestFirst();

  const bar = el('header', 'bar', app);
  setText(el('h1', 'brand', bar), tr('Пульс', 'Pulse'));
  setText(el('span', 'brand-note', bar), tr('Мастерская', 'Studio'));
  const controls = el('nav', 'controls', bar);
  const surprise = () => go(WORKS[Math.floor(Math.random() * WORKS.length)]);
  const tour = () => go(order[0], '?tour');
  button(tr('Случайная работа', 'Random work'), controls, surprise);
  button(tr('Тур', 'Tour'), controls, tour);
  langSwitch(controls);

  const main = el('main', 'shelves', app);
  const shown: Work[] = [];
  for (const shelf of import.meta.env.DEV ? SHELVES : SHELVES.slice(0, 1)) {
    const works = order.filter((w) => stageOf(w) === shelf.stage);
    shown.push(...works);
    const section = el('section', '', main);
    const head = el('div', 'shelf-head', section);
    setText(el('h2', '', head), shelf.title);
    setText(el('span', 'shelf-count', head), `${works.length} ${word(works.length, ['работа', 'работы', 'работ'], ['work', 'works'])}`);
    if (!works.length) {
      setText(el('p', 'shelf-empty', section), tr('Пока пусто', 'Nothing yet'));
      continue;
    }
    const cards = el('div', 'shelf-cards', section);
    for (const work of works) card(work, shelf, cards);
  }

  addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const n = Number(e.key);
    if (n >= 1 && n <= shown.length) go(shown[n - 1]);
    else if (e.key === 'r' || e.key === 'к') surprise();
    else if (e.key === 'a' || e.key === 'ф') tour();
  });
}
