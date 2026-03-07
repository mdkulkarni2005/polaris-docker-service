import Docker from 'dockerode';
import { mkdir, writeFile, rm, chmod } from 'fs/promises';
import path from 'path';
import os from 'os';
import { registry } from './registry';
import type { SessionInfo } from './registry';
import { detectProject } from '../detection';
import { selectImage } from '../images/imageSelector';
import { containerPool, sessionLabels } from '../pool/containerPool';
import { redis } from '../lib/redis';
import { getAvailablePort, reservePort, releasePort } from '../ports';

const SANDBOX_IMAGE = process.env.SANDBOX_IMAGE ?? 'mdkulkanri20/polaris-sandbox:latest';
const MAX_SESSIONS = Math.max(1, parseInt(process.env.MAX_SESSIONS ?? '10', 10));
const MAX_SESSIONS_PER_USER = Math.max(
  1,
  parseInt(process.env.MAX_SESSIONS_PER_USER ?? '3', 10)
);


const docker = new Docker();

function isContainerGoneError(err: unknown): boolean {
  const e = err as { statusCode?: number; reason?: string; json?: { message?: string } };
  const code = e?.statusCode ?? (e?.json as { statusCode?: number })?.statusCode;
  return (
    Number(code) === 409 ||
    (typeof e?.reason === 'string' && e.reason.includes('container')) ||
    (typeof e?.json?.message === 'string' && e.json.message.includes('not running'))
  );
}

export async function pauseSession(sessionId: string): Promise<void> {
  const info = registry.get(sessionId);
  if (!info || info.status !== 'running') return;
  try {
    await docker.getContainer(info.containerId).pause();
    registry.updateStatus(sessionId, 'paused');
    redis.incr('polaris:stats:pauses').catch(() => {});
    console.log(`[polaris-docker] paused: ${sessionId}`);
  } catch (err: unknown) {
    if (isContainerGoneError(err)) {
      // Container exited/removed — remove stale session so watchdog stops retrying
      releasePort(info.port);
      if (info.portVite != null) releasePort(info.portVite);
      registry.delete(sessionId);
      console.log(`[polaris-docker] removed stale session (container gone): ${sessionId}`);
    } else {
      console.error(`[polaris-docker] pause failed: ${sessionId}`, err);
    }
  }
}

export async function unpauseSession(sessionId: string): Promise<void> {
  const info = registry.get(sessionId);
  if (!info || info.status !== 'paused') return;
  try {
    await docker.getContainer(info.containerId).unpause();
    registry.updateStatus(sessionId, 'running');
    registry.updateActivity(sessionId);
    redis.incr('polaris:stats:unpauses').catch(() => {});
    console.log(`[polaris-docker] unpaused: ${sessionId} in ~200ms`);
  } catch (err: unknown) {
    if (isContainerGoneError(err)) {
      releasePort(info.port);
      if (info.portVite != null) releasePort(info.portVite);
      registry.delete(sessionId);
      console.log(`[polaris-docker] removed stale session (container gone): ${sessionId}`);
    } else {
      console.error(`[polaris-docker] unpause failed: ${sessionId}`, err);
    }
  }
}

async function execAndWait(container: Docker.Container, cmd: string[]): Promise<void> {
  const exec = await container.exec({
    Cmd: cmd,
    User: 'root',
    AttachStdout: true,
    AttachStderr: true,
  });
  const stream = await exec.start({ hijack: true, stdin: false });
  await new Promise<void>((resolve) => {
    stream.on('end', resolve);
    stream.on('error', resolve);
    setTimeout(resolve, 10_000);
  });
}

async function copyFilesToContainer(
  containerId: string,
  files: { path: string; content: string }[]
): Promise<void> {
  const container = docker.getContainer(containerId);

  // Collect all directories that need to exist (always include /workspace itself)
  const dirs = new Set<string>(['/workspace']);
  for (const file of files) {
    const dir = path.dirname(file.path);
    if (dir && dir !== '.') {
      dirs.add(`/workspace/${dir}`);
    }
  }
  // Create all directories in a single exec
  await execAndWait(container, ['mkdir', '-p', ...dirs]);

  for (const file of files) {
    const base64 = Buffer.from(file.content).toString('base64');
    await execAndWait(container, [
      'sh', '-c', `echo '${base64}' | base64 -d > /workspace/${file.path}`,
    ]);
  }
  console.log(`[polaris-docker] copied ${files.length} files to pooled container`);
}

/**
 * Detect the project and write a startup script into the container.
 * The script is executed by the terminal shell (pty.ts) so the user
 * sees npm install / npm run dev output in their terminal.
 */
async function prepareAutoStart(
  containerId: string,
  sessionId: string,
  workspacePath: string,
  projectId: string
): Promise<void> {
  try {
    const detection = await detectProject(workspacePath, projectId);
    console.log(`[polaris-docker] detected: ${detection.framework} / ${detection.packageManager} / port ${detection.port}`);
    registry.updateDetection(sessionId, detection);

    const lines = ['#!/bin/sh', 'set -e', 'cd /workspace'];
    if (detection.installCommand) {
      lines.push(`echo "📦 Installing dependencies..."`, detection.installCommand);
    }
    lines.push(`echo "🚀 Starting dev server..."`, detection.devCommand);

    const script = lines.join('\n') + '\n';
    const container = docker.getContainer(containerId);
    await execAndWait(container, ['sh', '-c', `cat > /workspace/.polaris-start.sh << 'POLARIS_EOF'\n${script}POLARIS_EOF`]);
    await execAndWait(container, ['chmod', '+x', '/workspace/.polaris-start.sh']);
    console.log(`[polaris-docker] startup script written for: ${sessionId}`);
  } catch (err) {
    console.error(`[polaris-docker] prepareAutoStart failed:`, err);
  }
}

/**
 * Remove all polaris-managed containers that are NOT tracked in the
 * in-memory registry.  Uses the `polaris.managed=true` Docker label
 * so it catches both session and pool containers regardless of name.
 */
export async function cleanupOrphanContainers(): Promise<void> {
  try {
    const containers = await docker.listContainers({
      all: true,
      filters: { label: ['polaris.managed=true'] },
    });

    const knownIds = new Set<string>();
    for (const [, info] of registry.getAll()) {
      knownIds.add(info.containerId);
    }

    let removed = 0;
    for (const c of containers) {
      if (knownIds.has(c.Id)) continue;
      console.log(`[polaris-docker] cleaning orphan: ${c.Id.slice(0, 12)} (${c.Names?.join(', ')})`);
      try {
        await docker.getContainer(c.Id).remove({ force: true });
        removed++;
      } catch (err) {
        console.error(`[polaris-docker] failed to remove orphan ${c.Id.slice(0, 12)}:`, err);
      }
    }
    console.log(`[polaris-docker] cleaned ${removed} orphan containers (${containers.length} polaris-managed total)`);
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

/** Return true if the container exists and is running (not exited). */
async function isContainerRunning(containerId: string): Promise<boolean> {
  try {
    const container = docker.getContainer(containerId);
    const inspect = await container.inspect();
    return inspect.State?.Running === true;
  } catch {
    return false;
  }
}


/** Get the host path mounted as /workspace in the container (from inspect). */
async function getWorkspaceHostPath(containerId: string): Promise<string | null> {
  try {
    const container = docker.getContainer(containerId);
    const inspect = await container.inspect();
    const mounts = (inspect as { Mounts?: { Destination: string; Source: string }[] }).Mounts ?? [];
    const workspaceMount = mounts.find((m) => m.Destination === '/workspace' || m.Destination === '/workspace/');
    return workspaceMount?.Source ?? null;
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
  wasPaused?: boolean;
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
      if (existing.info.status === 'paused') {
        await unpauseSession(existing.sessionId);
        return {
          sessionId: existing.sessionId,
          containerId: existing.info.containerId,
          port: existing.info.port,
          reused: true,
          wasPaused: true,
        };
      }
      if (existing.info.status === 'running') {
        registry.updateActivity(existing.sessionId);
        return {
          sessionId: existing.sessionId,
          containerId: existing.info.containerId,
          port: existing.info.port,
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
    reservePort(port);
    reservePort(portVite);

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

    const detection = await detectProject(tempDir, projectId);
    const imageConfig = selectImage(detection.language);
    const containerImage = imageConfig.image;
    console.log(`[polaris-docker] using image: ${containerImage} for session: ${sessionId}`);

    const pooled = await containerPool.acquire();
    if (pooled) {
      console.log(`[polaris-docker] using pooled container: ${pooled.containerId.slice(0, 12)} ports=${pooled.port},${pooled.portVite}`);
      redis.incr('polaris:stats:pool-hits').catch(() => {});
      // Release the pre-allocated ports; use the pool's ports instead
      releasePort(port);
      releasePort(portVite);

      await copyFilesToContainer(pooled.containerId, files);

      prepareAutoStart(pooled.containerId, sessionId, tempDir, projectId)
        .catch(err => console.error('[polaris-docker] auto-start error:', err));

      const now = new Date();
      const info: SessionInfo = {
        containerId: pooled.containerId,
        port: pooled.port,
        portVite: pooled.portVite,
        userId,
        projectId,
        startedAt: now,
        lastActivity: now,
        status: 'running',
      };
      registry.set(sessionId, info);

      return { sessionId, containerId: pooled.containerId, port: pooled.port, reused: false };
    }

    // Pool empty — create fresh container (slower path)
    redis.incr('polaris:stats:cold-starts').catch(() => {});
    try {
      try {
        console.log(`[polaris-docker] pulling image: ${containerImage}`);
        await new Promise<void>((resolve, reject) => {
          docker.pull(containerImage, (err: Error, stream: NodeJS.ReadableStream) => {
            if (err) return reject(err);
            docker.modem.followProgress(stream, (err: Error | null) => {
              if (err) return reject(err);
              resolve();
            });
          });
        });
        console.log(`[polaris-docker] image ready: ${containerImage}`);
        try {
          const imageInfo = await docker.getImage(containerImage).inspect();
          const sizeMB = Math.round((imageInfo.Size ?? 0) / 1024 / 1024);
          console.log(`[polaris-docker] image size: ${containerImage} = ${sizeMB}MB`);
        } catch { /* size logging is best-effort */ }
      } catch (err) {
        console.error(`[polaris-docker] pull failed, using cached: ${containerImage}`, err);
        // continue anyway — image might already be cached locally
      }

      const isPortConflict = (e: unknown) =>
        String((e as Error)?.message ?? '').includes('port is already allocated') ||
        String((e as Error)?.message ?? '').includes('Bind for');

      const triedPorts = new Set<number>();
      const maxAttempts = 10;

      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const tryPort = attempt === 0 ? port : getAvailablePort(triedPorts);
        const tryPortVite =
          attempt === 0 ? portVite : getAvailablePort(new Set([...triedPorts, tryPort]));
        if (attempt > 0) {
          reservePort(tryPort);
          reservePort(tryPortVite);
        }
        triedPorts.add(tryPort);
        triedPorts.add(tryPortVite);

        let container: Awaited<ReturnType<Docker['createContainer']>> | null = null;
        try {
          const isCustomSandbox =
            containerImage === (process.env.SANDBOX_IMAGE ?? '');
          const containerConfig = {
            Image: containerImage,
            name: `polaris-${sessionId}`,
            Labels: sessionLabels(sessionId),
            HostConfig: {
              Memory: 536870912,
              CpuPeriod: 100000,
              CpuQuota: 50000,
              NetworkMode: 'bridge',
              Binds: [
                `${tempDir}:/workspace:rw`,
                `polaris-npm-cache:/root/.npm:rw`,
                `polaris-pip-cache:/root/.cache/pip:rw`,
                `polaris-go-cache:/root/go/pkg/mod:rw`,
              ],
              PortBindings: {
                '3000/tcp': [{ HostPort: tryPort.toString() }],
                '5173/tcp': [{ HostPort: tryPortVite.toString() }],
              },
            },
            ExposedPorts: { '3000/tcp': {}, '5173/tcp': {} },
            WorkingDir: '/workspace',
            User: isCustomSandbox ? 'sandbox' : 'root',
            Cmd: ['sleep', 'infinity'],
          };
          console.log('[polaris-docker] container config before create:', JSON.stringify(containerConfig, null, 2));

          container = await docker.createContainer(containerConfig);

          await container.start();
          const containerId = container.id;

          console.log(
            '[polaris-docker] container started, launching auto-start:',
            sessionId
          );
          prepareAutoStart(containerId, sessionId, tempDir, params.projectId)
            .catch(err => console.error("[polaris-docker] auto-start error:", err));

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
          releasePort(tryPort);
          releasePort(tryPortVite);
          if (attempt < maxAttempts - 1 && isPortConflict(err)) {
            console.log('[polaris-docker] port', tryPort, 'or', tryPortVite, 'in use, retrying');
            continue;
          }
          throw err;
        }
      }

      throw new Error('[polaris-docker] no available port in range after retries');
    } catch (err) {
    releasePort(port);
    releasePort(portVite);
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
    const workspacePath = path.join(os.tmpdir(), `polaris-${sessionId}`);
    prepareAutoStart(info.containerId, sessionId, workspacePath, info.projectId)
      .catch(err => console.error("[polaris-docker] auto-start error:", err));
    registry.updateStatus(sessionId, 'running');
    registry.updateActivity(sessionId);
    console.log('[polaris-docker] restarted container', { sessionId });
  }

  async pauseSession(sessionId: string): Promise<void> {
    await pauseSession(sessionId);
  }

  async unpauseSession(sessionId: string): Promise<void> {
    await unpauseSession(sessionId);
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

    releasePort(info.port);
    if (info.portVite != null) releasePort(info.portVite);
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
      if (port !== null) reservePort(port);
      if (portVite != null) reservePort(portVite);
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
