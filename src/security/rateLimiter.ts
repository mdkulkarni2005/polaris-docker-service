import { redis, Keys, TTL } from "../lib/redis"

const MAX_SESSIONS_PER_MINUTE = 5  // max 5 new containers per user per minute
const MAX_SESSIONS_PER_USER   = 3  // max 3 concurrent containers per user

export async function checkRateLimit(userId: string): Promise<{
  allowed: boolean
  reason?: string
  retryAfter?: number
}> {
  try {
    const minute = Math.floor(Date.now() / 60000)
    const key = Keys.rateLimit(userId, minute)

    // Increment counter for this user+minute window
    const count = await redis.incr(key)
    
    // Set TTL on first request in this window
    if (count === 1) {
      await redis.expire(key, TTL.rateLimit)
    }

    console.log(`[rate-limit] userId=${userId} count=${count}/${MAX_SESSIONS_PER_MINUTE}`)

    if (count > MAX_SESSIONS_PER_MINUTE) {
      return {
        allowed: false,
        reason: `Rate limit exceeded: max ${MAX_SESSIONS_PER_MINUTE} sessions per minute`,
        retryAfter: 60 - (Date.now() % 60000) / 1000,
      }
    }

    return { allowed: true }
  } catch (err) {
    // Redis error — fail open (allow the request)
    console.error("[rate-limit] error:", err)
    return { allowed: true }
  }
}
