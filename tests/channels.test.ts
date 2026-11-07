import { describe, expect, it } from 'vitest';
import { Charge, parseKoios, parseMempool, parseRpc, parseSolana, parseXrp } from '../src/channels/chain';
import { barsFromCandles, barsFromTrades, breath, breathRate, cellRadius, edgeFade, parseCoins, parseTicks, quoteOf, priceSpan, priceY, Tape, windows, type Bar, type Cell, type RawTrade } from '../src/channels/markets';
import { editRadius, LANGS, langColumn, parseEdit, parsePost, stack, traceX } from '../src/channels/social';
import { azimuthal, depthInk, parseQuakes, presence, quakeRadius } from '../src/channels/sensors';
import { gridFor, leadShare, leadSpan, matchProgress, parseScoreboard, rankMatches, teamInks, type Match } from '../src/channels/sports';
import { archPoint, bandOf, bearing, bearingFocus, meanBearing, parseAircraft, phaseOf, shortestTurn } from '../src/channels/transport';
import { airRings, aqiLabel, atHour, closeLoop, lineVisibility, parseWeather, precipFeel, rainLevel, riverPath, sunOrbit, sunTimes, type Hour } from '../src/channels/weather';
import { coverCrop, lightOf, parseCams as parseWindyCams, parseSlides, ribSource, worthShowing } from '../src/channels/glass';
import { flakeCount, moonPhase, parseAir, parseArrival, reach, skyAt, sunAltitude, trainColor, waitText } from '../src/channels/platform';
import { beamAt, buildScene, castShadows, dotAlpha, elevation, oblique, r2, terrain, tileOf } from '../src/channels/relief';
import { CITIES } from '../src/data/cities';
import { MOUNTAINS } from '../src/data/mountains';
import { word } from '../src/lib/format';
import { detect } from '../src/lib/i18n';
import { famous } from '../src/lib/stats';
import { distanceKm, mapLink, mapPreview, nearest, parseIp } from '../src/lib/locate';
import { ART } from '../src/lib/poster';

describe('markets', () => {
  const trade = (ts: number, px: number, sz: number, side: 'buy' | 'sell'): RawTrade => ({
    instId: 'BTC-USDT',
    tradeId: String(ts),
    px: String(px),
    sz: String(sz),
    side,
    ts: String(ts),
  });

  it('reads every trade of a message and keeps the taker side', () => {
    const raw = JSON.stringify({ arg: { channel: 'trades' }, data: [trade(5000, 100.5, 0.2, 'sell'), trade(5001, 101, 1, 'buy')] });
    expect(parseTicks(raw)).toEqual([
      { kind: 'trade', symbol: 'BTC-USDT', price: 100.5, qty: 0.2, time: 5000, sell: true },
      { kind: 'trade', symbol: 'BTC-USDT', price: 101, qty: 1, time: 5001, sell: false },
    ]);
  });

  it('reads the daily open from tickers', () => {
    const raw = JSON.stringify({ arg: { channel: 'tickers' }, data: [{ instId: 'BTC-USDT', open24h: '80', last: '76' }] });
    expect(parseTicks(raw)).toEqual([{ kind: 'mini', symbol: 'BTC-USDT', open: 80, close: 76 }]);
  });

  it('skips subscription acknowledgements', () => {
    expect(parseTicks(JSON.stringify({ event: 'subscribe', arg: { channel: 'trades' } }))).toEqual([]);
  });

  it('builds second bars from newest-first trades', () => {
    const bars = barsFromTrades([trade(3100, 12, 1, 'sell'), trade(2900, 11, 2, 'sell'), trade(2100, 10, 3, 'buy')]);
    expect(bars).toEqual([
      { t: 2, close: 11, buy: 3, sell: 2 },
      { t: 3, close: 12, buy: 0, sell: 1 },
    ]);
  });

  it('merges trades of one second and keeps live bars over history', () => {
    const tape = new Tape();
    tape.add(10, 1, 100_000, false);
    tape.add(11, 2, 100_500, true);
    tape.seed([
      { t: 99, close: 9, buy: 0, sell: 0 },
      { t: 100, close: 8, buy: 0, sell: 0 },
    ]);
    expect(tape.bars).toEqual([
      { t: 99, close: 9, buy: 0, sell: 0 },
      { t: 100, close: 11, buy: 1, sell: 2 },
    ]);
  });

  it('reads newest-first candles and estimates the side from the move', () => {
    const row = (ts: number, open: number, close: number, volume: number) => [ts, open, 0, 0, close, volume, 0, 0, 1].map(String);
    expect(barsFromCandles([row(3000, 5, 5, 4), row(2000, 6, 5, 2), row(1000, 5, 6, 3)])).toEqual([
      { t: 1, close: 6, buy: 3, sell: 0 },
      { t: 2, close: 5, buy: 0, sell: 2 },
      { t: 3, close: 5, buy: 2, sell: 2 },
    ]);
  });

  it('lets real trades replace candle estimates, but never live seconds', () => {
    const tape = new Tape();
    tape.seed([
      { t: 98, close: 1, buy: 1, sell: 0 },
      { t: 99, close: 1, buy: 1, sell: 0 },
    ]);
    tape.add(5, 1, 100_000, false);
    tape.seed([
      { t: 99, close: 2, buy: 0, sell: 7 },
      { t: 100, close: 9, buy: 0, sell: 9 },
    ]);
    expect(tape.bars).toEqual([
      { t: 98, close: 1, buy: 1, sell: 0 },
      { t: 99, close: 2, buy: 0, sell: 7 },
      { t: 100, close: 5, buy: 1, sell: 0 },
    ]);
  });

  const bar = (t: number, close: number, buy = 1, sell = 1): Bar => ({ t, close, buy, sell });

  it('groups seconds into ten-second windows in time order', () => {
    const cells = windows([bar(1000, 5), bar(1004, 7, 2, 0), bar(1010, 6)], 1012);
    expect(cells).toEqual([
      { slot: 100, buy: 3, sell: 1, open: 5, close: 7 },
      { slot: 101, buy: 1, sell: 1, open: 6, close: 6 },
    ]);
  });

  it('drops windows older than five minutes', () => {
    expect(windows([bar(1000, 5)], 1300)).toHaveLength(0);
  });

  const cell = (open: number, close: number): Cell => ({ slot: 1, buy: 1, sell: 1, open, close });

  it('puts the highest price at the top of the sheet', () => {
    const span = priceSpan([cell(100, 90), cell(90, 110)]);
    expect(priceY(110, span)).toBeLessThan(priceY(90, span));
    expect(priceY(110, span)).toBeGreaterThanOrEqual(ART.y);
    expect(priceY(90, span)).toBeLessThanOrEqual(ART.y + ART.h);
  });

  it('does not stretch a quiet market into a crash', () => {
    const span = priceSpan([cell(100_000, 100_000), cell(100_000, 100_001)]);
    expect(span.hi - span.lo).toBeCloseTo(100, 0);
    const drop = priceY(100_000, span) - priceY(100_001, span);
    expect(drop).toBeLessThan(ART.h * 0.02);
  });

  it('breathes within ten percent at a calm pace', () => {
    for (let phase = 0; phase < 7; phase += 0.1) {
      expect(breath(phase, 3)).toBeGreaterThanOrEqual(0.9);
      expect(breath(phase, 3)).toBeLessThanOrEqual(1.1);
    }
    expect(breath(1, 1)).not.toBe(breath(1, 2));
    expect(breathRate(0)).toBeCloseTo(0.6);
    expect(breathRate(500)).toBeCloseTo(1.8);
  });

  it('fades a window in exactly as it fades out', () => {
    expect(edgeFade(0)).toBe(0);
    expect(edgeFade(30)).toBe(0);
    expect(edgeFade(15)).toBe(1);
    expect(edgeFade(2.5)).toBeCloseTo(0.5);
    for (const cells of [0.5, 1, 2, 3, 4]) expect(edgeFade(cells)).toBeCloseTo(edgeFade(30 - cells));
  });

  it('makes disc area proportional to volume', () => {
    expect(cellRadius(100, 100) ** 2 / cellRadius(25, 100) ** 2).toBeCloseTo(4);
    expect(cellRadius(0, 100)).toBeGreaterThan(0);
  });
});

describe('weather', () => {
  const step = (time: string, mm?: number) => ({
    time,
    data: {
      instant: { details: { air_temperature: 3, wind_speed: 5, cloud_area_fraction: 50 } },
      next_1_hours: { details: { precipitation_amount: mm } },
    },
  });
  const city = { name: 'A', en: 'A', lat: 55.75, lon: 37.62, tz: 'Europe/Moscow' };
  const met = { properties: { timeseries: [step('2026-11-05T18:00:00Z', 1), step('2026-11-05T19:00:00Z')] } };

  it('reads the hourly forecast in km/h and tolerates gaps', () => {
    const t = Date.parse('2026-11-05T18:00:00Z');
    const f = parseWeather(city, met, { hourly: { time: [t / 1000], us_aqi: [40] } });
    expect(f).toMatchObject({ name: 'A', tz: 'Europe/Moscow' });
    expect(f.hours[0]).toEqual({ t, temp: 3, rain: 50, mm: 1, wind: 18, cloud: 50, aqi: 40 });
    expect(f.hours[1]).toMatchObject({ rain: 0, mm: 0, aqi: null });
    expect(parseWeather(city, met, null).hours[0].aqi).toBeNull();
  });

  it('skips the tail of the forecast without hourly precipitation and takes one day', () => {
    const hours = Array.from({ length: 30 }, (_, i) => step(new Date(Date.UTC(2026, 10, 5, i)).toISOString(), 0));
    const tail = { time: '2026-11-08T00:00:00Z', data: { instant: hours[0].data.instant } };
    const f = parseWeather(city, { properties: { timeseries: [...hours, tail] } }, null);
    expect(f.hours).toHaveLength(24);
  });

  it('puts 1 mm per hour in the middle of the rain scale', () => {
    expect(rainLevel(0)).toBe(0);
    expect(rainLevel(1)).toBe(50);
    expect(rainLevel(4)).toBe(100);
    expect(rainLevel(30)).toBe(100);
  });

  it('computes sunrise and sunset within minutes of published values', () => {
    const { sunrise, sunset } = sunTimes(55.75, 37.62, 1_793_956_380_000);
    expect(Math.abs(sunrise / 1000 - 1_793_940_369)).toBeLessThan(180);
    expect(Math.abs(sunset / 1000 - 1_793_972_391)).toBeLessThan(180);
  });

  it('stays defined during polar night and polar day', () => {
    const winter = Date.UTC(2026, 11, 21, 12);
    const night = sunTimes(78.2, 15.6, winter);
    const day = sunTimes(-78.2, 15.6, winter);
    expect(night.sunset).toBeGreaterThan(night.sunrise);
    expect(day.sunset - day.sunrise).toBeGreaterThan(23 * 3_600_000);
    expect(Number.isFinite(sunOrbit(winter, night.sunrise, night.sunset).height)).toBe(true);
  });

  it('labels AQI bands', () => {
    expect(aqiLabel(50)).toBe('воздух чистый');
    expect(aqiLabel(51)).toBe('воздух умеренный');
    expect(aqiLabel(200)).toBe('воздух вредный');
  });

  const hour = (temp: number, t = 0): Hour => ({ t, temp, rain: temp, mm: 0, wind: 0, cloud: 0, aqi: null });

  it('blends neighbouring hours', () => {
    const hours = [hour(0), hour(10), hour(20)];
    expect(atHour(hours, 1).temp).toBe(10);
    expect(atHour(hours, 1.5).temp).toBe(15);
    expect(atHour(hours, 1.5).t).toBe(5_400_000);
  });

  it('closes the loop from the last hour back into the first', () => {
    const hours = [hour(0), hour(10), hour(20)];
    expect(atHour(hours, 2.5).temp).toBe(10);
    expect(atHour(hours, 2.999).temp).toBeCloseTo(0, 1);
  });

  it('keeps a known air value when a neighbour is missing', () => {
    const hours = [{ ...hour(0), aqi: 40 }, hour(0)];
    expect(atHour(hours, 0.5).aqi).toBe(40);
  });

  const [rise, set] = [6 * 3_600_000, 18 * 3_600_000];

  it('places the sun by the time of day and repeats every day', () => {
    expect(sunOrbit(12 * 3_600_000, rise, set).height).toBeCloseTo(1);
    expect(sunOrbit(rise, rise, set).height).toBeCloseTo(0);
    expect(sunOrbit(24 * 3_600_000, rise, set).height).toBeCloseTo(-1);
    expect(sunOrbit(0, rise, set).height).toBeCloseTo(-1);
    expect(sunOrbit(36 * 3_600_000, rise, set).height).toBeCloseTo(1);
  });

  it('crosses the sky by day and returns by night without a jump', () => {
    expect(sunOrbit(12 * 3_600_000, rise, set).across).toBeCloseTo(0.5);
    expect(sunOrbit(set - 1, rise, set).across).toBeCloseTo(1, 4);
    expect(sunOrbit(set + 1, rise, set).across).toBeCloseTo(1, 4);
    expect(sunOrbit(rise - 1, rise, set).across).toBeCloseTo(0, 4);
  });

  const day = Array.from({ length: 144 }, (_, i) => 10 + 8 * Math.sin((i / 144) * Math.PI * 2));

  it('puts warm hours to the right and closes the day into a loop', () => {
    const { path } = riverPath(day);
    expect(path[35].x).toBeGreaterThan(path[107].x);
    expect(Math.abs(path[0].x - path[143].x)).toBeLessThan(2);
  });

  it('gives every hour the same height', () => {
    const { path, period } = riverPath(day);
    expect(period).toBe(ART.h);
    expect(path[1].y - path[0].y).toBeCloseTo(path[100].y - path[99].y);
    expect(path.at(-1)!.y).toBeCloseTo(ART.h);
  });

  it('uses one scale for all cities, so a flat day stays flat', () => {
    const swing = (temps: number[]) => {
      const xs = riverPath(temps).path.map((p) => p.x);
      return Math.max(...xs) - Math.min(...xs);
    };
    expect(swing(day.map((t) => t / 8))).toBeCloseTo(swing(day.map((t) => t / 2)) / 4);
  });

  it('brings the last hours back to the start and leaves the rest of the day alone', () => {
    const closed = closeLoop([5, 6, 7, 8, 9, 10, 11, 12, 13, 14], 4);
    expect(closed.at(-1)).toBeCloseTo(5);
    expect(closed.slice(0, 6)).toEqual([5, 6, 7, 8, 9, 10]);
  });

  it('keeps an extreme day on the sheet', () => {
    const xs = riverPath(day.map((t) => t * 5)).path.map((p) => p.x);
    expect(Math.max(...xs) - Math.min(...xs)).toBeLessThanOrEqual(56.001);
  });

  it('adds air rings only above clean air', () => {
    expect(airRings(null)).toBe(0);
    expect(airRings(40)).toBe(0);
    expect(airRings(100)).toBe(1);
    expect(airRings(150)).toBe(2);
    expect(airRings(900)).toBe(5);
  });

  it('keeps low chances of rain sparse', () => {
    expect(precipFeel(10, 0).share).toBeLessThan(0.02);
    expect(precipFeel(50, 0).share).toBe(0.25);
    expect(precipFeel(100, 0).share).toBe(1);
  });

  it('stays slow up to 50% whatever the amount', () => {
    expect(precipFeel(50, 0).speed).toBe(13);
    expect(precipFeel(50, 6).speed).toBe(13);
    expect(precipFeel(20, 6).speed).toBeLessThan(13);
    expect(precipFeel(50, 6).length).toBe(precipFeel(50, 0).length);
  });

  it('speeds up only past 50% and more with heavier rain', () => {
    expect(precipFeel(75, 0).speed).toBeGreaterThan(precipFeel(50, 0).speed * 2);
    expect(precipFeel(100, 0).speed).toBeGreaterThan(precipFeel(75, 0).speed);
    expect(precipFeel(100, 5).speed).toBeGreaterThan(precipFeel(100, 0).speed);
    expect(precipFeel(100, 0).length).toBeGreaterThan(precipFeel(40, 0).length);
  });

  it('adds outer lines as the wind grows', () => {
    const visible = (wind: number) => [0, 1, 2, 3, 4, 5, 6, 7].reduce((sum, k) => sum + lineVisibility(k, wind), 0);
    expect(visible(0)).toBeCloseTo(3);
    expect(visible(40)).toBe(8);
    expect(visible(10)).toBeGreaterThan(visible(2));
    expect(lineVisibility(0, 0)).toBe(0);
    expect(lineVisibility(3, 0)).toBe(1);
  });
});

describe('transport', () => {
  it('tells a one-sided flow from an even ring', () => {
    expect(bearingFocus([10, 10, 10])).toBeCloseTo(1);
    expect(bearingFocus([0, 90, 180, 270])).toBeCloseTo(0);
    expect(bearingFocus([])).toBe(0);
  });

  it('drops aircraft on the ground or without position', () => {
    const planes = parseAircraft({
      ac: [
        { hex: 'a', flight: 'DLH1  ', lat: 50, lon: 8, alt_baro: 10000, gs: 400, track: 90, baro_rate: -640 },
        { hex: 'b', lat: 50, lon: 8, alt_baro: 'ground' },
        { hex: 'c', alt_baro: 10000 },
      ],
    });
    expect(planes.map((p) => p.flight)).toEqual(['DLH1']);
    expect(planes[0].altM).toBeCloseTo(3048);
    expect(planes[0].climbFpm).toBe(-640);
  });

  it('takes bearing clockwise from north', () => {
    const center = { lat: 0, lon: 0 };
    expect(bearing(1, 0, center)).toBeCloseTo(0);
    expect(bearing(0, 1, center)).toBeCloseTo(90);
    expect(bearing(-1, 0, center)).toBeCloseTo(180);
  });

  it('averages bearings around north', () => {
    const mean = meanBearing([350, 10])!;
    expect(Math.min(mean, 360 - mean)).toBeCloseTo(0);
    expect(meanBearing([])).toBeNull();
  });

  it('turns along the shortest arc even after many laps', () => {
    expect(shortestTurn(350, 10)).toBeCloseTo(20);
    expect(shortestTurn(10, 350)).toBeCloseTo(-20);
    expect(shortestTurn(90, 120)).toBeCloseTo(30);
    expect(shortestTurn(725, 10)).toBeCloseTo(5);
    expect(shortestTurn(-350, 350)).toBeCloseTo(-20);
  });

  it('sorts altitude into ten bands and splits flight phases', () => {
    expect(bandOf(0)).toBe(0);
    expect(bandOf(11_000)).toBe(8);
    expect(bandOf(20_000)).toBe(9);
    expect([phaseOf(1200), phaseOf(100), phaseOf(-900)]).toEqual(['climb', 'level', 'descent']);
  });

  it('walks the arch from left foot over the top to the right foot', () => {
    const [left, top, right] = [archPoint(10, 0), archPoint(10, 0.5), archPoint(10, 1)];
    expect(left.x).toBeCloseTo(40);
    expect(right.x).toBeCloseTo(60);
    expect(top.x).toBeCloseTo(50);
    expect(top.y).toBeLessThan(left.y);
    expect(left.y).toBeCloseTo(right.y);
  });
});

describe('sports', () => {
  const event = (state: 'pre' | 'in' | 'post') => ({
    id: '1',
    date: '2026-11-05T20:00Z',
    status: { displayClock: "67'", clock: 4020, period: 2, type: { state, shortDetail: "67'" } },
    competitions: [
      {
        competitors: [
          { homeAway: 'away', score: '1', team: { shortDisplayName: 'Away', color: '0606fa' } },
          { homeAway: 'home', score: '2', team: { shortDisplayName: 'Home', color: 'e30000' } },
        ],
      },
    ],
  });

  it('reads home and away regardless of array order', () => {
    const [m] = parseScoreboard({ events: [event('in')] }, 'soccer/eng.1', 'АПЛ');
    expect(m).toMatchObject({ home: 'Home', away: 'Away', homeScore: 2, awayScore: 1, league: 'АПЛ' });
    expect(m.progress).toBeCloseTo(67 / 90);
  });

  it('computes progress per sport', () => {
    const type = { state: 'in' as const, shortDetail: '' };
    expect(matchProgress('basketball/nba', { clock: 360, period: 3, type })).toBeCloseTo(0.625);
    expect(matchProgress('hockey/nhl', { clock: 0, period: 3, type })).toBeCloseTo(1);
  });

  it('ranks live, then upcoming, then latest finished', () => {
    const m = (id: string, state: Match['state'], start: number) => ({ id, state, start }) as Match;
    const ranked = rankMatches([m('old', 'post', 1), m('late', 'pre', 9), m('new', 'post', 2), m('soon', 'pre', 5), m('now', 'in', 3)]);
    expect(ranked.map((x) => x.id)).toEqual(['now', 'soon', 'late', 'new', 'old']);
  });

  it('maps club colours to poster inks and separates clashes', () => {
    const [red, blue] = teamInks('e30000', '0606fa');
    expect(red).toBe('#e8624e');
    expect(blue).toBe('#2b7ea8');
    const [a, b] = teamInks('e30000', 'dd0000');
    expect(a).not.toBe(b);
    expect(teamInks(undefined, undefined)[0]).toBe('#1f1e1c');
  });

  it('builds a grid that holds every match inside the art area', () => {
    for (const n of [1, 2, 5, 10, 13, 16, 20]) {
      const { cols, rows, side } = gridFor(n);
      expect(cols * rows).toBeGreaterThanOrEqual(n);
      expect(cols * side).toBeLessThanOrEqual(ART.w + 0.001);
      expect(rows * side).toBeLessThanOrEqual(ART.h + 0.001);
    }
  });
});

describe('lead', () => {
  it('tells a narrow win from a rout', () => {
    const share = (homeScore: number, awayScore: number) => leadShare({ homeScore, awayScore, span: 3 });
    expect(Math.abs(share(1, 0))).toBeLessThan(Math.abs(share(7, 0)));
    expect(share(0, 1)).toBeGreaterThan(0);
    expect(share(3, 2)).toBeCloseTo(share(1, 0));
    expect(share(9, 0)).toBe(-1);
  });

  it('weighs a lead by sport', () => {
    expect(leadSpan('basketball/nba')).toBeGreaterThan(leadSpan('soccer/eng.1'));
    expect(leadSpan('hockey/nhl')).toBe(3);
  });
});

describe('social', () => {
  it('normalises language tags into fixed columns', () => {
    expect(LANGS[langColumn(['pt-BR'])]).toBe('pt');
    expect(LANGS[langColumn(['RU'])]).toBe('ru');
    expect(LANGS[langColumn(['ko'])]).toBe('другие');
    expect(LANGS[langColumn(undefined)]).toBe('другие');
  });

  it('counts only created posts', () => {
    const post = (operation: string) =>
      JSON.stringify({ kind: 'commit', commit: { operation, record: { langs: ['en'], text: 'x' } } });
    expect(parsePost(post('create'))).toBe(0);
    expect(parsePost(post('delete'))).toBeNull();
    expect(parsePost(JSON.stringify({ kind: 'identity' }))).toBeNull();
  });

  it('takes only Wikipedia edits and reads their language', () => {
    const event = (type: string, server_name: string) => JSON.stringify({ type, server_name, length: { old: 500, new: 380 } });
    expect(parseEdit(event('edit', 'ru.wikipedia.org'))).toEqual({ lang: 'ru', bytes: -120 });
    expect(parseEdit(event('log', 'ru.wikipedia.org'))).toBeNull();
    expect(parseEdit(event('edit', 'www.wikidata.org'))).toBeNull();
    expect(parseEdit(event('edit', 'commons.wikimedia.org'))).toBeNull();
  });

  it('survives edits without a length', () => {
    expect(parseEdit(JSON.stringify({ type: 'edit', server_name: 'de.wikipedia.org' }))).toEqual({ lang: 'de', bytes: 0 });
  });

  it('gives every language a height equal to its share and fills the sheet', () => {
    const weights = [40, 15, 10, 10, 5, 5, 5, 10];
    const bands = stack(weights, ART.y, ART.h);
    bands.forEach((b, i) => expect(b.h).toBeCloseTo(weights[i]));
    bands.slice(1).forEach((b, i) => expect(b.y).toBeCloseTo(bands[i].y + bands[i].h));
    expect(bands.at(-1)!.y + bands.at(-1)!.h).toBeCloseTo(ART.y + ART.h);
  });

  it('runs time from the right edge to the left', () => {
    expect(traceX(0)).toBe(ART.x + ART.w);
    expect(traceX(20_000)).toBe(ART.x);
  });

  it('grows edit marks with bytes, whichever the sign', () => {
    expect(editRadius(5000)).toBeGreaterThan(editRadius(50));
    expect(editRadius(-5000)).toBe(editRadius(5000));
    expect(editRadius(10_000_000)).toBe(5);
  });
});

describe('glass', () => {
  it('crops a wide frame to the middle of the sheet with a slight zoom', () => {
    const crop = coverCrop(1920, 1080);
    expect(crop.w).toBeCloseTo(907.2 / 1.2);
    expect(crop.h).toBeCloseTo(1080 / 1.2);
    expect(crop.x + crop.w / 2).toBeCloseTo(960);
    expect(crop.y + crop.h / 2).toBeCloseTo(540);
  });

  it('keeps every rib strip inside the frame', () => {
    for (let i = 0; i < 30; i++) {
      const { from, span } = ribSource(i, 30, 3, 420);
      expect(from).toBeGreaterThanOrEqual(0);
      expect(from + span).toBeLessThanOrEqual(420.001);
    }
  });
});

describe('platform', () => {
  const row = (over: object) => ({ stationShortCode: 'KJÄ', type: 'ARRIVAL', cancelled: false, scheduledTime: '2026-11-06T06:50:00.000Z', ...over });
  const train = (over: object, rows: object[]) => ({ trainType: 'PYO', trainNumber: 265, trainCategory: 'Long-distance', cancelled: false, timeTableRows: rows, ...over });
  const now = Date.parse('2026-11-06T06:00:00.000Z');

  it('takes the next passenger train and its live estimate', () => {
    const json = [
      train({ trainType: 'VET', trainNumber: 11537, trainCategory: 'Locomotive' }, [row({})]),
      train({}, [row({ type: 'DEPARTURE' }), row({ stationShortCode: 'ROI' }), row({ liveEstimateTime: '2026-11-06T07:05:00.000Z' })]),
    ];
    const arrival = parseArrival(json as never, 'KJÄ', now)!;
    expect(arrival.name).toBe('PYO 265');
    expect(arrival.late).toBe(15);
  });

  it('skips arrived and cancelled trains', () => {
    const json = [
      train({}, [row({ actualTime: '2026-11-06T05:50:00.000Z' })]),
      train({ cancelled: true }, [row({})]),
      train({}, [row({ cancelled: true })]),
      train({}, [row({ scheduledTime: '2026-11-06T05:00:00.000Z' })]),
    ];
    expect(parseArrival(json as never, 'KJÄ', now)).toBeNull();
  });

  const hour = (temp: number, mm: number | null) => ({
    data: {
      instant: { details: { air_temperature: temp, wind_speed: 4, wind_from_direction: 90 } },
      ...(mm === null ? {} : { next_1_hours: { details: { precipitation_amount: mm } } }),
    },
  });

  it('counts only snow in frost and blows it with the wind', () => {
    const air = parseAir({ properties: { timeseries: [hour(-5, 0), hour(-3, 0.4), hour(4, 3), hour(-2, null)] } });
    expect(air.snow).toBe(0.4);
    expect(air.temp).toBe(-5);
    expect(air.drift).toBeCloseTo(-4);
    const later = { data: { instant: hour(-4, null).data.instant, next_6_hours: { details: { precipitation_amount: 3 } } } };
    expect(parseAir({ properties: { timeseries: [hour(-5, 0), later] } }).snow).toBe(0.5);
  });

  it('squeezes far hours and spends half the way on the last one', () => {
    expect(reach(3_600_000)).toBe(0.5);
    expect(reach(12 * 3_600_000)).toBeLessThan(0.1);
    expect(reach(-1000)).toBe(1);
  });

  it('has no flakes without snow', () => {
    expect(flakeCount(0)).toBe(0);
    expect(flakeCount(2)).toBe(flakeCount(9));
  });

  it('writes the wait in words', () => {
    expect(waitText(3 * 3_600_000 + 12 * 60_000)).toBe('3 часа 12 минут');
    expect(waitText(60 * 60_000)).toBe('1 час');
    expect(waitText(1000)).toBe('1 минуту');
  });

  it('finds the height of the sun', () => {
    const noon = Date.parse('2026-06-21T12:00:00Z');
    expect(sunAltitude(23.4, 0, noon)).toBeGreaterThan(85);
    expect(sunAltitude(23.4, 0, noon + 12 * 3_600_000)).toBeLessThan(-40);
    expect(sunAltitude(66.7, 27.4, Date.parse('2026-12-21T00:00:00Z'))).toBeLessThan(-30);
  });

  it('changes the sky with the sun', () => {
    expect(skyAt(-40)).toEqual(skyAt(-18));
    expect(skyAt(40)).toEqual(skyAt(10));
    expect(skyAt(-4).bottom).not.toBe(skyAt(-18).bottom);
  });

  it('knows the moon', () => {
    expect(moonPhase(947_182_440_000)).toBeCloseTo(0);
    expect(moonPhase(947_182_440_000 + 14.765294 * 86_400_000)).toBeCloseTo(0.5);
  });

  it('reddens a late train', () => {
    expect(trainColor(0)).toBe(trainColor(-5));
    expect(trainColor(60)).toBe(trainColor(30));
    expect(trainColor(30)).not.toBe(trainColor(0));
  });
});

describe('relief', () => {
  it('decodes height from a tile pixel', () => {
    expect(elevation(128, 0, 0)).toBe(0);
    expect(elevation(162, 144, 0)).toBe(8848);
  });

  it('finds the tile of a place', () => {
    expect(tileOf(0, 0, 1).x).toBeCloseTo(1);
    expect(tileOf(0, 0, 1).y).toBeCloseTo(1);
    expect(Math.floor(tileOf(35.36, 138.73, 8).x)).toBe(226);
  });

  it('spreads any first part of the points evenly', () => {
    const quarters = [0, 0, 0, 0];
    for (let n = 0; n < 1000; n++) {
      const { u, v } = r2(n);
      quarters[(u < 0.5 ? 0 : 1) + (v < 0.5 ? 0 : 2)]++;
    }
    for (const count of quarters) expect(Math.abs(count - 250)).toBeLessThan(12);
  });

  it('lights points softly in rank order', () => {
    expect(dotAlpha(0.5, 0.2)).toBe(1);
    expect(dotAlpha(0.5, 0.9)).toBe(0);
    expect(dotAlpha(0.5, 0.48)).toBeGreaterThan(0);
    expect(dotAlpha(0.5, 0.48)).toBeLessThan(1);
  });

  it('turns the beam around without a jump', () => {
    expect(Math.abs(beamAt(6500) - beamAt(6600))).toBeLessThan(0.01);
    expect(beamAt(6500)).toBeGreaterThan(1);
    expect(beamAt(6500) - beamAt(5000)).toBeGreaterThan(0.05);
  });

  const hill = () => {
    const size = 64;
    const pixels = new Uint8ClampedArray(size * size * 4);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const height = Math.max(0, 2000 - Math.hypot(x - 32, y - 32) * 90);
        pixels[(y * size + x) * 4] = Math.floor((height + 32768) / 256);
        pixels[(y * size + x) * 4 + 1] = Math.floor(height + 32768) % 256;
      }
    }
    return terrain(pixels, size);
  };

  it('reads the range of a terrain', () => {
    const t = hill();
    expect(t.lo).toBe(0);
    expect(t.hi).toBeGreaterThan(1800);
  });

  it('keeps heights and distances in one scale from the air', () => {
    const t = hill();
    const project = oblique(t, 84, 90);
    expect(project(0.5, 0.5, t.lo).y).toBeCloseTo(58);
    const side = oblique(t, 84, 60);
    expect(side(0.5, 0.5, t.lo).y - side(0.5, 0.5, t.lo + 1000).y).toBeCloseTo(0.5);
  });

  it('places every point once', () => {
    const t = hill();
    const scene = buildScene(t, 2000, oblique(t, 20, 60));
    expect(scene.count).toBe(2000);
    expect(scene.rank[1999]).toBeLessThan(1);
  });

  it('casts a shadow away from the sun', () => {
    const [w, h] = [40, 40];
    const heights = new Float32Array(w * h);
    heights[20 * w + 20] = 2;
    const out = new Float32Array(w * h);
    castShadows(heights, w, h, 1, 1, 0, 0.3, out);
    expect(out[20 * w + 15]).toBe(1);
    expect(out[20 * w + 25]).toBe(0);
    expect(out[5 * w + 15]).toBe(0);
  });
});

describe('sensors', () => {
  it('skips quakes without magnitude and sorts by time', () => {
    const f = (id: string, mag: number | null, time: number) => ({
      id,
      properties: { mag, place: 'X', time },
      geometry: { coordinates: [1, 2, 3] as [number, number, number] },
    });
    const quakes = parseQuakes({ features: [f('b', 2, 20), f('none', null, 15), f('a', 1, 10)] });
    expect(quakes.map((q) => q.id)).toEqual(['a', 'b']);
  });

  it('grows with magnitude and never draws below the minimum mark', () => {
    expect(quakeRadius(0.5)).toBe(0.55);
    expect(quakeRadius(6)).toBeGreaterThan(quakeRadius(4));
  });

  it('waits as a ghost, flares at the moment of the quake and settles', () => {
    expect(presence(-1)).toBeLessThan(presence(1e10));
    expect(presence(0)).toBe(1);
    expect(presence(86_400_000)).toBeLessThan(1);
    expect(presence(1e10)).toBe(0.5);
  });

  it('colours by depth band', () => {
    expect(new Set([depthInk(10), depthInk(150), depthInk(500)]).size).toBe(3);
  });

  it('measures true distance and direction from the station', () => {
    const north = azimuthal(1, 0, { lat: 0, lon: 0 });
    expect(north.km).toBeCloseTo(111.2, 0);
    expect(north.bearing).toBeCloseTo(0);
    expect(azimuthal(0, 1, { lat: 0, lon: 0 }).bearing).toBeCloseTo(Math.PI / 2);
    expect(azimuthal(0, 180, { lat: 0, lon: 0 }).km).toBeCloseTo(20015, -1);
  });
});

describe('Стекло на камерах Windy', () => {
  const raw = (over = {}) => ({
    webcamId: 1245318606,
    title: 'Phuket › North: Karon Beach',
    status: 'active',
    location: { city: 'Phuket', region: 'Phuket Province', country: 'Thailand', latitude: 7.83, longitude: 98.29 },
    player: { day: 'https://webcams.windy.com/webcams/public/embed/player/1245318606/day' },
    urls: { detail: 'https://windy.com/webcams/1245318606' },
    ...over,
  });

  it('keeps active cameras with a day timelapse', () => {
    const cams = parseWindyCams({ webcams: [raw(), raw({ status: 'inactive' }), raw({ player: {} })] });
    expect(cams).toHaveLength(1);
    expect(cams[0]).toMatchObject({ id: 1245318606, name: 'Phuket', place: 'Thailand', lat: 7.83, lon: 98.29 });
    expect(parseWindyCams({})).toEqual([]);
  });

  it('names a camera without a city by its region or title', () => {
    const place = (city: string, region: string) => ({ location: { city, region, country: 'Canada', latitude: 60, longitude: -135 } });
    expect(parseWindyCams({ webcams: [raw(place('unknown', 'Yukon'))] })[0].name).toBe('Yukon');
    expect(parseWindyCams({ webcams: [raw(place('unknown', ''))] })[0].name).toBe('Phuket');
  });

  it('reads normal frames from the player page in order', () => {
    const url = (size: string, t: number) => `https://imgproxy.windy.com/_/${size}/plain/day/1245318606/original/${t}.jpg`;
    const html = `slides: { preview: ['${url('preview', 1)}'], normal: ['${url('normal', 1)}','${url('normal', 2)}','${url('normal', 2)}'] }`;
    expect(parseSlides(html)).toEqual([url('normal', 1), url('normal', 2)]);
    expect(parseSlides('<html></html>')).toEqual([]);
  });

  it('skips cameras that are frozen, black or too short', () => {
    const day = Array.from({ length: 24 }, (_, i) => 0.1 + i * 0.02);
    expect(worthShowing(day)).toBe(true);
    expect(worthShowing(day.map(() => 0.5))).toBe(false);
    expect(worthShowing(day.map((v) => v / 10))).toBe(false);
    expect(worthShowing(day.slice(0, 5))).toBe(false);
  });

  it('measures light from black to white', () => {
    expect(lightOf(new Uint8ClampedArray([0, 0, 0, 255]))).toBe(0);
    expect(lightOf(new Uint8ClampedArray([255, 255, 255, 255]))).toBeCloseTo(1);
  });
});

describe('Много мест', () => {
  it('favours the head of the list but reaches its tail', () => {
    const pool = Array.from({ length: 100 }, (_, i) => i);
    expect(famous(pool, undefined, () => 0)).toBe(0);
    expect(famous(pool, 0, () => 0)).toBe(1);
    expect(famous(pool, undefined, () => 0.5)).toBe(12);
    expect(famous(pool, undefined, () => 0.999)).toBe(99);
  });

  it('puts the most traded coin first', () => {
    const row = (instId: string, volCcy24h: string) => ({ instId, volCcy24h });
    expect(parseCoins([row('SOL-USDT', '2000000'), row('BTC-USDT', '9000000')])).toEqual(['BTC', 'SOL']);
  });

  it('lists USDT among the popular coins and prices it in dollars', () => {
    const row = (coin: string, volCcy24h: string) => ({ instId: `${coin}-USDT`, volCcy24h });
    expect(parseCoins([row('BTC', '9000000'), row('ETH', '8000000'), row('SOL', '7000000')])).toEqual(['BTC', 'ETH', 'USDT', 'SOL']);
    expect(quoteOf('USDT')).toBe('USD');
    expect(quoteOf('BTC')).toBe('USDT');
  });

  it('opens Yandex Maps at longitude first', () => {
    expect(mapLink({ lat: 35.36, lon: 138.73 })).toBe('https://yandex.ru/maps/?ll=138.73,35.36&pt=138.73,35.36&z=12');
  });

  it('draws a small map with a marker at longitude first', () => {
    expect(mapPreview({ lat: 43.35, lon: 42.44 })).toContain('ll=42.44,43.35&z=2');
    expect(mapPreview({ lat: 43.35, lon: 42.44 })).toContain('pt=42.44,43.35,pm2rdm');
  });

  it('always opens the mountains with Elbrus', () => {
    expect(MOUNTAINS[0].name).toBe('Эльбрус');
  });

  it('finds the nearest place on a sphere', () => {
    expect(distanceKm({ lat: 55.75, lon: 37.62 }, { lat: 59.93, lon: 30.34 })).toBeCloseTo(634, -1);
    expect(nearest(CITIES, { lat: 55.8, lon: 37.5 }).name).toBe('Москва');
    expect(nearest(CITIES, { lat: 64.1, lon: -21.9 }).name).toBe('Рейкьявик');
    expect(nearest(MOUNTAINS, { lat: 35.3, lon: 138.7 }).name).toBe('Фудзи');
    expect(nearest([{ lat: 0, lon: 179 }, { lat: 0, lon: 0 }], { lat: 0, lon: -179 }).lon).toBe(179);
  });

  it('reads coordinates from IP services and survives their failures', () => {
    expect(parseIp({ latitude: 55.7558, longitude: 37.6173 })).toEqual({ lat: 55.76, lon: 37.62 });
    expect(parseIp({ latitude: '55.7558', longitude: '37.6173' })).toEqual({ lat: 55.76, lon: 37.62 });
    expect(parseIp({})).toBeNull();
    expect(parseIp({ latitude: '', longitude: '' })).toBeNull();
  });

  it('knows many real cities with working time zones', () => {
    expect(CITIES.length).toBeGreaterThan(500);
    expect(new Set(CITIES.map((c) => c.name)).size).toBe(CITIES.length);
    for (const c of CITIES) {
      expect(Math.abs(c.lat)).toBeLessThanOrEqual(90);
      expect(Math.abs(c.lon)).toBeLessThanOrEqual(180);
      expect(() => new Intl.DateTimeFormat('ru-RU', { timeZone: c.tz })).not.toThrow();
    }
  });

  it('knows many real mountains', () => {
    expect(MOUNTAINS.length).toBeGreaterThan(400);
    expect(new Set(MOUNTAINS.map((m) => m.name)).size).toBe(MOUNTAINS.length);
    for (const m of MOUNTAINS) {
      expect(Math.abs(m.lat)).toBeLessThan(85);
      expect([10, 11]).toContain(m.zoom);
    }
  });

  it('keeps traded coins and skips stablecoins and quiet pairs', () => {
    const row = (instId: string, volCcy24h: string) => ({ instId, volCcy24h });
    const data = [row('BTC-USDT', '1182191220.9'), row('USDC-USDT', '900000000'), row('QUIET-USDT', '12000'), row('ETH-BTC', '5000000')];
    expect(parseCoins(data)).toEqual(['BTC']);
    const named = ['XRP', 'XLM', 'XTZ', 'XTSLA', 'XNVDA', 'XMU', 'XAUT'].map((coin) => row(`${coin}-USDT`, '5000000'));
    expect(parseCoins(named)).toEqual(['XRP', 'XLM', 'USDT', 'XTZ']);
  });
});

describe('Языки', () => {
  it('prefers the saved choice, then the browser, then English', () => {
    expect(detect('en', ['ru-RU'])).toBe('en');
    expect(detect('ru', ['en-US'])).toBe('ru');
    expect(detect(null, ['ru-RU', 'en'])).toBe('ru');
    expect(detect(null, ['de-DE', 'en-GB'])).toBe('en');
    expect(detect(null, ['de-DE', 'ru'])).toBe('ru');
    expect(detect(null, ['ja'])).toBe('en');
    expect(detect('nonsense', [])).toBe('en');
  });

  it('names every place in both languages', () => {
    for (const place of [...CITIES, ...MOUNTAINS]) {
      expect(place.en).toBeTruthy();
      expect(place.en).not.toMatch(/[а-яё]/i);
    }
  });

  it('counts words in both grammars', () => {
    expect(word(2, ['час', 'часа', 'часов'], ['hour', 'hours'])).toBe('часа');
  });
});

describe('Блокчейн', () => {
  it('reads the latest block from each kind of source', () => {
    expect(parseMempool([{ height: 974747, tx_count: 4207, timestamp: 1793929057 }])).toEqual({ height: 974747, txs: 4207, at: 1793929057000 });
    expect(parseRpc([{ id: 1, result: '0x1921bf8' }, { id: 2, result: '0x3c' }])).toEqual({ height: 26352632, txs: 60 });
    expect(parseXrp({ result: { ledger: { ledger_index: '108143250', transactions: ['a', 'b'] } } })).toEqual({ height: 108143250, txs: 2 });
    expect(parseKoios([{ block_height: 14163690, tx_count: 0, block_time: 1793929761 }])).toEqual({ height: 14163690, txs: 0, at: 1793929761000 });
    const samples = [{ numSlots: 282, numTransactions: 89045 }];
    expect(parseSolana([{ id: 1, result: 465930472 }, { id: 2, result: samples }]).txs).toBeCloseTo(315.8, 0);
  });

  it('charges with time and discharges after enough blocks', () => {
    const charge = new Charge(2, 10, 100);
    expect(charge.read({ height: 5, txs: 100 }, 0)).toBe(false);
    expect(charge.pending(10_000)).toBeCloseTo(100);
    expect(charge.tension(20_000)).toBeCloseTo(1);
    expect(charge.read({ height: 6, txs: 100 }, 10_000)).toBe(false);
    expect(charge.read({ height: 7, txs: 100 }, 20_000)).toBe(true);
    expect(charge.pending(20_000)).toBe(0);
  });

  it('starts a slow chain already charged by the time since its block', () => {
    const charge = new Charge(1, 600, 3000);
    charge.read({ height: 1, txs: 3000, at: 0 }, 300_000);
    expect(charge.tension(300_000)).toBeCloseTo(0.5);
  });
});
