/**
 * 简易内存缓存 — 替代 Redis
 * 支持 TTL（秒级）、惰性过期 + 定期清理
 */

interface CacheEntry<T = unknown> {
  value: T
  expiresAt: number // 时间戳（毫秒）
}

export class MemoryCache {
  private store = new Map<string, CacheEntry>()
  private readonly cleanupInterval: ReturnType<typeof setInterval>

  /** 默认清理过期键的间隔（秒） */
  constructor(private ttlCheckInterval = 60) {
    this.cleanupInterval = setInterval(() => this.evictExpired(), ttlCheckInterval * 1000)
  }

  // ---- 基础操作 ----

  get<T = string>(key: string): T | null {
    const entry = this.store.get(key)
    if (!entry) return null
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key)
      return null
    }
    return entry.value as T
  }

  set(key: string, value: unknown, ttlSec: number): void {
    this.store.set(key, {
      value,
      expiresAt: Date.now() + ttlSec * 1000,
    })
  }

  del(key: string): void {
    this.store.delete(key)
  }

  exists(key: string): boolean {
    return this.get(key) !== null
  }

  /** 更新 TTL（秒），仅当 key 存在时有效 */
  expire(key: string, ttlSec: number): boolean {
    const entry = this.store.get(key)
    if (!entry) return false
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key)
      return false
    }
    entry.expiresAt = Date.now() + ttlSec * 1000
    return true
  }

  /** 获取剩余 TTL（秒），-2 表示不存在，-1 表示无限制 */
  ttl(key: string): number {
    const entry = this.store.get(key)
    if (!entry) return -2
    const remaining = Math.floor((entry.expiresAt - Date.now()) / 1000)
    if (remaining <= 0) {
      this.store.delete(key)
      return -2
    }
    return remaining
  }

  // ---- 内部清理 ----

  private evictExpired(): void {
    const now = Date.now()
    for (const [key, entry] of this.store) {
      if (now > entry.expiresAt) {
        this.store.delete(key)
      }
    }
  }

  /** 销毁缓存（主要用于测试 / 热重载） */
  destroy(): void {
    clearInterval(this.cleanupInterval)
    this.store.clear()
  }

  /** 当前键数量（仅供调试） */
  get size(): number {
    return this.store.size
  }
}

/** 全局单例 */
export const cache = new MemoryCache()
