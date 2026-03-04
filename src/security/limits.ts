import { registry } from '../session/registry';
import { sessionManager } from '../session/manager';

const MAX_SESSIONS = Math.max(1, parseInt(process.env.MAX_SESSIONS ?? '10', 10));
const SESSION_TIMEOUT_MS =
  Math.max(60_000, parseInt(process.env.SESSION_TIMEOUT_MINUTES ?? '30', 10) * 60 * 1000);
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
    const toStop: string[] = [];
    for (const [sessionId, session] of registry.getAll()) {
      const idleMs = Date.now() - session.lastActivity.getTime();
      if (idleMs > SESSION_TIMEOUT_MS) {
        toStop.push(sessionId);
      }
    }
    for (const sessionId of toStop) {
      console.log('[polaris-docker] auto-killing idle session:', sessionId);
      sessionManager.stopSession(sessionId).catch(() => {});
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
