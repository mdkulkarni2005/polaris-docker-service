import { Router, type Request, type Response, type NextFunction } from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';
import Docker from 'dockerode';
import { registry } from '../session/registry';
import { isInternalKeyInvalid } from '../security/auth';
import { unpauseSession } from '../session/manager';

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

const PORT_PRIORITY = [5173, 3000, 3001, 3002, 8000, 4200, 8080];

async function findPreviewTargetPort(containerId: string, sessionId: string): Promise<number | null> {
  try {
    const container = docker.getContainer(containerId);
    const inspect = await container.inspect();
    const portBindings = inspect.NetworkSettings?.Ports ?? {};

    const candidates: { containerPort: number; hostPort: number }[] = [];
    for (const [key, bindings] of Object.entries(portBindings)) {
      if (!bindings?.length) continue;
      const containerPort = parseInt(key, 10);
      const hostPort = parseInt(bindings[0].HostPort ?? '', 10);
      if (Number.isFinite(containerPort) && Number.isFinite(hostPort)) {
        candidates.push({ containerPort, hostPort });
      }
    }

    candidates.sort((a, b) => {
      const ai = PORT_PRIORITY.indexOf(a.containerPort);
      const bi = PORT_PRIORITY.indexOf(b.containerPort);
      return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
    });

    for (const { containerPort, hostPort } of candidates) {
      try {
        const resp = await fetch(`http://127.0.0.1:${hostPort}/`, {
          method: 'GET',
          signal: AbortSignal.timeout(PORT_PROBE_TIMEOUT_MS),
        });
        if (resp.status < 500) {
          console.log('[polaris-docker] preview port selected:', sessionId, 'containerPort', containerPort, 'hostPort', hostPort);
          return hostPort;
        }
      } catch {
        // port not responding, try next
      }
    }

    await logContainerListeningPorts(container, sessionId);
  } catch (err) {
    console.log('[polaris-docker] preview inspect error:', sessionId, containerId, err);
  }

  return null;
}

async function logContainerListeningPorts(container: Docker.Container, sessionId: string): Promise<void> {
  try {
    const exec = await container.exec({
      Cmd: ['sh', '-c', "ss -tlnp 2>/dev/null || netstat -tlnp 2>/dev/null || echo 'no tool'"],
      AttachStdout: true,
      AttachStderr: true,
      User: 'root',
    });
    const stream = await exec.start({ hijack: true, stdin: false });
    let output = '';
    stream.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    await new Promise<void>(resolve => {
      stream.on('end', resolve);
      stream.on('error', resolve);
      setTimeout(resolve, 3000);
    });

    const listening: number[] = [];
    const portRe = /(?:\*|0\.0\.0\.0|::):(\d+)/g;
    let m;
    while ((m = portRe.exec(output)) !== null) {
      const p = parseInt(m[1], 10);
      if (p > 0 && p < 65536) listening.push(p);
    }

    if (listening.length) {
      console.log(`[polaris-docker] container ${sessionId} has listeners on ports: ${[...new Set(listening)].join(', ')} (none mapped to host)`);
    }
  } catch {
    // diagnostic only — ignore errors
  }
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

    if (session.status === 'paused') {
      console.log(`[polaris-docker] auto-unpausing for request: ${sessionId}`);
      await unpauseSession(sessionId);
      await new Promise(r => setTimeout(r, 300));
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
        proxyRes(proxyRes, req) {
          const STATIC_RE = /\.(js|css|png|svg|ico|woff|woff2|ttf|jpg|jpeg|gif|webp)(\?|$)/;
          if (STATIC_RE.test(req.url ?? '')) {
            proxyRes.headers['cache-control'] = 'public, max-age=31536000, immutable';
          } else {
            proxyRes.headers['cache-control'] = 'no-cache, no-store, must-revalidate';
          }
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
