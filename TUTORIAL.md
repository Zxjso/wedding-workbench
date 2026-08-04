# 从零搭建一个「私有数字工作台」——以《青山影像·拍剪后期工作台》为例

> 这不是一份普通的产品说明，而是一份**制作教程**：把上面这个工作台从 0 到 1 是怎么做出来的，拆成可复用的思路和代码骨架。
> 你可以照着它，做出属于自己的「个人/工作室数字工作台」（婚摄、电商、自媒体、知识付费……皆可套用）。
> 项目代号：`qing-shan-workbench`，当前版本 `v1.5.3`。

---

## 0. 你能从这份教程学到什么

1. 用「**单文件前端 + 零依赖 Node 后端 + SQLite**」做出一个**私有、可多端同步**的 Web 应用——不用 React、不用数据库服务、不用 Docker 也能跑。
2. 怎么把它**部署到云服务器**，并且做到「我推代码，服务器自动更新 + 自动发通知」。
3. 怎么把**抖音 / 小红书**等外部平台的数据「抓」回来，接进自己的工作台（爬虫 + 摄取 API 的完整链路）。
4. 真实项目里**踩过的坑**和对应的设计决策——这是教程最有价值的部分。

---

## 1. 先看成品：它是长什么样的

「青山影像工作台」是一个给婚礼/婚纱摄影工作室用的私有后台，包含这些模块：

| 模块 | key | 作用 |
|------|-----|------|
| 数据总览 | `overview` | 工作室经营数据总览（含平台账号数据卡） |
| 我的视频 | `videos` | 管理自有视频，并和平台作品做对照 |
| 数据看板 | `metrics` | 展示抖音/小红书抓取来的播放、点赞、私信 |
| 财务与订单 | `finance` | 订单、收款、尾款管理 |
| 拍剪后期 | `delivered` | 拍摄/剪辑/交付进度管理 |
| 小青 AI 诊断 | `xiaoqing` | 视频体检（AI 能力） |
| 婚礼拍摄灵感库 | `viral` | 灵感素材收集 |

> 设计要点：**所有模块共用一套导航机制**，新增一个页面几乎零成本（见 §4.1）。

---

## 2. 技术选型原则（为什么这么做）

| 层 | 选型 | 理由 |
|----|------|------|
| 前端 | 单个 `index.html` + `auth.js` + `sw.js` | 零构建、好分发、可直接「添加到主屏幕」当 App |
| 后端 | Node.js 内置模块 `node:http` + `node:sqlite` + `node:crypto` | **零 npm 依赖**，部署只需 `node server.js` |
| 数据库 | SQLite（`data/wb.db`） | 文件即数据库，备份=复制一个文件 |
| 部署 | git + pm2 + 任意 Node 主机 | 最轻量，个人/小团队够用 |
| 爬虫 | Python + Playwright（**本机运行**，不进仓库） | 模拟登录自家后台抓数据，绕过平台密钥门槛 |
| 通知 | 企业微信群机器人 Webhook | 上线自动提醒，零额外 App |

**核心思想**：对个人/小工作室，**「能跑、好备份、好迁移」比「架构先进」重要十倍**。这个组合满足这三点。

---

## 3. 后端骨架：一个文件搞定（`server.js`）

后端只有 530 行，零依赖。关键点如下。

### 3.1 起服务 + 静态托管
用原生 `http` 模块起服务；非 `/api/` 的请求全部走静态文件托管，并做了**目录穿越防护**：

```js
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
  else serveStatic(req, res, url.pathname);
});
// serveStatic 里：const fp = path.normalize(path.join(ROOT, rel));
// if (!fp.startsWith(ROOT)) { 403 }   // 防 ../ 穿越
```

### 3.2 建库建表（node:sqlite）
Node ≥ 22.5 自带 `node:sqlite`，不用装任何东西：

```js
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(DB_PATH);
db.exec(`CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL,
  pw_hash TEXT NOT NULL, shots TEXT NOT NULL DEFAULT '[]', ...);
CREATE TABLE IF NOT EXISTS metrics_works(platform TEXT, wkey TEXT, title TEXT,
  play INTEGER, like INTEGER, collect INTEGER, comment INTEGER, ...);
CREATE TABLE IF NOT EXISTS metrics_daily(...);    -- 每日聚合快照
CREATE TABLE IF NOT EXISTS metrics_dm(...);       -- 私信`);
```

> 表设计哲学：**「平台作品」和「私信」分开存**，抓取时 upsert（按 `platform|标题` 主键），所以重复跑不会翻倍。

### 3.3 账号系统（注册 / 登录 / 多端会话）
- 密码用 `crypto.scryptSync` 加盐哈希，**绝不存明文**。
- 一个账号允许多端（手机+电脑）同时登录：每个账号在 `users.tokens` 里存一个 **token 数组**，每个 token 带过期时间（30 天）。

```js
function hashPw(pw){ const salt=crypto.randomBytes(16);
  return salt.toString('hex')+':'+crypto.scryptSync(pw,salt,64).toString('hex'); }
```

### 3.4 ⭐ 设计要点：双 Token 体系（安全隔离）
这是本项目很重要的一课——**用户登录 token** 和 **数据摄取 token（ingest token）** 必须分开：

- `ingest token`：爬虫/脚本用来**写入**数据（保存在服务器 `data/ingest_token.txt`，或环境变量 `WB_INGEST_TOKEN`）。
- 登录 token：用户用来**读取**数据。

两者互不相关：爬虫泄露只影响「能不能写入」，不影响用户账号。

```js
// 摄取接口只认 ingest token
const itok = req.headers['x-ingest-token'] || body.token || url.searchParams.get('token');
if (itok !== INGEST_TOKEN) return sendJSON(res, 401, {error:'ingest token invalid'});
```

### 3.5 数据摄取接口（`POST /api/metrics/ingest`）
爬虫把数据推到这里。支持两种传法：
- `{ platform:"xhs", items:[ {title,play,like,collect,comment}, ... ] }`
- `{ douyin:[...], xhs:[...], dms:{ douyin:[...], xhs:[...] } }`

写入时用 `parseCount` 把「1.2万 / 3,456 / 12.3亿」统一转成整数——这是后面 §7 踩坑修复过的关键函数。

### 3.6 数据读取接口（`GET /api/metrics`）
需登录 token，返回 `{ works, summary, daily, dms, dmSummary, lastSync }`。前端拿去画趋势图、爆款榜、私信概览。

---

## 4. 前端：单文件工作台（`index.html`）

### 4.1 ⭐ 导航委托机制（加页面零成本）
所有导航按钮带 `data-m` 属性，切换函数统一处理：

```js
function switchMod(m){
  $$(".modsec").forEach(s=>s.classList.toggle("on", s.id==="mod-"+m));
  $$(".nav-it").forEach(b=>b.classList.toggle("on", b.dataset.m===m));
  // 新页面只需在这里加一行触发：
  if(m==="metrics") loadMetrics();
  if(m==="videos") loadVideosMatch();
}
```

**新增一个模块 = 三处改动**：① 侧边栏加 `<button data-m="xxx">`；② 加一个 `<section id="mod-xxx">`；③ `switchMod` 里加一行加载函数。这就是「可扩展」的骨架。

### 4.2 模块密码锁（前端遮挡层）
「数据总览 / 财务 / 数据看板」设了密码 `qsyx2026`：

```js
const LOCK_PASS = 'qsyx2026';
const LOCKED_MODS = new Set(['overview','finance','metrics']);
```

点进去弹锁屏，输对一次，**本次会话内三个模块全解锁**。

> ⚠️ **诚实说明**：这个锁是**前端校验**，密码写在 JS 里，本质是「防随手点开」，不是银行级安全。要做到真安全，需要把密码校验移到后端（§8）。

### 4.3 版本化 Service Worker 缓存
`sw.js` 用版本号做缓存键，每次发布**必须 bump**，否则用户看到的是旧页面：

```js
const CACHE = 'wb-app-v1.5.3';
```

配套动作：服务器更新后，用户浏览器按 **Ctrl+Shift+R** 强刷即可拿到新前端。

---

## 5. 把外部平台数据接进来：爬虫 + 摄取

### 5.1 思路
抖音/小红书**没有给个人用的公开分析 API**，但你有自己的创作者后台。所以方案是：
**用 Playwright 在本机模拟登录你自己的后台 → 抓取作品数据 → 推给云端摄取接口 → 前端展示。**

风控（保命）原则：
- ✅ 只抓**你自己**的账号，不抓竞品
- ✅ 用**本地正常宽带**，别挂代理
- ✅ 同步间隔 **≥ 60 分钟**
- ✅ 仅个人数据备份，不商用

### 5.2 爬虫设计（`crawler/crawl_self.py`，本机运行，已被 gitignore）
关键设计：
- **环境变量驱动**：`WORKBENCH_URL`（云端地址）、`WB_TOKEN`（摄取令牌）、`XHS_WORKS_URL` / `XHS_DM_URL`（小红书地址，因为平台地址常变，做成可覆盖最稳）。
- **参数化**：`--once`（单次）、`--xhs-only`（只抓小红书，跳过抖音）、`--debug`（打印每个作品的原始文本，便于校准）。
- **登录态复用**：`launch_persistent_context` 把登录态存到本地 `profile/`，首次扫码后以后免登录。
- **隐藏自动化特征**：`--disable-blink-features=AutomationControlled` + `navigator.webdriver = undefined`，降低被平台检测风险。

推送代码极简：

```python
payload = {"platform":"xhs","items":items,"dms":dms,"ts":int(time.time())}
req = urllib.request.Request(WORKBENCH_URL, data=json.dumps(payload).encode(),
    headers={"Content-Type":"application/json","x-ingest-token":WB_TOKEN}, method="POST")
urllib.request.urlopen(req, timeout=20)
```

### 5.3 完整链路
```
本机 Playwright 爬虫 ──POST /api/metrics/ingest──► server.js ──► data/wb.db
                                                          │
                                          前端 /api/metrics ──► 数据看板/总览/我的视频
```

---

## 6. 部署上线（让别人也能访问）

### 6.1 本地 / 局域网
```bash
node server.js          # 默认端口 3000，PORT=8080 可改
# 手机连同一 WiFi 打开 http://<电脑局域网IP>:3000 即可同步
```

### 6.2 云服务器一键部署（`setup-server.sh`）
在腾讯云/阿里云轻量（Ubuntu/OpenCloudOS 均可）以 root 跑这个脚本，它会自动：
1. 装 Node.js 22 + git
2. `git clone` 项目
3. 装 pm2 并 `pm2 start server.js`（崩溃自拉起、开机自启）
4. 放行防火墙 3000 端口

> 最后一步还要去**云厂商控制台**的「防火墙」加一条入站规则：`TCP 3000 来源 0.0.0.0/0`。
> 想去掉网址里的 `:3000`，把 `PORT=3000` 改成 `PORT=80` 并放行 80。

### 6.3 ⭐ 自动更新 + 上线通知（`deploy-watch.js`）
把「我改代码推 GitHub → 服务器自动拉取重启 → 发企微通知」全自动化：

```js
// 每 WB_DEPLOY_CHECK_SEC 秒(默认300)检查 git
// 发现 HEAD 变化 → pm2 restart workbench → POST 企微群机器人 Webhook
```

启动方式（Webhook 来自企业微信「群机器人」）：

```bash
WB_WECOM_WEBHOOK="https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxxx" \
pm2 start deploy-watch.js --name workbench-deploy && pm2 save
```

之后你**只管写代码推 GitHub**，服务器自己更新，群里收到 🚀 提醒。

### 6.4 其他部署方式
仓库里还准备了 `Dockerfile` / `render.yaml` / `railway.json` / `Procfile`，可一键部署到 Render、Railway 等平台（注意要给数据目录挂持久卷，否则重启丢数据）。

---

## 7. ⭐ 踩坑清单（经验值）

| 坑 | 现象 | 解法 |
|----|------|------|
| SQL 保留字 `like` | `SUM(like)` 报语法错 | 别名 `plays/likes` 再映射回字段名 |
| **日期被当成播放量** | 数据里出现 `2026`、`08-03` | `parseCount` 显式拒绝 `20xx-`、`MM-DD`、`HH:MM` 等日期时间格式 |
| 小红书地址会变 | 默认 URL 返回 404 | 做成环境变量 `XHS_WORKS_URL` 覆盖，别写死 |
| 二维码过期 / 登录态丢失 | 爬虫来不及扫码就跑完 | `persistent_context` 存登录态；检测到登录页就 `input()` 暂停等人扫 |
| 爬虫解析错位 | 播放/点赞对不上 | 优先「按标签提取」（数字+赞/收藏），找不到才按出现顺序兜底 |
| pm2 显示版本不对 | 列表写 1.4.0 实际已 1.5.x | pm2 读 `package.json` 的 version，记得同步 bump |
| Service Worker 缓存 | 前端更新了浏览器还是旧的 | 每次发版 bump `sw.js` 的 `CACHE` 版本号 + 用户强刷 |

---

## 8. 安全与边界（务必看）

1. **前端密码锁 ≠ 真安全**：密码写在 JS 里，懂技术的人能翻到。敏感模块建议把校验移到后端（登录后服务端判断是否放行）。
2. **公网部署务必**：用强密码、尽量上 HTTPS（可用 Caddy/Nginx 反代免费证书）。
3. **ingest token 要保密**：它等于「写数据权限」，泄露了别人能往你库里塞数据。
4. **爬虫合规**：只抓自己账号、本地网络、低频、不商用，风险可控；批量抓竞品或高频请求有封号/法律风险。

---

## 9. 一分钟上手清单（给想复刻的你）

```bash
# 1. 跑起来
git clone <你的仓库> && cd wedding-workbench
node server.js
# 浏览器打开 http://localhost:3000 → 注册账号（6位用户名+6位字母数字密码）

# 2. 部署到云（服务器上）
bash setup-server.sh
# 控制台放行 3000 端口

# 3. 自动更新+通知（服务器上，可选）
WB_WECOM_WEBHOOK="https://qyapi.weixin.qq.com/...key=xxxx" \
pm2 start deploy-watch.js --name workbench-deploy && pm2 save

# 4. 抓小红书数据（本机，需先装 Playwright）
cd crawler
python -m venv .venv && .venv\Scripts\Activate.ps1
pip install playwright && playwright install chromium
$env:WORKBENCH_URL="http://<你的服务器IP>:3000/api/metrics/ingest"
$env:WB_TOKEN="从数据看板页复制的令牌"
python -u crawl_self.py --once --xhs-only --debug
```

---

## 10. 这份教程对应的真实文件清单

| 文件 | 作用 | 行数 |
|------|------|------|
| `index.html` | 单文件前端（导航/各模块/密码锁/SVG 图表） | ~3765 |
| `auth.js` | 前端鉴权与云同步逻辑 | ~265 |
| `sw.js` | PWA 离线壳 + 版本化缓存 | ~168 |
| `server.js` | 零依赖后端：静态托管 + API + SQLite | ~530 |
| `deploy-watch.js` | 服务器自动 git pull + 重启 + 企微通知 | ~148 |
| `setup-server.sh` | 云服务器一键部署脚本 | ~60 |
| `crawler/crawl_self.py` | 本机 Playwright 爬虫（**不进仓库**） | ~500 |
| `package.json` / `version.json` | 版本与启动配置 | — |

> 想看完整实现，整个项目就是最好的教材：`clone` 下来，从 `server.js` 的 `handleApi` 读起，再读 `index.html` 的 `switchMod`，最后读 `crawler/crawl_self.py`，一条数据链路就通了。

---

*教程基于 `qing-shan-workbench` v1.5.3 整理。可自由分享、改写，用于学习或个人项目。*
