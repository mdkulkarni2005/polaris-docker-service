import Docker from 'dockerode';
import { mkdir, writeFile, rm, chmod, readdir } from 'fs/promises';
import path from 'path';
import os from 'os';
import { registry } from './registry';
import type { SessionInfo } from './registry';

const SANDBOX_IMAGE = process.env.SANDBOX_IMAGE ?? 'mdkulkanri20/polaris-sandbox:latest';
const MAX_SESSIONS = Math.max(1, parseInt(process.env.MAX_SESSIONS ?? '10', 10));
const MAX_SESSIONS_PER_USER = Math.max(
  1,
  parseInt(process.env.MAX_SESSIONS_PER_USER ?? '3', 10)
);

const PORT_START = 3100;
const PORT_END = 3200;
const usedPorts = new Set<number>();

const docker = new Docker();

async function autoStartDevServer(
  containerId: string,
  sessionId: string
): Promise<void> {
  console.log(
    `[polaris-docker] === AUTO START CALLED: ${sessionId} for container ${containerId} ===`
  );

  const container = docker.getContainer(containerId);
  const baseCommand =
    process.env.POLARIS_DEV_COMMAND ??
    'npm run dev -- --host 0.0.0.0 --port 5173';
  const fullCommand = `cd /workspace 2>/dev/null || true; nohup sh -c "npm install && ${baseCommand}" > /tmp/dev.log 2>&1 & echo $! > /tmp/dev.pid`;

  console.log(
    '[polaris-docker] auto-start dev server workingDir:',
    '/workspace'
  );
  console.log(
    '[polaris-docker] auto-start dev server command:',
    fullCommand
  );

  try {
    const exec = await container.exec({
      AttachStdout: true,
      AttachStderr: true,
      AttachStdin: false,
      Tty: false,
      User: 'sandbox',
      WorkingDir: '/workspace',
      Cmd: ['/bin/bash', '-lc', fullCommand],
    });

    const stream = await exec.start({ hijack: true, stdin: false });

    if (!stream) {
      console.error(
        '[polaris-docker] auto-start exec stream not available',
        { sessionId, containerId }
      );
      return;
    }

    let output = '';
    stream.on('data', (chunk: Buffer | string) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
      output += text;
    });

    stream.on('end', async () => {
      try {
        const inspect = await exec.inspect();
        const exitCode = (inspect as { ExitCode?: number }).ExitCode ?? null;
        if (exitCode === 0) {
          console.log(
            '[polaris-docker] auto-start exec completed successfully',
            { sessionId, containerId }
          );
        } else {
          console.error(
            '[polaris-docker] auto-start exec exited with non-zero code',
            { sessionId, containerId, exitCode, output }
          );
        }
      } catch (err) {
        console.error(
          '[polaris-docker] auto-start exec inspect failed',
          {
            sessionId,
            containerId,
            error: err instanceof Error ? err.message : String(err),
          }
        );
      }
    });

    stream.on('error', (err: Error) => {
      console.error(
        '[polaris-docker] auto-start exec stream error',
        { sessionId, containerId, error: err.message }
      );
    });
  } catch (err) {
    console.error(
      '[polaris-docker] auto-start dev server failed',
      {
        sessionId,
        containerId,
        error: err instanceof Error ? err.message : String(err),
      }
    );
    throw err;
  }
}

export async function cleanupOrphanContainers(): Promise<void> {
  try {
    const containers = await docker.listContainers({ all: true });
    const polarisContainers = containers.filter((c) =>
      c.Names?.some((n) => n.includes('polaris-'))
    );
    for (const c of polarisContainers) {
      console.log(
        `[polaris-docker] cleaning orphan: ${c.Id.slice(0, 12)}`
      );
      await docker.getContainer(c.Id).remove({ force: true });
    }
    console.log(
      `[polaris-docker] cleaned ${polarisContainers.length} orphan containers`
    );
  } catch (err) {
    console.error('[polaris-docker] cleanup error:', err);
  }
}

/** Find a container by name (Docker names are often /name). Returns container Id or null. */
async function findContainerByName(name: string): Promise<string | null> {
  const list = await docker.listContainers({ all: true });
  const normalized = name.startsWith('/') ? name : `/${name}`;
  const found = list.find(
    (c) => c.Names && (c.Names.includes(normalized) || c.Names.includes(name))
  );
  return found?.Id ?? null;
}

function getAvailablePort(skipPorts?: Set<number>): number {
  for (let p = PORT_START; p <= PORT_END; p++) {
    if (!usedPorts.has(p) && !skipPorts?.has(p)) return p;
  }
  throw new Error('[polaris-docker] no available port in range');
}

/** Get the host path mounted as /workspace in the container (from inspect). */
async function getWorkspaceHostPath(containerId: string): Promise<string | null> {
  try {
    const container = docker.getContainer(containerId);
    const inspect = await container.inspect();
    const mounts = (inspect as { Mounts?: { Destination: string; Source: string }[] }).Mounts ?? [];
    // #region agent log
    fetch('http://127.0.0.1:7449/ingest/3a1c7907-5e49-4774-9778-95d691a47c77', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': 'e2a0b7' }, body: JSON.stringify({ sessionId: 'e2a0b7', runId: 'workspace-debug', hypothesisId: 'H2_H5', location: 'manager.ts:getWorkspaceHostPath', message: 'inspect Mounts raw', data: { containerId, mountsCount: mounts.length, mounts: mounts.map(m => ({ Dest: m.Destination, Source: m.Source })), osTmpdir: os.tmpdir() }, timestamp: Date.now() }) }).catch(() => {});
    // #endregion
    const workspaceMount = mounts.find((m) => m.Destination === '/workspace' || m.Destination === '/workspace/');
    const source = workspaceMount?.Source ?? null;
    // #region agent log
    fetch('http://127.0.0.1:7449/ingest/3a1c7907-5e49-4774-9778-95d691a47c77', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': 'e2a0b7' }, body: JSON.stringify({ sessionId: 'e2a0b7', runId: 'workspace-debug', hypothesisId: 'H2_H5', location: 'manager.ts:getWorkspaceHostPath', message: 'resolved workspace source', data: { source, found: !!workspaceMount }, timestamp: Date.now() }) }).catch(() => {});
    // #endregion
    return source;
  } catch {
    return null;
  }
}

/** Write files into a workspace directory (host path). */
async function writeFilesToHostPath(
  hostPath: string,
  files: { path: string; content: string }[]
): Promise<void> {
  if (files.length === 0) return;
  await mkdir(hostPath, { recursive: true });
  await chmod(hostPath, 0o777);
  for (const file of files) {
    const fullPath = path.join(hostPath, file.path);
    const dir = path.dirname(fullPath);
    await mkdir(dir, { recursive: true });
    await writeFile(fullPath, file.content, 'utf-8');
    console.log('[polaris-docker] synced file:', fullPath);
  }
  // #region agent log
  try {
    const listing = await readdir(hostPath, { withFileTypes: true });
    const recursive = await Promise.all(listing.filter(d => d.isDirectory()).map(d => readdir(path.join(hostPath, d.name)).then(entries => ({ dir: d.name, entries }))));
    fetch('http://127.0.0.1:7449/ingest/3a1c7907-5e49-4774-9778-95d691a47c77', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': 'e2a0b7' }, body: JSON.stringify({ sessionId: 'e2a0b7', runId: 'workspace-debug', hypothesisId: 'H3_H4', location: 'manager.ts:writeFilesToHostPath', message: 'host dir after write', data: { hostPath, topLevel: listing.map(d => d.name), subdirs: recursive }, timestamp: Date.now() }) }).catch(() => {});
  } catch (e) {
    fetch('http://127.0.0.1:7449/ingest/3a1c7907-5e49-4774-9778-95d691a47c77', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': 'e2a0b7' }, body: JSON.stringify({ sessionId: 'e2a0b7', runId: 'workspace-debug', hypothesisId: 'H4', location: 'manager.ts:writeFilesToHostPath', message: 'readdir failed after write', data: { hostPath, err: String(e) }, timestamp: Date.now() }) }).catch(() => {});
  }
  // #endregion
}

/** Write files into an existing session's workspace (for reuse path). Uses container mount when available. */
async function writeFilesToWorkspace(
  sessionId: string,
  containerId: string,
  files: { path: string; content: string }[]
): Promise<void> {
  if (files.length === 0) return;
  const hostPath = await getWorkspaceHostPath(containerId);
  const fallbackPath = path.join(os.tmpdir(), `polaris-${sessionId}`);
  const tempDir = hostPath ?? fallbackPath;
  // #region agent log
  fetch('http://127.0.0.1:7449/ingest/3a1c7907-5e49-4774-9778-95d691a47c77', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': 'e2a0b7' }, body: JSON.stringify({ sessionId: 'e2a0b7', runId: 'workspace-debug', hypothesisId: 'H1_H2', location: 'manager.ts:writeFilesToWorkspace', message: 'path choice', data: { sessionId, containerId, hostPathFromInspect: hostPath, fallbackPath, chosen: tempDir, sameAsFallback: tempDir === fallbackPath }, timestamp: Date.now() }) }).catch(() => {});
  // #endregion
  console.log('[polaris-docker] workspace host path for', sessionId, '->', tempDir, hostPath ? '(from container inspect)' : '(fallback)');
  await writeFilesToHostPath(tempDir, files);
}

export interface CreateSessionParams {
  sessionId: string;
  projectId: string;
  userId: string;
  files: { path: string; content: string }[];
}

export interface CreateSessionResult {
  sessionId: string;
  containerId: string;
  port: number;
  reused?: boolean;
}

export interface SessionStatus {
  running: boolean;
  port?: number;
}

export class SessionManager {
  async createSession(params: CreateSessionParams): Promise<CreateSessionResult> {
    const { sessionId, projectId, userId, files } = params;

    const existing = registry.findByProjectId(projectId, userId);
    if (existing) {
      if (existing.info.status === 'running') {
        registry.updateActivity(existing.sessionId);
        await writeFilesToWorkspace(existing.sessionId, existing.info.containerId, files);
        console.log('[polaris-docker] reusing running session:', existing.sessionId, 'projectId:', projectId);
        return {
          sessionId: existing.sessionId,
          containerId: existing.info.containerId,
          port: existing.info.port,
          reused: true,
        };
      }
      if (existing.info.status === 'stopped') {
        console.log('[polaris-docker] restarting stopped session:', existing.sessionId, 'projectId:', projectId);
        await this.restartSession(existing.sessionId);
        const info = registry.get(existing.sessionId);
        if (info) await writeFilesToWorkspace(existing.sessionId, info.containerId, files);
        const infoAfter = registry.get(existing.sessionId);
        if (!infoAfter) throw new Error('[polaris-docker] session lost after restart');
        return {
          sessionId: existing.sessionId,
          containerId: infoAfter.containerId,
          port: infoAfter.port,
          reused: true,
        };
      }
    }

    const userSessions = registry.countByUser(userId);
    if (userSessions >= MAX_SESSIONS_PER_USER) {
      throw new Error('Per-user session limit reached');
    }

    if (registry.count() >= MAX_SESSIONS) {
      throw new Error('Max sessions reached');
    }

    const projectPrefix = projectId.slice(0, 8);
    const containerName = `polaris-${projectPrefix}`;
    const orphanId = await findContainerByName(containerName);
    if (orphanId) {
      const result = await this.reattachOrphanContainer(sessionId, projectId, userId, orphanId);
      if (result) {
        await writeFilesToWorkspace(sessionId, result.containerId, files);
        return result;
      }
      await docker.getContainer(orphanId).remove({ force: true }).catch(() => {});
    }

    const port = getAvailablePort();
    const portVite = getAvailablePort(new Set([port]));
    usedPorts.add(port);
    usedPorts.add(portVite);

    const tempDir = path.join(os.tmpdir(), `polaris-${sessionId}`);
    await mkdir(tempDir, { recursive: true });
    await chmod(tempDir, 0o777);
    console.log('[polaris-docker] tempDir:', tempDir);

    for (const file of files) {
      const fullPath = path.join(tempDir, file.path);
      const dir = path.dirname(fullPath);
      await mkdir(dir, { recursive: true });
      await writeFile(fullPath, file.content, 'utf-8');
      console.log('[polaris-docker] wrote file:', fullPath, '(path:', file.path, ')');
    }

    try {
      try {
        await docker.getImage(SANDBOX_IMAGE).inspect();
      } catch {
        if (!SANDBOX_IMAGE.includes('/') && !SANDBOX_IMAGE.includes('.')) {
          throw new Error(
            `Image "${SANDBOX_IMAGE}" not found. Build it locally: docker build -t polaris-sandbox:latest -f Dockerfile.sandbox .`
          );
        }
        const stream = await docker.pull(SANDBOX_IMAGE);
        await new Promise<void>((resolve, reject) => {
          docker.modem.followProgress(stream, (err: Error | null) => (err ? reject(err) : resolve()));
        });
      }

      const isPortConflict = (e: unknown) =>
        String((e as Error)?.message ?? '').includes('port is already allocated') ||
        String((e as Error)?.message ?? '').includes('Bind for');

      const triedPorts = new Set<number>();
      const maxAttempts = Math.min(10, PORT_END - PORT_START + 1);

      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const tryPort = attempt === 0 ? port : getAvailablePort(triedPorts);
        const tryPortVite =
          attempt === 0 ? portVite : getAvailablePort(new Set([...triedPorts, tryPort]));
        if (attempt > 0) {
          usedPorts.add(tryPort);
          usedPorts.add(tryPortVite);
        }
        triedPorts.add(tryPort);
        triedPorts.add(tryPortVite);

        let container: Awaited<ReturnType<Docker['createContainer']>> | null = null;
        try {
          const containerConfig = {
            Image: SANDBOX_IMAGE,
            name: `polaris-${sessionId}`,
            HostConfig: {
              Memory: 536870912,
              CpuPeriod: 100000,
              CpuQuota: 50000,
              NetworkMode: 'bridge',
              Binds: [`${tempDir}:/workspace:rw`],
              PortBindings: {
                '3000/tcp': [{ HostPort: tryPort.toString() }],
                '5173/tcp': [{ HostPort: tryPortVite.toString() }],
              },
            },
            ExposedPorts: { '3000/tcp': {}, '5173/tcp': {} },
            WorkingDir: '/workspace',
            User: 'sandbox',
          };
          console.log('[polaris-docker] container config before create:', JSON.stringify(containerConfig, null, 2));

          container = await docker.createContainer(containerConfig);

          await container.start();
          const containerId = container.id;

          console.log(
            '[polaris-docker] container started, launching auto-start:',
            sessionId
          );
          autoStartDevServer(containerId, sessionId).catch((err: unknown) => {
            console.error(
              '[polaris-docker] TOP LEVEL auto-start error:',
              sessionId,
              err
            );
          });

          const now = new Date();
          const info: SessionInfo = {
            containerId,
            port: tryPort,
            portVite: tryPortVite,
            userId,
            projectId,
            startedAt: now,
            lastActivity: now,
            status: 'running',
          };
          registry.set(sessionId, info);

          return { sessionId, containerId, port: tryPort, reused: false };
        } catch (err) {
          if (container) {
            await container.remove({ force: true }).catch(() => {});
          }
          usedPorts.delete(tryPort);
          usedPorts.delete(tryPortVite);
          if (attempt < maxAttempts - 1 && isPortConflict(err)) {
            console.log('[polaris-docker] port', tryPort, 'or', tryPortVite, 'in use, retrying');
            continue;
          }
          throw err;
        }
      }

      throw new Error('[polaris-docker] no available port in range after retries');
    } catch (err) {
    usedPorts.delete(port);
    usedPorts.delete(portVite);
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

  async restartSession(sessionId: string): Promise<void> {
    const info = registry.get(sessionId);
    if (!info) throw new Error(`[polaris-docker] session not found: ${sessionId}`);
    const container = docker.getContainer(info.containerId);
    await container.start();
    console.log(
      '[polaris-docker] container started, launching auto-start (restart):',
      sessionId
    );
    autoStartDevServer(info.containerId, sessionId).catch((err: unknown) => {
      console.error(
        '[polaris-docker] TOP LEVEL auto-start error (restart):',
        sessionId,
        err
      );
    });
    registry.updateStatus(sessionId, 'running');
    registry.updateActivity(sessionId);
    console.log('[polaris-docker] restarted container', { sessionId });
  }

  /** Stop container only (idle). Keeps container and tempDir; use stopSession for full teardown. */
  async stopContainerIdle(sessionId: string): Promise<void> {
    const info = registry.get(sessionId);
    if (!info) return;
    try {
      const container = docker.getContainer(info.containerId);
      await container.stop({ t: 5 });
    } catch (err) {
      console.log('[polaris-docker] container stop error (idle)', { sessionId, err });
    }
    registry.updateStatus(sessionId, 'stopped');
    console.log('[polaris-docker] stopping idle container:', sessionId);
  }

  /** Full teardown: stop + remove container, delete tempDir, remove from registry. */
  async stopSession(sessionId: string): Promise<void> {
    const info = registry.get(sessionId);
    if (!info) return;

    try {
      const container = docker.getContainer(info.containerId);
      await container.stop({ t: 5 });
      await container.remove({ force: true });
    } catch (err) {
      console.log('[polaris-docker] container stop/remove error (may already be gone)', { sessionId, err });
    }

    const tempDir = path.join(os.tmpdir(), `polaris-${sessionId}`);
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});

    usedPorts.delete(info.port);
    if (info.portVite != null) usedPorts.delete(info.portVite);
    registry.delete(sessionId);
    console.log('[polaris-docker] session stopped', { sessionId });
  }

  getStatus(sessionId: string): SessionStatus {
    const info = registry.get(sessionId);
    if (!info) return { running: false };
    return { running: info.status === 'running', port: info.port };
  }

  /** Reattach an orphan container (exists in Docker but not in registry, e.g. after server restart). */
  private async reattachOrphanContainer(
    sessionId: string,
    projectId: string,
    userId: string,
    containerId: string
  ): Promise<CreateSessionResult | null> {
    try {
      const container = docker.getContainer(containerId);
      const inspect = await container.inspect();
      const ports = inspect.NetworkSettings?.Ports ?? {};
      const port3000 = ports['3000/tcp']?.[0]?.HostPort;
      const port5173 = ports['5173/tcp']?.[0]?.HostPort;
      const port = port3000 ? parseInt(port3000, 10) : null;
      const portVite = port5173 ? parseInt(port5173, 10) : null;
      if (port == null) {
        console.log('[polaris-docker] orphan container missing 3000/tcp binding:', containerId);
        return null;
      }
      if (!inspect.State.Running) {
        await container.start();
      }
      if (port !== null) usedPorts.add(port);
      if (portVite != null) usedPorts.add(portVite);
      const now = new Date();
      const info: SessionInfo = {
        containerId,
        port,
        portVite: portVite ?? undefined,
        userId,
        projectId,
        startedAt: now,
        lastActivity: now,
        status: 'running',
      };
      registry.set(sessionId, info);
      console.log('[polaris-docker] reattached orphan container:', sessionId, 'projectId:', projectId);
      return { sessionId, containerId, port, reused: true };
    } catch (err) {
      console.log('[polaris-docker] reattach orphan failed:', sessionId, err);
      return null;
    }
  }
}

export const sessionManager = new SessionManager();
