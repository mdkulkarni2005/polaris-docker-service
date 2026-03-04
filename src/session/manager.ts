import Docker from 'dockerode';
import { mkdir, writeFile, rm } from 'fs/promises';
import path from 'path';
import os from 'os';
import { registry } from './registry';
import type { SessionInfo } from './registry';

const SANDBOX_IMAGE = process.env.SANDBOX_IMAGE ?? 'mdkulkanri20/polaris-sandbox:latest';

const PORT_START = 3100;
const PORT_END = 3200;
const usedPorts = new Set<number>();

const docker = new Docker();

function getAvailablePort(skipPorts?: Set<number>): number {
  for (let p = PORT_START; p <= PORT_END; p++) {
    if (!usedPorts.has(p) && !skipPorts?.has(p)) return p;
  }
  throw new Error('[polaris-docker] no available port in range');
}

export interface CreateSessionParams {
  sessionId: string;
  projectId: string;
  userId: string;
  files: { path: string; content: string }[];
}

export interface CreateSessionResult {
  containerId: string;
  port: number;
}

export interface SessionStatus {
  running: boolean;
  port?: number;
}

export class SessionManager {
  async createSession(params: CreateSessionParams): Promise<CreateSessionResult> {
    const { sessionId, projectId, userId, files } = params;

    const port = getAvailablePort();
    usedPorts.add(port);

    const tempDir = path.join(os.tmpdir(), `polaris-${sessionId}`);
    await mkdir(tempDir, { recursive: true });

    for (const file of files) {
      const fullPath = path.join(tempDir, file.path);
      const dir = path.dirname(fullPath);
      await mkdir(dir, { recursive: true });
      await writeFile(fullPath, file.content, 'utf-8');
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
        if (attempt > 0) usedPorts.add(tryPort);
        triedPorts.add(tryPort);

        let container: Awaited<ReturnType<Docker['createContainer']>> | null = null;
        try {
          container = await docker.createContainer({
            Image: SANDBOX_IMAGE,
            name: `polaris-${sessionId}`,
            HostConfig: {
              Memory: 536870912,
              CpuPeriod: 100000,
              CpuQuota: 50000,
              NetworkMode: 'bridge',
              Binds: [`${tempDir}:/workspace`],
              PortBindings: {
                '3000/tcp': [{ HostPort: tryPort.toString() }],
              },
            },
            ExposedPorts: { '3000/tcp': {} },
            WorkingDir: '/workspace',
            User: 'sandbox',
          });

          await container.start();

          const containerId = container.id;
          const now = new Date();
          const info: SessionInfo = {
            containerId,
            port: tryPort,
            userId,
            projectId,
            startedAt: now,
            lastActivity: now,
          };
          registry.set(sessionId, info);

          return { containerId, port: tryPort };
        } catch (err) {
          if (container) {
            await container.remove({ force: true }).catch(() => {});
          }
          usedPorts.delete(tryPort);
          if (attempt < maxAttempts - 1 && isPortConflict(err)) {
            console.log('[polaris-docker] port', tryPort, 'in use, retrying with another port');
            continue;
          }
          throw err;
        }
      }

      throw new Error('[polaris-docker] no available port in range after retries');
    } catch (err) {
      usedPorts.delete(port);
      await rm(tempDir, { recursive: true, force: true }).catch(() => {});
      throw err;
    }
  }

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
    registry.delete(sessionId);
    console.log('[polaris-docker] session stopped', { sessionId });
  }

  getStatus(sessionId: string): SessionStatus {
    const info = registry.get(sessionId);
    if (!info) return { running: false };
    return { running: true, port: info.port };
  }
}

export const sessionManager = new SessionManager();
