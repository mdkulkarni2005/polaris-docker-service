import type { DetectionResult } from '../detection';
import { redis, Keys, TTL } from '../lib/redis';
import Docker from 'dockerode';

export type SessionStatusType = 'running' | 'stopped' | 'paused' | 'deleted';

export interface SessionInfo {
  containerId: string;
  /** Host port for container port 3000 (Next.js, etc.) */
  port: number;
  /** Host port for container port 5173 (Vite default) */
  portVite?: number;
  userId: string;
  projectId: string;
  startedAt: Date;
  lastActivity: Date;
  status: SessionStatusType;
  detection?: import('../detection').DetectionResult;
}

export class SessionRegistry {
  private readonly sessions = new Map<string, SessionInfo>();

  set(sessionId: string, info: SessionInfo): void {
    this.sessions.set(sessionId, info);
    console.log('[polaris-docker] session registered', { sessionId, userId: info.userId, projectId: info.projectId });
    redis
      .set(Keys.session(sessionId), JSON.stringify(info), { ex: TTL.session })
      .catch((err) => console.error('[registry] redis set error:', err));
  }

  get(sessionId: string): SessionInfo | undefined {
    return this.sessions.get(sessionId);
  }

  delete(sessionId: string): void {
    this.sessions.delete(sessionId);
    console.log('[polaris-docker] session deleted', { sessionId });
    redis.del(Keys.session(sessionId)).catch((err) => console.error('[registry] redis del error:', err));
  }

  has(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  getAll(): Map<string, SessionInfo> {
    return new Map(this.sessions);
  }

  count(): number {
    return this.sessions.size;
  }

  updateActivity(sessionId: string): void {
    const info = this.sessions.get(sessionId);
    if (info) {
      info.lastActivity = new Date();
      redis.expire(Keys.session(sessionId), TTL.session).catch(() => {});
    }
  }

  updateStatus(sessionId: string, status: SessionStatusType): void {
    const info = this.sessions.get(sessionId);
    if (info) {
      info.status = status;
    }
  }

  updateDetection(sessionId: string, detection: DetectionResult): void {
    const info = this.sessions.get(sessionId);
    if (info) {
      info.detection = detection;
      console.log(`[polaris-docker] detection saved: ${sessionId}`);
    }
  }

  /** Restore sessions from Redis on startup. */
  async restoreFromRedis(): Promise<void> {
    const docker = new Docker();
    try {
      const keys = await redis.keys('polaris:session:*');
      let restored = 0;
      for (const key of keys) {
        const sessionId = key.replace(/^polaris:session:/, '');
        const raw = await redis.get(key);
        if (raw == null) continue;
        let info: SessionInfo;
        if (typeof raw === 'string') {
          try {
            info = JSON.parse(raw) as SessionInfo;
          } catch {
            await redis.del(key).catch(() => {});
            continue;
          }
        } else if (typeof raw === 'object' && raw !== null && 'containerId' in raw) {
          info = raw as SessionInfo;
        } else {
          continue;
        }
        let containerState: SessionStatusType;
        try {
          const inspect = await docker.getContainer(info.containerId).inspect();
          const state = inspect.State;
          if (state.Running) {
            containerState = state.Paused ? 'paused' : 'running';
          } else {
            containerState = 'stopped';
          }
        } catch {
          await redis.del(key).catch(() => {});
          continue;
        }
        info.startedAt = new Date(info.startedAt);
        info.lastActivity = new Date(info.lastActivity);
        info.status = containerState;
        this.sessions.set(sessionId, info);
        console.log(`[registry] restored: ${sessionId} (${containerState})`);
        restored++;
      }
      console.log(`[registry] restored ${restored} sessions from Redis`);
    } catch (err) {
      console.error('[registry] restoreFromRedis error:', err);
    }
  }

  countByStatus(status: SessionInfo["status"]): number {
    let count = 0;
    for (const info of this.sessions.values()) {
      if (info.status === status) count++;
    }
    return count;
  }

  countByUser(userId: string): number {
    let count = 0;
    for (const info of this.sessions.values()) {
      if (info.userId === userId && info.status !== 'deleted') {
        count += 1;
      }
    }
    return count;
  }

  findByProjectId(
    projectId: string,
    userId?: string
  ): { sessionId: string; info: SessionInfo } | undefined {
    for (const [sessionId, info] of this.sessions) {
      if (
        info.projectId === projectId &&
        info.status !== 'deleted' &&
        (userId == null || info.userId === userId)
      ) {
        return { sessionId, info };
      }
    }
    return undefined;
  }
}

export const registry = new SessionRegistry();
