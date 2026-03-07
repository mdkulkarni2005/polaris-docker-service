import { registry } from '../session/registry';
import { sessionManager } from '../session/manager';

const MAX_SESSIONS = Math.max(1, parseInt(process.env.MAX_SESSIONS ?? '10', 10));
const IDLE_PAUSE_MS = 5 * 60 * 1000;        // 5 min idle → pause
const IDLE_STOP_MS = 30 * 60 * 1000;        // 30 min idle → stop
const IDLE_DELETE_MS = 24 * 60 * 60 * 1000;  // 24 hours → delete
const WATCHDOG_INTERVAL_MS = 30_000;

export function checkSessionLimit(): boolean {
  const atLimit = registry.count() >= MAX_SESSIONS;
  if (atLimit) {
    console.log('[polaris-docker] session limit hit');
  }
  return atLimit;
}

export function startWatchdog(): NodeJS.Timeout {
  const handle = setInterval(() => {
    (async () => {
      for (const [sessionId, info] of registry.getAll()) {
        const idleMs = Date.now() - info.lastActivity.getTime();

        if (idleMs > IDLE_DELETE_MS) {
          console.log(`[watchdog] deleting expired: ${sessionId}`);
          await sessionManager.stopSession(sessionId);
        } else if (idleMs > IDLE_STOP_MS && info.status === 'paused') {
          console.log(`[watchdog] stopping paused: ${sessionId}`);
          await sessionManager.stopContainerIdle(sessionId);
        } else if (idleMs > IDLE_PAUSE_MS && info.status === 'running') {
          console.log(`[watchdog] pausing idle: ${sessionId}`);
          await sessionManager.pauseSession(sessionId);
        }
      }
    })().catch((err) => console.error('[watchdog] error:', err));
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
