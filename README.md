# 青山影像 · 拍剪后期工作台（含后端）

单文件前端 + 零依赖 Node.js 后端（内置 SQLite），支持账号注册/登录、手机电脑多端同步、抖音/小红书授权配置与同步引擎。

## 目录
- `index.html` 前端页面（含登录门禁、账号同步中心）
- `auth.js` 前端鉴权与云同步逻辑
- `sw.js` PWA 离线壳
- `server.js` 后端：静态托管 + `/api/*` 接口 + SQLite 持久化 + 定时同步
- `package.json` 启动脚本
- `Dockerfile` / `render.yaml` / `railway.json` / `Procfile` 一键部署配置

## 本地运行
```bash
node server.js          # 默认端口 3000，可用 PORT=8080 覆盖
# 浏览器打开 http://localhost:3000
# 手机连同一 WiFi 打开 http://<电脑局域网IP>:3000 即可同步
```
数据库文件在 `data/wb.db`（SQLite，永久留存）。

## 部署到公网（手机/电脑任意地点同步）
> 静态托管平台（如 CloudStudio）**不能**运行后端，门禁不会生效。
> 必须把这整个项目部署到 Node 主机，由 `server.js` 同域托管前端。

### 方式 A：Render（推荐，磁盘持久化）
1. 把本项目推到你的 GitHub 仓库。
2. 打开 https://render.com → New → Web Service → 连接该仓库。
3. Render 会自动读取 `render.yaml`：构建命令 `true`、启动 `node server.js`、挂载 1GB 磁盘到 `/app/data`。
4. 部署完成后，Render 给一个 `https://xxx.onrender.com` 域名，打开即要求注册/登录，手机电脑互通。

### 方式 B：Railway
1. 把本项目推到 GitHub。
2. 打开 https://railway.app → New Project → Deploy from GitHub repo。
3. Railway 读取 `railway.json`（`node server.js`）。
4. 为保证数据永久留存，在 Railway 项目里添加 **Volume**，挂载到 `/app/data`，并设置环境变量 `WB_DB=/app/data/wb.db`。

## 账号规则
- 用户名：6 位字母或数字
- 密码：6 位，且同时包含字母和数字
- 同一账号可在手机 + 电脑同时登录，数据互相隔离、自动同步
- 登录后 token 存浏览器，不点「退出登录」就保持登录、重开自动加载

## 同步引擎
- 登录即时同步；可设置每 1 小时 / 4 小时 / 每天定时同步
- 抖音/小红书需先在对应开放平台创建应用并填入 ClientID / 密钥 / Token
- 未授权或网络异常时，工作台会记录并提示「抖音授权过期 / 网络异常」
