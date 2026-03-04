---
name: polaris-docker-service
description: Builds and maintains the polaris-docker-service Node.js microservice that manages Docker containers for the Polaris browser-based cloud IDE. Use when editing this repo, adding routes, session/terminal/proxy logic, or when the user mentions Polaris, cloud IDE containers, or polaris-docker-service.
---

# Polaris Docker Service

## Overview

Node.js microservice that manages Docker containers for the Polaris browser-based cloud IDE. HTTP server on port 4000; all routes require Clerk JWT. One container per user session, in-memory session registry, strict limits.

## Stack

| Layer | Technology |
|-------|------------|
| Runtime | Node.js |
| HTTP | Express (port 4000) |
| Containers | dockerode |
| Terminal | node-pty + ws (streaming to xterm.js) |
| Auth | @clerk/backend (JWT) |
| Language | TypeScript (strict mode) |
| Deploy | Railway |

## Folder Structure

```
src/
├── server.ts              # Express + WebSocket server entry point
├── session/
│   ├── manager.ts         # dockerode container create/stop/status
│   └── registry.ts        # In-memory sessionId → container map
├── terminal/
│   └── pty.ts             # node-pty ↔ WebSocket bridge
├── proxy/
│   └── preview.ts         # HTTP proxy for user's running app
└── security/
    ├── auth.ts            # Clerk JWT middleware
    └── limits.ts          # Watchdog + session limits
```

## Key Rules

- **TypeScript**: Every file is TypeScript with strict mode. No `any`; use interfaces for all data shapes.
- **Auth**: All Express routes require Clerk JWT verification. Use the middleware from `src/security/auth.ts`.
- **Sessions**: Tracked in-memory via `src/session/registry.ts`. One Docker container per user session.
- **Lifecycle**: Auto-kill containers after 30 minutes.
- **Concurrency**: Max 10 concurrent sessions enforced (enforce in `src/security/limits.ts`).
- **Container constraints**: Non-root user; 512MB RAM limit; CPU quota 50000/100000.

## Code Generation

When generating or modifying code in this service:

1. **Types**: Use TypeScript interfaces for all request/response and internal data shapes.
2. **Errors**: Handle errors with try/catch; return appropriate HTTP status codes (4xx/5xx).
3. **Logging**: Log important events with `console.log` prefixed by `[polaris-docker]` (e.g. `console.log('[polaris-docker] session started', sessionId)`).
4. **Security**: Never expose container internals (IDs, host paths, internal ports) to the client. Expose only session identifiers and safe status/preview URLs.

## Conventions Checklist

- [ ] All routes protected by Clerk JWT middleware from `src/security/auth.ts`
- [ ] Session create/lookup via `src/session/registry.ts`; container ops via `src/session/manager.ts`
- [ ] Terminal: node-pty in `src/terminal/pty.ts`, bridged to WebSocket for xterm.js
- [ ] App preview: proxy in `src/proxy/preview.ts` for user's running app
- [ ] Limits and watchdog logic in `src/security/limits.ts` (max 10 sessions, 30-min TTL)
