import './lib/legacy';
import '@fontsource-variable/jost/index.css';
import { LANG } from './lib/i18n';
import { openGallery } from './pages/gallery';
import { openKiosk } from './pages/kiosk';
import { openWork } from './pages/work';
import { findWork } from './works';

document.documentElement.lang = LANG;

const app = document.querySelector<HTMLElement>('#app')!;
const work = findWork(location.pathname);

if (/^\/kiosk\/?$/.test(location.pathname)) void openKiosk(app);
else if (work) void openWork(app, work);
else if (location.pathname === '/') openGallery(app);
else location.replace('/');
