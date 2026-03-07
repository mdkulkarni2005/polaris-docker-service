import Docker from 'dockerode';
import { getAvailablePort, reservePort, releasePort } from '../ports';

const POOL_SIZE = 2;
const POOL_IMAGE = 'node:20-alpine';
const POOL_MAX_AGE_MS = 10 * 60 * 1000; // 10 min — evict stale pool containers
const POOL_MAINTENANCE_INTERVAL_MS = 60_000;
const docker = new Docker();

export const POLARIS_LABELS = {
  'polaris.managed': 'true',
} as const;

export function poolLabels(): Record<string, string> {
  return { ...POLARIS_LABELS, 'polaris.type': 'pool' };
}

export function sessionLabels(sessionId: string): Record<string, string> {
  return { ...POLARIS_LABELS, 'polaris.type': 'session', 'polaris.session': sessionId };
}

export interface PoolAcquireResult {
  containerId: string;
  port: number;
  portVite: number;
}

interface PoolContainer {
  containerId: string;
  port: number;
  portVite: number;
  createdAt: Date;
}

class ContainerPool {
  private pool: PoolContainer[] = [];
  private docker: Docker;
  private isWarming = false;
  private maintenanceHandle: NodeJS.Timeout | null = null;

  constructor(docker: Docker) {
    this.docker = docker;
  }

  async initialize(): Promise<void> {
    console.log(`[pool] initializing with size: ${POOL_SIZE}`);
    await this.fillPool();
    this.maintenanceHandle = setInterval(() => {
      this.evictStale().catch(err => console.error('[pool] maintenance error:', err));
    }, POOL_MAINTENANCE_INTERVAL_MS);
  }

  async acquire(): Promise<PoolAcquireResult | null> {
    const item = this.pool.shift();
    if (item) {
      console.log(`[pool] acquired: ${item.containerId.slice(0, 12)} ports=${item.port},${item.portVite} (${this.pool.length} remaining)`);
      this.fillPool().catch(err => console.error('[pool] refill error:', err));
      return { containerId: item.containerId, port: item.port, portVite: item.portVite };
    }
    console.log('[pool] empty — will create fresh container');
    return null;
  }

  async release(containerId: string): Promise<void> {
    try {
      await this.docker.getContainer(containerId).remove({ force: true });
      console.log(`[pool] released and removed: ${containerId.slice(0, 12)}`);
    } catch (err) {
      console.error('[pool] release error:', err);
    }
  }

  private async fillPool(): Promise<void> {
    if (this.isWarming) return;
    this.isWarming = true;
    try {
      let failures = 0;
      while (this.pool.length < POOL_SIZE && failures < 10) {
        const result = await this.createPoolContainer();
        if (result) {
          this.pool.push({ ...result, createdAt: new Date() });
          console.log(`[pool] warmed: ${result.containerId.slice(0, 12)} ports=${result.port},${result.portVite} (${this.pool.length}/${POOL_SIZE})`);
          failures = 0;
        } else {
          failures++;
        }
      }
    } finally {
      this.isWarming = false;
    }
  }

  private async createPoolContainer(): Promise<{ containerId: string; port: number; portVite: number } | null> {
    const port = getAvailablePort();
    reservePort(port);
    const portVite = getAvailablePort(new Set([port]));
    reservePort(portVite);

    let container: Awaited<ReturnType<Docker['createContainer']>> | null = null;
    try {
      container = await this.docker.createContainer({
        Image: POOL_IMAGE,
        Cmd: ['/bin/sh', '-c', 'mkdir -p /workspace && tail -f /dev/null'],
        WorkingDir: '/workspace',
        Labels: poolLabels(),
        ExposedPorts: { '3000/tcp': {}, '5173/tcp': {} },
        HostConfig: {
          Binds: [
            'polaris-npm-cache:/root/.npm:rw',
            'polaris-pip-cache:/root/.cache/pip:rw',
          ],
          Memory: 512 * 1024 * 1024,
          NanoCpus: 500000000,
          PortBindings: {
            '3000/tcp': [{ HostPort: port.toString() }],
            '5173/tcp': [{ HostPort: portVite.toString() }],
          },
        },
      });
      await container.start();
      return { containerId: container.id, port, portVite };
    } catch (err) {
      if (container) {
        await container.remove({ force: true }).catch(() => {});
      }
      const msg = String((err as Error)?.message ?? '');
      if (msg.includes('port is already allocated') || msg.includes('Bind for')) {
        // Keep ports reserved so the next attempt picks different ones
        console.log(`[pool] port ${port} or ${portVite} in use on host, skipping`);
      } else {
        releasePort(port);
        releasePort(portVite);
        console.error('[pool] createPoolContainer error:', err);
      }
      return null;
    }
  }

  async evictStale(): Promise<void> {
    const now = Date.now();
    const stale = this.pool.filter(c => now - c.createdAt.getTime() > POOL_MAX_AGE_MS);
    for (const item of stale) {
      const idx = this.pool.indexOf(item);
      if (idx !== -1) this.pool.splice(idx, 1);
      try {
        releasePort(item.port);
        releasePort(item.portVite);
        await this.docker.getContainer(item.containerId).remove({ force: true });
        console.log(`[pool] evicted stale: ${item.containerId.slice(0, 12)} (age ${Math.round((now - item.createdAt.getTime()) / 1000)}s)`);
      } catch {}
    }
    if (stale.length > 0) {
      this.fillPool().catch(err => console.error('[pool] refill after evict error:', err));
    }
  }

  async cleanup(): Promise<void> {
    if (this.maintenanceHandle) {
      clearInterval(this.maintenanceHandle);
      this.maintenanceHandle = null;
    }
    for (const item of this.pool) {
      try {
        releasePort(item.port);
        releasePort(item.portVite);
        await this.docker.getContainer(item.containerId).remove({ force: true });
      } catch {}
    }
    this.pool = [];
    console.log('[pool] cleaned up all pool containers');
  }

  size(): number {
    return this.pool.length;
  }
}

export const containerPool = new ContainerPool(docker);
