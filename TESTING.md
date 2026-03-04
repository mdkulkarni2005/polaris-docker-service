# How to test polaris-docker-service

## 1. Prerequisites

- **Docker** running (Docker Desktop on Mac).
- **Sandbox image** built once:
  ```bash
  docker build -t polaris-sandbox:latest -f Dockerfile.sandbox .
  ```
- **`.env`** in project root with at least:
  ```
  DOCKER_SERVICE_INTERNAL_KEY=test-key-change-this
  ```
  (Use the same value in `x-internal-key` when calling the API.)

---

## 2. Start the server

```bash
npm run dev
```

You should see:
- `[polaris-docker] running on 4000`
- `[polaris-docker] watchdog started`

Leave this terminal open.

---

## 3. Test the API (curl)

Use a **second terminal**. Replace `test-key-change-this` if your `.env` key is different.

**Health (no auth):**
```bash
curl -s http://localhost:4000/health
```
Expect: `{"status":"ok","totalSessions":0,"maxSessions":10,"availableSlots":10,"uptime":...}`

**Start a session:**
```bash
curl -s -X POST http://localhost:4000/session/start \
  -H "Content-Type: application/json" \
  -H "x-internal-key: test-key-change-this" \
  -d '{
    "sessionId": "my-session",
    "projectId": "p1",
    "userId": "u1",
    "files": [
      { "path": "index.js", "content": "const http = require(\"http\"); http.createServer((req,res) => res.end(\"Hello from Polaris Docker!\")).listen(3000)" }
    ]
  }'
```
Expect: `sessionId`, `wsUrl`, `previewUrl`.

**List sessions:**
```bash
curl -s http://localhost:4000/sessions -H "x-internal-key: test-key-change-this"
```
Expect: JSON array with one session (sessionId, projectId, userId, port, startedAt, lastActivity).

**Health again (should show 1 session):**
```bash
curl -s http://localhost:4000/health
```
Expect: `"totalSessions":1`

**Stop the session:**
```bash
curl -s -X POST http://localhost:4000/session/stop \
  -H "Content-Type: application/json" \
  -H "x-internal-key: test-key-change-this" \
  -d '{ "sessionId": "my-session" }'
```
Expect: `{"success":true}`

**Health again (should show 0 sessions):**
```bash
curl -s http://localhost:4000/health
```
Expect: `"totalSessions":0`

---

## 4. Test terminal in the browser

1. Start the server (`npm run dev`).
2. Open **test-terminal.html** in a browser (e.g. drag the file into Chrome, or open via `file:///path/to/test-terminal.html`).
3. Click **Start Session**.
4. You should see a shell prompt in the terminal (e.g. `sandbox@...:/workspace$`).
5. Type commands (e.g. `ls`, `node -v`). They run inside the container.

The test page uses `x-internal-key: test-key-change-this`; it must match your `.env`.

---

## 5. Test preview (app in container)

1. Start a session (via curl above or test-terminal.html). Note the **previewUrl** (e.g. `http://localhost:4000/preview/my-session`).
2. In the **terminal** (test-terminal.html or WebSocket), the container already has `index.js` if you started with the curl body above. Run:
   ```bash
   node index.js
   ```
   (Or run: `node -e "require('http').createServer((q,r)=>r.end('Hello from Polaris Docker!')).listen(3000)"`.)
3. In the browser, open the **previewUrl**. You should see: **Hello from Polaris Docker!**

If you don’t run a server on port 3000 in the container, the preview will return “App not ready yet” (expected).

---

## 6. Lint (optional)

```bash
npm run lint
```
Expect: no errors (exit code 0).
