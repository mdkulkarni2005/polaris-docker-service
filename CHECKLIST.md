# Polaris Docker Service — Verification Checklist

## Code & setup

- [x] **src/security/limits.ts** — Watchdog + session cap (`checkSessionLimit`, `startWatchdog`, `stopWatchdog`, `getStats`)
- [x] **src/security/auth.ts** — `hybridAuth` (internal key or Clerk JWT)
- [x] **src/server.ts** — Watchdog starts on listen; limit enforced in POST /session/start

## Commands

- [ ] **npm run lint** — zero errors  
  ```bash
  npm run lint
  ```
- [ ] **npm run dev** — log shows `[polaris-docker] watchdog started`  
  ```bash
  npm run dev
  ```

## API tests (server running, e.g. `npm run dev`)

Use `x-internal-key` (same as `DOCKER_SERVICE_INTERNAL_KEY` in `.env`) or a valid Clerk Bearer token.

- [ ] **Test 1: GET /health** — returns `ok`  
  ```bash
  curl -s http://localhost:4000/health | jq
  ```  
  Expect: `{ "status": "ok", "totalSessions", "maxSessions", "availableSlots", "uptime" }`

- [ ] **Test 2: POST /session/start** — returns `wsUrl` + `previewUrl`  
  ```bash
  curl -s -X POST http://localhost:4000/session/start \
    -H "Content-Type: application/json" \
    -H "x-internal-key: YOUR_INTERNAL_KEY" \
    -d '{"sessionId":"check-1","projectId":"p1","userId":"u1","files":[{"path":"index.js","content":"console.log(\"hello\")"}]}' | jq
  ```  
  Expect: `sessionId`, `wsUrl`, `previewUrl`

- [ ] **Test 3: GET /sessions** — shows active session  
  ```bash
  curl -s http://localhost:4000/sessions -H "x-internal-key: YOUR_INTERNAL_KEY" | jq
  ```  
  Expect: array with one entry (sessionId, projectId, userId, port, startedAt, lastActivity)

- [ ] **Test 4: GET /health** — `totalSessions: 1`  
  ```bash
  curl -s http://localhost:4000/health | jq .totalSessions
  ```  
  Expect: `1`

- [ ] **Test 5: Preview shows "Hello from Polaris Docker!"**  
  1. Start a session (Test 2) and note `sessionId` and `previewUrl`.  
  2. In the **terminal** (test-terminal.html or WebSocket terminal), inside the container run a server on port 3000:
     ```bash
     node -e "require('http').createServer((q,r)=>{r.end('Hello from Polaris Docker!')}).listen(3000)"
     ```
  3. Open `previewUrl` in the browser (e.g. `http://localhost:4000/preview/check-1`).  
  Expect: page body shows **Hello from Polaris Docker!**

- [ ] **Test 6: POST /session/stop** — then GET /health shows `totalSessions: 0`  
  ```bash
  curl -s -X POST http://localhost:4000/session/stop \
    -H "Content-Type: application/json" \
    -H "x-internal-key: YOUR_INTERNAL_KEY" \
    -d '{"sessionId":"check-1"}'
  curl -s http://localhost:4000/health | jq .totalSessions
  ```  
  Expect: `0`

---

Replace `YOUR_INTERNAL_KEY` with the value of `DOCKER_SERVICE_INTERNAL_KEY` in your `.env` (e.g. `test-key-change-this` for local testing).

---

## Cleanup (port conflicts / leftover sessions)

To remove **only** session containers created by this service (image `polaris-sandbox:latest`), so you don’t remove other Polaris stack containers (e.g. traefik, redis):

```bash
docker ps -aq --filter ancestor=polaris-sandbox:latest | xargs -r docker rm -f
```

On macOS (no `xargs -r`):

```bash
docker ps -aq --filter ancestor=polaris-sandbox:latest | xargs docker rm -f
```

To remove **all** containers whose name starts with `polaris-` (including traefik, redis, etc.) — use only if you intend to tear down the whole stack:

```bash
# Not recommended if you have other polaris-* services
docker rm -f $(docker ps -aq --filter name=polaris-)
```
