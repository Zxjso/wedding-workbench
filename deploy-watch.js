/**
 * deploy-watch.js —— 工作台自动部署 + 企业微信上线通知守护进程
 *
 * 作用：
 *   1. 每隔 WB_DEPLOY_CHECK_SEC 秒（默认 300）在仓库目录执行 `git pull`
 *   2. 若检测到有新提交（HEAD 变化），自动 `pm2 restart workbench` 使新代码生效
 *   3. 通过企业微信群机器人 Webhook 推送「已自动更新」通知到群里
 *
 * 企业微信 Webhook 配置（二选一，推荐环境变量）：
 *   - 环境变量：WB_WECOM_WEBHOOK=https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxxx
 *   - 或文件：    data/wecom_webhook.txt（一行 Webhook 地址，data/ 已被 gitignore，不会进仓库）
 *
 * 其他可选环境变量：
 *   - WB_DEPLOY_CHECK_SEC  轮询间隔秒数（默认 300）
 *   - WB_PUBLIC_URL        工作台公网地址，用于通知里附链接（默认 http://124.220.208.18:3000）
 *
 * 启动（在服务器上）：
 *   WB_WECOM_WEBHOOK="https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxxx" \
 *     pm2 start deploy-watch.js --name workbench-deploy
 *   pm2 save
 */

'use strict';

const { execSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');

const REPO_DIR = __dirname;
const DATA_DIR = path.join(REPO_DIR, 'data');
const WEBHOOK_FILE = path.join(DATA_DIR, 'wecom_webhook.txt');
const INTERVAL_MS = (parseInt(process.env.WB_DEPLOY_CHECK_SEC, 10) || 300) * 1000;
const PUBLIC_URL = process.env.WB_PUBLIC_URL || 'http://124.220.208.18:3000';

function getWebhook() {
  if (process.env.WB_WECOM_WEBHOOK) return process.env.WB_WECOM_WEBHOOK.trim();
  try {
    return fs.readFileSync(WEBHOOK_FILE, 'utf8').trim();
  } catch (e) {
    return '';
  }
}

function currentHead() {
  try {
    return execSync('git rev-parse HEAD', { cwd: REPO_DIR }).toString().trim();
  } catch (e) {
    return '';
  }
}

function lastCommitInfo() {
  try {
    return execSync('git log -1 --pretty=format:"%h %s (%an, %ar)"', { cwd: REPO_DIR })
      .toString()
      .trim();
  } catch (e) {
    return '';
  }
}

function gitPull() {
  const r = spawnSync('git', ['pull'], { cwd: REPO_DIR, encoding: 'utf8' });
  return {
    code: r.status,
    out: `${r.stdout || ''}${r.stderr || ''}`.trim(),
  };
}

function restartWorkbench() {
  try {
    execSync('pm2 restart workbench', { cwd: REPO_DIR, stdio: 'ignore' });
    return true;
  } catch (e) {
    return false;
  }
}

function sendWecom(content) {
  const url = getWebhook();
  if (!url) {
    console.log('[deploy-watch] 未配置企微 Webhook，跳过通知');
    return;
  }
  let u;
  try {
    u = new URL(url);
  } catch (e) {
    console.log('[deploy-watch] Webhook 地址无效:', url);
    return;
  }
  const payload = JSON.stringify({ msgtype: 'markdown', markdown: { content } });
  const req = https.request(
    {
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    },
    (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => console.log('[deploy-watch] 企微通知响应:', body.trim() || res.statusCode));
    }
  );
  req.on('error', (e) => console.log('[deploy-watch] 企微通知失败:', e.message));
  req.write(payload);
  req.end();
}

function checkOnce() {
  const before = currentHead();
  if (!before) {
    console.log('[deploy-watch] 无法读取 git HEAD，跳过本轮');
    return;
  }
  const r = gitPull();
  if (r.code !== 0) {
    console.log('[deploy-watch] git pull 失败:', r.out.slice(0, 200));
    return;
  }
  const after = currentHead();
  if (after && after !== before) {
    console.log('[deploy-watch] 检测到新提交', after, '-> 重启 workbench');
    const ok = restartWorkbench();
    const info = lastCommitInfo();
    const content =
      `## 🚀 工作台已自动更新\n` +
      `> **新版本**: \`${after.slice(0, 8)}\`\n` +
      `> **提交**: ${info || after}\n` +
      `> **服务重启**: ${ok ? 'pm2 restart 成功 ✅' : '⚠️ 需手动 `pm2 restart workbench`'}\n` +
      `> **访问地址**: [${PUBLIC_URL}](${PUBLIC_URL})\n` +
      `> **时间**: ${new Date().toLocaleString('zh-CN')}\n\n` +
      `> 浏览器请按 <font color="warning">Ctrl+Shift+R</font> 强刷以加载新前端。`;
    sendWecom(content);
  }
}

const startHead = currentHead();
console.log(
  `[deploy-watch] 已启动，监控目录 ${REPO_DIR}，当前 HEAD ${startHead.slice(0, 8)}，` +
    `每 ${INTERVAL_MS / 1000}s 检查一次，企微通知=${getWebhook() ? '已配置' : '未配置'}`
);

// 启动时不主动通知；仅在有新提交时通知。
checkOnce(); // 立即检查一次
setInterval(checkOnce, INTERVAL_MS);
