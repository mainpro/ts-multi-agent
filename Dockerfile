# ---- 构建阶段 ----
FROM node:20-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install

COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# ---- 运行阶段 ----
FROM node:20-alpine AS runner

WORKDIR /app

# 安装运行时依赖：bubblewrap（沙箱隔离）+ bash（命令兼容性）
# 注意：bubblewrap 在容器内需要 setuid 权限才能创建 user namespace
RUN apk add --no-cache bubblewrap bash && \
    chmod u+s /usr/bin/bwrap

# 仅复制运行时所需文件
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist
COPY config/ ./config/

# 创建非 root 用户运行服务
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
USER appuser

EXPOSE 3000

ENV NODE_ENV=production
ENV PORT=3000

CMD ["node", "dist/index.js"]
