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

// ── 白名单（从独立文件动态加载，支持运行时热重载） ──
const whitelistPath = join(__dirname, '..', 'whitelist.txt')

function parseWhitelist(content: string): Set<string> {
  return new Set(
    content
      .split('\n')
      .map(s => s.trim().toLowerCase())
      .filter(s => s.length > 0 && !s.startsWith('#')),
  )
}

let whitelist: Set<string>

function loadWhitelist(): Set<string> {
  try {
    return parseWhitelist(readFileSync(whitelistPath, 'utf-8'))
  } catch {
    return new Set()
  }
}

whitelist = loadWhitelist()

// 监听文件变化，自动热重载
try {
  const watcher = statSync(whitelistPath)
  watchFile(whitelistPath, { interval: 1000 }, () => {
    const newList = loadWhitelist()
    whitelist = newList
    console.log(`[WHITELIST] 已重新加载，共 ${whitelist.size} 条规则`)
  })
} catch {
  // whitelist.txt 不存在时不启动监听
}

function isAllowed(email: string): boolean {
  return whitelist.size === 0 || whitelist.has(email)
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
    console.log(`[DEV MAIL] To: ${to}`)
    console.log(`[DEV MAIL] Subject: ${subject}`)
    console.log(`[DEV MAIL] Body: ${text}`)
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

// ────────── 1. 发送验证码 ──────────

app.post('/api/send-code', async (c) => {
  const { email } = await c.req.json()
  if (!email || typeof email !== 'string') {
    return c.json({ error: '邮箱必填' }, 400)
  }
  const normalizedEmail = email.trim().toLowerCase()

  // 白名单检查
  if (!isAllowed(normalizedEmail)) {
    return c.json({ error: '该邮箱不在白名单中，禁止登录' }, 403)
  }

  // 频率限制：同一邮箱 60 秒内不可重复发送
  const rateKey = `ratelimit:${normalizedEmail}`
  if (cache.exists(rateKey)) {
    const remaining = cache.ttl(rateKey)
    return c.json({ error: `发送过于频繁，请 ${remaining} 秒后再试` }, 429)
  }

  // 生成 6 位数字验证码
  const code = String(Math.floor(100000 + Math.random() * 900000))
  const ttl = Number(CODE_TTL)

  cache.set(`code:${normalizedEmail}`, { code, attempts: 0, sendAt: Date.now() }, ttl)
  cache.set(rateKey, '1', Number(RATE_LIMIT_TTL))

  const sent = await sendEmail(
    normalizedEmail,
    '登录验证码',
    render(emailHtmlTemplate, { code, ttl: String(ttl / 60) }),
    render(emailTextTemplate, { code, ttl: String(ttl / 60) }),
  )

  if (!sent && transporter) {
    // SMTP 发送失败，清理缓存以便重试
    cache.del(`code:${normalizedEmail}`)
    cache.del(rateKey)
    return c.json({ error: '邮件发送失败，请稍后重试' }, 502)
  }

  return c.json({ success: true, message: '验证码已发送' })
})

// ────────── 2. 验证码校验并登录 ──────────

app.post('/api/verify-code', async (c) => {
  const { email, code } = await c.req.json()
  if (!email || !code) {
    return c.json({ error: '参数不全' }, 400)
  }
  const normalizedEmail = email.trim().toLowerCase()

  // 白名单检查（二次校验）
  if (!isAllowed(normalizedEmail)) {
    return c.json({ error: '该邮箱不在白名单中，禁止登录' }, 403)
  }

  const stored = cache.get<{ code: string; attempts: number; sendAt: number } | null>(`code:${normalizedEmail}`)
  if (!stored) {
    return c.json({ error: '验证码过期或不存在，请重新发送' }, 400)
  }

  // 最多允许 3 次错误尝试
  if (stored.attempts >= 3) {
    cache.del(`code:${normalizedEmail}`)
    return c.json({ error: '验证码已失效，请重新发送' }, 400)
  }

  if (stored.code !== code) {
    stored.attempts++
    // 重新写入（保留原有剩余 TTL）
    const remaining = cache.ttl(`code:${normalizedEmail}`)
    if (remaining > 0) {
      cache.set(`code:${normalizedEmail}`, stored, remaining)
    }
    return c.json({ error: `验证码错误，还剩 ${3 - stored.attempts} 次机会` }, 400)
  }

  // ── 验证成功 ──
  cache.del(`code:${normalizedEmail}`)

  const sessionId = crypto.randomUUID()
  const sessionTtl = Number(SESSION_TTL)
  cache.set(`session:${sessionId}`, { email: normalizedEmail, createdAt: Date.now() }, sessionTtl)

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
  if (!sessionId) return c.json({ error: '未登录' }, 401)

  const session = cache.get<{ email: string; createdAt: number } | null>(`session:${sessionId}`)
  if (!session) return c.json({ error: '会话已过期' }, 401)

  // 滑动过期：每次访问刷新 TTL
  cache.expire(`session:${sessionId}`, Number(SESSION_TTL))

  return c.json({ email: session.email, createdAt: session.createdAt })
})

// ────────── 4. 登出 ──────────

app.post('/api/logout', async (c) => {
  const sessionId = getCookie(c, 'quickAuth')
  if (sessionId) {
    cache.del(`session:${sessionId}`)
  }
  deleteCookie(c, 'quickAuth', {
    path: '/',
    ...(cookieDomain ? { domain: cookieDomain } : {}),
  })
  return c.json({ success: true })
})

// ────────── 5. Nginx auth_request 验证端点 ──────────

app.get('/auth', async (c) => {
  const sessionId = getCookie(c, 'quickAuth')
  if (!sessionId) {
    c.status(401)
    return c.body('Unauthorized')
  }

  const session = cache.get<{ email: string } | null>(`session:${sessionId}`)
  if (!session) {
    c.status(401)
    return c.body('Unauthorized')
  }

  // 滑动过期
  cache.expire(`session:${sessionId}`, Number(SESSION_TTL))

  c.header('X-User-Email', session.email)
  return c.body('OK')
})

// ────────── 6. 登录页面 ──────────

app.get('/login', (c) => {
  // 已登录则直接跳转首页
  const sessionId = getCookie(c, 'quickAuth')
  if (sessionId && cache.get(`session:${sessionId}`)) {
    return c.redirect('/')
  }
  return c.html(loginHtml)
})

// ────────── 7. 受保护的示例页面 ──────────

app.get('/', (c) => {
  const sessionId = getCookie(c, 'quickAuth')
  if (!sessionId) return c.redirect(loginUrl)

  const session = cache.get<{ email: string } | null>(`session:${sessionId}`)
  if (!session) return c.redirect(loginUrl)

  cache.expire(`session:${sessionId}`, Number(SESSION_TTL))

  return c.html(render(homeHtml, { email: session.email }))
})

export default app
