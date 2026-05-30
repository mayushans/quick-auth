import { serve } from '@hono/node-server'
import app from './app.js'

const PORT = process.env.PORT || '3000'

serve({
  fetch: app.fetch,
  port: Number(PORT),
}, (info) => {
  console.log(`Quick Auth server running on http://localhost:${info.port}`)
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER) {
    console.log('未配置 SMTP，验证码将打印到控制台（开发模式）')
  }
})
