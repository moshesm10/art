export type Lang = 'ru' | 'en';

export const LANGS: Lang[] = ['ru', 'en'];

const KEY = 'puls-lang';

// Выбор зрителя важнее браузера. Если браузер не знает ни одного из языков, показываем английский
export function detect(saved: string | null, languages: readonly string[]): Lang {
  if (saved === 'ru' || saved === 'en') return saved;
  for (const language of languages) {
    const code = language.slice(0, 2).toLowerCase();
    if (code === 'ru' || code === 'en') return code;
  }
  return 'en';
}

function savedLang(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

// Вне браузера, в тестах, работает исходный язык проекта
export const LANG: Lang = typeof document === 'undefined' ? 'ru' : detect(savedLang(), navigator.languages);
export const LOCALE = LANG === 'en' ? 'en-GB' : 'ru-RU';

export const tr = <T>(ru: T, en: T): T => (LANG === 'en' ? en : ru);

export function setLang(lang: Lang): void {
  try {
    localStorage.setItem(KEY, lang);
  } catch {
    // Хранилище закрыто: язык сменится только на эту страницу
  }
  location.reload();
}
