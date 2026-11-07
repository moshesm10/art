// Запекает список камер для сборки: node scripts/cams.mjs
// Ключ Windy нельзя отдавать в браузер, а кадры камер открыты, поэтому на сайт уезжает только готовый список
import { readFileSync, writeFileSync } from 'node:fs';

const PAGES = 10;
const LIMIT = 50;
const KINDS = 'beach,coast,mountain,city,lake,landscape,port';

const key = /^WINDY_KEY=(.+)$/m.exec(readFileSync('.env', 'utf8'))?.[1].trim();
if (!key) throw new Error('В .env нет WINDY_KEY');

const webcams = [];
for (let page = 0; page < PAGES; page++) {
  const url = `https://api.windy.com/webcams/api/v3/webcams?limit=${LIMIT}&offset=${page * LIMIT}&sortKey=popularity&sortDirection=desc&categories=${KINDS}&categoryOperation=or&include=location,player,urls`;
  const res = await fetch(url, { headers: { 'x-windy-api-key': key } });
  if (!res.ok) throw new Error(`Windy: HTTP ${res.status}`);
  for (const cam of (await res.json()).webcams ?? []) {
    const { city, region, country, latitude, longitude } = cam.location;
    webcams.push({
      webcamId: cam.webcamId,
      title: cam.title,
      status: cam.status,
      location: { city, region, country, latitude, longitude },
      player: { day: cam.player?.day },
      urls: { detail: cam.urls.detail },
    });
  }
}

if (webcams.length < LIMIT) throw new Error(`Windy вернул мало камер: ${webcams.length}`);
writeFileSync('public/cams.json', JSON.stringify({ webcams }));
console.log(`Камер в списке: ${webcams.length}`);
