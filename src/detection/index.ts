import { detectPackageManager } from "./packageManager"
import { detectFramework } from "./framework"
import { DetectionResult, DEFAULT_DETECTION } from "./types"
import { getCachedDetection, setCachedDetection } from "./cache"
import * as fs from "fs/promises"
import * as path from "path"

export async function detectProject(
  workspacePath: string,
  projectId?: string
): Promise<DetectionResult> {
  // Check cache first
  if (projectId) {
    const cached = await getCachedDetection(projectId)
    if (cached) return cached
  }

  console.log(`[detection] scanning: ${workspacePath}`)

  try {
    // 1. Read workspace file list (root level only)
    const entries = await fs.readdir(workspacePath)
    const fileList = entries

    console.log(`[detection] found files: ${fileList.join(", ")}`)

    // 2. Detect package manager
    const { packageManager, installCommand } = detectPackageManager(fileList)

    // 3. Detect framework
    const frameworkInfo = await detectFramework(
      workspacePath,
      fileList,
      packageManager
    )

    const result: DetectionResult = {
      framework: frameworkInfo.framework,
      language: frameworkInfo.language,
      packageManager,
      installCommand,
      devCommand: frameworkInfo.devCommand,
      port: frameworkInfo.port,
      confidence: frameworkInfo.confidence,
      detectedFrom: frameworkInfo.detectedFrom,
    }

    // Store in cache for next time
    if (projectId) {
      await setCachedDetection(projectId, result)
    }

    console.log(`[detection] result:`, JSON.stringify(result, null, 2))
    return result

  } catch (err) {
    console.error("[detection] error:", err)
    return DEFAULT_DETECTION
  }
}

export { DetectionResult, DEFAULT_DETECTION } from "./types"
