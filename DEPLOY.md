# 部署文档

## 要求

- Node.js >= 20
- 端口: 3000（通过环境变量 `PORT` 配置，也支持 `--port=3000` 命令行参数）

## 快速开始

```bash
# 1. 安装依赖
npm install

# 2. 配置 API Key（编辑 .env）
#    构建时会自动复制 .env.example 到 dist/.env
#    LLM Provider 配置可参考 .env.example 中的注释

# 3. 构建（tsup 打包成单文件 dist/index.js）
npm run build

# 4. 启动
npm start --port=3000
```

## 部署 dist/

`npm run build` 产出 `dist/` 目录，可直接分发运行，不需要源码和 node_modules：

```bash
# 目标服务器上先编辑 dist/.env 配置 API Key
node dist/index.js
```

```
dist/
├── index.js          ← 单文件，含 express/zod 等所有依赖
├── .env              ← 部署时编辑
├── AGENTS.md
├── improvement.md
├── skills/
├── system-skills/
└── public/
```

## Docker 部署

### Docker Compose

```bash
docker compose up -d
docker compose logs -f
```

### Docker 手动部署

```bash
# 构建镜像
docker build -t ts-multi-agent .

# 运行容器
docker run -d \
  --name ts-multi-agent \
  -p 3000:3000 \
  --env-file .env \
  -v $(pwd)/data:/app/data \
  --restart unless-stopped \
  ts-multi-agent
```

## Nginx 反向代理

```nginx
upstream ts_multi_agent {
    server 127.0.0.1:3000;
}

server {
    listen 443 ssl;
    server_name your-domain.com;

    # SSE 流式接口需要关闭缓冲
    location /tasks/stream {
        proxy_pass http://ts_multi_agent;
        proxy_http_version 1.1;
        proxy_buffering off;
        proxy_read_timeout 300s;
    }

    location / {
        proxy_pass http://ts_multi_agent;
        proxy_http_version 1.1;
    }
}
```
