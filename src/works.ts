import { HOME } from './lib/dom';
import { tr } from './lib/i18n';
import type { Poster } from './lib/poster';
import stages from './works-stages.json';

export type Stage = 'ready' | 'idea';

export interface Work {
  no: number;
  slug: string;
  title: string;
  date: string;
  load: () => Promise<Poster>;
}

// Реестр выпусков: новая работа — одна запись. Код работы грузится только на её странице
const ALL_WORKS: Work[] = [
  { no: 1, slug: 'markets', title: tr('Рынки', 'Markets'), date: '2026-11-05', load: async () => new (await import('./channels/markets')).Markets() },
  { no: 2, slug: 'weather', title: tr('Погода', 'Weather'), date: '2026-11-05', load: async () => new (await import('./channels/weather')).Weather() },
  { no: 3, slug: 'sky', title: tr('Небо', 'Sky'), date: '2026-11-05', load: async () => new (await import('./channels/transport')).Transport() },
  { no: 4, slug: 'sports', title: tr('Спорт', 'Sport'), date: '2026-11-05', load: async () => new (await import('./channels/sports')).Sports() },
  { no: 5, slug: 'network', title: tr('Сеть', 'Network'), date: '2026-11-05', load: async () => new (await import('./channels/social')).Social() },
  { no: 6, slug: 'earth', title: tr('Земля', 'Earth'), date: '2026-11-05', load: async () => new (await import('./channels/sensors')).Sensors() },
  { no: 7, slug: 'relief', title: tr('Рельеф', 'Relief'), date: '2026-11-05', load: async () => new (await import('./channels/relief')).Relief() },
  { no: 8, slug: 'platform', title: tr('Последний поезд', 'Last Train'), date: '2026-11-06', load: async () => new (await import('./channels/platform')).Platform() },
  { no: 9, slug: 'glass', title: tr('Окно', 'Window'), date: '2026-11-06', load: async () => new (await import('./channels/glass')).Windows() },
  { no: 10, slug: 'chain', title: tr('Блокчейн', 'Blockchain'), date: '2026-11-06', load: async () => new (await import('./channels/chain')).Blocks() },
  { no: 11, slug: 'race', title: tr('Гонка', 'Race'), date: '2026-11-07', load: async () => new (await import('./channels/race')).Grand() },
];

// На опубликованный сайт попадают только готовые работы, идеи остаются в мастерской
export const WORKS = import.meta.env.PROD ? ALL_WORKS.filter((work) => stageOf(work) === 'ready') : ALL_WORKS;

// Новая работа начинает идеей, готовой её делает только решение автора
export function stageOf(work: Work, known: Record<string, string> = stages): Stage {
  return known[work.slug] === 'ready' ? 'ready' : 'idea';
}

export const workPath = (work: Work) => `${HOME}work/${work.slug}/`;
export const previewPath = (work: Work) => `${HOME}previews/${work.slug}.jpg`;

export function findWork(pathname: string, works = WORKS): Work | undefined {
  const slug = /^\/work\/([a-z0-9-]+)\/?$/.exec(pathname)?.[1];
  return works.find((w) => w.slug === slug);
}

// Свежий выпуск первым, работы одного дня идут по номеру
export function newestFirst(works = WORKS): Work[] {
  return [...works].sort((a, b) => b.date.localeCompare(a.date) || a.no - b.no);
}

export function neighbours(work: Work, works = WORKS): { previous: Work; next: Work } {
  const order = newestFirst(works);
  const i = order.indexOf(work);
  return { previous: order[(i - 1 + order.length) % order.length], next: order[(i + 1) % order.length] };
}
