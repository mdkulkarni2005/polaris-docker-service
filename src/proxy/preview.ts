import { Router, type Request, type Response, type NextFunction } from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';
import Docker from 'dockerode';
import { registry } from '../session/registry';
import { isInternalKeyInvalid } from '../security/auth';

const PROXY_TIMEOUT_MS = 8000;
const PORT_PROBE_TIMEOUT_MS = 1000;

const docker = new Docker();

const PREVIEW_NOT_READY_HTML = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Preview</title></head>
<body style="font-family:system-ui;max-width:560px;margin:60px auto;padding:20px;color:#333;">
  <h2>Preview not ready yet</h2>
  <p>Start your dev server in the <strong>Terminal</strong> tab:</p>
  <ul>
    <li><code>npm install</code> (if needed)</li>
    <li><code>npm run dev</code></li>
  </ul>
  <p>Vite uses port 5173; Next.js often uses 3000. Refresh this tab after the server is running.</p>
</body>
</html>
`;

function sendPreviewNotReady(res: Response): void {
  res.status(502).setHeader('Content-Type', 'text/html; charset=utf-8').send(PREVIEW_NOT_READY_HTML);
}

const PREVIEW_CONTAINER_PORTS = [5173, 3000, 8000, 4200, 8080] as const;

async function findPreviewTargetPort(containerId: string, sessionId: string): Promise<number | null> {
  try {
    const container = docker.getContainer(containerId);
    const inspect = await container.inspect();
    const ports = inspect.NetworkSettings?.Ports ?? {};

    for (const containerPort of PREVIEW_CONTAINER_PORTS) {
      const key = `${containerPort}/tcp`;
      const binding = ports[key]?.[0]?.HostPort;
      if (!binding) continue;

      const hostPort = parseInt(binding, 10);
      if (!Number.isFinite(hostPort)) continue;

      try {
        const resp = await fetch(`http://127.0.0.1:${hostPort}/`, {
          method: 'GET',
          signal: AbortSignal.timeout(PORT_PROBE_TIMEOUT_MS),
        });
        if (resp.status < 500) {
          console.log(
            '[polaris-docker] preview port selected:',
            sessionId,
            'containerPort',
            containerPort,
            'hostPort',
            hostPort
          );
          return hostPort;
        }
      } catch {
        // Ignore and try next candidate port
      }
    }
  } catch (err) {
    console.log('[polaris-docker] preview inspect error:', sessionId, containerId, err);
  }

  return null;
}

export function createPreviewRouter(): Router {
  const router = Router();

  router.get(/^\/preview\/([^/]+)(?:\/.*)?$/, async (req: Request, res: Response, next: NextFunction) => {
    const queryKey = typeof req.query?.key === 'string' ? req.query.key : null;
    if (isInternalKeyInvalid(req.headers, queryKey)) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const sessionId = (req.params as Record<string, string>).sessionId ?? (req.params as Record<string, string>)[0];
    if (!sessionId) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    const session = registry.get(sessionId);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    registry.updateActivity(sessionId);
    console.log('[polaris-docker] preview request:', sessionId, req.method, req.path);

    const targetPort = await findPreviewTargetPort(session.containerId, sessionId);

    if (targetPort == null) {
      console.log('[polaris-docker] preview not ready (no responsive dev server):', sessionId);
      sendPreviewNotReady(res);
      return;
    }

    const proxy = createProxyMiddleware<Request, Response>({
      target: `http://127.0.0.1:${targetPort}`,
      changeOrigin: true,
      pathRewrite: { [`^/preview/${sessionId}`]: '' },
      proxyTimeout: PROXY_TIMEOUT_MS,
      timeout: PROXY_TIMEOUT_MS,
      on: {
        proxyRes(proxyRes) {
          if (proxyRes.statusCode && proxyRes.statusCode < 500) {
            console.log('[polaris-docker] preview proxy OK:', sessionId, '-> port', targetPort);
          }
        },
        error: (err: Error) => {
          console.log('[polaris-docker] preview proxy error:', sessionId, 'port', targetPort, err.message);
          if (!res.headersSent) sendPreviewNotReady(res);
        },
      },
    });

    proxy(req, res, (err?: unknown) => {
      if (err && !res.headersSent) sendPreviewNotReady(res);
      else if (!res.headersSent) next();
    });
  });

  return router;
}
