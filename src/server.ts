import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import ws from 'ws';
import cors from 'cors';
import Docker from 'dockerode';
import { cleanupOrphanContainers, sessionManager } from './session/manager';
import { registry } from './session/registry';
import { hybridAuth, isInternalKeyInvalid } from './security/auth';
import { startWatchdog, stopWatchdog, getStats } from './security/limits';
import { attachTerminal } from './terminal/pty';
import { createPreviewRouter } from './proxy/preview';

const docker = new Docker();

const PORT = Number(process.env.PORT) || 4000;

const app = express();
app.use(cors());
app.use(express.json());
app.use((err: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (err instanceof SyntaxError && 'body' in err) {
    res.status(400).json({ error: 'Invalid JSON' });
    return;
  }
  next(err);
});
app.use(createPreviewRouter());

const server = createServer(app);

const wss = new ws.Server({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url!, `http://${req.headers.host}`);
  const pathname = url.pathname;
  const queryKey = url.searchParams.get('key');
  const match = pathname.match(/^\/terminal\/(.+)$/);
  if (!match) {
    socket.destroy();
    return;
  }
  if (isInternalKeyInvalid(req.headers, queryKey)) {
    socket.destroy();
    return;
  }
  const sessionId = match[1];
  wss.handleUpgrade(req, socket, head, (client) => {
    if (!registry.has(sessionId)) {
      client.close(4404, 'Session not found');
      return;
    }
    registry.updateActivity(sessionId);
    attachTerminal(client, sessionId, docker).catch((err: unknown) => {
      console.log('[polaris-docker] terminal attach failed:', sessionId, err);
    });
  });
});

interface StartSessionBody {
  sessionId: string;
  projectId: string;
  userId: string;
  files: { path: string; content: string }[];
}

interface StopSessionBody {
  sessionId: string;
}

app.post('/session/start', hybridAuth, async (req, res) => {
  try {
    const body = req.body as StartSessionBody;
    const { sessionId, projectId, userId, files } = body;
    if (!sessionId || !projectId || !userId || !Array.isArray(files)) {
      res.status(400).json({ error: 'Missing or invalid sessionId, projectId, userId, or files' });
      return;
    }
    const result = await sessionManager.createSession({ sessionId, projectId, userId, files });
    const effectiveSessionId = result.sessionId;
    const host = req.headers.host ?? `localhost:${PORT}`;
    const isHttps = req.headers['x-forwarded-proto'] === 'https';
    const wsProtocol = isHttps ? 'wss' : 'ws';
    const httpProtocol = isHttps ? 'https' : 'http';
    const wsUrl = `${wsProtocol}://${host}/terminal/${effectiveSessionId}`;
    const previewUrl = `${httpProtocol}://${host}/preview/${effectiveSessionId}`;
    res.status(200).json({
      sessionId: effectiveSessionId,
      wsUrl,
      previewUrl,
      reused: result.reused ?? false,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.log('[polaris-docker] session start error', { err });
    if (message === 'Max sessions reached') {
      return res.status(429).json({
        error: 'Max sessions reached. Try again later.',
        maxSessions: parseInt(process.env.MAX_SESSIONS ?? '10', 10),
      });
    }
    res.status(500).json({ error: message });
  }
});

app.post('/session/stop', hybridAuth, async (req, res) => {
  try {
    const body = req.body as StopSessionBody;
    const { sessionId } = body;
    if (!sessionId) {
      res.status(400).json({ error: 'Missing sessionId' });
      return;
    }
    await sessionManager.stopSession(sessionId);
    res.status(200).json({ success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ error: message });
  }
});

app.get('/session/status', hybridAuth, (req, res) => {
  const sessionId = req.query.sessionId as string | undefined;
  if (!sessionId) {
    res.status(400).json({ error: 'Missing sessionId query' });
    return;
  }
  res.status(200).json(sessionManager.getStatus(sessionId));
});

app.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok', ...getStats(), uptime: process.uptime() });
});

app.get('/sessions', hybridAuth, (_req, res) => {
  const sessions = Array.from(registry.getAll().entries()).map(
    ([sessionId, info]: [string, import('./session/registry').SessionInfo]) => ({
    sessionId,
    projectId: info.projectId,
    userId: info.userId,
    port: info.port,
    status: info.status,
    startedAt: info.startedAt,
    lastActivity: info.lastActivity,
  }));
  res.status(200).json(sessions);
});

server.listen(PORT, async () => {
  await cleanupOrphanContainers();
  const watchdogHandle = startWatchdog();
  console.log('[polaris-docker] running on', PORT);
  console.log('[polaris-docker] watchdog started');

  process.on('SIGTERM', () => {
    stopWatchdog(watchdogHandle);
    server.close();
  });
});
