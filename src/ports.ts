import Docker from 'dockerode';

const PORT_START = 3100;
const PORT_END = 3300;
const usedPorts = new Set<number>();

export function getAvailablePort(skipPorts?: Set<number>): number {
  for (let p = PORT_START; p <= PORT_END; p++) {
    if (!usedPorts.has(p) && !skipPorts?.has(p)) return p;
  }
  throw new Error('[polaris-docker] no available port in range');
}

export function reservePort(port: number): void {
  usedPorts.add(port);
}

export function releasePort(port: number): void {
  usedPorts.delete(port);
}

export function isPortUsed(port: number): boolean {
  return usedPorts.has(port);
}

/**
 * Scan all running Docker containers and mark any host ports in our
 * range as used.  Prevents conflicts when containers survive a
 * service restart but the in-memory set is empty.
 */
export async function syncPortsFromDocker(): Promise<void> {
  const docker = new Docker();
  try {
    const containers = await docker.listContainers();
    let synced = 0;
    for (const c of containers) {
      for (const p of c.Ports ?? []) {
        const hp = p.PublicPort;
        if (hp != null && hp >= PORT_START && hp <= PORT_END) {
          usedPorts.add(hp);
          synced++;
        }
      }
    }
    if (synced > 0) {
      console.log(`[ports] synced ${synced} occupied ports from Docker: ${[...usedPorts].sort().join(', ')}`);
    }
  } catch (err) {
    console.error('[ports] syncPortsFromDocker error:', err);
  }
}
