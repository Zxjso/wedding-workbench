/* 青山影像工作台 · Service Worker
 * 作用：App 壳缓存（离线可用）+ 自动应用更新 + 手机系统级弹窗通知
 * 版本数据/灵感推送走 network-first，保证用户总能拿到最新内容。
 */
const CACHE = 'wb-app-v1.5.0';
const STATE = 'wb-state-v1';
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon.png',
  './logo.png'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(SHELL).catch(() => {})).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE && k !== STATE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

/* 前端要求立即接管（修复：此前缺失该监听，postMessage 无人响应） */
self.addEventListener('message', e => {
  if (e.data === 'skipWaiting') self.skipWaiting();
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (url.pathname.indexOf('/__wb_') === 0) return; // 内部状态键，不拦截
  const isShell = SHELL.some(s => {
    const name = s.replace('./', '');
    return url.pathname.endsWith('/' + name) || url.pathname.endsWith(name) || (s === './' && (url.pathname.endsWith('/') || url.pathname === ''));
  });
  if (isShell) {
    e.respondWith(caches.match(e.request).then(r => r || fetch(e.request)));
    return;
  }
  e.respondWith(
    fetch(e.request).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy));
      return res;
    }).catch(() => caches.match(e.request))
  );
});

/* ---------- 状态读写（页面把档期/版本摘要放进来，供后台巡检使用） ---------- */
async function readState(key, dft) {
  try {
    const c = await caches.open(STATE);
    const r = await c.match('/__wb_' + key);
    if (!r) return dft;
    return await r.json();
  } catch (e) { return dft; }
}
async function writeState(key, val) {
  try {
    const c = await caches.open(STATE);
    await c.put('/__wb_' + key, new Response(JSON.stringify(val), { headers: { 'Content-Type': 'application/json' } }));
  } catch (e) {}
}
self.addEventListener('message', e => {
  if (e.data && e.data.type === 'wb-state') writeState(e.data.key, e.data.val);
});

/* ---------- 通知点击：聚焦已开的工作台，没开就打开 ---------- */
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const target = (e.notification.data && e.notification.data.url) || './';
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const c of list) {
        if ('focus' in c) { c.navigate && c.navigate(target); return c.focus(); }
      }
      return self.clients.openWindow(target);
    })
  );
});

/* ---------- 后台定期巡检：工作台更新 + 婚礼倒计时 ---------- */
function d0(x) { const d = new Date(x); d.setHours(0, 0, 0, 0); return d; }
function daysTo(s) {
  if (!s) return null;
  const d = d0(String(s).replace(/-/g, '/'));
  if (isNaN(d.getTime())) return null;
  return Math.round((d - d0(new Date())) / 86400000);
}

async function bgCheck() {
  const today = new Date().toISOString().slice(0, 10);
  const pref = await readState('pref', { shoot: true, update: true });

  // 1) 版本更新
  if (pref.update !== false) {
    try {
      const r = await fetch('version.json?t=' + Date.now(), { cache: 'no-store' });
      if (r.ok) {
        const j = await r.json();
        const seen = await readState('ver', null);
        if (j && j.version && seen && j.version !== seen) {
          await self.registration.showNotification('📲 工作台已更新 ' + j.version, {
            body: (j.notes || '有新功能上线，点开看看').slice(0, 90),
            tag: 'wb-update-' + j.version, icon: 'icon.png', badge: 'icon.png',
            renotify: true, data: { url: './' }
          });
          await writeState('ver', j.version);
        }
      }
    } catch (e) {}
  }
  // 3) 交片倒计时：超期 / 0 / 1 / 3 / 7 天（手机系统弹窗）
  if (pref.shoot !== false) {
    const delivers = await readState('delivers', []);
    const sentDl = await readState('sent_dl', {});
    let dirtyDl = false;
    for (const s of delivers) {
      const n = daysTo(s.deliverDate);
      if (n === null) continue;
      const notify = n < 0 || [0, 1, 3, 7].indexOf(n) >= 0;
      if (!notify) continue;
      const key = s.id + '_' + n;
      if (sentDl[key] === today) continue;
      let title, body;
      if (n < 0) {
        title = '⚠️ 交片已超期 ' + Math.abs(n) + ' 天：「' + s.name + '」';
        body = [s.company ? '婚庆：' + s.company : '', '客户在等长片，尽快交付'].filter(Boolean).join(' · ');
      } else if (n === 0) {
        title = '📦 今天该交片：「' + s.name + '」';
        body = [s.company ? '婚庆：' + s.company : '', '把成片发出去'].filter(Boolean).join(' · ');
      } else {
        title = '📦 还有 ' + n + ' 天交片：「' + s.name + '」';
        body = [s.company ? '婚庆：' + s.company : '', n <= 1 ? '今晚把精修安排上' : '提前排好交片'].filter(Boolean).join(' · ');
      }
      await self.registration.showNotification(title, {
        body: body || '点开工作台看交片进度',
        tag: 'wb-dl-' + s.id + '-' + n, icon: 'icon.png', badge: 'icon.png',
        renotify: true, data: { url: './' }
      });
      sentDl[key] = today; dirtyDl = true;
    }
    if (dirtyDl) await writeState('sent_dl', sentDl);
  }
}

self.addEventListener('periodicsync', e => {
  if (e.tag === 'wb-check') e.waitUntil(bgCheck());
});
self.addEventListener('sync', e => {
  if (e.tag === 'wb-check') e.waitUntil(bgCheck());
});

/* 若将来接入 Web Push 服务端，这里直接可用 */
self.addEventListener('push', e => {
  let d = { title: '青山影像工作台', body: '有新消息' };
  try { if (e.data) d = Object.assign(d, e.data.json()); } catch (err) { if (e.data) d.body = e.data.text(); }
  e.waitUntil(self.registration.showNotification(d.title, {
    body: d.body, icon: 'icon.png', badge: 'icon.png', tag: d.tag || 'wb-push',
    renotify: true, data: { url: d.url || './' }
  }));
});
