# ts-multi-agent 部署文档

## 目录

- [1. 环境要求](#1-环境要求)
- [2. 快速开始](#2-快速开始)
- [3. 环境变量配置](#3-环境变量配置)
- [4. 安装与构建](#4-安装与构建)
- [5. 启动方式](#5-启动方式)
- [6. API 端点说明](#6-api-端点说明)
- [7. 健康检查](#7-健康检查)
- [8. Docker 部署（推荐生产环境）](#8-docker-部署推荐生产环境)
- [9. Nginx 反向代理配置](#9-nginx-反向代理配置)
- [10. PM2 进程管理](#10-pm2-进程管理)
- [11. 业务配置说明](#11-业务配置说明)
- [12. 常见问题排查](#12-常见问题排查)

---

## 1. 环境要求

| 项目 | 最低版本 | 推荐版本 |
|------|---------|---------|
| Node.js | >= 18.0.0 | 20.x LTS |
| Bun（开发环境） | >= 1.0.0 | 最新稳定版 |
| npm / yarn / pnpm | 任意 | npm 10.x |
| 操作系统 | Linux / macOS | Ubuntu 22.04 LTS |
| 内存 | 512MB | 2GB+ |
| 磁盘 | 200MB | 1GB+ |
| Shell | /bin/sh（必须） | /bin/bash |

> **注意**：
> - 生产环境推荐使用 Node.js 运行编译后的代码，开发环境使用 Bun 以获得更快的重启速度。
> - 系统必须安装 `/bin/sh`（所有 Linux 发行版默认自带）。如果使用 `/bin/bash`，可获更好的命令兼容性，但非必须。
> - 如需启用沙箱隔离（推荐），需安装 bubblewrap（见下方说明）。

---

## 2. 快速开始

```bash
# 1. 克隆项目
git clone <repository-url>
cd ts-multi-agent

# 2. 安装依赖
npm install

# 3. 配置环境变量
cp .env.example .env
# 编辑 .env 文件，填入实际的 API Key

# 4. 构建
npm run build

# 5. 启动
npm start
```

服务默认监听 **3000** 端口，启动后访问 `http://localhost:3000/health` 验证是否正常运行。

---

## 3. 环境变量配置

复制 `.env.example` 为 `.env`，根据实际需要配置：

### 3.1 LLM Provider 配置（必填，至少配置一个）

```bash
# 方式一：OpenRouter（推荐免费方案）
OPENROUTER_API_KEY=sk-or-v1-xxxxxxxx

# 方式二：NVIDIA API
NVIDIA_API_KEY=nvapi-xxxxxxxx

# 方式三：智谱 AI
ZHIPU_API_KEY=xxxxxxxx

# 方式四：SiliconFlow
SILICONFLOW_API_KEY=sk-xxxxxxxx
```

### 3.2 模型配置（必填）

```bash
# 当前激活的 LLM 提供商
LLM_PROVIDER=siliconflow

# 使用的模型名称
LLM_MODEL=Pro/MiniMaxAI/MiniMax-M2.5

# API 基础地址
LLM_BASE_URL=https://api.siliconflow.cn/v1/
```

**各 Provider 对应配置示例**：

| Provider | LLM_PROVIDER | LLM_MODEL | LLM_BASE_URL |
|----------|-------------|-----------|-------------|
| OpenRouter | `openrouter` | `qwen/qwen3.6-plus-preview:free` | `https://openrouter.ai/api/v1/` |
| NVIDIA | `nvidia` | `minimax-m2.5` | `https://integrate.api.nvidia.com/v1/` |
| 智谱 AI | `zhipu` | `glm-4-flash` | `https://open.bigmodel.cn/api/paas/v4/` |
| SiliconFlow | `siliconflow` | `Pro/MiniMaxAI/MiniMax-M2.5` | `https://api.siliconflow.cn/v1/` |

### 3.3 业务配置（可选）

```bash
# 保底机制配置文件（位于 config/ 目录下）
# 可选值：fallback.md（默认运维）、ecommerce.md（电商）
FALLBACK_CONFIG=fallback.md
```

---

## 4. 安装与构建

### 4.1 安装依赖

```bash
# 使用 npm
npm install

# 或使用 bun（更快）
bun install
```

### 4.2 TypeScript 编译

```bash
npm run build
```

编译产物输出到 `dist/` 目录，包含：
- `dist/index.js` — 入口文件
- `dist/**/*.js` — 各模块编译产物
- `dist/**/*.d.ts` — TypeScript 类型声明
- `dist/**/*.js.map` — Source Map 文件

### 4.3 运行测试

```bash
# 使用 bun 运行测试
bun test

# 监听模式
bun test --watch
```

---

## 5. 启动方式

### 5.1 开发模式（热重载）

```bash
# 使用 bun --watch 实现文件变更自动重启
npm run dev
```

### 5.2 生产模式

```bash
# 先编译
npm run build

# 再启动
npm start
```

### 5.3 直接使用 Node.js

```bash
node dist/index.js
```

### 5.4 指定端口

支持两种方式指定端口，优先级为 **命令行参数 > 环境变量 > 默认值 3000**：

```bash
# 方式一：命令行参数（优先级最高）
node dist/index.js --port=8080

# 方式二：环境变量
PORT=8080 node dist/index.js

# 方式三：都不指定，默认 3000
node dist/index.js
```

> 端口值会进行合法性校验（1-65535），无效值会回退到默认端口 3000。

---

## 6. API 端点说明

| 方法 | 端点 | 说明 |
|------|------|------|
| `GET` | `/health` | 健康检查 |
| `GET` | `/skills` | 列出所有已注册技能 |
| `GET` | `/metrics` | Prometheus 格式指标数据 |
| `POST` | `/tasks/stream` | SSE 流式任务提交 |
| `POST` | `/tasks/execute` | Plan Mode 执行确认 |
| `GET` | `/tasks/:id` | 查询任务状态 |
| `GET` | `/tasks/:id/result` | 获取任务结果 |
| `DELETE` | `/tasks/:id` | 取消任务 |

### 6.1 健康检查示例

```bash
curl http://localhost:3000/health
```

### 6.2 提交任务示例（SSE 流式）

```bash
curl -N -X POST http://localhost:3000/tasks/stream \
  -H "Content-Type: application/json" \
  -d '{"message": "你好", "sessionId": "test-session-001"}'
```

---

## 7. 健康检查

生产环境建议配置健康检查，确保服务可用：

```bash
# HTTP 健康检查
curl -sf http://localhost:3000/health || echo "Service down!"

# 在 crontab 或监控系统中使用
# 返回 200 表示服务正常
```

---

## 8. Docker 部署（推荐生产环境）

### 8.1 Dockerfile

项目根目录已提供 `Dockerfile`，采用多阶段构建：

```dockerfile
# ---- 构建阶段 ----
FROM node:20-alpine AS builder
# 安装依赖 + TypeScript 编译

# ---- 运行阶段 ----
FROM node:20-alpine AS runner
# 安装 bubblewrap（沙箱隔离）+ bash（命令兼容性）
# 关键：chmod u+s /usr/bin/bwrap — 解决容器内 user namespace 权限问题
# 创建非 root 用户运行服务
```

> **关于 bubblewrap setuid**：Docker 容器默认禁用了非特权 user namespace，bwrap 需要以 setuid root 权限运行才能创建隔离环境。Dockerfile 中已通过 `chmod u+s /usr/bin/bwrap` 处理。如果日志中出现 `Creating new namespace failed` 错误，请确认 bwrap 具有 setuid 权限：`ls -la /usr/bin/bwrap`（应显示 `-rwsr-xr-x`）。

### 8.2 .dockerignore

项目根目录已提供 `.dockerignore`，排除 `node_modules`、`dist`、`__tests__`、`.env` 等非必要文件，加速构建。

### 8.3 构建与运行

```bash
# 构建镜像
docker build -t ts-multi-agent:latest .

# 运行容器
docker run -d \
  --name ts-multi-agent \
  -p 3000:3000 \
  --env-file .env \
  -v $(pwd)/config:/app/config:ro \
  --restart unless-stopped \
  ts-multi-agent:latest

# 查看日志
docker logs -f ts-multi-agent

# 停止容器
docker stop ts-multi-agent
```

### 8.4 Docker Compose

项目根目录已提供 `docker-compose.yml`，包含健康检查和资源限制配置。

```bash
# 启动
docker compose up -d

# 查看状态
docker compose ps

# 查看日志
docker compose logs -f

# 停止
docker compose down
```

---

## 9. Nginx 反向代理配置

生产环境建议使用 Nginx 作为反向代理，提供 HTTPS、静态资源缓存和负载均衡。

```nginx
upstream ts_multi_agent {
    server 127.0.0.1:3000;
    keepalive 64;
}

server {
    listen 80;
    server_name your-domain.com;

    # 强制跳转 HTTPS
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name your-domain.com;

    ssl_certificate     /etc/nginx/ssl/cert.pem;
    ssl_certificate_key /etc/nginx/ssl/key.pem;

    # SSE 流式接口（关闭缓冲）
    location /tasks/stream {
        proxy_pass http://ts_multi_agent;
        proxy_http_version 1.1;
        proxy_set_header Connection '';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 300s;
    }

    # 常规 API 接口
    location / {
        proxy_pass http://ts_multi_agent;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";

        # 请求体大小限制（文件上传场景）
        client_max_body_size 50m;

        # 超时设置
        proxy_connect_timeout 60s;
        proxy_read_timeout 300s;
        proxy_send_timeout 60s;
    }

    # Prometheus 指标端点（限制内网访问）
    location /metrics {
        allow 127.0.0.1;
        allow 10.0.0.0/8;
        allow 172.16.0.0/12;
        allow 192.168.0.0/16;
        deny all;
        proxy_pass http://ts_multi_agent;
    }
}
```

---

## 10. PM2 进程管理

如果不使用 Docker，推荐使用 PM2 进行进程管理。

### 10.1 安装 PM2

```bash
npm install -g pm2
```

### 10.2 生态系统配置文件

创建 `ecosystem.config.js`：

```javascript
module.exports = {
  apps: [{
    name: 'ts-multi-agent',
    script: 'dist/index.js',
    instances: 1,            // 单实例模式（有状态服务）
    exec_mode: 'fork',
    autorestart: true,
    watch: false,
    max_memory_restart: '1G',
    env: {
      NODE_ENV: 'production',
      PORT: 3000
    },
    error_file: './logs/pm2-error.log',
    out_file: './logs/pm2-out.log',
    merge_logs: true,
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    time: true
  }]
};
```

### 10.3 常用命令

```bash
# 启动
pm2 start ecosystem.config.js

# 查看状态
pm2 status

# 查看日志
pm2 logs ts-multi-agent

# 重启
pm2 restart ts-multi-agent

# 停止
pm2 stop ts-multi-agent

# 删除进程
pm2 delete ts-multi-agent

# 设置开机自启
pm2 startup
pm2 save
```

---

## 11. 业务配置说明

### 11.1 保底机制配置

项目通过 `config/` 目录下的 Markdown 文件配置不同业务场景的保底策略：

| 配置文件 | 适用场景 |
|---------|---------|
| `config/fallback.md` | 通用运维场景（默认） |
| `config/ecommerce.md` | 电商客服场景 |

通过环境变量 `FALLBACK_CONFIG` 切换：

```bash
# 使用电商保底配置
FALLBACK_CONFIG=ecommerce.md node dist/index.js
```

### 11.2 自定义保底配置

在 `config/` 目录下创建新的 `.md` 文件，格式参考 `config/fallback.md`，包含以下章节：

```markdown
# 保底机制配置

## 转人工触发条件
## 反问约束
## 技能匹配规则
## 特殊情况判断
```

### 11.3 用户画像数据

用户画像存储在 `data/user-profile.json`，支持运行时读写更新。

---

## 12. 常见问题排查

### 12.1 启动失败

```bash
# 检查 Node.js 版本
node -v  # 需要 >= 18.0.0

# 检查编译产物是否存在
ls dist/index.js

# 检查端口是否被占用
lsof -i :3000
```

### 12.2 LLM 调用失败

```bash
# 确认 API Key 已正确配置
cat .env | grep API_KEY

# 确认 Provider 和 Model 配置匹配
cat .env | grep LLM_

# 测试 API 连通性
curl -H "Authorization: Bearer $SILICONFLOW_API_KEY" \
  https://api.siliconflow.cn/v1/models
```

### 12.3 SSE 流式响应中断

- 检查 Nginx 是否关闭了 `proxy_buffering`（参见第 9 节）
- 检查 `proxy_read_timeout` 是否足够长（建议 300s+）
- 检查防火墙/负载均衡器是否对长连接有超时限制

### 12.4 内存占用过高

```bash
# 查看进程内存
pm2 monit   # 如果使用 PM2
docker stats # 如果使用 Docker

# 设置内存上限自动重启
# PM2: ecosystem.config.js 中 max_memory_restart: '1G'
# Docker: deploy.resources.limits.memory: 1G
```

### 12.5 日志查看

```bash
# 直接运行
# 日志输出到 stdout/stderr

# PM2
pm2 logs ts-multi-agent --lines 100

# Docker
docker logs --tail 100 -f ts-multi-agent
```

### 12.6 沙箱系统

系统内置了基于 bubblewrap（bwrap）的沙箱隔离机制，用于安全执行 bash 命令。

#### 工作原理

```
用户命令 → PathGuard（命令过滤） → Sandbox（沙箱隔离） → 执行结果
```

- **PathGuard**：前置过滤器，拦截危险命令（如 `rm -rf /`、`sudo` 等）和敏感路径访问
- **Sandbox**：使用 bubblewrap 创建隔离环境，限制文件系统和网络访问

#### 安装 bubblewrap

```bash
# Ubuntu / Debian
sudo apt install bubblewrap

# Alpine Linux（Docker 常用基础镜像）
apk add bubblewrap

# CentOS / RHEL
sudo yum install bubblewrap

# 验证安装
command -v bwrap  # 应输出 /usr/bin/bwrap
```

#### 判断沙箱是否生效

查看日志中 `module: "Sandbox"` 的输出：

**沙箱已启用**（bwrap 可用）：
```json
{"level":"info","module":"Sandbox","message":"bubblewrap 可用，沙箱隔离已启用"}
{"level":"info","module":"Sandbox","message":"沙箱执行命令","command":"npm install","network":"isolated","shell":"/bin/bash"}
{"level":"info","module":"Sandbox","message":"沙箱命令执行完成","exitCode":0}
```

**沙箱未启用**（bwrap 不可用，回退到直接执行）：
```json
{"level":"warn","module":"Sandbox","message":"bubblewrap 不可用，命令将在无隔离环境下直接执行"}
{"level":"warn","module":"Sandbox","message":"命令在无隔离环境下执行","reason":"bubblewrap 不可用"}
```

#### 常见问题

**Q: 日志中出现 `spawn /bin/bash ENOENT`**
- **原因**：部署环境（如 Alpine Docker 镜像）默认没有 `/bin/bash`
- **修复**：系统已自动回退到 `/bin/sh`，无需额外操作。如需 bash，安装即可：`apk add bash`

**Q: 日志显示 `bubblewrap 不可用`**
- **原因**：未安装 bubblewrap
- **修复**：按上方说明安装，或确认容器镜像中包含 bwrap

**Q: 命令执行报权限不足**
- **原因**：沙箱默认禁用网络（`--unshare-net`），某些需要网络的命令（如 `npm install`）会失败
- **说明**：这是预期行为。如需网络访问，需在代码中显式配置 `network: true`

**Q: 日志中出现 `Creating new namespace failed`**
- **原因**：Docker 容器默认禁用了非特权 user namespace，bwrap 无法创建隔离环境
- **修复**：在 Dockerfile 中为 bwrap 设置 setuid 权限：`chmod u+s /usr/bin/bwrap`（项目 Dockerfile 已包含此配置）
- **验证**：进入容器执行 `ls -la /usr/bin/bwrap`，应显示 `-rwsr-xr-x`（注意 `s` 标志）

---

## 附录：部署检查清单

- [ ] Node.js >= 18.0.0 已安装
- [ ] 依赖已安装（`npm install`）
- [ ] `.env` 文件已配置（至少一个 LLM API Key）
- [ ] `LLM_PROVIDER`、`LLM_MODEL`、`LLM_BASE_URL` 已正确设置
- [ ] `FALLBACK_CONFIG` 已根据业务场景选择
- [ ] TypeScript 编译成功（`npm run build`）
- [ ] 健康检查通过（`/health` 返回 200）
- [ ] SSE 流式接口正常（`/tasks/stream`）
- [ ] Nginx 反向代理已配置（生产环境）
- [ ] PM2 / Docker 进程管理已配置（生产环境）
- [ ] 日志收集已配置
- [ ] 防火墙规则已设置（仅开放 80/443 端口）
- [ ] bubblewrap 已安装（`command -v bwrap`），沙箱隔离生效
- [ ] 日志中确认 `module: "Sandbox"` 输出沙箱执行状态
