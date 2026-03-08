FROM node:20-alpine

WORKDIR /app

# 先复制依赖文件，利用 Docker 层缓存
COPY package.json package-lock.json ./
RUN npm ci --production

# 复制应用代码和静态文件
COPY server.js ./
COPY static/ ./static/
COPY .env.example ./

EXPOSE 8800

CMD ["node", "server.js"]
