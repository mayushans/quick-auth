# Quick Auth

> 基于邮箱验证码的无密码认证服务，配合 Nginx `auth_request` 做集中式鉴权。

## 特性

- **无密码** — 不储存任何账号密码，仅通过邮箱验证码验证身份
- **独立域名认证中心** — 作为独立的认证服务，其他业务通过 Nginx `auth_request` 委托鉴权
- **内存缓存** — 使用内存缓存替代 Redis，零外部依赖
- **邮箱白名单** — 可选的白名单机制，限制允许登录的邮箱
- **滑动过期** — 会话每次被访问自动续期
- **验证码防暴力破解** — 最多 3 次错误尝试，60 秒发送频率限制
- **开发友好** — 未配置 SMTP 时验证码直接打印到控制台

## 快速开始

```bash
# 安装依赖
npm install

# 复制环境变量配置
cp .env.example .env

# 启动开发服务器
npm run dev
```

打开 http://localhost:3000 即可看到登录页面。

## 项目结构

```
quick-auth/
├── src/
│   ├── app.ts              # Hono 应用（路由 & 业务逻辑）
│   ├── cache.ts            # 内存缓存（替代 Redis）
│   ├── index.ts            # 入口文件（启动服务器）
│   ├── api.ts              # 导出 app 供外部使用
│   ├── pages/
│   │   ├── login.html      # 登录页面
│   │   └── home.html       # 首页模板（{{email}} 占位符）
│   └── emails/
│       ├── verify-code.html  # 邮件 HTML 模板
│       └── verify-code.txt   # 邮件纯文本模板
├── nginx/
│   ├── README.md           # Nginx 配置说明
│   ├── auth-server.conf    # 认证服务器配置片段
│   ├── app-server.conf     # 业务服务器配置片段
│   ├── access-control.conf # 基于邮箱的访问控制
│   └── snippets
│       ├── auth-location.conf  # 反向代理鉴权端点
│       ├── auth-use.conf       # 对当前访问路径鉴权
│       └── auth-acl-email.conf # 对邮箱地址进行限制
├── .env.example            # 环境变量示例
├── whitelist.example.txt   # 白名单示例
└── quick-auth.service.example  # systemd 服务配置示例
```

## API 接口

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/send-code` | POST | 发送验证码到指定邮箱（60s 频率限制） |
| `/api/verify-code` | POST | 校验验证码，登录成功设置 httpOnly Cookie |
| `/api/me` | GET | 获取当前登录的会话信息 |
| `/api/logout` | POST | 登出，清除会话 |
| `/auth` | GET | Nginx `auth_request` 鉴权端点（返回 200/401） |
| `/login` | GET | 登录页面 |
| `/` | GET | 受保护的示例首页 |

### 发送验证码

```bash
curl -X POST http://localhost:3000/api/send-code \
  -H "Content-Type: application/json" \
  -d '{"email":"user@example.com"}'
```

### 校验验证码

```bash
curl -X POST http://localhost:3000/api/verify-code \
  -H "Content-Type: application/json" \
  -d '{"email":"user@example.com","code":"123456"}'
```

### 获取会话信息

```bash
curl http://localhost:3000/api/me -b "quickAuth=<SESSION_ID>"
```

## 环境变量

所有配置通过 `.env` 文件加载：

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `SMTP_HOST` | — | SMTP 服务器地址（空时使用开发模式） |
| `SMTP_PORT` | `587` | SMTP 服务器端口 |
| `SMTP_USER` | — | SMTP 账号 |
| `SMTP_PASS` | — | SMTP 密码 |
| `FROM_EMAIL` | `SMTP_USER` | 发件人地址 |
| `SESSION_TTL` | `86400` | 会话有效期（秒），默认 24h |
| `CODE_TTL` | `300` | 验证码有效期（秒），默认 5min |
| `RATE_LIMIT_TTL` | `60` | 发送频率限制间隔（秒） |
| `PORT` | `3000` | 服务监听端口 |
| `NODE_ENV` | `development` | 生产环境设为 `production`（启用 Cookie Secure 标记） |
| `AUTH_PUBLIC_URL` | — | 认证中心公网地址，例如 `https://auth.example.com` |
| `AUTH_COOKIE_DOMAIN` | — | Cookie 共享域名，例如 `.example.com`（跨子域共享登录态，需 HTTPS） |

## 邮箱白名单

在项目根目录创建 `whitelist.txt`，每行一个邮箱地址：

```
# 邮箱白名单
admin@example.com
user@example.com
```

- 文件存在时，只有白名单内的邮箱可以登录
- 文件不存在或为空时，不限制登录

## 与 Nginx 集成

Quick Auth 作为独立域名的认证中心，其他业务服务通过 Nginx 的 `auth_request` 委托鉴权。

### 架构示意

```
用户访问 app.example.com/protected（未登录）
        │
        ▼
Nginx auth_request ──→ auth.example.com/auth（校验 Cookie）
        │                       │
        │ 401                   │ 200（已登录）
        ▼                       ▼
 重定向到 auth.example.com/      转发请求到后端，
 login?redirect=               携带 X-User-Email`
 https://app.example.
 com/protected
        │
        ▼
   用户完成登录
        │
        ▼
 登录页 JS 读取 redirect 参数
 跳转回 app.example.com/protected
```

### 认证服务器配置（auth.example.com）

```nginx
server {
    listen 80;
    server_name auth.example.com;

    location /login { proxy_pass http://127.0.0.1:3000; }
    location /api/  { proxy_pass http://127.0.0.1:3000; }

    # 注意：不能加 internal，其他服务器的 proxy_pass 需要访问此端点
    location = /auth {
        proxy_pass http://127.0.0.1:3000/auth;
        proxy_pass_request_body off;
        proxy_set_header Cookie $http_cookie;
    }

    location / {
        auth_request /auth;
        error_page 401 = @auth_login;
        proxy_pass http://127.0.0.1:3000;
    }

    # 未认证 → 登录页，带回原地址用于跳回
    # 使用 $http_host 以保留非标端口（如 :8080）
    location @auth_login {
        return 302 /login?redirect=$scheme://$http_host$request_uri;
    }
}
```

### 业务服务配置（app.example.com）

```nginx
server {
    listen 80;
    server_name app.example.com;

    # 将鉴权委托给 auth.example.com/auth
    location = /_auth_check {
        proxy_pass http://auth.example.com/auth;
        proxy_pass_request_body off;
        proxy_set_header Cookie $http_cookie;
    }

    location / {
        auth_request /_auth_check;
        auth_request_set $user_email $upstream_http_x_user_email;
        proxy_set_header X-User-Email $user_email;

        error_page 401 = @to_auth_login;
        proxy_pass http://your-backend:8080;
    }

    # 未认证 → 跳转到认证中心的登录页，登录后跳回原地址
    # 使用 $http_host 以保留非标端口（如 http://app.example.com:8080）
    location @to_auth_login {
        return 302 http://auth.example.com/login?redirect=$scheme://$http_host$request_uri;
    }
}
```

完整的配置片段见 [`nginx/`](./nginx/) 目录，按需选用：

- [`nginx/auth-server.conf`](./nginx/auth-server.conf) — 认证服务器
- [`nginx/app-server.conf`](./nginx/app-server.conf) — 业务服务器

## 生产部署

### systemd 服务

参考 [`quick-auth.service.example`](./quick-auth.service.example)：

```bash
sudo cp quick-auth.service.example /etc/systemd/system/quick-auth.service
# 修改 WorkingDirectory、User 等路径
sudo systemctl daemon-reload
sudo systemctl enable quick-auth
sudo systemctl start quick-auth
sudo journalctl -u quick-auth -f
```

### 构建

```bash
npm run build
node dist/index.js
```

## 技术栈

- [Hono](https://hono.dev/) — 轻量级 Web 框架
- [TypeScript](https://www.typescriptlang.org/) — 类型安全
- [nodemailer](https://nodemailer.com/) — 邮件发送
- [dotenv](https://github.com/motdotla/dotenv) — 环境变量加载
- [@hono/node-server](https://github.com/honojs/node-server) — Node.js 适配器

