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

      // Fetch project files from Convex (replace with your Convex client call)
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

/**
 * Load project files for the Docker container.
 * Replace with your Convex client, e.g.:
 *   const files = await convex.query(api.projects.getFiles, { projectId });
 *   return files.map(f => ({ path: f.path, content: f.content }));
 */
async function getProjectFiles(
  projectId: string
): Promise<{ path: string; content: string }[]> {
  // TODO: Wire to Convex — e.g. fetch from Convex HTTP API or use ConvexClient
  return [];
}
