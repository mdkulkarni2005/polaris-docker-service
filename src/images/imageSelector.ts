import { Language } from "../detection/types"

interface ImageConfig {
  image: string
  reason: string
  extraPackages?: string[]  // packages to pre-install at container start
}

const IMAGE_MAP: Record<Language, ImageConfig> = {
  javascript: {
    image: "node:20-alpine",
    reason: "JS/TS project",
  },
  typescript: {
    image: "node:20-alpine",
    reason: "TypeScript project",
  },
  python: {
    image: "python:3.12-slim",
    reason: "Python project",
    extraPackages: ["pip install --upgrade pip"],
  },
  go: {
    image: "golang:1.22-alpine",
    reason: "Go project",
  },
  rust: {
    image: "rust:1.77-slim",
    reason: "Rust project",
  },
  php: {
    image: "php:8.3-cli-alpine",
    reason: "PHP project",
  },
  unknown: {
    image: process.env.SANDBOX_IMAGE ?? "node:20-alpine",
    reason: "Unknown language — using default",
  },
}

export function selectImage(language: Language): ImageConfig {
  const config = IMAGE_MAP[language] ?? IMAGE_MAP.unknown
  console.log(`[image-selector] ${language} → ${config.image} (${config.reason})`)
  return config
}
