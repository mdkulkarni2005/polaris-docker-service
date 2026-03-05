# Step 1 — Add env vars to Polaris (local setup)

Do this in your **Polaris** app repo (the Next.js cloud IDE). This assumes **polaris-docker-service runs on your machine** (e.g. `npm run dev` on port 4000), not on Railway.

## 1. Open your Polaris repo

```bash
cd /path/to/your/polaris-repo
```

## 2. Create or edit `.env.local`

Create a file named `.env.local` in the **root** of the Polaris repo (same level as `package.json`).

## 3. Add these three variables (local)

Copy the contents from **STEP1-ENV-FOR-POLARIS.txt**, or paste this and fix the one placeholder:

```bash
DOCKER_SERVICE_URL=http://localhost:4000
DOCKER_SERVICE_INTERNAL_KEY=paste_same_value_from_polaris_docker_service_env
NEXT_PUBLIC_PREVIEW_PROVIDER=webcontainer
```

| Variable | What to use (local) |
|----------|---------------------|
| `DOCKER_SERVICE_URL` | `http://localhost:4000` — polaris-docker-service on your machine (default port 4000). No trailing slash. |
| `DOCKER_SERVICE_INTERNAL_KEY` | **Exact same value** as in polaris-docker-service `.env` (copy the `DOCKER_SERVICE_INTERNAL_KEY` line from there). |
| `NEXT_PUBLIC_PREVIEW_PROVIDER` | Leave as `webcontainer` for now. Switch to `docker` after wiring is done. |

## 4. Run both apps when testing

- **Terminal 1:** In polaris-docker-service: `npm run dev` (port 4000).
- **Terminal 2:** In Polaris: `npm run dev` (e.g. port 3000).

Polaris will call `http://localhost:4000` from its server (Next.js API route), so both must run on the same machine.

## 5. Optional: create a branch for Day 5

```bash
git checkout -b day5-docker-preview
```

## Step 1 done when

- [ ] Polaris repo has `.env.local`
- [ ] `DOCKER_SERVICE_URL=http://localhost:4000`
- [ ] `DOCKER_SERVICE_INTERNAL_KEY` = same as in polaris-docker-service `.env`
- [ ] `NEXT_PUBLIC_PREVIEW_PROVIDER=webcontainer`

After this, we can go to Step 2 (copy provider, API route, and hook into Polaris).
