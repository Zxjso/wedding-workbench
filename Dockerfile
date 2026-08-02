# 青山影像·拍剪后期工作台 后端镜像
# 用法：
#   docker build -t qsy-workbench .
#   docker run -d --name wb -p 3000:3000 -v wb_data:/app/data qsy-workbench
# 然后访问 http://<服务器IP>:3000  （手机同网络或已做端口映射均可访问）
FROM node:22.5-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev 2>/dev/null || true
COPY . .
RUN mkdir -p /app/data
ENV PORT=3000
EXPOSE 3000
CMD ["node", "server.js"]
