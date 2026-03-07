import { Framework, Language, PackageManager } from "./types"
import * as fs from "fs/promises"
import * as path from "path"

interface FrameworkInfo {
  framework: Framework
  language: Language
  devCommand: string
  port: number
  confidence: "high" | "medium" | "low"
  detectedFrom: string
}

export async function detectFramework(
  workspacePath: string,
  fileList: string[],
  packageManager: PackageManager
): Promise<FrameworkInfo> {
  const pm = packageManager === "unknown" ? "npm" : packageManager

  // Helper to read a file safely
  async function readFile(filename: string): Promise<string> {
    try {
      return await fs.readFile(path.join(workspacePath, filename), "utf-8")
    } catch {
      return ""
    }
  }

  // Read package.json if it exists
  let packageJson: Record<string, unknown> = {}
  let scripts: Record<string, string> = {}
  let dependencies: Record<string, string> = {}
  let devDependencies: Record<string, string> = {}

  if (fileList.includes("package.json")) {
    try {
      const raw = await readFile("package.json")
      packageJson = JSON.parse(raw)
      scripts = (packageJson.scripts as Record<string, string>) ?? {}
      dependencies = (packageJson.dependencies as Record<string, string>) ?? {}
      devDependencies = (packageJson.devDependencies as Record<string, string>) ?? {}
      const allDeps = { ...dependencies, ...devDependencies }

      // Check config files first — highest confidence
      if (fileList.some(f => f.startsWith("vite.config"))) {
        const isReact = "react" in allDeps
        const isSvelte = "svelte" in allDeps
        const isVue = "vue" in allDeps
        const framework = isSvelte ? "svelte" : isVue ? "vue" : "vite"
        const lang = fileList.some(f => f.endsWith(".ts") || f.endsWith(".tsx")) ? "typescript" : "javascript"
        return {
          framework,
          language: lang,
          devCommand: `${pm} run dev -- --host 0.0.0.0 --port 5173`,
          port: 5173,
          confidence: "high",
          detectedFrom: "vite.config.*",
        }
      }

      if (fileList.some(f => f.startsWith("next.config"))) {
        const lang = fileList.some(f => f.endsWith(".ts") || f.endsWith(".tsx")) ? "typescript" : "javascript"
        return {
          framework: "nextjs",
          language: lang,
          devCommand: `${pm} run dev -- -p 3000`,
          port: 3000,
          confidence: "high",
          detectedFrom: "next.config.*",
        }
      }

      if (fileList.some(f => f.startsWith("nuxt.config"))) {
        return {
          framework: "nuxt",
          language: "typescript",
          devCommand: `${pm} run dev`,
          port: 3000,
          confidence: "high",
          detectedFrom: "nuxt.config.*",
        }
      }

      if (fileList.some(f => f.startsWith("svelte.config"))) {
        return {
          framework: "sveltekit",
          language: "typescript",
          devCommand: `${pm} run dev -- --host 0.0.0.0`,
          port: 5173,
          confidence: "high",
          detectedFrom: "svelte.config.*",
        }
      }

      if (fileList.includes("angular.json")) {
        return {
          framework: "angular",
          language: "typescript",
          devCommand: `${pm} run start -- --host 0.0.0.0`,
          port: 4200,
          confidence: "high",
          detectedFrom: "angular.json",
        }
      }

      // Check package.json dependencies — medium confidence
      if ("react-scripts" in allDeps || "react-scripts" in scripts) {
        return {
          framework: "react-cra",
          language: "javascript",
          devCommand: `${pm} run start`,
          port: 3000,
          confidence: "medium",
          detectedFrom: "package.json react-scripts",
        }
      }

      // Has a dev script — use it with low confidence
      if ("dev" in scripts) {
        const lang = fileList.some(f => f.endsWith(".ts")) ? "typescript" : "javascript"
        return {
          framework: "unknown",
          language: lang,
          devCommand: `${pm} run dev`,
          port: 3000,
          confidence: "low",
          detectedFrom: "package.json scripts.dev",
        }
      }

      if ("start" in scripts) {
        return {
          framework: "express",
          language: "javascript",
          devCommand: `${pm} run start`,
          port: 3000,
          confidence: "low",
          detectedFrom: "package.json scripts.start",
        }
      }
    } catch {
      // package.json parse error
    }
  }

  // Python detection
  if (fileList.includes("manage.py")) {
    return {
      framework: "django",
      language: "python",
      devCommand: "python manage.py runserver 0.0.0.0:8000",
      port: 8000,
      confidence: "high",
      detectedFrom: "manage.py",
    }
  }

  if (fileList.includes("app.py") || fileList.includes("main.py")) {
    const content = await readFile("app.py") || await readFile("main.py")
    const isFastapi = content.includes("fastapi") || content.includes("FastAPI")
    const isFlask = content.includes("flask") || content.includes("Flask")
    if (isFastapi) {
      return {
        framework: "fastapi",
        language: "python",
        devCommand: "uvicorn main:app --host 0.0.0.0 --port 8000 --reload",
        port: 8000,
        confidence: "high",
        detectedFrom: "main.py (FastAPI)",
      }
    }
    if (isFlask) {
      return {
        framework: "flask",
        language: "python",
        devCommand: "flask run --host=0.0.0.0 --port=8000",
        port: 8000,
        confidence: "high",
        detectedFrom: "app.py (Flask)",
      }
    }
  }

  // Go detection
  if (fileList.includes("go.mod") || fileList.includes("main.go")) {
    return {
      framework: "go",
      language: "go",
      devCommand: "go run .",
      port: 8080,
      confidence: "high",
      detectedFrom: "go.mod / main.go",
    }
  }

  // Rust detection
  if (fileList.includes("Cargo.toml")) {
    return {
      framework: "rust",
      language: "rust",
      devCommand: "cargo run",
      port: 8080,
      confidence: "high",
      detectedFrom: "Cargo.toml",
    }
  }

  // Static HTML
  if (fileList.includes("index.html")) {
    return {
      framework: "static",
      language: "javascript",
      devCommand: "npx serve . -p 3000 -s",
      port: 3000,
      confidence: "medium",
      detectedFrom: "index.html",
    }
  }

  return {
    framework: "unknown",
    language: "unknown",
    devCommand: "npm run dev",
    port: 3000,
    confidence: "low",
    detectedFrom: "default fallback",
  }
}
