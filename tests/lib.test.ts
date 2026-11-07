import { directUrl } from '../src/routes';
import { describe, expect, it } from 'vitest';
import { fmtKickoff, fmtPrice, fmtSigned, fmtTemp, plural } from '../src/lib/format';
import { Feed, nextDelay, worstFeed } from '../src/lib/net';
import { glide, median, other, percentile, Rolling, sample } from '../src/lib/stats';
import { mixHex, nearest, tempPaper } from '../src/lib/theme';

describe('Rolling', () => {
  it('averages finished seconds and ignores the current one', () => {
    const r = new Rolling(10);
    r.add(4, 1000);
    r.add(2, 2000);
    r.add(100, 3000);
    expect(r.rate(2, 3500)).toBe(3);
  });

  it('forgets data older than one ring turn', () => {
    const r = new Rolling(10);
    r.add(5, 1000);
    expect(r.rate(5, 12_000)).toBe(0);
  });
});

describe('stats', () => {
  it('finds the median', () => {
    expect(median([])).toBeNull();
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });

  it('glides with a soft start and settles without overshoot', () => {
    const g = { x: 0, v: 0 };
    const steps: number[] = [];
    for (let i = 0; i < 600; i++) {
      const before = g.x;
      glide(g, 100, 1 / 60, 2);
      steps.push(g.x - before);
      expect(g.x).toBeLessThanOrEqual(100);
    }
    expect(steps[0]).toBeLessThan(Math.max(...steps) / 10);
    expect(g.x).toBeCloseTo(100, 0);
  });

  it('reads a percentile without being thrown by a single spike', () => {
    expect(percentile([], 0.9)).toBe(0);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 1000], 0.5)).toBe(6);
  });

  it('samples without repeats', () => {
    expect(new Set(sample([1, 2, 3, 4], 4, () => 0.5)).size).toBe(4);
  });

  it('always picks something different from the current choice', () => {
    for (let i = 0; i < 200; i++) expect(other([1, 2, 3], 2)).not.toBe(2);
  });
});

describe('theme', () => {
  it('mixes and finds the closest ink', () => {
    expect(mixHex('#000000', '#ffffff', 0.5)).toBe('#808080');
    expect(nearest('#ff0000', ['#0000ff', '#ee1111'])).toBe('#ee1111');
  });

  it('warms the paper with temperature and stays in range', () => {
    const red = (hex: string) => parseInt(hex.slice(1, 3), 16);
    expect(red(tempPaper(40))).toBeGreaterThan(red(tempPaper(-20)));
    expect(tempPaper(-60)).toBe(tempPaper(-25));
    expect(tempPaper(60)).toBe(tempPaper(42));
  });
});

describe('nextDelay', () => {
  it('keeps the normal interval while requests succeed', () => {
    expect(nextDelay(300_000, 0)).toBe(300_000);
  });

  it('retries soon after a failure and backs off up to the interval', () => {
    expect([1, 2, 3].map((n) => nextDelay(300_000, n))).toEqual([3000, 6000, 12_000]);
    expect(nextDelay(300_000, 20)).toBe(300_000);
    expect(nextDelay(10_000, 5)).toBe(10_000);
  });
});

describe('Feed', () => {
  it('moves from connecting to live to stale', () => {
    const feed = new Feed('x', 1000);
    expect(feed.status()).toBe('connecting');
    feed.ok();
    expect(feed.status(feed.lastAt + 500)).toBe('live');
    expect(feed.status(feed.lastAt + 1500)).toBe('stale');
  });

  it('reports the worst of several feeds', () => {
    const [a, b] = [new Feed('a', 1000), new Feed('b', 1000)];
    a.ok();
    b.fail();
    expect(worstFeed([a, b]).name).toBe('b');
  });
});

describe('format', () => {
  it('uses Russian plural forms', () => {
    const word = (n: number) => plural(n, 'борт', 'борта', 'бортов');
    expect([1, 3, 5, 11, 21, 112].map(word)).toEqual(['борт', 'борта', 'бортов', 'бортов', 'борт', 'бортов']);
  });

  it('adds a weekday only for other days', () => {
    const now = new Date(2026, 10, 5, 12).getTime();
    expect(fmtKickoff(new Date(2026, 10, 5, 20, 45).getTime(), now)).toBe('20:45');
    expect(fmtKickoff(new Date(2026, 10, 6, 3, 0).getTime(), now)).toMatch(/^пт,? 03:00$/);
  });

  it('keeps precision for cheap coins', () => {
    expect(fmtPrice(0.07171)).toBe('0,0717');
    expect(fmtPrice(693.1)).toBe('693,10');
  });

  it('prints a real minus sign', () => {
    expect(fmtTemp(-3.4)).toBe('−3°');
    expect(fmtSigned(-5.24)).toBe('−5,2');
    expect(fmtSigned(1)).toBe('+1,0');
  });
});

describe('direct routes', () => {
  it('sends /api addresses straight to the source', () => {
    expect(directUrl('/api/okx/api/v5/market/candles')).toBe('https://www.okx.com/api/v5/market/candles');
    expect(directUrl('/api/metno/weatherapi')).toBe('https://api.met.no/weatherapi');
  });

  it('leaves other addresses alone', () => {
    expect(directUrl('/cams.json')).toBe('/cams.json');
    expect(directUrl('https://example.com/api/okx/x')).toBe('https://example.com/api/okx/x');
  });
});
