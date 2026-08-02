#!/bin/bash
# 在云服务器上运行：拉取最新代码并重启服务（数据 data/ 已被 gitignore，不会被覆盖）
set -e
cd /root/wedding-workbench
echo "== 拉取最新代码 =="
git pull
echo "== 重启服务 =="
pm2 restart workbench
echo "✅ 已更新并重启。浏览器刷新即可（前端若没变，按 Ctrl+Shift+R 强刷）"
