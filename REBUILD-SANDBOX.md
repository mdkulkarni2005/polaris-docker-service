# Rebuild sandbox image (fix "container stopped/paused" 409)

The service uses `SANDBOX_IMAGE=mdkulkanri20/polaris-sandbox:latest`. By default that is **pulled from Docker Hub**, which still has the old image (container exits right away).

To use the **fixed** image (container stays running with `tail -f /dev/null`), build it **locally** with the same tag:

```bash
cd /Users/manaskulkarni/polaris-docker-service
docker build -t mdkulkanri20/polaris-sandbox:latest -f Dockerfile.sandbox .
```

Then **restart** the service (Ctrl+C, then `npm run dev`). Docker will use your local image instead of pulling from Hub.

To confirm the right image is used:

```bash
docker images mdkulkanri20/polaris-sandbox:latest
```

You should see a recent "Created" time. New sessions should then stay running and the terminal should attach without 409.
