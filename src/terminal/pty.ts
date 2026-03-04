import type WebSocket from 'ws';
import type Docker from 'dockerode';
import { registry } from '../session/registry';

interface ResizeMessage {
  type: 'resize';
  cols: number;
  rows: number;
}

interface InputMessage {
  type: 'input';
  data: string;
}

type ClientMessage = ResizeMessage | InputMessage;

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

  try {
    const container = docker.getContainer(session.containerId);
    const exec = await container.exec({
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: true,
      Cmd: ['/bin/bash'],
    });

    const execStream = await exec.start({ hijack: true, stdin: true });
    if (!execStream) {
      ws.send(JSON.stringify({ type: 'error', message: 'Failed to start exec' }));
      ws.close();
      return;
    }

    ws.send(JSON.stringify({ type: 'connected', sessionId }));
    console.log('[polaris-docker] terminal connected:', sessionId);

    execStream.on('data', (chunk: Buffer | string) => {
      if (ws.readyState === ws.OPEN) {
        ws.send(typeof chunk === 'string' ? chunk : chunk.toString());
      }
    });

    execStream.on('end', () => {
      console.log('[polaris-docker] terminal exec stream ended:', sessionId);
      ws.close();
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
      } else {
        execStream.write(msg);
      }
    });

    ws.on('close', () => {
      console.log('[polaris-docker] terminal client closed:', sessionId);
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
