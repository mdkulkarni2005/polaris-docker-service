import { registry } from '../session/registry';
import { sessionManager } from '../session/manager';

const MAX_SESSIONS = Math.max(1, parseInt(process.env.MAX_SESSIONS ?? '10', 10));
const IDLE_STOP_MS = 60 * 60 * 1000; // 1 hour — stop container, keep in registry
const IDLE_DELETE_MS = 24 * 60 * 60 * 1000; // 24 hours — full teardown
const WATCHDOG_INTERVAL_MS = 60_000;

export function checkSessionLimit(): boolean {
  const atLimit = registry.count() >= MAX_SESSIONS;
  if (atLimit) {
    console.log('[polaris-docker] session limit hit');
  }
  return atLimit;
}

export function startWatchdog(): NodeJS.Timeout {
  const handle = setInterval(() => {
    const toDelete: string[] = [];
    const toStopIdle: string[] = [];
    for (const [sessionId, session] of registry.getAll()) {
      const idleMs = Date.now() - session.lastActivity.getTime();
      if (idleMs > IDLE_DELETE_MS) {
        toDelete.push(sessionId);
      } else if (session.status === 'running' && idleMs > IDLE_STOP_MS) {
        toStopIdle.push(sessionId);
      }
    }
    for (const sessionId of toDelete) {
      console.log('[polaris-docker] deleting expired container:', sessionId);
      sessionManager.stopSession(sessionId).catch(() => {});
    }
    for (const sessionId of toStopIdle) {
      sessionManager.stopContainerIdle(sessionId).catch(() => {});
    }
  }, WATCHDOG_INTERVAL_MS);
  return handle;
}

export function stopWatchdog(handle: NodeJS.Timeout): void {
  clearInterval(handle);
}

export function getStats(): {
  totalSessions: number;
  maxSessions: number;
  availableSlots: number;
} {
  const totalSessions = registry.count();
  return {
    totalSessions,
    maxSessions: MAX_SESSIONS,
    availableSlots: Math.max(0, MAX_SESSIONS - totalSessions),
  };
}
