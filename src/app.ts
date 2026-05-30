import 'dotenv/config'
import { readFileSync, watchFile, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Hono } from 'hono'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import { cors } from 'hono/cors'
import nodemailer from 'nodemailer'
import { cache } from './cache.js'

// ── 加载 HTML 模板 ──
const __dirname = dirname(fileURLToPath(import.meta.url))
const loginHtml = readFileSync(join(__dirname, 'pages', 'login.html'), 'utf-8')
const homeHtml = readFileSync(join(__dirname, 'pages', 'home.html'), 'utf-8')

// ── 加载邮件模板 ──
const emailHtmlTemplate = readFileSync(join(__dirname, 'emails', 'verify-code.html'), 'utf-8')
const emailTextTemplate = readFileSync(join(__dirname, 'emails', 'verify-code.txt'), 'utf-8')

function render(template: string, vars: Record<string, string>): string {
  let result = template
  for (const [key, value] of Object.entries(vars)) {
    result = result.replaceAll(`{{${key}}}`, value)
  }
  return result
}

// ──────────────────────────── 环境变量 ────────────────────────────

const {
  SMTP_HOST = '',
  SMTP_PORT = '587',
  SMTP_USER = '',
  SMTP_PASS = '',
  FROM_EMAIL = '',
  SESSION_TTL = '86400',       // 会话有效期（秒），默认 24h
  CODE_TTL = '300',            // 验证码有效期（秒），默认 5min
  RATE_LIMIT_TTL = '60',       // 频率限制间隔（秒）
  NODE_ENV = 'development',
  AUTH_PUBLIC_URL = '',        // Quick Auth 公网地址，例如 https://auth.example.com
  AUTH_COOKIE_DOMAIN = '',     // Cookie 共享域名，例如 .example.com（跨子域共享登录态）
} = process.env

// ── 启动日志 ──
console.log(`[BOOT] NODE_ENV=${NODE_ENV}`)
console.log(`[BOOT] SMTP=${SMTP_HOST ? '已配置 (' + SMTP_HOST + ')' : '未配置（开发模式打印到控制台）'}`)
console.log(`[BOOT] SESSION_TTL=${SESSION_TTL}s, CODE_TTL=${CODE_TTL}s, RATE_LIMIT_TTL=${RATE_LIMIT_TTL}s`)
console.log(`[BOOT] AUTH_PUBLIC_URL=${AUTH_PUBLIC_URL || '未设置（使用相对路径）'}`)
console.log(`[BOOT] AUTH_COOKIE_DOMAIN=${AUTH_COOKIE_DOMAIN || '未设置（不跨域共享）'}`)

// ── 调试模式标志（仅在 NODE_ENV=development 时打印详细日志） ──
const isDebug = NODE_ENV === 'development'
function debugLog(...args: unknown[]) {
  if (isDebug) console.log('[DEBUG]', ...args)
}

// ── 登录页地址（用于重定向） ──
const loginUrl = AUTH_PUBLIC_URL ? `${AUTH_PUBLIC_URL}/login` : '/login'

// ── Cookie 域名（剥离端口，端口不属于 Cookie Domain 属性） ──
const cookieDomain = AUTH_COOKIE_DOMAIN
  ? AUTH_COOKIE_DOMAIN.replace(/:\d+$/, '')
  : ''

// ── 判断当前请求是否为 HTTPS ──
function isHttps(c: { req: { header: (name: string) => string | undefined; url: string } }): boolean {
  // 优先信任反向代理传递的协议头
  const proto = c.req.header('x-forwarded-proto')
  if (proto === 'https') return true
  // 回退：检查请求 URL
  return c.req.url.startsWith('https://')
}

// ── 构建 Cookie 选项 ──
function sessionCookieOptions(c: Parameters<typeof isHttps>[0]) {
  const https = isHttps(c)
  const share = !!cookieDomain
  return {
    httpOnly: true as const,
    secure: https || share,   // SameSite=None 强制 Secure
    sameSite: share ? 'None' as const : 'Lax' as const,
    maxAge: Number(SESSION_TTL),
    path: '/',
    ...(share ? { domain: cookieDomain } : {}),
  }
}

// ── 访问控制配置（从 access-control.json 加载，支持运行时热重载） ──
// 合并了原 whitelist.txt 与 Nginx 访问控制规则
// 文件格式见 access-control.json 示例

interface WhitelistEntry {
  groups: string[]
}

interface AccessRule {
  path: string
  host?: string          // 限制域名，如 "admin.example.com"；不配置则匹配所有
  port?: number          // 限制端口，如 8080；不配置则匹配所有
  requireAuth: boolean
  requireGroups?: string[]   // 允许访问的用户组，不配置则不限
}

interface AccessControlConfig {
  whitelist: Array<{ email: string; groups?: string[] }>
  access_rules: Array<{
    path: string
    host?: string
    port?: number
    requireAuth?: boolean
    requireGroups?: string[]
  }>
}

const configPath = join(__dirname, '..', 'access-control.json')
const legacyWhitelistPath = join(__dirname, '..', 'whitelist.txt')

let whitelist: Map<string, WhitelistEntry> = new Map()
let accessRules: AccessRule[] = []

function parseWhitelistFromLegacy(content: string): Map<string, WhitelistEntry> {
  const map = new Map<string, WhitelistEntry>()
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const parts = trimmed.split(/\s+/)
    const email = parts[0].toLowerCase()
    const groups = parts.length > 1
      ? parts[1].split(',').map(g => g.trim()).filter(Boolean)
      : []
    map.set(email, { groups })
  }
  return map
}

function loadAccessControl(): void {
  try {
    const raw = readFileSync(configPath, 'utf-8')
    const parsed = JSON.parse(raw) as AccessControlConfig
    const newWhitelist = new Map<string, WhitelistEntry>()
    for (const entry of (parsed.whitelist ?? [])) {
      newWhitelist.set(entry.email.toLowerCase(), { groups: entry.groups ?? [] })
    }
    whitelist = newWhitelist
    accessRules = (parsed.access_rules ?? []).map(r => ({
      path: r.path,
      host: r.host || undefined,
      port: r.port || undefined,
      requireAuth: r.requireAuth ?? false,
      requireGroups: r.requireGroups,
    }))
    debugLog(`[CONFIG] 已加载：${whitelist.size} 条白名单，${accessRules.length} 条访问规则`)
  } catch {
    // 回退到旧版 whitelist.txt
    try {
      whitelist = parseWhitelistFromLegacy(readFileSync(legacyWhitelistPath, 'utf-8'))
      accessRules = []
      debugLog(`[CONFIG] 已从 whitelist.txt 加载 ${whitelist.size} 条规则（兼容模式）`)
    } catch {
      whitelist = new Map()
      accessRules = []
    }
  }
}

loadAccessControl()

// 监听配置文件变化，自动热重载
try {
  statSync(configPath)
  watchFile(configPath, { interval: 1000 }, () => {
    loadAccessControl()
    debugLog(`[CONFIG] 配置文件已重新加载`)
  })
} catch {
  // access-control.json 不存在，尝试监听旧版 whitelist.txt
  try {
    statSync(legacyWhitelistPath)
    watchFile(legacyWhitelistPath, { interval: 1000 }, () => {
      loadAccessControl()
    })
  } catch {
    // 两个文件都不存在，不启动监听
  }
}

function isAllowed(email: string): boolean {
  return whitelist.size === 0 || whitelist.has(email)
}

function getUserGroups(email: string): string[] {
  const entry = whitelist.get(email)
  return entry ? entry.groups : []
}

// ──────────────────────────── 邮件发送器 ────────────────────────────

const transporter = SMTP_HOST && SMTP_USER
  ? nodemailer.createTransport({
      host: SMTP_HOST,
      port: Number(SMTP_PORT),
      auth: { user: SMTP_USER, pass: SMTP_PASS },
    })
  : null

async function sendEmail(to: string, subject: string, html: string, text: string): Promise<boolean> {
  if (!transporter) {
    debugLog(`[DEV MAIL] To: ${to}`)
    debugLog(`[DEV MAIL] Subject: ${subject}`)
    debugLog(`[DEV MAIL] Body: ${text}`)
    return true
  }
  try {
    await transporter.sendMail({ from: FROM_EMAIL || SMTP_USER, to, subject, html, text })
    return true
  } catch (err) {
    console.error(`[MAIL ERROR] Failed to send to ${to}:`, err instanceof Error ? err.message : err)
    return false
  }
}

// ──────────────────────────── 应用 ────────────────────────────

const app = new Hono()

app.use('/api/*', cors({ origin: '*', credentials: true }))

// ── 访问规则匹配工具函数（供 /auth 端点使用） ──

/**
 * 解析请求的 host 和 port（从 Host 请求头提取）
 */
function parseRequestHost(hostHeader: string): { host: string; port?: number } {
  const colonIdx = hostHeader.lastIndexOf(':')
  if (colonIdx > 0) {
    const port = Number(hostHeader.slice(colonIdx + 1))
    if (!Number.isNaN(port)) {
      const result = { host: hostHeader.slice(0, colonIdx), port }
      debugLog(`parseRequestHost: "${hostHeader}" → host="${result.host}", port=${result.port}`)
      return result
    }
  }
  debugLog(`parseRequestHost: "${hostHeader}" → host="${hostHeader}" (no port)`)
  return { host: hostHeader }
}

/**
 * 检查请求是否匹配一条访问规则（路径 + 域名 + 端口）
 */
function matchRule(
  requestPath: string,
  requestHost: string,
  requestPort: number | undefined,
  rule: AccessRule,
): boolean {
  // 1. 域名匹配（如果规则指定了 host）
  if (rule.host && rule.host !== requestHost) {
    debugLog(`matchRule: host不匹配 rule.host="${rule.host}" !== requestHost="${requestHost}"`)
    return false
  }
  // 2. 端口匹配（如果规则指定了 port）
  if (rule.port !== undefined && rule.port !== requestPort) {
    debugLog(`matchRule: 端口不匹配 rule.port=${rule.port} !== requestPort=${requestPort}`)
    return false
  }
  // 3. 路径匹配
  if (rule.path.endsWith('/*')) {
    const prefix = rule.path.slice(0, -2)
    const matched = requestPath === prefix || requestPath.startsWith(prefix + '/')
    debugLog(`matchRule: path="${requestPath}" ~ rule.path="${rule.path}" → ${matched}`)
    return matched
  }
  const matched = rule.path === requestPath
  debugLog(`matchRule: path="${requestPath}" ~ rule.path="${rule.path}" → ${matched}`)
  return matched
}

/**
 * 根据访问规则校验当前请求的权限
 * @returns 'ok' | 'unauthorized' | 'forbidden'
 */
function checkAccessRule(
  requestPath: string,
  requestHost: string,
  requestPort: number | undefined,
  sessionGroups: string[],
): 'ok' | 'unauthorized' | 'forbidden' {
  const rule = accessRules.find(r => matchRule(requestPath, requestHost, requestPort, r))
  // 没有匹配规则 → 允许
  if (!rule || !rule.requireAuth) {
    debugLog(`checkAccessRule: 无匹配规则或requireAuth=false → ok`)
    return 'ok'
  }
  // 规则要求特定用户组
  if (rule.requireGroups && rule.requireGroups.length > 0) {
    const passed = rule.requireGroups.some(g => sessionGroups.includes(g))
    debugLog(`checkAccessRule: requireGroups=[${rule.requireGroups}] sessionGroups=[${sessionGroups}] → ${passed ? 'ok' : 'forbidden'}`)
    return passed ? 'ok' : 'forbidden'
  }
  debugLog(`checkAccessRule: 匹配规则但无用户组限制 → ok`)
  return 'ok'
}

// ────────── 1. 发送验证码 ──────────

app.post('/api/send-code', async (c) => {
  const { email } = await c.req.json()
  debugLog(`[API] POST /api/send-code email="${email}"`)
  if (!email || typeof email !== 'string') {
    debugLog(`[API] send-code: 邮箱为空或类型错误`)
    return c.json({ error: '邮箱必填' }, 400)
  }
  const normalizedEmail = email.trim().toLowerCase()
  debugLog(`[API] send-code: normalizedEmail="${normalizedEmail}"`)

  // 白名单检查
  if (!isAllowed(normalizedEmail)) {
    debugLog(`[API] send-code: 白名单拒绝 email="${normalizedEmail}"`)
    return c.json({ error: '该邮箱不在白名单中，禁止登录' }, 403)
  }
  debugLog(`[API] send-code: 白名单通过`)

  // 频率限制：同一邮箱 60 秒内不可重复发送
  const rateKey = `ratelimit:${normalizedEmail}`
  if (cache.exists(rateKey)) {
    const remaining = cache.ttl(rateKey)
    debugLog(`[API] send-code: 频率限制，剩余 ${remaining}s`)
    return c.json({ error: `发送过于频繁，请 ${remaining} 秒后再试` }, 429)
  }

  // 生成 6 位数字验证码
  const code = String(Math.floor(100000 + Math.random() * 900000))
  const ttl = Number(CODE_TTL)
  debugLog(`[API] send-code: 生成验证码 code=${code} ttl=${ttl}s`)

  cache.set(`code:${normalizedEmail}`, { code, attempts: 0, sendAt: Date.now() }, ttl)
  cache.set(rateKey, '1', Number(RATE_LIMIT_TTL))

  const sent = await sendEmail(
    normalizedEmail,
    '登录验证码',
    render(emailHtmlTemplate, { code, ttl: String(ttl / 60) }),
    render(emailTextTemplate, { code, ttl: String(ttl / 60) }),
  )

  if (!sent && transporter) {
    debugLog(`[API] send-code: SMTP发送失败，清理缓存`)
    // SMTP 发送失败，清理缓存以便重试
    cache.del(`code:${normalizedEmail}`)
    cache.del(rateKey)
    return c.json({ error: '邮件发送失败，请稍后重试' }, 502)
  }

  debugLog(`[API] send-code: 验证码已发送至 ${normalizedEmail}`)
  return c.json({ success: true, message: '验证码已发送' })
})

// ────────── 2. 验证码校验并登录 ──────────

app.post('/api/verify-code', async (c) => {
  const { email, code } = await c.req.json()
  debugLog(`[API] POST /api/verify-code email="${email}" code="${code}"`)
  if (!email || !code) {
    debugLog(`[API] verify-code: 参数不全`)
    return c.json({ error: '参数不全' }, 400)
  }
  const normalizedEmail = email.trim().toLowerCase()

  // 白名单检查（二次校验）
  if (!isAllowed(normalizedEmail)) {
    debugLog(`[API] verify-code: 白名单拒绝 email="${normalizedEmail}"`)
    return c.json({ error: '该邮箱不在白名单中，禁止登录' }, 403)
  }

  const stored = cache.get<{ code: string; attempts: number; sendAt: number } | null>(`code:${normalizedEmail}`)
  if (!stored) {
    debugLog(`[API] verify-code: 验证码过期或不存在 email="${normalizedEmail}"`)
    return c.json({ error: '验证码过期或不存在，请重新发送' }, 400)
  }

  // 最多允许 3 次错误尝试
  if (stored.attempts >= 3) {
    debugLog(`[API] verify-code: 验证码已失效（attempts=${stored.attempts}）email="${normalizedEmail}"`)
    cache.del(`code:${normalizedEmail}`)
    return c.json({ error: '验证码已失效，请重新发送' }, 400)
  }

  if (stored.code !== code) {
    stored.attempts++
    debugLog(`[API] verify-code: 验证码错误 (attempt ${stored.attempts}/3) email="${normalizedEmail}"`)
    // 重新写入（保留原有剩余 TTL）
    const remaining = cache.ttl(`code:${normalizedEmail}`)
    if (remaining > 0) {
      cache.set(`code:${normalizedEmail}`, stored, remaining)
    }
    return c.json({ error: `验证码错误，还剩 ${3 - stored.attempts} 次机会` }, 400)
  }

  // ── 验证成功 ──
  debugLog(`[API] verify-code: 验证成功 email="${normalizedEmail}"`)
  cache.del(`code:${normalizedEmail}`)

  const sessionId = crypto.randomUUID()
  const sessionTtl = Number(SESSION_TTL)
  const groups = getUserGroups(normalizedEmail)
  cache.set(`session:${sessionId}`, { email: normalizedEmail, groups, createdAt: Date.now() }, sessionTtl)
  debugLog(`[API] verify-code: 创建会话 sessionId="${sessionId.slice(0, 8)}..." groups=[${groups}] ttl=${sessionTtl}s`)

  setCookie(c, 'quickAuth', sessionId, sessionCookieOptions(c))

  // 记住上次登录的邮箱（非 httpOnly，供登录页 JS 预填）
  setCookie(c, 'last_email', normalizedEmail, {
    httpOnly: false,
    secure: isHttps(c),
    sameSite: 'Lax',
    maxAge: 30 * 86400,   // 保留 30 天
    path: '/',
  })

  return c.json({ success: true, email: normalizedEmail })
})

// ────────── 3. 获取当前会话信息 ──────────

app.get('/api/me', async (c) => {
  const sessionId = getCookie(c, 'quickAuth')
  debugLog(`[API] GET /api/me sessionId="${sessionId ? sessionId.slice(0, 8) + '...' : '无'}"`)
  if (!sessionId) {
    debugLog(`[API] /api/me: 未登录（无Cookie）`)
    return c.json({ error: '未登录' }, 401)
  }

  const session = cache.get<{ email: string; groups: string[]; createdAt: number } | null>(`session:${sessionId}`)
  if (!session) {
    debugLog(`[API] /api/me: 会话已过期 sessionId="${sessionId.slice(0, 8)}..."`)
    return c.json({ error: '会话已过期' }, 401)
  }
  debugLog(`[API] /api/me: 会话有效 email="${session.email}"`)

  // 滑动过期：每次访问刷新 TTL
  cache.expire(`session:${sessionId}`, Number(SESSION_TTL))

  return c.json({ email: session.email, groups: session.groups, createdAt: session.createdAt })
})

// ────────── 4. 登出 ──────────

app.post('/api/logout', async (c) => {
  const sessionId = getCookie(c, 'quickAuth')
  debugLog(`[API] POST /api/logout sessionId="${sessionId ? sessionId.slice(0, 8) + '...' : '无'}"`)
  if (sessionId) {
    cache.del(`session:${sessionId}`)
    debugLog(`[API] logout: 已删除会话`)
  }
  deleteCookie(c, 'quickAuth', {
    path: '/',
    ...(cookieDomain ? { domain: cookieDomain } : {}),
  })
  return c.json({ success: true })
})

// ────────── 5. Nginx auth_request 校验端点 ──────────
// Nginx 通过 auth_request 调用此端点，根据 access-control.json 中的规则
// 返回 200（允许访问）、401（未登录）或 403（权限不足）。

app.get('/auth', async (c) => {
  const sessionId = getCookie(c, 'quickAuth')
  const xOriginalUri = c.req.header('x-original-uri')
  debugLog(`[AUTH] GET /auth sessionId="${sessionId ? sessionId.slice(0, 8) + '...' : '无'}" x-original-uri="${xOriginalUri || '无'}"`)

  if (!sessionId) {
    debugLog(`[AUTH] → 401: 无会话Cookie`)
    c.status(401)
    return c.body('Unauthorized')
  }

  const session = cache.get<{ email: string; groups: string[] } | null>(`session:${sessionId}`)
  if (!session) {
    debugLog(`[AUTH] → 401: 会话已过期或不存在`)
    c.status(401)
    return c.body('Unauthorized')
  }
  debugLog(`[AUTH] 会话有效: email="${session.email}" groups=[${session.groups}]`)

  // 滑动过期
  cache.expire(`session:${sessionId}`, Number(SESSION_TTL))

  // ── 访问控制校验 ──
  // Nginx 通过 X-Original-URI 传递原始请求路径
  const originalUri = xOriginalUri || c.req.path
  // 优先使用 X-Forwarded-Host（Nginx 反向代理时携带），其次使用 Host 头
  const hostHeader = c.req.header('x-forwarded-host') || c.req.header('host') || ''
  const { host: requestHost, port: requestPort } = parseRequestHost(hostHeader)
  debugLog(`[AUTH] 校验: path="${originalUri}" host="${requestHost}" port="${requestPort ?? '默认'}"`)

  const accessResult = checkAccessRule(originalUri, requestHost, requestPort, session.groups)
  debugLog(`[AUTH] → ${accessResult === 'ok' ? '200 OK' : accessResult === 'forbidden' ? '403 Forbidden' : '401 Unauthorized'}`)

  if (accessResult === 'forbidden') {
    c.status(403)
    return c.body('Forbidden')
  }

  c.header('X-User-Email', session.email)
  c.header('X-User-Groups', session.groups.join(','))

  return c.body('OK')
})

// ────────── 6. 登录页面 ──────────

app.get('/login', (c) => {
  // 已登录则直接跳转首页
  const sessionId = getCookie(c, 'quickAuth')
  if (sessionId && cache.get(`session:${sessionId}`)) {
    debugLog(`[PAGE] GET /login: 已登录，重定向到 /`)
    return c.redirect('/')
  }
  debugLog(`[PAGE] GET /login: 渲染登录页`)
  return c.html(loginHtml)
})

// ────────── 7. 受保护的示例页面 ──────────

app.get('/', (c) => {
  const sessionId = getCookie(c, 'quickAuth')
  debugLog(`[PAGE] GET / sessionId="${sessionId ? sessionId.slice(0, 8) + '...' : '无'}"`)
  if (!sessionId) {
    debugLog(`[PAGE] GET /: 未登录，重定向到 ${loginUrl}`)
    return c.redirect(loginUrl)
  }

  const session = cache.get<{ email: string } | null>(`session:${sessionId}`)
  if (!session) {
    debugLog(`[PAGE] GET /: 会话过期，重定向到 ${loginUrl}`)
    return c.redirect(loginUrl)
  }

  cache.expire(`session:${sessionId}`, Number(SESSION_TTL))
  debugLog(`[PAGE] GET /: 渲染首页 email="${session.email}"`)
  return c.html(render(homeHtml, { email: session.email }))
})

export default app
