export interface Place {
  name: string;
  en: string;
  lat: number;
  lon: number;
}

export interface City extends Place {
  tz: string;
}

export interface Radar extends Place {
  around: string;
  code: string;
}

export interface Station extends Place {
  around: string;
}

export interface League {
  path: string;
  title: string;
  en: string;
}

// Только узлы с плотным покрытием ADS-B: над Москвой в сети adsb.lol почти нет бортов
export const RADARS: Radar[] = [
  { name: 'Франкфурт', en: 'Frankfurt', around: 'Франкфурта', code: 'FRA', lat: 50.03, lon: 8.57 },
  { name: 'Лондон', en: 'London', around: 'Лондона', code: 'LHR', lat: 51.47, lon: -0.45 },
  { name: 'Амстердам', en: 'Amsterdam', around: 'Амстердама', code: 'AMS', lat: 52.31, lon: 4.76 },
  { name: 'Париж', en: 'Paris', around: 'Парижа', code: 'CDG', lat: 49.01, lon: 2.55 },
  { name: 'Стамбул', en: 'Istanbul', around: 'Стамбула', code: 'IST', lat: 41.27, lon: 28.75 },
  { name: 'Нью-Йорк', en: 'New York', around: 'Нью-Йорка', code: 'JFK', lat: 40.64, lon: -73.78 },
  { name: 'Чикаго', en: 'Chicago', around: 'Чикаго', code: 'ORD', lat: 41.98, lon: -87.9 },
  { name: 'Лос-Анджелес', en: 'Los Angeles', around: 'Лос-Анджелеса', code: 'LAX', lat: 33.94, lon: -118.41 },
];
export const RADAR_RADIUS_NM = 150;

// Точки наблюдения на сейсмических поясах: толчки считаются вокруг них
export const STATIONS: Station[] = [
  { name: 'Токио', en: 'Tokyo', around: 'Токио', lat: 35.68, lon: 139.69 },
  { name: 'Джакарта', en: 'Jakarta', around: 'Джакарты', lat: -6.21, lon: 106.85 },
  { name: 'Сантьяго', en: 'Santiago', around: 'Сантьяго', lat: -33.45, lon: -70.67 },
  { name: 'Анкоридж', en: 'Anchorage', around: 'Анкориджа', lat: 61.22, lon: -149.9 },
  { name: 'Лос-Анджелес', en: 'Los Angeles', around: 'Лос-Анджелеса', lat: 34.05, lon: -118.24 },
  { name: 'Стамбул', en: 'Istanbul', around: 'Стамбула', lat: 41.01, lon: 28.98 },
  { name: 'Рейкьявик', en: 'Reykjavik', around: 'Рейкьявика', lat: 64.15, lon: -21.94 },
  { name: 'Веллингтон', en: 'Wellington', around: 'Веллингтона', lat: -41.29, lon: 174.78 },
];
export const SEISMIC_RADIUS_KM = 6000;

export interface PlatformPlace extends Place {
  code: string;
}

// Северные станции, куда пассажирский поезд приходит редко
export const PLATFORMS: PlatformPlace[] = [
  { name: 'Кемиярви', en: 'Kemijärvi', code: 'KJÄ', lat: 66.71, lon: 27.43 },
  { name: 'Нурмес', en: 'Nurmes', code: 'NRM', lat: 63.54, lon: 29.14 },
  { name: 'Каяани', en: 'Kajaani', code: 'KAJ', lat: 64.22, lon: 27.73 },
  { name: 'Рованиеми', en: 'Rovaniemi', code: 'ROI', lat: 66.5, lon: 25.72 },
];

export interface ReliefPlace extends Place {
  zoom: number;
}

// Формы, которые читаются как тело: одиночные вулканы, складки и разломы
export const COINS = ['BTC', 'ETH', 'USDT', 'SOL', 'XRP', 'BNB', 'DOGE', 'ADA', 'LINK', 'LTC', 'AVAX'];

export const LEAGUES: League[] = [
  { path: 'soccer/uefa.champions', title: 'Лига чемпионов', en: 'Champions League' },
  { path: 'soccer/uefa.europa', title: 'Лига Европы', en: 'Europa League' },
  { path: 'soccer/eng.1', title: 'Премьер-лига', en: 'Premier League' },
  { path: 'soccer/rus.1', title: 'РПЛ', en: 'RPL' },
  { path: 'basketball/nba', title: 'НБА', en: 'NBA' },
  { path: 'hockey/nhl', title: 'НХЛ', en: 'NHL' },
  { path: 'soccer/esp.1', title: 'Ла Лига', en: 'La Liga' },
  { path: 'soccer/ger.1', title: 'Бундеслига', en: 'Bundesliga' },
  { path: 'soccer/ita.1', title: 'Серия А', en: 'Serie A' },
  { path: 'soccer/fra.1', title: 'Лига 1', en: 'Ligue 1' },
  { path: 'football/nfl', title: 'НФЛ', en: 'NFL' },
  { path: 'baseball/mlb', title: 'МЛБ', en: 'MLB' },
];

export const TOUR_MS = 20_000;
export const KIOSK_MS = 180_000;
export const KIOSK_RETRY_MS = 30_000;
