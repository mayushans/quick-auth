# Nginx 配置片段

此目录包含 Quick Auth 的 Nginx 配置片段，按角色拆分为独立文件，方便按需引入。

## 文件说明

| 文件 | 适用场景 |
|------|----------|
| `auth-server.conf` | 部署 Quick Auth 认证服务本身的 Nginx（域名如 `auth.example.com`） |
| `app-server.conf` | 受保护的业务服务，通过 `auth_request` 委托鉴权（域名如 `app.example.com`） |
| `snippets/auth-location.conf` | 在 server 块中引用，反向代理鉴权端点 |
| `snippets/auth-use.conf`| 在 location 处引用，对当前访问路径鉴权，验证用户是否已登录 |

## 架构流程

```
用户访问 app.example.com/protected（未登录）
        │
        ▼
Nginx auth_request ──→ auth.example.com/auth ──→ 401
        │
        ▼
重定向到 auth.example.com/login?redirect=原始地址
        │
        ▼
用户完成验证码登录 → JS 跳转回原始地址

已登录用户访问受保护路径：

用户请求 /private/
        │
        ▼
auth_request /_auth_check ──→ 后端 /auth
        │                           │
        │                    ← X-User-Email      (邮箱)
        │                    ← X-User-Groups     (组名，如 "admin")
        ▼
auth_request_set 捕获两个变量
        │
        ├─ $user_groups !~ admin → 403（不满足组要求）
        └─ 通过 → proxy_pass 并传递 X-User-Email / X-User-Groups
```

## 跨域 Cookie 要求

认证服务器和业务服务必须共享同一父域（如 `.example.com`），
并在 `.env` 中设置 `AUTH_COOKIE_DOMAIN=.example.com`。
不同根域名之间无法共享 Cookie，如需支持请自行扩展 token 交换机制。
