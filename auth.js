/* ============================================================
 *  auth.js —— 注册登录门禁 + 云端同步中心
 *  依赖主脚本已定义的全局：store / $ / $$ / toast / dlShots /
 *  saveDlShots / renderDeliverAll / D_STATUS 等
 * ============================================================ */
(function () {
  'use strict';

  /* ---------- API 客户端 ---------- */
  async function api(method, pathname, body) {
    try {
      const opt = { method, headers: { 'content-type': 'application/json' } };
      if (body) opt.body = JSON.stringify(body);
      const r = await fetch(pathname, opt);
      let data = {};
      try { data = await r.json(); } catch (e) {}
      if (r.ok) return { ok: true, status: r.status, data };
      if (r.status === 404) return { ok: false, offline: true, status: 404, data };
      return { ok: false, status: r.status, data };
    } catch (e) {
      return { ok: false, offline: true, status: 0, data: {} };
    }
  }

  /* ---------- 全局状态 ---------- */
  let wbCfg = { douyin: {}, xhs: {}, syncInterval: 'daily' };
  let curMe = null;

  let memToken = null;
  function getToken() { return store.get('wb_token', null) || memToken; }
  function getMeState() { return curMe; }

  /* ---------- 登录门禁 ---------- */
  function showGate(mode) {
    const g = document.getElementById('loginGate');
    if (!g) return;
    g.style.display = 'flex';
    switchGateTab(mode || 'login');
  }
  function hideGate() {
    const g = document.getElementById('loginGate');
    if (g) g.style.display = 'none';
  }
  function switchGateTab(tab) {
    const isReg = tab === 'register';
    document.querySelectorAll('#loginGate .gt-tab').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
    document.getElementById('gateTitle').textContent = isReg ? '注册工作台账号' : '登录工作台';
    document.getElementById('gateSubmit').textContent = isReg ? '注册并进入' : '登录';
    document.getElementById('gateHint').textContent = isReg
      ? '用户名 6 位字母/数字；密码 6 位，且同时含字母和数字。'
      : '输入账号密码，登录后自动同步你的全部配置与历史数据。';
    document.getElementById('gateMode').value = isReg ? 'register' : 'login';
  }
  function gateErr(msg) {
    const e = document.getElementById('gateErr');
    e.textContent = msg || '';
    e.style.display = msg ? 'block' : 'none';
  }

  async function gateSubmit() {
    const mode = document.getElementById('gateMode').value;
    const username = document.getElementById('gateUser').value.trim();
    const password = document.getElementById('gatePwd').value;
    gateErr('');
    if (!/^[A-Za-z0-9]{6}$/.test(username)) { gateErr('用户名必须是 6 位字母或数字'); return; }
    if (!/^(?=.*[A-Za-z])(?=.*[0-9])[A-Za-z0-9]{6}$/.test(password)) { gateErr('密码必须是 6 位，且同时包含字母和数字'); return; }
    const r = mode === 'register'
      ? await api('POST', '/api/register', { username, password })
      : await api('POST', '/api/login', { username, password });
    if (!r.ok) {
      if (r.offline) gateErr('无法连接服务器，请确认后端已启动（node server.js）');
      else gateErr(r.data.error || '操作失败');
      return;
    }
    const remember = document.getElementById('gateRemember') ? document.getElementById('gateRemember').checked : false;
    if (remember) {
      store.set('wb_token', r.data.token);
      store.set('wb_user', r.data.username);
    } else {
      memToken = r.data.token; // 仅存内存：刷新页面即失效，强制重新登录
    }
    enterApp(r.data);
  }

  async function enterApp(me) {
    curMe = me; wbCfg = me.config || wbCfg;
    const t = getToken();
    let cloud = Array.isArray(me.shots) ? me.shots : [];
    // 关键修复：云端为空但本地有数据 → 先把本地上传，避免「登录即被清空」
    if (cloud.length === 0 && Array.isArray(dlShots) && dlShots.length && t) {
      const r = await api('POST', '/api/shots', { token: t, shots: dlShots });
      if (r.ok) { cloud = dlShots.map(s => ({ ...s })); if (curMe) curMe.shots = cloud; }
    }
    if (cloud.length) { dlShots = cloud.map(s => ({ ...s })); store.set('wb_shots', dlShots); }
    else if (t) { await api('POST', '/api/shots', { token: t, shots: dlShots || [] }); }
    hideGate();
    renderSessBar();
    renderAcct(me);
    if (typeof renderDeliverAll === 'function') renderDeliverAll();
    if (cloud.length) toast('已同步 ' + cloud.length + ' 场拍剪后期数据 ✅');
    else toast('欢迎，' + me.username + ' 👋');
    startPollSync();
  }

  async function doLogout() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    const t = getToken();
    if (t) await api('POST', '/api/logout', { token: t });
    store.set('wb_token', null);
    store.set('wb_user', null);
    store.set('wb_shots', null);
    memToken = null;
    dlShots = [];
    location.reload();
  }

  /* ---------- 会话条 ---------- */
  function renderSessBar() {
    const bar = document.getElementById('sessBar');
    if (!bar) return;
    const u = store.get('wb_user', '');
    bar.style.display = 'flex';
    bar.querySelector('#sessUser').textContent = '👤 ' + u;
  }

  /* ---------- 账号同步中心 ---------- */
  function renderAcct(me) {
    me = me || curMe; if (!me) return;
    const set = (id, txt) => { const el = document.getElementById(id); if (el) el.textContent = txt; };
    set('acctUser', me.username);
    const dy = me.config && me.config.douyin;
    const xh = me.config && me.config.xhs;
    set('acctDy', (dy && dy.clientId) ? '已配置' : '未配置');
    set('acctXhs', (xh && xh.token) ? '已配置' : '未配置');
    set('acctLast', me.lastSyncAt ? new Date(me.lastSyncAt).toLocaleString('zh-CN') : '—');
    const box = document.getElementById('acctLog');
    if (box) {
      if (!me.logs || !me.logs.length) {
        box.innerHTML = '<p style="font-size:.74rem;color:var(--faint);margin:0">暂无同步记录，点上方按钮立即同步。</p>';
      } else {
        box.innerHTML = me.logs.slice(0, 8).map(l => {
          const c = l.status === 'ok' ? 'var(--green)' : 'var(--red)';
          const ic = l.status === 'ok' ? '✅' : '⚠️';
          return '<div style="display:flex;gap:6px;font-size:.74rem;padding:4px 0;border-top:1px dashed var(--line)">' +
            '<span style="color:' + c + '">' + ic + '</span>' +
            '<span style="color:var(--muted)">[' + (l.platform === 'douyin' ? '抖音' : '小红书') + ']</span>' +
            '<span style="flex:1">' + esc(l.message) + '</span>' +
            '<span style="color:var(--faint)">' + (l.createdAt || '').slice(5, 16).replace('T', ' ') + '</span></div>';
        }).join('');
      }
    }
  }
  function esc(s) { return String(s || '').replace(/[&<>"]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m])); }

  function acctOpenSettings() {
    const m = curMe; if (!m) return;
    document.getElementById('acctDyId').value = (m.config && m.config.douyin && m.config.douyin.clientId) || '';
    document.getElementById('acctDySecret').value = (m.config && m.config.douyin && m.config.douyin.clientSecret) || '';
    document.getElementById('acctXhsToken').value = (m.config && m.config.xhs && m.config.xhs.token) || '';
    document.getElementById('acctInterval').value = (m.config && m.config.syncInterval) || 'daily';
    document.getElementById('acctModal').style.display = 'flex';
  }
  function acctCloseSettings() { document.getElementById('acctModal').style.display = 'none'; }

  async function acctSaveSettings() {
    const body = {
      token: getToken(),
      douyin: { clientId: document.getElementById('acctDyId').value.trim(), clientSecret: document.getElementById('acctDySecret').value.trim() },
      xhs: { token: document.getElementById('acctXhsToken').value.trim() },
      syncInterval: document.getElementById('acctInterval').value
    };
    const r = await api('POST', '/api/config', body);
    if (!r.ok) { toast(r.offline ? '无法连接服务器' : (r.data.error || '保存失败')); return; }
    curMe.config = { douyin: body.douyin, xhs: body.xhs, syncInterval: body.syncInterval };
    acctCloseSettings();
    toast('授权配置已保存 ☁️');
    renderAcct(curMe);
  }

  async function acctSync(platform) {
    toast('正在同步' + (platform === 'douyin' ? '抖音' : '小红书') + '…');
    const r = await api('POST', '/api/sync', { token: getToken(), platform });
    if (!r.ok) { toast(r.offline ? '无法连接服务器' : (r.data.error || '同步失败')); return; }
    const res = (r.data.results || [])[0] || {};
    // 刷新 me
    const me = await api('GET', '/api/me?token=' + encodeURIComponent(getToken()));
    if (me.ok) { curMe = me.data; renderAcct(curMe); }
    toast((platform === 'douyin' ? '抖音' : '小红书') + '：' + (res.message || (res.status === 'ok' ? '同步成功' : '同步失败')));
  }

  /* ---------- 列表变更钩子：同步到云端 ---------- */
  window.wbGetToken = getToken; // 供数据看板等模块取登录 token
  window.pushShots = function () {
    const t = getToken(); if (!t) return;
    api('POST', '/api/shots', { token: t, shots: dlShots }).then(r => {
      if (r.ok && curMe) { curMe.shots = Array.isArray(dlShots) ? dlShots : []; }
    });
  };

  /* ---------- 自动同步轮询：登录后每 12 秒拉取云端，实现多端近实时互通 ---------- */
  let pollTimer = null;
  function startPollSync() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(async () => {
      const t = getToken(); if (!t) return;
      const me = await api('GET', '/api/me?token=' + encodeURIComponent(t));
      if (me.ok && Array.isArray(me.data.shots)) {
        dlShots = me.data.shots.map(s => ({ ...s }));
        store.set('wb_shots', dlShots);
        if (typeof renderDeliverAll === 'function') renderDeliverAll();
        curMe = me.data;
      }
    }, 12000);
  }

  /* ---------- boot ---------- */
  async function bootAuth() {
    const ping = await api('GET', '/api/ping');
    if (ping.offline || !ping.ok) {
      // 后端不可达：本地模式，不强制登录
      const g = document.getElementById('loginGate'); if (g) g.style.display = 'none';
      const bar = document.getElementById('sessBar'); if (bar) bar.style.display = 'none';
      // 提示：当前是本地模式，手机/电脑不会互通。运行 server.js 托管本页即可开启云同步。
      if (typeof toast === 'function') {
        toast('当前为本地模式：数据只存在本机。运行 node server.js 托管本页后，手机与电脑即可同步');
      }
      return;
    }
    const token = getToken();
    if (token) {
      const me = await api('GET', '/api/me?token=' + encodeURIComponent(token));
      if (me.ok) { enterApp(me.data); return; }
      store.set('wb_token', null);
    }
    showGate('login');
  }

  /* ---------- 事件绑定 ---------- */
  function bind() {
    const sb = document.getElementById('sessBar');
    if (sb) sb.querySelector('#sessLogout').onclick = doLogout;
    const g = document.getElementById('loginGate');
    if (g) {
      g.querySelectorAll('.gt-tab').forEach(b => b.onclick = () => switchGateTab(b.dataset.tab));
      document.getElementById('gateSubmit').onclick = gateSubmit;
      document.getElementById('gateUser').addEventListener('keydown', e => { if (e.key === 'Enter') gateSubmit(); });
      document.getElementById('gatePwd').addEventListener('keydown', e => { if (e.key === 'Enter') gateSubmit(); });
    }
    const m = document.getElementById('acctModal');
    if (m) {
      m.querySelector('#acctSave').onclick = acctSaveSettings;
      m.querySelector('#acctClose').onclick = acctCloseSettings;
      m.addEventListener('click', e => { if (e.target === m) acctCloseSettings(); });
    }
  }

  // 暴露给内联 onclick
  window.acctOpenSettings = acctOpenSettings;
  window.acctSync = acctSync;
  window.doLogout = doLogout;

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => { bind(); bootAuth(); });
  else { bind(); bootAuth(); }
})();
