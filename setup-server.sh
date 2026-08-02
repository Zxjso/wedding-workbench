#!/bin/bash
# 用法：在腾讯云/阿里云轻量服务器（Ubuntu/Debian/CentOS/OpenCloudOS，以 root 登录）终端里，
#       把本脚本内容粘贴运行，或保存后 bash setup-server.sh 执行。
set -e

# ===== 1/5 安装 Node.js 22 + git =====
if command -v apt-get &>/dev/null; then
  echo "== 1/5 安装 Node.js 22 + git (Debian/Ubuntu) =="
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get update -y
  apt-get install -y nodejs git
elif command -v dnf &>/dev/null; then
  echo "== 1/5 安装 Node.js 22 + git (RHEL/OpenCloudOS 8+) =="
  curl -fsSL https://rpm.nodesource.com/setup_22.x | bash -
  dnf install -y nodejs git
elif command -v yum &>/dev/null; then
  echo "== 1/5 安装 Node.js 22 + git (CentOS/OpenCloudOS/RHEL) =="
  curl -fsSL https://rpm.nodesource.com/setup_22.x | bash -
  yum install -y nodejs git
else
  echo "未能识别包管理器，请手动安装 Node.js 22 和 git 后再运行本脚本。"
  exit 1
fi

# ===== 2/5 拉取项目（公开仓库，无需令牌） =====
echo "== 2/5 拉取项目（公开仓库，无需令牌） =="
cd /root
rm -rf wedding-workbench
git clone https://github.com/Zxjso/wedding-workbench.git
cd wedding-workbench

# ===== 3/5 安装 pm2 进程守护（开机自启、崩溃自拉起） =====
echo "== 3/5 安装 pm2 进程守护（开机自启、崩溃自拉起） =="
npm install -g pm2

# ===== 4/5 启动服务（端口 3000） =====
echo "== 4/5 启动服务（端口 3000） =="
PORT=3000 pm2 start server.js --name workbench
pm2 startup
pm2 save

# ===== 5/5 开放系统防火墙端口 3000 =====
echo "== 5/5 开放系统防火墙端口 3000 =="
if command -v ufw &>/dev/null; then
  ufw allow 3000/tcp || true
elif command -v firewall-cmd &>/dev/null; then
  firewall-cmd --permanent --add-port=3000/tcp || true
  firewall-cmd --reload || true
else
  echo "未检测到 ufw/firewalld，请手动放行端口 3000。"
fi

echo ""
echo "=================================================="
echo "✅ 部署完成！"
echo "下一步（重要）：到云厂商控制台的『防火墙』添加入站规则："
echo "   协议 TCP   端口 3000   来源 0.0.0.0/0"
echo "然后浏览器访问：  http://<你的服务器公网IP>:3000"
echo "（想去掉 :3000，把上面 PORT=3000 改成 PORT=80，并在控制台放行 80）"
echo "=================================================="
