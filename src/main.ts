import './lib/legacy';
import '@fontsource-variable/jost/index.css';
import { HOME, sitePath } from './lib/dom';
import { LANG } from './lib/i18n';
import { openGallery } from './pages/gallery';
import { openKiosk } from './pages/kiosk';
import { openWork } from './pages/work';
import { findWork } from './works';

document.documentElement.lang = LANG;

const app = document.querySelector<HTMLElement>('#app')!;
const path = sitePath(location.pathname);
const work = findWork(path);

if (/^\/kiosk\/?$/.test(path)) void openKiosk(app);
else if (work) void openWork(app, work);
else if (path === '/') openGallery(app);
else location.replace(HOME);
