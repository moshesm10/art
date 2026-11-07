import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { findWork, neighbours, newestFirst, previewPath, stageOf, WORKS, type Work } from '../src/works';
import stages from '../src/works-stages.json';

// Холст без браузера: любой метод отвечает, поэтому постер можно нарисовать в тесте
const canvas = () =>
  new Proxy({} as Record<string | symbol, unknown>, {
    get: (target, key) => (key in target ? target[key] : () => ({ width: 0 })),
    set: (target, key, value) => {
      target[key] = value;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;

describe('registry', () => {
  it('numbers works in a row without gaps', () => {
    expect(WORKS.map((w) => w.no)).toEqual(WORKS.map((_, i) => i + 1));
  });

  it('gives every work its own address', () => {
    expect(new Set(WORKS.map((w) => w.slug)).size).toBe(WORKS.length);
    for (const w of WORKS) {
      expect(w.slug).toMatch(/^[a-z0-9-]+$/);
      expect(findWork(`/work/${w.slug}/`)).toBe(w);
      expect(findWork(`/work/${w.slug}`)).toBe(w);
    }
    expect(findWork('/work/nothing/')).toBeUndefined();
    expect(findWork('/')).toBeUndefined();
  });

  it('puts the latest release first and keeps one day in number order', () => {
    const w = (no: number, date: string) => ({ no, date }) as Work;
    const order = newestFirst([w(1, '2026-11-05'), w(2, '2026-11-05'), w(3, '2026-11-07')]);
    expect(order.map((x) => x.no)).toEqual([3, 1, 2]);
  });

  it('treats an unknown work as an idea until the author decides', () => {
    const work = { slug: 'fresh' } as Work;
    expect(stageOf(work, {})).toBe('idea');
    expect(stageOf(work, { fresh: 'ready' })).toBe('ready');
    expect(stageOf(work, { fresh: 'nonsense' })).toBe('idea');
  });

  it('keeps stages only for works that exist', () => {
    for (const slug of Object.keys(stages)) expect(WORKS.some((w) => w.slug === slug)).toBe(true);
  });

  it('walks through all works in a circle', () => {
    const order = newestFirst();
    expect(neighbours(order[0]).previous).toBe(order.at(-1));
    expect(neighbours(order.at(-1)!).next).toBe(order[0]);
  });
});

describe.each(WORKS.map((w) => [`№ ${w.no} ${w.slug}`, w] as const))('%s', (_, work) => {
  it('explains itself', async () => {
    const poster = await work.load();
    expect(poster.service).toBe(work.title);
    expect(work.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(poster.source).toBeTruthy();
    expect(poster.kind).toBeTruthy();
    expect(poster.feeds.length).toBeGreaterThan(0);
    for (const text of Object.values(poster.encoding)) expect(text.length).toBeGreaterThan(20);
  });

  it('survives the first frame without data', async () => {
    const poster = await work.load();
    const now = Date.now();
    expect(poster.paper()).toBeTruthy();
    expect(poster.label(now).title).toBeTruthy();
    expect(() => poster.draw({ ctx: canvas(), now, dt: 0.016 })).not.toThrow();
    expect(poster.pick(50, 50, now)).toBeNull();
  });

  it('has a preview for the gallery', () => {
    expect(existsSync(`public${previewPath(work)}`)).toBe(true);
  });
});
