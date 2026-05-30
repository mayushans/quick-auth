# Nginx 配置片段

此目录包含 Quick Auth 的 Nginx 配置片段，按角色拆分为独立文件，方便按需引入。

## 文件说明

| 文件 | 适用场景 |
|------|----------|
| `auth-server.conf` | 部署 Quick Auth 认证服务本身的 Nginx（域名如 `auth.example.com`） |
| `app-server.conf` | 受保护的业务服务，通过 `auth_request` 委托鉴权（域名如 `app.example.com`） |
| `access-control.conf` | 基于邮箱的访问控制，限制只有特定邮箱才能访问某些路径,在 http 块引入 |
| `snippets/auth-location.conf` | 在 server 块中引用，反向代理鉴权端点 |
| `snippets/auth-use.conf`| 在 location 处引用，对当前访问路径鉴权，验证用户是否已登录 |
| `snippets/auth-acl-email.conf`| 受保护的路径中加入访问控制，限制 access-control.conf 中配置的邮箱 |

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
```

## 跨域 Cookie 要求

认证服务器和业务服务必须共享同一父域（如 `.example.com`），
并在 `.env` 中设置 `AUTH_COOKIE_DOMAIN=.example.com`。
不同根域名之间无法共享 Cookie，如需支持请自行扩展 token 交换机制。
