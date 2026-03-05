# Day 5 — Connect Polaris to polaris-docker-service

This folder contains the **Polaris app** (Next.js) code you add so the IDE can use the Docker preview backend. Do the work on a separate git branch in your **Polaris** repo.

## Quick checklist

- [ ] Add env vars to Polaris (Step 1)
- [ ] Copy abstraction + API + hook (Steps 2–3)
- [ ] Wire Terminal and Preview with feature flag (Step 4)
- [ ] Wire `getProjectFiles` in `/api/sandbox` to Convex

## Step 1 — Env in Polaris

In your **Polaris** repo, create or edit `.env.local`. **Local setup** (polaris-docker-service on your machine):

```bash
# .env.local — local
DOCKER_SERVICE_URL=http://localhost:4000
DOCKER_SERVICE_INTERNAL_KEY=random_secret_string
NEXT_PUBLIC_PREVIEW_PROVIDER=webcontainer
```

Use the same `DOCKER_SERVICE_INTERNAL_KEY` as in polaris-docker-service `.env`. For Railway, use `DOCKER_SERVICE_URL=https://your-service.railway.app` instead. Set `NEXT_PUBLIC_PREVIEW_PROVIDER=docker` when you want to use Docker instead of WebContainer.

## Step 2 — Copy these into your Polaris repo

| From (this folder) | To (Polaris repo) |
|-------------------|---------------------|
| `src/features/preview/provider.ts` | `src/features/preview/provider.ts` |
| `src/app/api/sandbox/route.ts` | `src/app/api/sandbox/route.ts` |
| `src/features/preview/hooks/useDockerPreview.ts` | `src/features/preview/hooks/useDockerPreview.ts` |

## Step 3 — Convex: project files

In Polaris, `src/app/api/sandbox/route.ts` has a `getProjectFiles(projectId)` stub. Replace it with your Convex query so the Docker service receives the project files, e.g.:

```ts
import { fetchQuery } from "convex/nextjs";
import { api } from "@/convex/_generated/api";

async function getProjectFiles(projectId: string) {
  const files = await fetchQuery(api.projects.getFiles, { projectId });
  return files.map((f: { path: string; content: string }) => ({ path: f.path, content: f.content }));
}
```

(Adjust to your Convex API and file shape.)

## Step 4 — Terminal and Preview wiring

See **TERMINAL-PREVIEW-WIRING.md** in this folder. Summary:

- **Terminal.tsx:** Add prop `wsUrl: string | null`. When set, connect xterm.js to that WebSocket; send input and `{ type: "resize", cols, rows }`. Keep existing WebContainer logic when `wsUrl` is null.
- **Preview.tsx:** Use `previewUrl` from the Docker hook when provider is Docker.
- **Parent (e.g. project page):** Use `PREVIEW_PROVIDER` / `isDockerProvider()` to choose `useDockerPreview` vs your existing WebContainer hook; pass `terminalWsUrl` and `previewUrl` into Terminal and Preview.

## Abstraction pattern

```
Terminal.tsx / Preview.tsx
         ↓ (same props interface)
  ┌──────────────────────┐
  │   Provider Selector   │  ← PREVIEW_PROVIDER env
  └──────────────────────┘
         ↓              ↓
  useWebContainer   useDockerPreview
         ↓              ↓
  WebContainer API  POST /api/sandbox → Docker Service (Railway)
```

Switch to Docker by setting `NEXT_PUBLIC_PREVIEW_PROVIDER=docker`; no component changes needed.

## Phase 1 done checklist (from your plan)

- [ ] Railway + polaris-docker-service deployed
- [ ] POST /session/start returns sessionId, wsUrl, previewUrl
- [ ] POST /session/stop works
- [ ] WebSocket terminal streams to xterm.js
- [ ] Clerk JWT (or internal key) verified on Docker service
- [ ] DOCKER_SERVICE_URL in Polaris .env
- [ ] POST /api/sandbox route working
- [ ] useDockerPreview wired to Terminal (via wsUrl)
- [ ] Preview iframe loads Docker preview URL
- [ ] Feature flag switches WebContainer vs Docker
- [ ] WebContainer code still intact
- [ ] E2E: open project → terminal → `npm run dev` → preview loads
