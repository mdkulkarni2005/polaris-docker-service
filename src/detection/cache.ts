import { redis, Keys, TTL } from "../lib/redis"
import { DetectionResult } from "./types"

export async function getCachedDetection(
  projectId: string
): Promise<DetectionResult | null> {
  try {
    const cached = await redis.get<DetectionResult>(Keys.detection(projectId))
    if (cached) {
      console.log(`[detection-cache] HIT: ${projectId} → ${cached.framework}`)
      return cached
    }
    console.log(`[detection-cache] MISS: ${projectId}`)
    return null
  } catch (err) {
    console.error("[detection-cache] get error:", err)
    return null  // fail open — never block detection
  }
}

export async function setCachedDetection(
  projectId: string,
  result: DetectionResult
): Promise<void> {
  try {
    await redis.set(Keys.detection(projectId), result, { ex: TTL.detection })
    console.log(`[detection-cache] SET: ${projectId} → ${result.framework} (TTL: 1hr)`)
  } catch (err) {
    console.error("[detection-cache] set error:", err)
    // fail silently — cache miss is fine
  }
}

export async function invalidateDetectionCache(
  projectId: string
): Promise<void> {
  try {
    await redis.del(Keys.detection(projectId))
    console.log(`[detection-cache] INVALIDATED: ${projectId}`)
  } catch (err) {
    console.error("[detection-cache] invalidate error:", err)
  }
}
