import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { defineConfig, loadEnv, type Plugin, type ProxyOptions } from 'vite';
import { ROUTES } from './src/routes';

// REST-источники идут через сервер Vite: часть из них не отдаёт CORS-заголовки или недоступна из браузера напрямую
const upstream = process.env.HTTPS_PROXY ?? process.env.https_proxy;
const agent = upstream ? new HttpsProxyAgent(upstream) : undefined;

// ESPN отвечает 403 на браузерные заголовки, поэтому наружу уходит обычный серверный запрос
const route = (target: string, prefix: string, headers: Record<string, string> = {}): ProxyOptions => ({
  target,
  agent,
  changeOrigin: true,
  rewrite: (path: string) => path.slice(prefix.length),
  bypass: (req) => {
    // Тело запроса к сетям блокчейна должно дойти как есть, поэтому его заголовки сохраняются
    const { 'content-type': type, 'content-length': length } = req.headers;
    const body = type && length ? { 'content-type': type, 'content-length': length } : {};
    req.headers = { accept: 'application/json', 'user-agent': 'puls-stand', ...body, ...headers };
  },
});

// Ключ Windy живёт в .env и добавляется только здесь: браузер его не видит
const windyKey = loadEnv('development', process.cwd(), '').WINDY_KEY ?? '';

const proxy = {
  ...Object.fromEntries(Object.entries(ROUTES).map(([prefix, target]) => [prefix, route(target, prefix)])),
  '/api/windy': route('https://api.windy.com', '/api/windy', { 'x-windy-api-key': windyKey }),
};

const STAGES_FILE = 'src/works-stages.json';

// Кнопка мастерской пишет статус в файл проекта. Адрес есть только у дев-сервера, в сборку он не попадает
const stages: Plugin = {
  name: 'puls-stages',
  configureServer(server) {
    server.middlewares.use('/admin/stage', (req, res) => {
      // JSON нельзя отправить с чужого сайта без разрешения, поэтому другие типы отклоняются
      if (req.method !== 'POST' || req.headers['content-type'] !== 'application/json') {
        res.statusCode = 405;
        return res.end();
      }
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        try {
          const { slug, stage } = JSON.parse(body);
          if (!/^[a-z0-9-]+$/.test(slug) || !['ready', 'idea'].includes(stage)) throw new Error('bad stage');
          const known = JSON.parse(readFileSync(STAGES_FILE, 'utf8'));
          writeFileSync(STAGES_FILE, `${JSON.stringify({ ...known, [slug]: stage }, null, 2)}\n`);
          res.end();
        } catch {
          res.statusCode = 400;
          res.end();
        }
      });
    });
  },
};

// Статичный хостинг отдаёт только настоящие файлы, поэтому у каждого адреса сайта должна быть своя страница
const pages: Plugin = {
  name: 'puls-pages',
  apply: 'build',
  closeBundle() {
    const known: Record<string, string> = JSON.parse(readFileSync(STAGES_FILE, 'utf8'));
    const ready = Object.keys(known).filter((slug) => known[slug] === 'ready');
    for (const path of ['kiosk', ...ready.map((slug) => `work/${slug}`)]) {
      mkdirSync(`dist/${path}`, { recursive: true });
      copyFileSync('dist/index.html', `dist/${path}/index.html`);
    }
  },
};

export default defineConfig({
  plugins: [stages, pages],
  server: { proxy },
  preview: { proxy },
  // Киоск работает на iPad mini 2, выше iOS 12 он не обновляется
  build: { target: 'safari12', cssTarget: 'safari12' },
});
