/**
 * 导出 app 实例，方便外部使用（如测试、自定义挂载）
 * @example
 *   import app from './api.js'
 *   // 或在另一个 Hono 应用中挂载
 *   import { Hono } from 'hono'
 *   const top = new Hono()
 *   top.route('/auth', app)
 */
import app from './app.js'
export default app
export type AppType = typeof app