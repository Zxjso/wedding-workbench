#!/usr/bin/env node
/**
 * 青山影像·拍剪后期工作台 —— 后端服务
 * 零依赖：Node.js (>=22.5, 内置 node:sqlite) + 原生 http
 *
 * 功能：
 *  - 静态托管前端 (index.html / auth.js / sw.js / 资源)
 *  - 用户注册 / 登录 / 登出（6位用户名 + 6位字母数字密码，scrypt 加密）
 *  - 云端持久化「拍剪后期」列表、抖音/小红书授权配置、同步快照与日志
 *  - 多设备登录同一账号自动同步历史数据（互相隔离）
 *  - 内置定时同步调度（每1小时 / 4小时 / 每天）
 *
 * 运行：node server.js   （端口可用环境变量 PORT 覆盖，默认 3000）
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = process.env.WB_DB || path.join(DATA_DIR, 'wb.db');

// 数据看板摄取令牌：爬虫/脚本推送数据时使用，与登录 token 相互独立
const INGEST_TOKEN_FILE = path.join(DATA_DIR, 'ingest_token.txt');
let INGEST_TOKEN = process.env.WB_INGEST_TOKEN || '';
if (!INGEST_TOKEN) { try { INGEST_TOKEN = fs.readFileSync(INGEST_TOKEN_FILE, 'utf8').trim(); } catch (e) {} }
if (!INGEST_TOKEN) { INGEST_TOKEN = crypto.randomBytes(24).toString('hex'); try { fs.writeFileSync(INGEST_TOKEN_FILE, INGEST_TOKEN); } catch (e) {} }

const db = new DatabaseSync(DB_PATH);
db.exec(`
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  pw_hash TEXT NOT NULL,
  douyin TEXT NOT NULL DEFAULT '{}',
  xhs TEXT NOT NULL DEFAULT '{}',
  shots TEXT NOT NULL DEFAULT '[]',
  sync_interval TEXT NOT NULL DEFAULT 'daily',
  last_sync_at TEXT,
  created_at TEXT NOT NULL,
  last_login_at TEXT,
  tokens TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS sync_snapshots(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  platform TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sync_logs(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  platform TEXT NOT NULL,
  status TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS metrics_works(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  platform TEXT NOT NULL,
  wkey TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  play INTEGER NOT NULL DEFAULT 0,
  like INTEGER NOT NULL DEFAULT 0,
  collect INTEGER NOT NULL DEFAULT 0,
  comment INTEGER NOT NULL DEFAULT 0,
  publish_time TEXT,
  first_seen TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS metrics_daily(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  platform TEXT NOT NULL,
  day TEXT NOT NULL,
  total_play INTEGER NOT NULL DEFAULT 0,
  total_like INTEGER NOT NULL DEFAULT 0,
  total_collect INTEGER NOT NULL DEFAULT 0,
  total_comment INTEGER NOT NULL DEFAULT 0,
  work_count INTEGER NOT NULL DEFAULT 0,
  fetched_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_metrics_works_platform ON metrics_works(platform);
CREATE INDEX IF NOT EXISTS idx_metrics_daily_platform_day ON metrics_daily(platform, day);
CREATE TABLE IF NOT EXISTS metrics_dm(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  platform TEXT NOT NULL,
  wkey TEXT NOT NULL,
  peer TEXT NOT NULL DEFAULT '',
  last_message TEXT NOT NULL DEFAULT '',
  unread INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_metrics_dm_platform ON metrics_dm(platform);
CREATE TABLE IF NOT EXISTS breakdown(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL DEFAULT '',
  platform TEXT NOT NULL DEFAULT '',
  analysis TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_breakdown_user ON breakdown(user_id, created_at);
`);

/* ---------------- 工具函数 ---------------- */
const nowISO = () => new Date().toISOString();
const TOKEN_TTL = 30 * 24 * 3600 * 1000; // 30 天

function hashPw(pw) {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(pw, salt, 64);
  return salt.toString('hex') + ':' + h.toString('hex');
}
function verifyPw(pw, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, h] = stored.split(':');
  try {
    const hh = crypto.scryptSync(pw, Buffer.from(salt, 'hex'), 64);
    return crypto.timingSafeEqual(Buffer.from(h, 'hex'), hh);
  } catch (e) { return false; }
}
function newToken() { return crypto.randomBytes(24).toString('hex'); }

// 把 "1.2万" / "3,456" / "12.3亿" 这类文本转成整数
function parseCount(s) {
  if (s === undefined || s === null || s === '') return 0;
  s = String(s).replace(/,/g, '');
  const m = s.match(/[\d.]+/);
  if (!m) return 0;
  let n = parseFloat(m[0]);
  if (/亿/.test(s)) n *= 1e8;
  else if (/万/.test(s)) n *= 1e4;
  return Math.round(n);
}

/* 多端并发会话：一个账号可同时在手机/电脑登录，各自持有独立有效 token */
function addSession(userId) {
  const u = db.prepare('SELECT tokens FROM users WHERE id=?').get(userId);
  let arr = []; try { arr = JSON.parse(u.tokens || '[]'); } catch (e) {}
  arr = arr.filter(s => s.exp > Date.now()); // 清理过期
  arr.push({ t: newToken(), exp: Date.now() + TOKEN_TTL });
  db.prepare('UPDATE users SET tokens=? WHERE id=?').run(JSON.stringify(arr), userId);
  return arr[arr.length - 1].t;
}
function uidFromToken(token) {
  if (!token) return null;
  const rows = db.prepare('SELECT id,tokens FROM users').all();
  for (const u of rows) {
    let arr = []; try { arr = JSON.parse(u.tokens || '[]'); } catch (e) {}
    for (const s of arr) if (s.t === token && s.exp > Date.now()) return u.id;
  }
  return null;
}
function removeSession(token) {
  const rows = db.prepare('SELECT id,tokens FROM users').all();
  for (const u of rows) {
    let arr = []; try { arr = JSON.parse(u.tokens || '[]'); } catch (e) {}
    const before = arr.length;
    arr = arr.filter(s => s.t !== token);
    if (arr.length !== before) db.prepare('UPDATE users SET tokens=? WHERE id=?').run(JSON.stringify(arr), u.id);
  }
}

/* 校验规则：用户名 6 位字母数字；密码 6 位且必须同时含字母与数字 */
const RE_USER = /^[A-Za-z0-9]{6}$/;
const RE_PW = /^(?=.*[A-Za-z])(?=.*[0-9])[A-Za-z0-9]{6}$/;

/* ---------------- 同步引擎（抖音 / 小红书） ----------------
 * 真实接入需用户在「抖音开放平台 / 小红书商业开放平台」创建应用并取得授权。
 * 这里实现：有凭证则尝试真实调用（best-effort，带超时）；任何失败都按规范
 * 记录「抖音授权过期 / 网络异常」类日志，并返回友好提示，绝不抛未捕获异常。
 */
async function fetchDouyin(cfg) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 6000);
  try {
    // 1) 换取 client_token（抖音开放平台 client_credentials 模式）
    const r = await fetch('https://open.douyin.com/oauth/client_token/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_key: cfg.clientId, client_secret: cfg.clientSecret, grant_type: 'client_credential' }),
      signal: ac.signal
    });
    const j = await r.json().catch(() => ({}));
    if (j && j.data && j.data.access_token) {
      // 2) 后续可调用视频列表/数据接口；此处返回结构化占位（真实字段按官方文档填充）
      return { plays: 0, likes: 0, followers: 0, items: [], authorized: true };
    }
    throw new Error('授权失败：' + ((j && j.message) || 'invalid_client / 密钥错误'));
  } finally { clearTimeout(timer); }
}
async function fetchXhs(cfg) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 6000);
  try {
    // 小红书商业开放平台：使用已获取的 API token 调用数据接口
    const r = await fetch('https://api.xiaohongshu.com/api/creator/data/overview', {
      method: 'GET',
      headers: { 'authorization': 'Bearer ' + (cfg.token || ''), 'content-type': 'application/json' },
      signal: ac.signal
    });
    if (r.status === 200) {
      const j = await r.json().catch(() => ({}));
      return { plays: (j && j.plays) || 0, likes: (j && j.likes) || 0, followers: (j && j.followers) || 0, items: [], authorized: true };
    }
    if (r.status === 401) throw new Error('授权过期（token 失效，请重新授权）');
    throw new Error('接口返回 ' + r.status);
  } finally { clearTimeout(timer); }
}

async function runSync(userId, platform) {
  const u = db.prepare('SELECT douyin,xhs FROM users WHERE id=?').get(userId);
  const cfg = platform === 'douyin' ? JSON.parse(u.douyin || '{}') : JSON.parse(u.xhs || '{}');
  const ts = nowISO();
  const label = platform === 'douyin' ? '抖音' : '小红书';
  let status = 'ok', message = label + '：同步成功', payload = { platform, syncedAt: ts, plays: 0, likes: 0, followers: 0, items: [] };
  try {
    if (platform === 'douyin') {
      if (!cfg.clientId || !cfg.clientSecret) {
        status = 'error'; message = '抖音：未配置 ClientID / 密钥，请在「账号设置」中填写';
      } else {
        const data = await fetchDouyin(cfg);
        payload = Object.assign(payload, data);
      }
    } else {
      if (!cfg.token) {
        status = 'error'; message = '小红书：未配置 API 授权 token，请在「账号设置」中填写';
      } else {
        const data = await fetchXhs(cfg);
        payload = Object.assign(payload, data);
      }
    }
  } catch (e) {
    status = 'error';
    let m = (e && e.message) ? e.message : '网络异常';
    if (e && e.name === 'AbortError') m = '网络异常（请求超时）';
    message = label + '：' + m;
  }
  db.prepare('INSERT INTO sync_logs(user_id,platform,status,message,created_at) VALUES(?,?,?,?,?)').run(userId, platform, status, message, ts);
  if (status === 'ok') {
    db.prepare('INSERT INTO sync_snapshots(user_id,platform,payload,created_at) VALUES(?,?,?,?)').run(userId, platform, JSON.stringify(payload), ts);
  }
  db.prepare('UPDATE users SET last_sync_at=? WHERE id=?').run(ts, userId);
  return { status, message, payload };
}

/* 内置定时同步：按各账号 sync_interval 触发 */
const INTERVAL_MS = { hourly: 3600e3, '4h': 4 * 3600e3, daily: 24 * 3600e3 };
async function schedulerTick() {
  try {
    const rows = db.prepare('SELECT id,username,sync_interval,last_sync_at,tokens FROM users').all();
    const now = Date.now();
    for (const u of rows) {
      let arr = []; try { arr = JSON.parse(u.tokens || '[]'); } catch (e) {}
      if (!arr.some(s => s.exp > now)) continue; // 无有效会话则跳过
      const iv = INTERVAL_MS[u.sync_interval] || INTERVAL_MS.daily;
      const last = u.last_sync_at ? Date.parse(u.last_sync_at) : 0;
      if (now - last >= iv) {
        for (const p of ['douyin', 'xhs']) {
          try { await runSync(u.id, p); } catch (e) { /* 调度中的单点失败不影响其他账号 */ }
        }
        console.log('[scheduler] 已为', u.username, '执行定时同步');
      }
    }
  } catch (e) { console.error('[scheduler] error', e.message); }
}

/* ---------------- HTTP 辅助 ---------------- */
function sendJSON(res, code, obj) {
  const b = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(b);
}
function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 5e6) req.destroy(); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8' };

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  // 防目录穿越
  const fp = path.normalize(path.join(ROOT, rel));
  if (!fp.startsWith(ROOT)) { res.writeHead(403); res.end('forbidden'); return; }
  fs.stat(fp, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); res.end('404 Not Found'); return; }
    const ext = path.extname(fp).toLowerCase();
    res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream' });
    fs.createReadStream(fp).pipe(res);
  });
}

/* ---------------- API 路由 ---------------- */
async function handleApi(req, res, url) {
  const p = url.pathname;
  const method = req.method.toUpperCase();

  if (p === '/api/ping') return sendJSON(res, 200, { ok: true, time: nowISO() });

  // 需要 token 的接口
  const authPaths = ['/api/me', '/api/config', '/api/sync', '/api/shots', '/api/breakdown', '/api/logout'];
  let uid = null;
  if (authPaths.includes(p) && method !== 'GET') {
    const body = await readBody(req);
    const token = (body && body.token) || url.searchParams.get('token');
    uid = uidFromToken(token);
    if (!uid) return sendJSON(res, 401, { error: '登录已失效，请重新登录' });
    req._uid = uid; req._body = body; req._token = token;
  }

  if (p === '/api/register' && method === 'POST') {
    const body = await readBody(req);
    const username = String(body.username || '').trim();
    const password = String(body.password || '');
    if (!RE_USER.test(username)) return sendJSON(res, 400, { error: '用户名必须是 6 位字母或数字' });
    if (!RE_PW.test(password)) return sendJSON(res, 400, { error: '密码必须是 6 位，且同时包含字母和数字' });
    const exist = db.prepare('SELECT id FROM users WHERE username=?').get(username);
    if (exist) return sendJSON(res, 409, { error: '该用户名已被注册，请换一个' });
    db.prepare('INSERT INTO users(username,pw_hash,created_at,last_login_at) VALUES(?,?,?,?)')
      .run(username, hashPw(password), nowISO(), nowISO());
    const uid = db.prepare('SELECT id FROM users WHERE username=?').get(username).id;
    const token = addSession(uid);
    return sendJSON(res, 200, { token, username });
  }

  if (p === '/api/login' && method === 'POST') {
    const body = await readBody(req);
    const username = String(body.username || '').trim();
    const password = String(body.password || '');
    const u = db.prepare('SELECT * FROM users WHERE username=?').get(username);
    if (!u || !verifyPw(password, u.pw_hash)) return sendJSON(res, 401, { error: '用户名或密码错误' });
    const token = addSession(u.id);
    db.prepare('UPDATE users SET last_login_at=? WHERE id=?').run(nowISO(), u.id);
    return sendJSON(res, 200, buildMe(u, token));
  }

  if (p === '/api/logout' && method === 'POST') {
    removeSession(req._token);
    return sendJSON(res, 200, { ok: true });
  }

  if (p === '/api/me' && method === 'GET') {
    const token = url.searchParams.get('token');
    const uid = uidFromToken(token);
    if (!uid) return sendJSON(res, 401, { error: '请先登录' });
    const u = db.prepare('SELECT * FROM users WHERE id=?').get(uid);
    return sendJSON(res, 200, buildMe(u, token));
  }

  if (p === '/api/config' && method === 'POST') {
    const b = req._body;
    const douyin = sanitizeCfg(b.douyin, ['clientId', 'clientSecret']);
    const xhs = sanitizeCfg(b.xhs, ['token']);
    const iv = ['hourly', '4h', 'daily'].includes(b.syncInterval) ? b.syncInterval : 'daily';
    db.prepare('UPDATE users SET douyin=?,xhs=?,sync_interval=? WHERE id=?')
      .run(JSON.stringify(douyin), JSON.stringify(xhs), iv, req._uid);
    return sendJSON(res, 200, { ok: true });
  }

  if (p === '/api/shots' && method === 'POST') {
    const b = req._body;
    let shots = [];
    try { shots = Array.isArray(b.shots) ? b.shots : JSON.parse(b.shots || '[]'); } catch (e) { shots = []; }
    if (!Array.isArray(shots)) shots = [];
    db.prepare('UPDATE users SET shots=? WHERE id=?').run(JSON.stringify(shots), req._uid);
    return sendJSON(res, 200, { ok: true, count: shots.length });
  }

  if (p === '/api/sync' && method === 'POST') {
    const b = req._body;
    const platforms = b.platform ? [b.platform] : ['douyin', 'xhs'];
    const results = [];
    for (const pf of platforms) {
      if (pf !== 'douyin' && pf !== 'xhs') continue;
      results.push(await runSync(req._uid, pf));
    }
    return sendJSON(res, 200, { results });
  }

  /* ---------------- 数据看板：摄取接口（独立 ingest token 鉴权） ---------------- */
  if (p === '/api/metrics/ingest' && method === 'POST') {
    const body = await readBody(req);
    const itok = (req.headers && req.headers['x-ingest-token']) || (body && body.token) || url.searchParams.get('token');
    if (!itok || itok !== INGEST_TOKEN) return sendJSON(res, 401, { error: 'ingest token invalid' });
    const now = nowISO();
    const today = new Date().toISOString().slice(0, 10);
    const sources = {};
    if (['douyin', 'xhs'].includes(body && body.platform)) sources[body.platform] = Array.isArray(body.items) ? body.items : (Array.isArray(body.works) ? body.works : []);
    else { if (Array.isArray(body.douyin)) sources.douyin = body.douyin; if (Array.isArray(body.xhs)) sources.xhs = body.xhs; }
    let total = 0;
    for (const pf of Object.keys(sources)) {
      if (pf !== 'douyin' && pf !== 'xhs') continue;
      for (const it of (sources[pf] || [])) {
        const title = String((it && it.title) || '').trim();
        const wkey = pf + '|' + (title || ('__untitled_' + (total++)));
        const play = parseCount(it && it.play), like = parseCount(it && it.like), collect = parseCount(it && it.collect), comment = parseCount(it && it.comment);
        const ex = db.prepare('SELECT id FROM metrics_works WHERE wkey=?').get(wkey);
        if (ex) db.prepare('UPDATE metrics_works SET title=?,play=?,like=?,collect=?,comment=?,updated_at=? WHERE wkey=?').run(title, play, like, collect, comment, now, wkey);
        else db.prepare('INSERT INTO metrics_works(platform,wkey,title,play,like,collect,comment,publish_time,first_seen,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(pf, wkey, title, play, like, collect, comment, String((it && (it.publish_time || it.date)) || ''), now, now);
        total++;
      }
      const agg = db.prepare('SELECT COALESCE(SUM(play),0) tp,COALESCE(SUM(like),0) tl,COALESCE(SUM(collect),0) tc,COALESCE(SUM(comment),0) tcm,COUNT(*) cnt FROM metrics_works WHERE platform=?').get(pf);
      db.prepare('INSERT INTO metrics_daily(platform,day,total_play,total_like,total_collect,total_comment,work_count,fetched_at) VALUES(?,?,?,?,?,?,?,?)').run(pf, today, agg.tp, agg.tl, agg.tc, agg.tcm, agg.cnt, now);
    }
    /* ----- 私信(DM) ----- */
    const dmSources = {};
    if (body && body.dms && typeof body.dms === 'object') {
      if (Array.isArray(body.dms.douyin)) dmSources.douyin = body.dms.douyin;
      if (Array.isArray(body.dms.xhs)) dmSources.xhs = body.dms.xhs;
    } else if (['douyin', 'xhs'].includes(body && body.platform) && Array.isArray(body.dms)) {
      dmSources[body.platform] = body.dms;
    }
    let dmTotal = 0;
    for (const pf of Object.keys(dmSources)) {
      if (pf !== 'douyin' && pf !== 'xhs') continue;
      for (const dm of (dmSources[pf] || [])) {
        const peer = String((dm && dm.peer) || (dm && dm.name) || (dm && dm.contact) || '').trim();
        const wkey = pf + '|' + (peer || ('__dm_' + (dmTotal++)));
        const lastMsg = String((dm && dm.last) || (dm && dm.last_message) || (dm && dm.message) || '').trim().slice(0, 500);
        const unread = parseInt((dm && dm.unread) || 0, 10) || 0;
        const ex = db.prepare('SELECT id FROM metrics_dm WHERE wkey=?').get(wkey);
        if (ex) db.prepare('UPDATE metrics_dm SET peer=?,last_message=?,unread=?,updated_at=? WHERE wkey=?').run(peer, lastMsg, unread, now, wkey);
        else db.prepare('INSERT INTO metrics_dm(platform,wkey,peer,last_message,unread,updated_at) VALUES(?,?,?,?,?,?)').run(pf, wkey, peer, lastMsg, unread, now);
        dmTotal++;
      }
    }
    return sendJSON(res, 200, { ok: true, count: total, dmCount: dmTotal, updatedAt: now });
  }

  /* ---------------- 数据看板：读取接口（需登录 token） ---------------- */
  if (p === '/api/metrics' && method === 'GET') {
    const tk = url.searchParams.get('token');
    if (!uidFromToken(tk)) return sendJSON(res, 401, { error: '请先登录' });
    const pf = url.searchParams.get('platform') || 'all';
    const plats = pf === 'all' ? ['douyin', 'xhs'] : [pf];
    const ph = plats.map(() => '?').join(',');
    const works = db.prepare('SELECT platform,title,play,like,collect,comment,publish_time,updated_at FROM metrics_works WHERE platform IN (' + ph + ') ORDER BY play DESC').all(...plats);
    const summary = {};
    for (const pp of ['douyin', 'xhs']) {
      const a = db.prepare('SELECT COALESCE(SUM(play),0) plays,COALESCE(SUM(like),0) likes,COALESCE(SUM(collect),0) collects,COALESCE(SUM(comment),0) comments,COUNT(*) cnt FROM metrics_works WHERE platform=?').get(pp);
      summary[pp] = { play: a.plays, like: a.likes, collect: a.collects, comment: a.comments, cnt: a.cnt };
    }
    const daily = db.prepare('SELECT platform,day,total_play,total_like,total_collect,total_comment,work_count,fetched_at FROM metrics_daily WHERE platform IN (' + ph + ') ORDER BY fetched_at').all(...plats);
    const last = db.prepare('SELECT MAX(fetched_at) mx FROM metrics_daily').get();
    const dms = db.prepare('SELECT platform,peer,last_message,unread,updated_at FROM metrics_dm WHERE platform IN (' + ph + ') ORDER BY unread DESC, updated_at DESC').all(...plats);
    const dmSummary = {};
    for (const pp of ['douyin', 'xhs']) {
      const d = db.prepare('SELECT COUNT(*) cnt, COALESCE(SUM(unread),0) unread FROM metrics_dm WHERE platform=?').get(pp);
      dmSummary[pp] = { convs: d.cnt, unread: d.unread };
    }
    return sendJSON(res, 200, { works, summary, daily, dms, dmSummary, lastSync: last.mx, platform: pf });
  }

  /* ---------------- 爆款拆解记录（需登录 token） ---------------- */
  if (p === '/api/breakdown' && method === 'GET') {
    const tk = url.searchParams.get('token');
    const uid = uidFromToken(tk);
    if (!uid) return sendJSON(res, 401, { error: '请先登录' });
    const rows = db.prepare('SELECT id,title,url,platform,analysis,tags,created_at FROM breakdown WHERE user_id=? ORDER BY created_at DESC').all(uid);
    return sendJSON(res, 200, { items: rows });
  }
  if (p === '/api/breakdown' && method === 'POST') {
    const b = req._body;
    if (b && b.action === 'delete') {
      const id = parseInt(b.id, 10);
      if (id) db.prepare('DELETE FROM breakdown WHERE id=? AND user_id=?').run(id, req._uid);
      return sendJSON(res, 200, { ok: true });
    }
    const title = String((b && b.title) || '').trim().slice(0, 300);
    const urlv = String((b && b.url) || '').trim().slice(0, 2000);
    const platform = String((b && b.platform) || '').trim().slice(0, 20);
    const analysis = String((b && b.analysis) || '').slice(0, 20000);
    const tags = String((b && b.tags) || '').trim().slice(0, 200);
    if (!title && !analysis) return sendJSON(res, 400, { error: '请至少填写标题或拆解内容' });
    db.prepare('INSERT INTO breakdown(user_id,title,url,platform,analysis,tags,created_at) VALUES(?,?,?,?,?,?,?)')
      .run(req._uid, title, urlv, platform, analysis, tags, nowISO());
    return sendJSON(res, 200, { ok: true });
  }

  return sendJSON(res, 404, { error: 'not found' });
}

function sanitizeCfg(obj, keys) {
  const out = {};
  if (obj && typeof obj === 'object') {
    for (const k of keys) if (typeof obj[k] === 'string') out[k] = obj[k].slice(0, 2000);
  }
  return out;
}

function buildMe(u, token) {
  // 取最近一次成功的快照 + 最近 20 条日志
  const snaps = db.prepare('SELECT platform,payload,created_at FROM sync_snapshots WHERE user_id=? ORDER BY id DESC LIMIT 10').all(u.id);
  const logs = db.prepare('SELECT platform,status,message,created_at FROM sync_logs WHERE user_id=? ORDER BY id DESC LIMIT 20').all(u.id);
  let shots = [];
  try { shots = JSON.parse(u.shots || '[]'); } catch (e) { shots = []; }
  let douyin = {}, xhs = {};
  try { douyin = JSON.parse(u.douyin || '{}'); } catch (e) {}
  try { xhs = JSON.parse(u.xhs || '{}'); } catch (e) {}
  const snapMap = {};
  for (const s of snaps) { try { snapMap[s.platform] = JSON.parse(s.payload); } catch (e) {} }
  return {
    token,
    ingestToken: INGEST_TOKEN,
    username: u.username,
    config: { douyin, xhs, syncInterval: u.sync_interval },
    shots,
    snapshots: snapMap,
    logs: logs.map(l => ({ platform: l.platform, status: l.status, message: l.message, createdAt: l.created_at })),
    lastSyncAt: u.last_sync_at || null
  };
}

/* ---------------- 主服务 ---------------- */
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
    } else {
      serveStatic(req, res, url.pathname);
    }
  } catch (e) {
    console.error('[server] error', e);
    if (!res.headersSent) sendJSON(res, 500, { error: 'server error' });
  }
});

function lanAddresses() {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const ni of ifaces[name] || []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address);
    }
  }
  return out;
}

server.listen(PORT, '0.0.0.0', () => {
  console.log('🚀 青山影像工作台后端已启动');
  console.log('   本机访问:  http://localhost:' + PORT);
  const lans = lanAddresses();
  if (lans.length) {
    console.log('   局域网(手机同WiFi访问):');
    lans.forEach(ip => console.log('     → http://' + ip + ':' + PORT));
  }
  console.log('   提示：要让手机/外网任意位置访问，请把本服务部署到一台公网 Node 主机（见 Dockerfile / render.yaml）。');
  // 启动调度器：每 15 分钟检查一次
  setInterval(schedulerTick, 15 * 60 * 1000);
  schedulerTick();
});
