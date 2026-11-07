import { KIOSK } from './dom';
import { tr } from './i18n';

export interface Spot {
  lat: number;
  lon: number;
}

const ASK_MS = 5000;
const EARTH_KM = 6371;
const IP_SERVICES = ['https://ipwho.is/', 'https://get.geojs.io/v1/ip/geo.json'];

// Яндекс принимает координаты в порядке долгота, широта
export function mapLink({ lat, lon }: Spot): string {
  return `https://${tr('yandex.ru', 'yandex.com')}/maps/?ll=${lon},${lat}&pt=${lon},${lat}&z=12`;
}

// Миниатюра показывает часть света, поэтому масштаб мелкий и один для всех мест
export function mapPreview({ lat, lon }: Spot): string {
  return `https://static-maps.yandex.ru/1.x/?ll=${lon},${lat}&z=2&size=300,150&l=map&pt=${lon},${lat},pm2rdm&lang=${tr('ru_RU', 'en_US')}`;
}

export function distanceKm(a: Spot, b: Spot): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.sqrt(h));
}

export function nearest<T extends Spot>(pool: T[], spot: Spot): T {
  return pool.reduce((a, b) => (distanceKm(b, spot) < distanceKm(a, spot) ? b : a));
}

// Точность до километра: работе нужен ближайший город, а не адрес зрителя
const rounded = (lat: number, lon: number): Spot => ({ lat: Math.round(lat * 100) / 100, lon: Math.round(lon * 100) / 100 });

// Сервисы отдают координаты то числами, то строками, а при ошибке их нет вовсе
export function parseIp(json: { latitude?: number | string; longitude?: number | string }): Spot | null {
  const [lat, lon] = [json.latitude, json.longitude].map((v) => (v === undefined || v === '' ? NaN : Number(v)));
  return Number.isFinite(lat) && Number.isFinite(lon) ? rounded(lat, lon) : null;
}

// Окно с вопросом браузера может висеть сколько угодно, поэтому ждём его недолго
function fromBrowser(): Promise<Spot | null> {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(null);
    setTimeout(() => resolve(null), ASK_MS);
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => resolve(rounded(coords.latitude, coords.longitude)),
      () => resolve(null),
      { timeout: ASK_MS, maximumAge: 3600_000 },
    );
  });
}

async function fromIp(): Promise<Spot | null> {
  for (const url of IP_SERVICES) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
      const spot = res.ok ? parseIp(await res.json()) : null;
      if (spot) return spot;
    } catch {
      // Сервис недоступен: пробуем следующий
    }
  }
  return null;
}

// Сначала браузер, потом адрес IP. Если нет ни того ни другого, работа выберет место случайно
export async function locate(): Promise<Spot | null> {
  // Запрос геопозиции в киоске повис бы окном поверх постера, и закрыть его некому
  return (KIOSK ? null : await fromBrowser()) ?? fromIp();
}
