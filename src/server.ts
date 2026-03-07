import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import path from 'path';
import ws from 'ws';
import cors from 'cors';
import Docker from 'dockerode';
import { sessionManager, cleanupOrphanContainers } from './session/manager';
import { registry } from './session/registry';
import { syncPortsFromDocker } from './ports';
import { hybridAuth, isInternalKeyInvalid } from './security/auth';
import { checkRateLimit } from './security/rateLimiter';
import { startWatchdog, stopWatchdog, getStats } from './security/limits';
import { attachTerminal } from './terminal/pty';
import { createPreviewRouter } from './proxy/preview';
import { containerPool } from './pool/containerPool';

const docker = new Docker();

async function ensureCacheVolumes(): Promise<void> {
  const volumes = ['polaris-npm-cache', 'polaris-pip-cache', 'polaris-go-cache'];
  for (const name of volumes) {
    try {
      await docker.getVolume(name).inspect();
      console.log(`[polaris-docker] cache volume exists: ${name}`);
    } catch {
      await docker.createVolume({ Name: name });
      console.log(`[polaris-docker] created cache volume: ${name}`);
    }
  }
}

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

interface FileUpdateBody {
  sessionId: string;
  path: string;
  content: string;
}

interface FilesSyncBody {
  sessionId: string;
  files: { path: string; content: string }[];
}

/** Sync a single file into a session container via docker exec. Caller must ensure session exists. */
async function syncFileToContainer(
  sessionId: string,
  filePath: string,
  content: string
): Promise<void> {
  const info = registry.get(sessionId);
  if (!info) throw new Error('Session not found');
  const container = docker.getContainer(info.containerId);

  const dir = path.dirname(filePath);
  if (dir && dir !== '.') {
    const mkdirExec = await container.exec({
      Cmd: ['mkdir', '-p', `/workspace/${dir}`],
      AttachStdout: false,
      AttachStderr: false,
      User: 'root',
    });
    const mkdirStream = await mkdirExec.start({ hijack: true, stdin: false });
    await new Promise<void>((resolve, reject) => {
      mkdirStream.on('end', resolve);
      mkdirStream.on('error', reject);
    });
  }

  const base64Content = Buffer.from(content).toString('base64');
  const writeExec = await container.exec({
    Cmd: [
      'sh',
      '-c',
      `echo '${base64Content}' | base64 -d > "/workspace/$1"`,
      'sh',
      filePath,
    ],
    AttachStdout: true,
    AttachStderr: true,
    User: 'root',
    WorkingDir: '/workspace',
  });
  const writeStream = await writeExec.start({ hijack: true, stdin: false });
  await new Promise<void>((resolve, reject) => {
    writeStream.on('end', resolve);
    writeStream.on('error', reject);
  });

  console.log(`[polaris-docker] file synced: ${sessionId} → ${filePath}`);
  registry.updateActivity(sessionId);
}

app.post('/session/start', hybridAuth, async (req, res) => {
  try {
    const body = req.body as StartSessionBody;
    const { sessionId, projectId, userId, files } = body;
    if (!sessionId || !projectId || !userId || !Array.isArray(files)) {
      res.status(400).json({ error: 'Missing or invalid sessionId, projectId, userId, or files' });
      return;
    }

    const rateCheck = await checkRateLimit(userId);
    if (!rateCheck.allowed) {
      res.status(429).json({
        error: rateCheck.reason,
        retryAfter: rateCheck.retryAfter,
      });
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
    if (message === 'Per-user session limit reached') {
      return res.status(429).json({
        error: 'Per-user session limit reached. Close an existing preview and try again.',
        maxSessionsPerUser: parseInt(
          process.env.MAX_SESSIONS_PER_USER ?? '3',
          10
        ),
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

app.post('/session/file/update', hybridAuth, async (req, res) => {
  try {
    const body = req.body as FileUpdateBody;
    const { sessionId, path: filePath, content } = body;
    if (sessionId == null || filePath == null || content == null) {
      res.status(400).json({ error: 'Missing sessionId, path, or content' });
      return;
    }
    if (!registry.has(sessionId)) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    await syncFileToContainer(sessionId, filePath, content);
    res.status(200).json({ success: true, path: filePath });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[polaris-docker] /session/file/update error', { err });
    res.status(500).json({ error: message });
  }
});

app.post('/session/files/sync', hybridAuth, async (req, res) => {
  try {
    const body = req.body as FilesSyncBody;
    const { sessionId, files } = body;
    if (sessionId == null || !Array.isArray(files)) {
      res.status(400).json({ error: 'Missing sessionId or files array' });
      return;
    }
    if (!registry.has(sessionId)) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    let synced = 0;
    for (const file of files) {
      if (file.path == null || file.content == null) continue;
      await syncFileToContainer(sessionId, file.path, file.content);
      synced += 1;
    }
    res.status(200).json({ success: true, synced });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[polaris-docker] /session/files/sync error', { err });
    res.status(500).json({ error: message });
  }
});

app.get('/session/status', hybridAuth, (req, res) => {
  const sessionId = req.query.sessionId as string | undefined;
  if (!sessionId) {
    res.status(400).json({ error: 'Missing sessionId query' });
    return;
  }
  const status = sessionManager.getStatus(sessionId);
  const detection = registry.get(sessionId)?.detection;
  res.status(200).json({
    running: status.running,
    ...(status.port !== undefined && { port: status.port }),
    ...(detection !== undefined && { detection }),
    devServerReady: undefined as boolean | undefined,
  });
});

app.get('/session/devlog', hybridAuth, async (req, res) => {
  const sessionId = req.query.sessionId as string | undefined;
  if (!sessionId) {
    res.status(400).json({ error: 'Missing sessionId query' });
    return;
  }

  const session = registry.get(sessionId);
  if (!session) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }

  const containerId = session.containerId;
  const container = docker.getContainer(containerId);

  const execInContainer = async (cmd: string): Promise<{ output: string; error?: string }> => {
    try {
      const exec = await container.exec({
        AttachStdout: true,
        AttachStderr: true,
        AttachStdin: false,
        Tty: false,
        User: 'root',
        WorkingDir: '/workspace',
        Cmd: ['/bin/sh', '-c', cmd],
      });
      const stream = await exec.start({ hijack: true, stdin: false });
      if (!stream) {
        return { output: '', error: 'Failed to start exec' };
      }
      let output = '';
      stream.on('data', (chunk: Buffer | string) => {
        const text = typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
        output += text;
      });
      await new Promise<void>((resolve, reject) => {
        stream.on('end', () => resolve());
        stream.on('error', (err: Error) => reject(err));
      });
      return { output };
    } catch (err) {
      return {
        output: '',
        error: err instanceof Error ? err.message : String(err),
      };
    }
  };

  try {
    const devLogResult = await execInContainer(
      'if [ -f /tmp/dev.log ]; then cat /tmp/dev.log; else echo "dev.log not found"; fi'
    );
    const psResult = await execInContainer('ps aux');

    if (devLogResult.error || psResult.error) {
      console.error('[polaris-docker] /session/devlog exec error', {
        sessionId,
        containerId,
        devLogError: devLogResult.error,
        processesError: psResult.error,
      });
      res.status(500).json({
        error: 'Failed to execute debug commands in container',
        devLogError: devLogResult.error,
        processesError: psResult.error,
      });
      return;
    }

    res.status(200).json({
      sessionId,
      containerId,
      devLog: devLogResult.output,
      processes: psResult.output,
    });
  } catch (err) {
    console.error('[polaris-docker] /session/devlog unexpected error', {
      sessionId,
      containerId,
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({
      error: 'Unexpected error while collecting dev logs',
    });
  }
});

app.get('/health', (_req, res) => {
  res.status(200).json({
    status: 'ok',
    totalSessions: registry.count(),
    running: registry.countByStatus('running'),
    paused: registry.countByStatus('paused'),
    stopped: registry.countByStatus('stopped'),
    poolSize: containerPool.size(),
    uptime: process.uptime(),
  });
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
  await ensureCacheVolumes();

  // Discover host ports already bound by Docker so the allocator skips them.
  await syncPortsFromDocker();

  // Restore known sessions from Redis, then kill any Docker containers
  // that are polaris-managed but not in the registry (leaked/orphaned).
  await registry.restoreFromRedis();
  await cleanupOrphanContainers();
  await containerPool.initialize();

  const watchdogHandle = startWatchdog();

  console.log(`[polaris-docker] running on ${PORT}`);

  process.on('SIGTERM', () => {
    stopWatchdog(watchdogHandle);
    server.close();
  });
});
