# Step 2 — Detailed guide (copy 3 files into Polaris)

## What we're doing (simple version)

You have **two projects**:

1. **polaris-docker-service** (this repo) — the backend that runs Docker containers. It’s already set up.
2. **Polaris** — your main app (the cloud IDE, usually a Next.js app). It runs in a **different folder** on your computer.

Step 2 means: **add 3 new files inside your Polaris project** so Polaris can talk to polaris-docker-service (start/stop sessions, get terminal and preview URLs).

You are **not** moving files from one repo to another. You are **creating the same 3 files** inside the Polaris project, with the same content that already exists in `polaris-connect/` in this repo.

---

## Where the files must go (in your Polaris project)

Inside your **Polaris** project folder, the structure should look like this when you’re done:

```
your-polaris-project/
├── src/
│   ├── app/
│   │   └── api/
│   │       └── sandbox/
│   │           └── route.ts          ← FILE 2 (API route)
│   └── features/
│       └── preview/
│           ├── provider.ts          ← FILE 1 (provider)
│           └── hooks/
│               └── useDockerPreview.ts   ← FILE 3 (hook)
├── package.json
├── .env.local
└── ...
```

So you need to create:

- `src/features/preview/provider.ts`
- `src/app/api/sandbox/route.ts`
- `src/features/preview/hooks/useDockerPreview.ts`

---

## Method 1: Create each file by hand (copy-paste)

Open your **Polaris** project in your editor. Then do the following for each file.

---

### File 1 — `src/features/preview/provider.ts`

1. In your Polaris project, go to the `src` folder.
2. If there is no `features` folder, create it. Inside `features`, create `preview`.
3. Create a new file: `src/features/preview/provider.ts`
4. Paste this **entire** content and save:

```ts
/**
 * Preview provider abstraction.
 * Swap "webcontainer" | "docker" here (or via NEXT_PUBLIC_PREVIEW_PROVIDER) to change provider.
 */
export type PreviewProviderType = "webcontainer" | "docker";

export const PREVIEW_PROVIDER: PreviewProviderType =
  (process.env.NEXT_PUBLIC_PREVIEW_PROVIDER as PreviewProviderType) ?? "webcontainer";

export const isDockerProvider = (): boolean => PREVIEW_PROVIDER === "docker";
```

---

### File 2 — `src/app/api/sandbox/route.ts`

1. In your Polaris project, go to `src/app`.
2. If there is no `api` folder, create it. Inside `api`, create `sandbox`.
3. Create a new file: `src/app/api/sandbox/route.ts`
4. Paste this **entire** content and save:

```ts
import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { randomUUID } from "crypto";

const DOCKER_SERVICE_URL = process.env.DOCKER_SERVICE_URL;
const DOCKER_SERVICE_INTERNAL_KEY = process.env.DOCKER_SERVICE_INTERNAL_KEY;

export interface SandboxPostBody {
  action: "start" | "stop" | "status";
  projectId?: string;
  sessionId?: string;
}

export interface SandboxStartResponse {
  sessionId: string;
  wsUrl: string;
  previewUrl: string;
}

async function fetchWithInternalKey(
  path: string,
  options: RequestInit & { method?: string; body?: string } = {}
): Promise<Response> {
  const url = `${DOCKER_SERVICE_URL?.replace(/\/$/, "")}${path}`;
  const headers: HeadersInit = {
    "Content-Type": "application/json",
    ...(DOCKER_SERVICE_INTERNAL_KEY
      ? { "x-internal-key": DOCKER_SERVICE_INTERNAL_KEY }
      : {}),
    ...options.headers,
  };
  return fetch(url, { ...options, headers });
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as SandboxPostBody;
    const { action, projectId, sessionId } = body;

    if (!action) {
      return NextResponse.json(
        { error: "Missing action" },
        { status: 400 }
      );
    }

    if (!DOCKER_SERVICE_URL) {
      return NextResponse.json(
        { error: "DOCKER_SERVICE_URL not configured" },
        { status: 503 }
      );
    }

    if (action === "start") {
      const { userId } = await auth();
      if (!userId) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }
      if (!projectId) {
        return NextResponse.json(
          { error: "Missing projectId for start" },
          { status: 400 }
        );
      }

      const files = await getProjectFiles(projectId);
      const newSessionId = randomUUID();

      const res = await fetchWithInternalKey("/session/start", {
        method: "POST",
        body: JSON.stringify({
          sessionId: newSessionId,
          projectId,
          userId,
          files,
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        return NextResponse.json(
          { error: err.error ?? "Docker service error" },
          { status: res.status }
        );
      }

      const data = (await res.json()) as SandboxStartResponse;
      return NextResponse.json({
        sessionId: data.sessionId,
        wsUrl: data.wsUrl,
        previewUrl: data.previewUrl,
      });
    }

    if (action === "stop") {
      if (!sessionId) {
        return NextResponse.json(
          { error: "Missing sessionId for stop" },
          { status: 400 }
        );
      }
      const res = await fetchWithInternalKey("/session/stop", {
        method: "POST",
        body: JSON.stringify({ sessionId }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        return NextResponse.json(
          { error: err.error ?? "Docker service error" },
          { status: res.status }
        );
      }
      return NextResponse.json({ success: true });
    }

    if (action === "status") {
      if (!sessionId) {
        return NextResponse.json(
          { error: "Missing sessionId for status" },
          { status: 400 }
        );
      }
      const res = await fetchWithInternalKey(
        `/session/status?sessionId=${encodeURIComponent(sessionId)}`,
        { method: "GET" }
      );
      if (!res.ok) {
        return NextResponse.json(
          { error: "Docker service error" },
          { status: res.status }
        );
      }
      const data = await res.json();
      return NextResponse.json(data);
    }

    return NextResponse.json(
      { error: "Invalid action" },
      { status: 400 }
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

async function getProjectFiles(
  projectId: string
): Promise<{ path: string; content: string }[]> {
  // TODO: Wire to Convex later — for now returns empty array
  return [];
}
```

---

### File 3 — `src/features/preview/hooks/useDockerPreview.ts`

1. In your Polaris project, under `src/features/preview/`, create a folder named `hooks` (if it doesn’t exist).
2. Create a new file: `src/features/preview/hooks/useDockerPreview.ts`
3. Paste this **entire** content and save:

```ts
"use client";

import { useState, useCallback, useEffect } from "react";

export type DockerPreviewStatus =
  | "idle"
  | "starting"
  | "ready"
  | "error";

export interface UseDockerPreviewReturn {
  status: DockerPreviewStatus;
  previewUrl: string | null;
  sessionId: string | null;
  terminalWsUrl: string | null;
  error: string | null;
  start: () => Promise<void>;
  stop: () => Promise<void>;
}

export interface UseDockerPreviewProps {
  projectId: string;
  enabled: boolean;
}

export function useDockerPreview({
  projectId,
  enabled,
}: UseDockerPreviewProps): UseDockerPreviewReturn {
  const [status, setStatus] = useState<DockerPreviewStatus>("idle");
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [terminalWsUrl, setTerminalWsUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const start = useCallback(async () => {
    if (!projectId || !enabled) return;
    setStatus("starting");
    setError(null);
    try {
      const res = await fetch("/api/sandbox", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "start", projectId }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error ?? "Failed to start sandbox");
      }
      setSessionId(data.sessionId);
      setTerminalWsUrl(data.wsUrl ?? null);
      setPreviewUrl(data.previewUrl ?? null);
      setStatus("ready");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      setError(message);
      setStatus("error");
    }
  }, [projectId, enabled]);

  const stop = useCallback(async () => {
    const sid = sessionId;
    if (!sid) return;
    try {
      await fetch("/api/sandbox", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "stop", sessionId: sid }),
      });
    } finally {
      setSessionId(null);
      setTerminalWsUrl(null);
      setPreviewUrl(null);
      setStatus("idle");
      setError(null);
    }
  }, [sessionId]);

  useEffect(() => {
    return () => {
      if (sessionId) {
        fetch("/api/sandbox", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "stop", sessionId }),
        }).catch(() => {});
      }
    };
  }, [sessionId]);

  return {
    status,
    previewUrl,
    sessionId,
    terminalWsUrl,
    error,
    start,
    stop,
  };
}
```

---

## Method 2: Copy with terminal (if you prefer)

1. Open Terminal.
2. Go to the **polaris-docker-service** folder (this repo):
   ```bash
   cd /Users/manaskulkarni/polaris-docker-service
   ```
3. Set your Polaris project path (change the path to where your Polaris app actually is):
   ```bash
   POLARIS_REPO=/Users/manaskulkarni/polaris
   ```
   (Replace `polaris` with your real Polaris project folder name/path.)
4. Create the folders and copy the files:
   ```bash
   mkdir -p "$POLARIS_REPO/src/features/preview/hooks"
   mkdir -p "$POLARIS_REPO/src/app/api/sandbox"
   cp polaris-connect/src/features/preview/provider.ts "$POLARIS_REPO/src/features/preview/provider.ts"
   cp polaris-connect/src/app/api/sandbox/route.ts "$POLARIS_REPO/src/app/api/sandbox/route.ts"
   cp polaris-connect/src/features/preview/hooks/useDockerPreview.ts "$POLARIS_REPO/src/features/preview/hooks/useDockerPreview.ts"
   ```

---

## What each file is for (short)

| File | What it does |
|------|----------------|
| **provider.ts** | Reads the env variable to decide if the app uses "webcontainer" or "docker" for preview. Other code uses `isDockerProvider()` to choose the right backend. |
| **route.ts** | This is the API route `POST /api/sandbox`. When the frontend calls it with "start", it calls your local Docker service (localhost:4000), gets sessionId, wsUrl, previewUrl, and returns them. "stop" and "status" also go through this route. |
| **useDockerPreview.ts** | A React hook. Your UI calls `start()` to start a Docker session and `stop()` to stop it. The hook gives you `previewUrl`, `terminalWsUrl`, `sessionId`, `status`, and `error`. |

---

## Step 2 done when

- [ ] In your **Polaris** project you have:  
  `src/features/preview/provider.ts`  
  `src/app/api/sandbox/route.ts`  
  `src/features/preview/hooks/useDockerPreview.ts`
- [ ] In the Polaris folder you run `npm run dev` and the app starts without errors.

The `getProjectFiles` function in `route.ts` still returns an empty array; we’ll connect it to Convex in a later step.
