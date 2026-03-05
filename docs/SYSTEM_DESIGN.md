# Polaris Docker Service — System Design

High-level and detailed view of the current architecture.

---

## 1. High-level architecture

```mermaid
flowchart TB
  subgraph External["External"]
    Polaris["Polaris Frontend (Browser)"]
  end

  subgraph Service["polaris-docker-service (Node.js :4000)"]
    HTTP["HTTP API\n/session/*, /health, /sessions"]
    WS["WebSocket\n/terminal/:sessionId"]
    Preview["Preview Proxy\n/preview/:sessionId"]
    Auth["Auth\nClerk JWT or Internal Key"]
  end

  subgraph Docker["Docker Host"]
    C1["Container 1\n/workspace, ports 3000/5173"]
    C2["Container 2\n..."]
    CN["Container N"]
  end

  Polaris -->|POST /session/start\nBearer / x-internal-key| Auth
  Auth --> HTTP
  Polaris -->|GET previewUrl\n+ key| Preview
  Polaris -->|WS wsUrl| WS
  HTTP --> SessionLogic["Session Manager\n+ Registry"]
  SessionLogic --> DockerAPI["Docker API\n(dockerode)"]
  DockerAPI --> C1 & C2 & CN
  Preview -->|probe + proxy| C1 & C2 & CN
  WS -->|exec bash| C1 & C2 & CN
```

---

## 2. Main components

```mermaid
flowchart LR
  subgraph src["src/"]
    server["server.ts\nExpress + HTTP + WS upgrade"]
    registry["session/registry.ts\nIn-memory Map\nsessionId → SessionInfo"]
    manager["session/manager.ts\nSessionManager\ncreate/stop/restart/reattach"]
    auth["security/auth.ts\nClerk JWT, internal key\nhybridAuth"]
    limits["security/limits.ts\nMAX_SESSIONS, per-user limit\nWatchdog (1h stop, 24h delete)"]
    terminal["terminal/pty.ts\nattachTerminal\nWebSocket ↔ exec stream"]
    preview["proxy/preview.ts\nPreview router\nport probe + proxy"]
  end

  server --> registry & manager & auth & limits & terminal & preview
  manager --> registry
  limits --> registry & manager
  terminal --> registry
  preview --> registry
```

---

## 3. Session lifecycle

```mermaid
stateDiagram-v2
  [*] --> CheckReuse: POST /session/start

  CheckReuse --> ReuseRunning: same projectId+userId, status=running
  CheckReuse --> RestartStopped: same projectId+userId, status=stopped
  CheckReuse --> CheckOrphan: no existing session
  CheckReuse --> RejectUserLimit: user sessions >= 3
  CheckReuse --> RejectGlobalLimit: total sessions >= MAX_SESSIONS

  RestartStopped --> Running: container.start + autoStartDevServer
  ReuseRunning --> Running: writeFilesToWorkspace, return existing

  CheckOrphan --> ReattachOrphan: orphan container found by name
  CheckOrphan --> CreateNew: no orphan
  ReattachOrphan --> Running: registry.set, writeFiles
  CreateNew --> Running: createContainer, start, autoStartDevServer, registry.set

  Running --> IdleStopped: idle 1h (watchdog)
  IdleStopped --> Running: next /session/start restarts
  IdleStopped --> Deleted: idle 24h (watchdog)
  Running --> Deleted: POST /session/stop or watchdog 24h

  Deleted --> [*]
  RejectUserLimit --> [*]
  RejectGlobalLimit --> [*]
```

---

## 4. Request flows

### 4.1 Start session (POST /session/start)

```mermaid
sequenceDiagram
  participant P as Polaris
  participant A as hybridAuth
  participant M as SessionManager
  participant R as Registry
  participant D as Docker
  participant Auto as autoStartDevServer

  P->>A: POST body: sessionId, projectId, userId, files
  A->>A: Clerk JWT or x-internal-key
  A->>M: createSession(params)

  M->>R: findByProjectId(projectId, userId)
  alt reuse running
    R-->>M: existing session
    M->>M: writeFilesToWorkspace, updateActivity
    M-->>P: 200 { sessionId, wsUrl, previewUrl, reused: true }
  else restart stopped
    M->>D: container.start()
    M->>Auto: autoStartDevServer (fire-and-forget + .catch)
    M->>R: updateStatus running
    M-->>P: 200 { sessionId, wsUrl, previewUrl, reused: true }
  else new session
    M->>R: countByUser(userId) < 3?
    M->>R: count() < MAX_SESSIONS?
    M->>M: tempDir = os.tmpdir()/polaris-{sessionId}
    M->>M: write files to tempDir
    M->>D: createContainer(image, Binds tempDir:/workspace, ports 3000/5173)
    M->>D: container.start()
    M->>Auto: autoStartDevServer(containerId, sessionId).catch(...)
    M->>R: set(sessionId, SessionInfo)
    M-->>P: 200 { sessionId, wsUrl, previewUrl, reused: false }
  end
```

### 4.2 Terminal (WebSocket /terminal/:sessionId)

```mermaid
sequenceDiagram
  participant P as Polaris (xterm.js)
  participant S as Server (upgrade)
  participant R as Registry
  participant T as attachTerminal
  participant D as Docker

  P->>S: WebSocket upgrade /terminal/{sessionId}?key=...
  S->>R: has(sessionId)?
  alt !has
    S-->>P: close 4404 Session not found
  else
    S->>R: updateActivity(sessionId)
    S->>T: attachTerminal(ws, sessionId, docker)
    T->>R: get(sessionId) → containerId
    T->>D: container.exec(bash -i, Tty, /workspace)
    T->>D: exec.start(hijack)
    T->>P: stream stdout (terminal output)
    P->>T: input/resize/restartDev messages
    T->>D: execStream.write(input)
  end
```

### 4.3 Preview (GET /preview/:sessionId)

```mermaid
sequenceDiagram
  participant P as Polaris iframe
  participant Proxy as Preview Router
  participant R as Registry
  participant D as Docker
  participant Dev as Dev server in container

  P->>Proxy: GET /preview/:sessionId (internal key or auth)
  Proxy->>R: get(sessionId) → containerId, port bindings
  Proxy->>D: inspect container ports
  loop probe 5173, 3000, 8000, 4200, 8080
    Proxy->>Dev: GET http://127.0.0.1:{hostPort}/
    Dev-->>Proxy: 200 OK or timeout
  end
  alt no responsive port
    Proxy-->>P: 502 Preview not ready HTML
  else port found
    Proxy->>Proxy: createProxyMiddleware(target hostPort)
    P->>Proxy: GET /preview/:sessionId/...
    Proxy->>Dev: proxy request
    Dev-->>Proxy: response
    Proxy-->>P: response
  end
```

### 4.4 Debug (GET /session/devlog?sessionId=)

```mermaid
sequenceDiagram
  participant Client as Client (e.g. Polaris / curl)
  participant S as server.ts
  participant R as Registry
  participant D as Docker

  Client->>S: GET /session/devlog?sessionId=xxx (hybridAuth)
  S->>R: get(sessionId)
  alt !session
    S-->>Client: 404 { error: "Session not found" }
  else
    S->>D: exec: cat /tmp/dev.log or "dev.log not found"
    S->>D: exec: ps aux
    S-->>Client: 200 { sessionId, containerId, devLog, processes }
  end
```

---

## 5. Limits and isolation

```mermaid
flowchart TB
  subgraph Limits["Limits (security/limits.ts)"]
    L1["Global: MAX_SESSIONS (default 10)\nregistry.count() >= N → reject"]
    L2["Per-user: MAX_SESSIONS_PER_USER (default 3)\nregistry.countByUser(userId) >= 3 → reject"]
    L3["Watchdog every 60s\nidle > 1h → stop container\nidle > 24h → stopSession (delete)"]
  end

  subgraph Isolation["Container isolation"]
    I1["One container per session\nname: polaris-{sessionId}"]
    I2["One bind: tempDir → /workspace\ntempDir = os.tmpdir()/polaris-{sessionId}"]
    I3["Reuse only when same projectId AND same userId\nfindByProjectId(projectId, userId)"]
    I4["Terminal & preview & devlog scoped by sessionId\nregistry.get(sessionId) → single containerId"]
  end

  Limits --> Isolation
```

| Mechanism | Purpose |
|-----------|--------|
| **MAX_SESSIONS** | Global cap so the host doesn’t run too many containers. |
| **MAX_SESSIONS_PER_USER** | Per-user cap (3); no user can hold more than 3 sessions. |
| **Watchdog** | Idle 1h → container stopped (session kept); idle 24h → container + registry entry removed. |
| **SessionInfo.userId** | Reuse and count are per user; no cross-user reuse. |
| **Isolated tempDir + single bind** | Each session has its own `/workspace`; no sharing of user code between sessions. |

---

## 6. Auto-start dev server

```mermaid
flowchart LR
  A["container.start()"] --> B["autoStartDevServer(containerId, sessionId)"]
  B --> C["exec: nohup sh -c 'npm install && npm run dev ...' > /tmp/dev.log 2>&1 &"]
  C --> D["Log: AUTO START CALLED\nLog: command, workingDir\nStream: stdout → exitCode log"]
  D --> E["/tmp/dev.log in container\n/session/devlog reads it"]
```

- **When:** After `container.start()` for new sessions and on `restartSession`.
- **Command:** Configurable via `POLARIS_DEV_COMMAND`; default `npm run dev -- --host 0.0.0.0 --port 5173`.
- **Output:** Piped to `/tmp/dev.log` in the container for debugging via `/session/devlog`.

---

## 7. File layout (reference)

```
src/
├── server.ts           # Express, HTTP, WS upgrade, routes
├── session/
│   ├── manager.ts      # SessionManager, autoStartDevServer, Docker create/start/stop
│   └── registry.ts     # In-memory sessionId → SessionInfo, countByUser, findByProjectId
├── terminal/
│   └── pty.ts          # attachTerminal: WebSocket ↔ Docker exec (bash)
├── proxy/
│   └── preview.ts      # GET /preview/:id → probe port → proxy to container
└── security/
    ├── auth.ts         # Clerk JWT, internal key, hybridAuth
    └── limits.ts       # MAX_SESSIONS, watchdog (1h stop, 24h delete)
```

---

## 8. Environment / config

| Env / constant | Default | Meaning |
|---------------|--------|--------|
| `PORT` | 4000 | HTTP server port. |
| `MAX_SESSIONS` | 10 | Global max concurrent sessions. |
| `MAX_SESSIONS_PER_USER` | 3 | Max concurrent sessions per user. |
| `SANDBOX_IMAGE` | mdkulkanri20/polaris-sandbox:latest | Container image. |
| `POLARIS_DEV_COMMAND` | `npm run dev -- --host 0.0.0.0 --port 5173` | Dev command in container. |
| `IDLE_STOP_MS` | 1h | Idle before container is stopped. |
| `IDLE_DELETE_MS` | 24h | Idle before session is fully deleted. |
| `WATCHDOG_INTERVAL_MS` | 60_000 | How often watchdog runs (1 min). |

---

*Generated for polaris-docker-service. View in an editor that supports Mermaid (e.g. VS Code with Mermaid extension, or [mermaid.live](https://mermaid.live)).*
