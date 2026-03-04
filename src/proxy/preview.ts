import { Router, type Request, type Response, type NextFunction } from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { registry } from '../session/registry';

export function createPreviewRouter(): Router {
  const router = Router();

  router.get(/^\/preview\/([^/]+)(?:\/.*)?$/, (req: Request, res: Response, next: NextFunction) => {
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

    const proxy = createProxyMiddleware<Request, Response>({
      target: `http://localhost:${session.port}`,
      changeOrigin: true,
      pathRewrite: { [`^/preview/${sessionId}`]: '' },
      on: {
        error: (err: Error, _req: Request, res: Response | import('net').Socket) => {
          console.log('[polaris-docker] preview proxy error:', sessionId, err.message);
          if ('status' in res && typeof res.status === 'function' && !res.headersSent) {
            res.status(502).json({
              error: 'App not ready yet',
              detail: err.message,
            });
          }
        },
      },
    });

    proxy(req, res, next);
  });

  return router;
}
