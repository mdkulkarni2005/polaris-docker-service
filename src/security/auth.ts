import type { RequestHandler } from 'express';
import { createClerkClient, verifyToken } from '@clerk/backend';

declare global {
  namespace Express {
    interface Request {
      userId?: string;
      userEmail?: string;
    }
  }
}

const clerk = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY! });

export { clerk };

export const clerkAuth: RequestHandler = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : undefined;

  if (!token) {
    console.log('[polaris-docker] auth failure: no token provided');
    res.status(401).json({ error: 'No token provided' });
    return;
  }

  try {
    const payload = await verifyToken(token, {
      secretKey: process.env.CLERK_SECRET_KEY!,
    });
    const sub = payload?.sub;
    if (typeof sub !== 'string') {
      console.log('[polaris-docker] auth failure: token missing sub');
      res.status(401).json({ error: 'Invalid token' });
      return;
    }
    req.userId = sub as string;
    req.userEmail = payload?.email as string | undefined;
    next();
  } catch {
    console.log('[polaris-docker] auth failure: invalid token');
    res.status(401).json({ error: 'Invalid token' });
    return;
  }
};

export const internalKeyAuth: RequestHandler = (req, res, next) => {
  const expected = process.env.DOCKER_SERVICE_INTERNAL_KEY;
  if (!expected) {
    console.log('[polaris-docker] WARNING: DOCKER_SERVICE_INTERNAL_KEY not set');
    next();
    return;
  }
  const key = req.headers['x-internal-key'];
  if (key !== expected) {
    console.log('[polaris-docker] auth failure: internal key mismatch');
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
};

export const hybridAuth: RequestHandler = (req, res, next) => {
  const expected = process.env.DOCKER_SERVICE_INTERNAL_KEY;
  const key = req.headers['x-internal-key'];
  if (expected && key === expected) {
    next();
    return;
  }
  clerkAuth(req, res, next);
};

/** Reject only when key is present and wrong. Use for WebSocket upgrade and preview. */
export function isInternalKeyInvalid(
  headers: { [key: string]: string | string[] | undefined },
  queryKey: string | null
): boolean {
  const expected = process.env.DOCKER_SERVICE_INTERNAL_KEY;
  if (!expected) return false;
  const headerKey = headers['x-internal-key'];
  const key = typeof headerKey === 'string' ? headerKey : queryKey;
  if (!key) return false; // no key sent → allow
  return key !== expected;
}
