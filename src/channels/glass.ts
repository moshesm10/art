import { HOME, KIOSK } from '../lib/dom';
import { tr } from '../lib/i18n';
import { distanceKm, locate, type Spot } from '../lib/locate';
import { Feed, getJson } from '../lib/net';
import { ART, SHEET_W, waiting, type Encoding, type Frame, type Label, type Poster, type Tip } from '../lib/poster';
import { glide } from '../lib/stats';
import { INK } from '../lib/theme';

const PAPER = '#efece4';
const STAGE_W = 420;
const STAGE_H = 500;
const REVEAL_SEC = 1.2;
const RIBS = 30;
const BEND = 3;
const ZOOM = 1.2;
const FRAME_SEC = 0.9;
const MIN_FRAMES = 12;
// Сутки камеры в памяти весят сотни мегабайт, а у iPad mini 2 всего гигабайт
const AHEAD = KIOSK ? 1 : 3;
const NEAR_KM = 250;
const NEAR_CAMS = 6;
const CREDIT = 'Webcams provided by Windy.com';
const KINDS = 'beach,coast,mountain,city,lake,landscape,port';

export interface Cam {
  id: number;
  title: string;
  place: string;
  name: string;
  page: string;
  lat: number;
  lon: number;
}

interface RawCam {
  webcamId: number;
  title: string;
  status: string;
  location: { city: string; region: string; country: string; latitude: number; longitude: number };
  player?: { day?: string };
  urls: { detail: string };
}

interface Reel {
  cam: Cam;
  frames: HTMLImageElement[];
}

// Полоска шире своего ребра сжимается в него и зеркалится от середины: так рифлёное стекло дробит картинку
export function ribSource(index: number, cells: number, bend: number, size: number): { from: number; span: number } {
  const span = (size / cells) * bend;
  return { from: Math.min((index / cells) * size, size - span), span };
}

// Кадр вписывается в лист по высоте и приближается к центру: посередине остаётся главное, по краям срезается лишнее
export function coverCrop(width: number, height: number): { x: number; y: number; w: number; h: number } {
  const h = height / ZOOM;
  const w = (h * STAGE_W) / STAGE_H;
  return { x: (width - w) / 2, y: (height - h) / 2, w, h };
}

// Город бывает неизвестен, тогда листу нужно другое имя: регион или название камеры
export function parseCams(json: { webcams?: RawCam[] }): Cam[] {
  return (json.webcams ?? []).flatMap((raw) => {
    if (raw.status !== 'active' || !raw.player?.day) return [];
    const { city, region, country, latitude: lat, longitude: lon } = raw.location;
    const name = [city, region].find((v) => v && v !== 'unknown') ?? raw.title.split('›')[0].trim();
    return [{ id: raw.webcamId, title: raw.title, place: country, name, page: raw.urls.detail, lat, lon }];
  });
}

// Плеер Windy держит кадры суток прямо в своей странице, от старых к новым
export function parseSlides(html: string): string[] {
  return [...new Set(html.match(/https:\/\/imgproxy\.windy\.com\/_\/normal\/plain\/day\/\d+\/original\/\d+\.jpg/g) ?? [])];
}

export function lightOf(pixels: Uint8ClampedArray): number {
  let sum = 0;
  for (let i = 0; i < pixels.length; i += 4) sum += 0.2126 * pixels[i] + 0.7152 * pixels[i + 1] + 0.0722 * pixels[i + 2];
  return sum / (pixels.length / 4) / 255;
}

// Камера, застывшая на одном кадре или чёрная все сутки, сквозь стекло выглядит поломкой
export function worthShowing(lights: number[]): boolean {
  return lights.length >= MIN_FRAMES && Math.max(...lights) > 0.25 && Math.max(...lights) - Math.min(...lights) > 0.04;
}

function loadFrame(url: string): Promise<HTMLImageElement> {
  const image = new Image();
  image.crossOrigin = 'anonymous';
  return new Promise((resolve, reject) => {
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`${url}: нет кадра`));
    image.src = url;
  });
}

export class Windows implements Poster {
  readonly service = tr('Окно', 'Window');
  readonly source = 'Windy Webcams';
  readonly kind = tr('другая камера', 'another camera');
  readonly align = 'left';
  readonly ink = INK;
  // Зерно цвета бумаги ложилось на снимок пятнами и спорило со стеклом
  readonly clean = true;
  readonly feeds = [new Feed('Windy', Infinity)];
  readonly encoding: Encoding = {
    color: tr('Весь цвет настоящий: это свет места за последние сутки, снятый веб-камерой. Тёмное стекло значит, что там была ночь.', 'All the colour is real: the light of the place over the last day, caught by a webcam. Dark glass means it was night there.'),
    form: tr('Случайная камера мира смотрит сквозь рифлёное стекло: каждая полоса сжимает и зеркалит кусок снимка, поэтому от места остаются только свет, цвет и ритм.', 'A random camera somewhere in the world looks through fluted glass: each rib squeezes and mirrors a slice of the picture, so only light, colour and rhythm remain of the place.'),
    speed: tr('За сутки камера оставляет около 24 снимков. Они перетекают друг в друга, и сутки проходят примерно за 20 секунд.', 'A camera leaves about 24 pictures a day. They melt into one another, and a whole day passes in about 20 seconds.'),
  };

  private cams: Cam[] = [];
  private near: Spot | null = null;
  private reel: Reel | null = null;
  private next: Reel[] = [];
  private seen: Reel[] = [];
  private filling = false;
  private meter: CanvasRenderingContext2D | null = null;
  private clock = 0;
  private stage: HTMLCanvasElement | null = null;
  private shade: HTMLCanvasElement | null = null;
  private reveal = { x: 0, v: 0 };

  paper(): string {
    return PAPER;
  }

  start(): void {
    void locate().then((spot) => {
      this.near = spot;
      void this.fill();
    });
  }

  private async fetchCams(): Promise<void> {
    const near = this.near;
    this.near = null;
    // Первая камера ищется рядом со зрителем, дальше весь мир. Список идёт от популярных: чаще берётся его начало
    if (import.meta.env.PROD) return this.useBakedCams(near);
    const offset = near ? 0 : Math.floor(950 * Math.random() ** 3);
    const area = near ? `nearby=${near.lat},${near.lon},${NEAR_KM}` : `categories=${KINDS}&categoryOperation=or`;
    const json = await getJson<{ webcams?: RawCam[] }>(
      `/api/windy/webcams/api/v3/webcams?limit=50&offset=${offset}&sortKey=popularity&sortDirection=desc&${area}&include=location,player,urls`,
    );
    const cams = parseCams(json);
    this.cams = near ? cams.slice(0, NEAR_CAMS).reverse() : cams.sort(() => Math.random() - 0.5);
  }

  // В сборке нет ключа Windy, поэтому камеры приходят из списка, который запёк scripts/cams.mjs
  private async useBakedCams(near: Spot | null): Promise<void> {
    const cams = parseCams(await getJson<{ webcams?: RawCam[] }>(`${HOME}cams.json`));
    this.cams = near
      ? cams.sort((a, b) => distanceKm(a, near) - distanceKm(b, near)).slice(0, NEAR_CAMS).reverse()
      : cams.sort(() => Math.random() - 0.5);
  }

  private measure(image: HTMLImageElement): number {
    this.meter ??= Object.assign(document.createElement('canvas'), { width: 12, height: 8 }).getContext('2d', { willReadFrequently: true })!;
    this.meter.drawImage(image, 0, 0, 12, 8);
    return lightOf(this.meter.getImageData(0, 0, 12, 8).data);
  }

  private async fetchReel(cam: Cam): Promise<Reel | null> {
    const res = await fetch(`/api/webcams/webcams/public/embed/player/${cam.id}/day`, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return null;
    const loaded = await Promise.allSettled(parseSlides(await res.text()).map(loadFrame));
    const frames = loaded.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
    return worthShowing(frames.map((frame) => this.measure(frame))) ? { cam, frames } : null;
  }

  // Камеры готовятся заранее, поэтому кнопка меняет место без ожидания
  private async fill(): Promise<void> {
    if (this.filling) return;
    this.filling = true;
    while (this.next.length < AHEAD) {
      try {
        if (!this.cams.length) await this.fetchCams();
        const cam = this.cams.pop();
        const reel = cam && (await this.fetchReel(cam));
        if (!reel) continue;
        if (this.reel) this.next.push(reel);
        else {
          this.show(reel);
          this.cams = [];
        }
      } catch (err) {
        console.warn('Windy', err);
        this.feeds[0].fail();
        await new Promise((done) => setTimeout(done, 3000));
      }
    }
    this.filling = false;
  }

  private show(reel: Reel): void {
    if (this.reel) this.seen = [this.reel, ...this.seen].slice(0, AHEAD);
    this.reel = reel;
    this.clock = 0;
    this.feeds[0].ok();
  }

  shuffle(rand: () => number = Math.random): void {
    const reel = this.next.shift() ?? this.seen[Math.floor(rand() * this.seen.length)];
    if (reel) this.show(reel);
    void this.fill();
  }

  label(): Label {
    if (!this.reel) return { title: this.service, print: `${tr('Веб-камера сквозь стекло', 'A webcam through glass')} · ${CREDIT}` };
    const { name, place } = this.reel.cam;
    return { title: name, print: `${place} · ${tr('сутки камеры сквозь стекло', 'a day of this camera through glass')} · ${CREDIT}` };
  }

  private paintFrame(px: CanvasRenderingContext2D, image: HTMLImageElement): void {
    const { x, y, w, h } = coverCrop(image.naturalWidth, image.naturalHeight);
    px.drawImage(image, x, y, w, h, 0, 0, STAGE_W, STAGE_H);
  }

  private paintStage({ frames }: Reel): HTMLCanvasElement {
    this.stage ??= Object.assign(document.createElement('canvas'), { width: STAGE_W, height: STAGE_H });
    const px = this.stage.getContext('2d')!;
    const at = (this.clock / FRAME_SEC) % frames.length;
    const index = Math.floor(at);
    this.paintFrame(px, frames[index]);
    px.globalAlpha = at - index;
    this.paintFrame(px, frames[(index + 1) % frames.length]);
    px.globalAlpha = 1;
    return this.stage;
  }

  // Блик и тень каждого ребра не меняются, поэтому рисуются один раз
  private paintShade(): HTMLCanvasElement {
    if (this.shade) return this.shade;
    this.shade = Object.assign(document.createElement('canvas'), { width: STAGE_W, height: STAGE_H });
    const px = this.shade.getContext('2d')!;
    const w = STAGE_W / RIBS;
    for (let col = 0; col < RIBS; col++) {
      const rib = px.createLinearGradient(col * w, 0, (col + 1) * w, 0);
      rib.addColorStop(0, 'rgba(255,255,255,0.22)');
      rib.addColorStop(0.5, 'rgba(255,255,255,0)');
      rib.addColorStop(1, 'rgba(0,0,0,0.2)');
      px.fillStyle = rib;
      px.fillRect(col * w, 0, w, STAGE_H);
    }
    return this.shade;
  }

  private rib(ctx: CanvasRenderingContext2D, stage: HTMLCanvasElement, col: number): void {
    const width = ART.w / RIBS;
    const { from, span } = ribSource(col, RIBS, BEND, STAGE_W);
    // Края стоят точно по пикселям холста: дробный край старый Safari размывает, и на стыке виден светлый шов
    const k = ctx.canvas.width / SHEET_W;
    const snap = (x: number) => Math.round(x * k) / k;
    const left = snap(ART.x + col * width);
    const middle = snap(ART.x + (col + 0.5) * width);
    const right = snap(ART.x + (col + 1) * width);
    ctx.drawImage(stage, from, 0, span / 2, STAGE_H, middle, ART.y, right - middle, ART.h);
    ctx.save();
    ctx.translate(middle, ART.y);
    ctx.scale(-1, 1);
    ctx.drawImage(stage, from, 0, span / 2, STAGE_H, 0, 0, middle - left, ART.h);
    ctx.restore();
  }

  draw({ ctx, dt }: Frame): void {
    if (!this.reel) return waiting(ctx, this.ink);
    glide(this.reveal, 1, dt, REVEAL_SEC);
    this.clock += dt;
    const stage = this.paintStage(this.reel);
    ctx.globalAlpha = Math.min(1, Math.max(0, this.reveal.x));
    // Подложка из того же кадра: если между рёбрами останется щель, в ней будет снимок, а не светлая бумага
    ctx.drawImage(stage, ART.x, ART.y, ART.w, ART.h);
    for (let col = 0; col < RIBS; col++) this.rib(ctx, stage, col);
    ctx.drawImage(this.paintShade(), ART.x, ART.y, ART.w, ART.h);
    ctx.globalAlpha = 1;
  }

  pick(): Tip | null {
    if (!this.reel) return null;
    return { value: this.reel.cam.title, label: this.reel.cam.place };
  }

  where(): Spot | null {
    return this.reel?.cam ?? null;
  }

  open(): string | null {
    return this.reel?.cam.page ?? null;
  }
}
