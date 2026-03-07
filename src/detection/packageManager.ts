import { PackageManager } from "./types"

interface PackageManagerInfo {
  packageManager: PackageManager
  installCommand: string
}

export function detectPackageManager(fileList: string[]): PackageManagerInfo {
  // Check in priority order — most specific first
  const checks: Array<{
    file: string
    pm: PackageManager
    install: string
  }> = [
    { file: "bun.lockb",       pm: "bun",     install: "bun install" },
    { file: "pnpm-lock.yaml",  pm: "pnpm",    install: "pnpm install" },
    { file: "yarn.lock",       pm: "yarn",    install: "yarn install" },
    { file: "package-lock.json", pm: "npm",   install: "npm install" },
    { file: "Pipfile.lock",    pm: "pipenv",  install: "pipenv install" },
    { file: "Pipfile",         pm: "pipenv",  install: "pipenv install" },
    { file: "poetry.lock",     pm: "poetry",  install: "poetry install" },
    { file: "requirements.txt", pm: "pip",    install: "pip install -r requirements.txt" },
    { file: "go.sum",          pm: "go",      install: "go mod download" },
    { file: "go.mod",          pm: "go",      install: "go mod download" },
    { file: "Cargo.lock",      pm: "cargo",   install: "cargo build" },
    { file: "Cargo.toml",      pm: "cargo",   install: "cargo build" },
    { file: "composer.json",   pm: "composer", install: "composer install" },
  ]

  for (const check of checks) {
    if (fileList.includes(check.file)) {
      console.log(`[detection] package manager: ${check.pm} (found ${check.file})`)
      return { packageManager: check.pm, installCommand: check.install }
    }
  }

  // Has package.json but no lockfile → default to npm
  if (fileList.includes("package.json")) {
    return { packageManager: "npm", installCommand: "npm install" }
  }

  return { packageManager: "unknown", installCommand: "" }
}
