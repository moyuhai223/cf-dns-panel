# ---- 构建前端 ----
FROM node:22-bookworm-slim AS web
WORKDIR /app/web
COPY web/package*.json ./
RUN npm install
COPY web/ ./
# 如需子路径反代:--build-arg BASE_PATH=/dns
ARG BASE_PATH=
ENV BASE_PATH=${BASE_PATH}
RUN npm run build   # 产物输出到 /app/public

# ---- 运行后端 ----
FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787
# better-sqlite3 在 linux 提供预编译二进制,通常无需编译工具
COPY package*.json ./
RUN npm install --omit=dev
COPY server/ ./server/
COPY --from=web /app/public ./public

# 数据(数据库 + 自动生成的密钥)持久化到该卷
VOLUME /app/data
EXPOSE 8787
CMD ["node", "server/index.js"]
