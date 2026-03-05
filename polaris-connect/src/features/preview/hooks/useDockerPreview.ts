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

  // Auto-stop on unmount
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
