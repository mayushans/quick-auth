# Quick Auth

> 基于邮箱验证码的无密码认证服务，内置访问控制。

## 特性

- **无密码** — 不储存任何账号密码，仅通过邮箱验证码验证身份
- **内存缓存** — 使用内存缓存替代 Redis，零外部依赖
- **白名单 + 访问控制** — 通过 `access-control.json` 统一管理邮箱白名单和路由访问权限
- **用户组权限** — 支持按用户组限制路由访问
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
│   └── auth-server.conf    # （可选）Nginx 反向代理配置
├── access-control.json     # 访问控制与白名单合并配置
├── .env.example            # 环境变量示例
├── whitelist.example.txt   # 旧版白名单示例（兼容参考）
└── quick-auth.service.example  # systemd 服务配置示例
```

## API 接口

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/send-code` | POST | 发送验证码到指定邮箱（60s 频率限制） |
| `/api/verify-code` | POST | 校验验证码，登录成功设置 httpOnly Cookie |
| `/api/me` | GET | 获取当前登录的会话信息 |
| `/api/logout` | POST | 登出，清除会话 |
| `/auth` | GET | Nginx `auth_request` 鉴权端点（校验登录态 + 访问规则，返回 200/401/403） |
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

## 访问控制配置

访问控制通过 `access-control.json` 统一管理，合并了邮箱白名单和路由访问规则。

**校验时机**：访问规则在 `/auth` 端点（即 Nginx `auth_request` 调用的端点）中校验，不影响登录流程。
Nginx 通过 `X-Original-URI` 请求头将原始访问路径传递给 `/auth`，`/auth` 根据规则返回 200（允许）、
401（未登录）或 403（权限不足）。

### 文件格式

```json
{
  "whitelist": [
    { "email": "admin@example.com", "groups": ["admin"] },
    { "email": "user@example.com", "groups": ["user", "editor"] }
  ],
  "access_rules": [
    { "path": "/",                "requireAuth": true },
    { "path": "/api/me",          "requireAuth": true },
    { "path": "/api/logout",      "requireAuth": true },

    { "path": "/admin/*",         "requireAuth": true, "requireGroups": ["admin"] },
    { "path": "/api/*",           "requireAuth": true, "host": "api.example.com", "port": 8080 },
    { "path": "/dashboard",       "requireAuth": true, "host": "app.example.com", "requireGroups": ["admin", "editor"] }
  ]
}
```

### 配置说明

#### `whitelist` — 邮箱白名单

| 字段 | 类型 | 说明 |
|------|------|------|
| `email` | `string` | 邮箱地址 |
| `groups` | `string[]` | （可选）用户组列表，用于后续路由权限判断 |

白名单为空数组时不限制登录。`groups` 只是标记用户的归属组，实际路由限制由 `access_rules` 决定。

#### `access_rules` — 路由访问规则

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `path` | `string` | 是 | 路由路径，支持精确匹配和 `/*` 通配符 |
| `host` | `string` | 否 | 限制域名，如 `"api.example.com"`。不配置则匹配所有域名 |
| `port` | `number` | 否 | 限制端口，如 `8080`。不配置则匹配所有端口 |
| `requireAuth` | `boolean` | 是 | `true` 时需登录才能访问 |
| `requireGroups` | `string[]` | 否 | 允许访问的用户组列表，用户需属于其中至少一个组 |

**匹配逻辑**：一条规则中同时指定 `host`、`port`、`path` 时，三者必须**全部匹配**才命中。

**默认行为**：未在 `access_rules` 中匹配的路由默认为公开（如 `/login`、`/api/send-code`）。

配置文件支持**运行时热重载**，修改后自动生效。

### 配置示例

#### 按域名隔离

```json
{ "path": "/api/*", "requireAuth": true, "host": "internal.example.com" }
```

仅 `internal.example.com` 域名的 `/api/*` 请求需要认证，其他域名下的 `/api/*` 不受限制。

#### 按端口隔离

```json
{ "path": "/admin/*", "requireAuth": true, "port": 8443 }
```

仅通过 `8443` 端口访问 `/admin/*` 时需要认证。

#### 按用户组限制

```json
{ "path": "/admin/*", "requireAuth": true, "requireGroups": ["admin"] }
```

匹配 `/admin/`、`/admin/settings` 等路径，仅 `admin` 组的用户可以访问。非 `admin` 组的已登录用户也会收到 403。

#### 多条件组合

```json
{ "path": "/dashboard", "requireAuth": true, "host": "app.example.com", "requireGroups": ["admin", "editor"] }
```

只有通过 `app.example.com` 访问 `/dashboard` 且属于 `admin` 或 `editor` 组的用户才能访问。

### 从旧版迁移

旧版使用 `whitelist.txt`（纯文本格式）配合 Nginx `auth_request` 做访问控制。
新版改用 `access-control.json`，将白名单和访问规则统一管理。

**迁移步骤**：

1. 参考 `access-control.json` 的格式，将 `whitelist.txt` 中的邮箱填入 `whitelist` 数组
2. 根据需要在 `access_rules` 中添加路由保护规则，支持域名、端口、用户组条件
3. 保留 `whitelist.txt` 可提供向后兼容（程序会自动回退读取）

## 与 Nginx 集成

Quick Auth 作为独立域名的认证中心，其他业务服务通过 Nginx 的 `auth_request` 委托鉴权。
访问控制规则在 `/auth` 端点中统一校验（由 `access-control.json` 配置），支持域名、端口、用户组限制。

### 架构示意

```
用户访问 app.example.com/protected（未登录）
        │
        ▼
Nginx auth_request ──→ auth.example.com/auth（校验 Cookie + 访问规则）
        │                       │
        │ 401 / 403             │ 200（已登录 + 权限通过）
        ▼                       ▼
 重定向到 auth.example.com/      转发请求到后端，
 login?redirect=               携带 X-User-Email`
 https://app.example.          和 X-User-Groups
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
        proxy_set_header X-Original-URI $request_uri;
    }

    location / {
        auth_request /_auth_check;
        auth_request_set $user_email $upstream_http_x_user_email;
        auth_request_set $user_groups $upstream_http_x_user_groups;

        error_page 401 = @to_auth_login;
        proxy_pass http://your-backend:8080;
    }

    # 未认证 → 跳转到认证中心的登录页，登录后跳回原地址
    location @to_auth_login {
        return 302 http://auth.example.com/login?redirect=$scheme://$http_host$request_uri;
    }
}
```

完整的配置片段见 [`nginx/`](./nginx/) 目录，按需选用：

- [`nginx/auth-server.conf`](./nginx/auth-server.conf) — 认证服务器
- [`nginx/app-server.conf`](./nginx/app-server.conf) — 业务服务器
- [`nginx/snippets/auth-location.conf`](./nginx/snippets/auth-location.conf) — 鉴权端点反向代理
- [`nginx/snippets/auth-use.conf`](./nginx/snippets/auth-use.conf) — auth_request 指令

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

