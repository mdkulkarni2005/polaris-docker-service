export interface SessionInfo {
  containerId: string;
  port: number;
  userId: string;
  projectId: string;
  startedAt: Date;
  lastActivity: Date;
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
}

export const registry = new SessionRegistry();
