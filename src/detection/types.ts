export interface DetectionResult {
  framework: Framework
  language: Language
  packageManager: PackageManager
  installCommand: string
  devCommand: string
  port: number
  confidence: "high" | "medium" | "low"
  detectedFrom: string // which file triggered detection e.g. "vite.config.js"
}

export type Framework =
  | "vite"
  | "nextjs"
  | "react-cra"
  | "vue"
  | "nuxt"
  | "svelte"
  | "sveltekit"
  | "angular"
  | "django"
  | "flask"
  | "fastapi"
  | "express"
  | "go"
  | "rust"
  | "php"
  | "static"
  | "unknown"

export type Language =
  | "javascript"
  | "typescript"
  | "python"
  | "go"
  | "rust"
  | "php"
  | "unknown"

export type PackageManager =
  | "npm"
  | "pnpm"
  | "yarn"
  | "bun"
  | "pip"
  | "pipenv"
  | "poetry"
  | "go"
  | "cargo"
  | "composer"
  | "unknown"

export const DEFAULT_DETECTION: DetectionResult = {
  framework: "unknown",
  language: "javascript",
  packageManager: "npm",
  installCommand: "npm install",
  devCommand: "npm run dev",
  port: 3000,
  confidence: "low",
  detectedFrom: "default",
}
