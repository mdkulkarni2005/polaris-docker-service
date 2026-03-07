import { Redis } from "@upstash/redis"

if (!process.env.UPSTASH_REDIS_REST_URL) {
  throw new Error("UPSTASH_REDIS_REST_URL not set")
}
if (!process.env.UPSTASH_REDIS_REST_TOKEN) {
  throw new Error("UPSTASH_REDIS_REST_TOKEN not set")
}

export const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
})

// Key builders — central place for all Redis key names
export const Keys = {
  detection:   (projectId: string) => `polaris:detection:${projectId}`,
  session:     (sessionId: string) => `polaris:session:${sessionId}`,
  rateLimit:   (userId: string, minute: number) => `polaris:ratelimit:${userId}:${minute}`,
  sessionList: () => `polaris:sessions`,
}

export const TTL = {
  detection:  60 * 60,        // 1 hour — detection result cache
  session:    60 * 60 * 24,   // 24 hours — session data
  rateLimit:  60,             // 1 minute — rate limit window
}
