import type WebSocket from 'ws';
import type Docker from 'dockerode';
import { registry } from '../session/registry';
import { unpauseSession } from '../session/manager';

interface ResizeMessage {
  type: 'resize';
  cols: number;
  rows: number;
}

interface InputMessage {
  type: 'input';
  data: string;
}

interface RestartDevMessage {
  type: 'restartDev';
}

type ClientMessage = ResizeMessage | InputMessage | RestartDevMessage;

export async function attachTerminal(
  ws: WebSocket,
  sessionId: string,
  docker: Docker
): Promise<void> {
  const session = registry.get(sessionId);
  if (!session) {
    ws.send(JSON.stringify({ type: 'error', message: 'Session not found' }));
    ws.close();
    return;
  }

  if (session.status === 'paused') {
    console.log(`[polaris-docker] auto-unpausing for request: ${sessionId}`);
    await unpauseSession(sessionId);
    await new Promise(r => setTimeout(r, 300));
  }

  try {
    const container = docker.getContainer(session.containerId);
    const exec = await container.exec({
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: true,
      User: 'root',
      WorkingDir: '/workspace',
      Cmd: ['/bin/sh', '-c', 'cd /workspace 2>/dev/null || true; if [ -f .polaris-start.sh ]; then sh .polaris-start.sh; rm -f .polaris-start.sh; fi; exec /bin/sh -i'],
    });

    const execStream = await exec.start({ hijack: true, stdin: true });
    if (!execStream) {
      ws.send(JSON.stringify({ type: 'error', message: 'Failed to start exec' }));
      ws.close();
      return;
    }

    console.log('[polaris-docker] terminal connected:', sessionId);

    execStream.on('data', (chunk: Buffer | string) => {
      if (ws.readyState !== ws.OPEN) {
        return;
      }
      const raw = typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
      const cleaned = raw
        .replace(/\r/g, '')
        .replace(/[⠙⠹⠸⠼⠴⠦⠧⠇⠏⠋]/g, '');
      if (cleaned.length === 0) return;
      ws.send(cleaned);
    });

    execStream.on('end', async () => {
      console.log(
        '[polaris-docker] terminal exec stream ended (server closing ws):',
        sessionId
      );
      try {
        const inspect = await exec.inspect();
        const exitCode = (inspect as { ExitCode?: number }).ExitCode;
        const msg = `\r\n[polaris-docker] dev server exited with code ${
          exitCode ?? 'unknown'
        }\r\n`;
        if (ws.readyState === ws.OPEN) {
          ws.send(msg);
        }
      } catch {
        // ignore inspect errors
      }
      if (ws.readyState === ws.OPEN) ws.close();
    });

    execStream.on('error', (err: Error) => {
      console.log('[polaris-docker] terminal exec stream error:', sessionId, err.message);
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: 'error', message: err.message }));
        ws.close();
      }
    });

    ws.on('message', (raw: Buffer | string) => {
      const msg = typeof raw === 'string' ? raw : raw.toString();
      let parsed: ClientMessage | null = null;
      try {
        parsed = JSON.parse(msg) as ClientMessage;
      } catch {
        execStream.write(msg);
        return;
      }
      if (parsed.type === 'resize') {
        const { cols, rows } = parsed;
        if (typeof cols === 'number' && typeof rows === 'number') {
          exec.resize({ h: rows, w: cols }).catch((err) => {
            console.log('[polaris-docker] terminal resize error:', sessionId, err);
          });
        }
      } else if (parsed.type === 'input') {
        execStream.write(parsed.data);
      } else if (parsed.type === 'restartDev') {
        // Send Ctrl+C to stop current dev server, then restart it.
        execStream.write('\x03');
        execStream.write(
          'npm run dev -- --host 0.0.0.0 --port 5173\n'
        );
      } else {
        execStream.write(msg);
      }
    });

    ws.on('close', (code: number, reason: Buffer) => {
      const reasonStr = reason?.length ? reason.toString() : '';
      console.log('[polaris-docker] terminal client closed:', sessionId, { code, reason: reasonStr || undefined });
      execStream.destroy();
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.log('[polaris-docker] terminal attach error:', sessionId, message);
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: 'error', message }));
      ws.close();
    }
  }
}
