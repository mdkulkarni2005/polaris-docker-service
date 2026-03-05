# Step 2 — Copy provider, API route, and hook into Polaris

Do this in your **Polaris** repo. You need to add three pieces: the provider abstraction, the `/api/sandbox` route, and the `useDockerPreview` hook.

---

## Option A: Copy with terminal (from polaris-docker-service folder)

Replace `POLARIS_REPO` with the full path to your Polaris app (e.g. `/Users/you/projects/polaris`).

```bash
# From polaris-docker-service repo root
POLARIS_REPO=/path/to/your/polaris-repo

# Create directories if needed
mkdir -p "$POLARIS_REPO/src/features/preview"
mkdir -p "$POLARIS_REPO/src/features/preview/hooks"
mkdir -p "$POLARIS_REPO/src/app/api/sandbox"

# Copy the three files
cp polaris-connect/src/features/preview/provider.ts "$POLARIS_REPO/src/features/preview/provider.ts"
cp polaris-connect/src/app/api/sandbox/route.ts "$POLARIS_REPO/src/app/api/sandbox/route.ts"
cp polaris-connect/src/features/preview/hooks/useDockerPreview.ts "$POLARIS_REPO/src/features/preview/hooks/useDockerPreview.ts"
```

---

## Option B: Copy manually

| Copy from (in polaris-docker-service) | To (in your Polaris repo) |
|--------------------------------------|---------------------------|
| `polaris-connect/src/features/preview/provider.ts` | `src/features/preview/provider.ts` |
| `polaris-connect/src/app/api/sandbox/route.ts` | `src/app/api/sandbox/route.ts` |
| `polaris-connect/src/features/preview/hooks/useDockerPreview.ts` | `src/features/preview/hooks/useDockerPreview.ts` |

Create any missing folders (`src/features/preview`, `src/features/preview/hooks`, `src/app/api/sandbox`) then copy the file contents.

---

## What each file does

1. **`src/features/preview/provider.ts`**  
   Exports `PREVIEW_PROVIDER` and `isDockerProvider()` so the app can switch between WebContainer and Docker via `NEXT_PUBLIC_PREVIEW_PROVIDER`.

2. **`src/app/api/sandbox/route.ts`**  
   Next.js API route `POST /api/sandbox` with `action: "start" | "stop" | "status"`. Calls your local Docker service at `DOCKER_SERVICE_URL` (localhost:4000) with `x-internal-key`.  
   **Note:** `getProjectFiles(projectId)` is still a stub (returns `[]`). You’ll wire it to Convex later so the container gets real project files.

3. **`src/features/preview/hooks/useDockerPreview.ts`**  
   Hook: `start()`, `stop()`, and state for `sessionId`, `previewUrl`, `terminalWsUrl`, `status`, `error`. Calls `/api/sandbox` and cleans up on unmount.

---

## Dependencies

The API route uses:

- `@clerk/nextjs` — `auth()`
- Next.js App Router (`next/server`)

The hook is client-side (`"use client"`) and only uses `fetch`. No extra packages needed if you already have Clerk and Next.js.

---

## Step 2 done when

- [ ] `src/features/preview/provider.ts` exists in Polaris
- [ ] `src/app/api/sandbox/route.ts` exists in Polaris
- [ ] `src/features/preview/hooks/useDockerPreview.ts` exists in Polaris
- [ ] Polaris dev server runs without errors (e.g. `npm run dev`)

Next: **Step 3** — Wire Convex in `getProjectFiles` (in `route.ts`) and **Step 4** — Wire Terminal and Preview with the feature flag.
