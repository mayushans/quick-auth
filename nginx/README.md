# Nginx 配置片段

此目录包含 Quick Auth 的 Nginx 配置片段，按角色拆分为独立文件，方便按需引入。

## 文件说明

| 文件 | 适用场景 |
|------|----------|
| `auth-server.conf` | 部署 Quick Auth 认证服务本身的 Nginx（域名如 `auth.example.com`） |
| `app-server.conf` | 受保护的业务服务，通过 `auth_request` 委托鉴权（域名如 `app.example.com`） |
| `snippets/auth-location.conf` | 在 server 块中引用，反向代理鉴权端点（传递 `X-Original-URI` 用于访问控制） |
| `snippets/auth-use.conf`| 在 location 处引用，对当前访问路径鉴权，验证用户是否已登录 |

## 架构流程

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

## 访问控制

访问控制由 `access-control.json` 统一配置，在 `/auth` 端点中统一校验：

- **域名限制** — 通过 `host` 字段指定允许的域名
- **端口限制** — 通过 `port` 字段指定允许的端口
- **用户组限制** — 通过 `requireGroups` 字段指定允许的用户组

Nginx 通过 `auth_request` 调用 `/auth`，`/auth` 返回 200（允许）、401（未登录）或 403（权限不足）。

## 跨域 Cookie 要求

认证服务器和业务服务必须共享同一父域（如 `.example.com`），
并在 `.env` 中设置 `AUTH_COOKIE_DOMAIN=.example.com`。
不同根域名之间无法共享 Cookie，如需支持请自行扩展 token 交换机制。
