export type SessionStatusType = 'running' | 'stopped' | 'deleted';

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
}

export class SessionRegistry {
  private readonly sessions = new Map<string, SessionInfo>();

  set(sessionId: string, info: SessionInfo): void {
    this.sessions.set(sessionId, info);
    console.log('[polaris-docker] session registered', { sessionId, userId: info.userId, projectId: info.projectId });
  }

  get(sessionId: string): SessionInfo | undefined {
    return this.sessions.get(sessionId);
  }

  delete(sessionId: string): void {
    this.sessions.delete(sessionId);
    console.log('[polaris-docker] session deleted', { sessionId });
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
    }
  }

  updateStatus(sessionId: string, status: SessionStatusType): void {
    const info = this.sessions.get(sessionId);
    if (info) {
      info.status = status;
    }
  }

  findByProjectId(projectId: string): { sessionId: string; info: SessionInfo } | undefined {
    for (const [sessionId, info] of this.sessions) {
      if (info.projectId === projectId && info.status !== 'deleted') {
        return { sessionId, info };
      }
    }
    return undefined;
  }
}

export const registry = new SessionRegistry();
