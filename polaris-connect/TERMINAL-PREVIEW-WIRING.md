# Terminal.tsx and Preview.tsx wiring

Copy the code below into your **Polaris** repo (not this Docker service repo).

## 1. Terminal.tsx — add `wsUrl` prop and Docker WebSocket path

Add a prop so the parent can pass the Docker terminal WebSocket URL. When `wsUrl` is set, use it instead of the WebContainer terminal.

- **New prop:** `wsUrl: string | null`
- **If `wsUrl` is provided:**
  - Create a WebSocket to `wsUrl`
  - `ws.onmessage` → `terminal.write(data)` (assuming `data` is string; if binary, decode as UTF-8)
  - On user input → `ws.send(data)`
  - On terminal resize → `ws.send(JSON.stringify({ type: "resize", cols, rows }))`
- **Else:** keep existing WebContainer terminal logic unchanged.

Docker service protocol: server sends raw terminal output and sometimes JSON (`{ type: "connected" }`, `{ type: "error", message }`). Client sends raw string for keystrokes and `{ type: "resize", cols, rows }` for resize.

Example shape (integrate with your existing Terminal component):

```tsx
// Add to your Terminal component props
interface TerminalProps {
  // ... existing props
  wsUrl?: string | null;  // When set, use Docker terminal via this WebSocket
}

// Inside the component, branch on wsUrl:
useEffect(() => {
  if (wsUrl) {
    const ws = new WebSocket(wsUrl);
    ws.binaryType = "arraybuffer";
    ws.onopen = () => {};
    ws.onmessage = (ev) => {
      const raw = typeof ev.data === "string" ? ev.data : new TextDecoder().decode(ev.data);
      try {
        const j = JSON.parse(raw);
        if (j.type === "error") setError(j.message ?? "Terminal error");
        // type === "connected" can be ignored or logged
        if (j.type !== "connected" && j.type !== "error") terminalRef.current?.write(raw);
      } catch {
        terminalRef.current?.write(raw);
      }
    };
    ws.onerror = () => setError("Terminal connection error");
    ws.onclose = () => {};
    const term = terminalRef.current;
    if (term) {
      term.onData((data) => ws.readyState === WebSocket.OPEN && ws.send(data));
      term.onResize(({ cols, rows }) => {
        if (ws.readyState === WebSocket.OPEN)
          ws.send(JSON.stringify({ type: "resize", cols, rows }));
      });
    }
    return () => ws.close();
  } else {
    // existing WebContainer terminal attach logic
  }
}, [wsUrl, /* other deps */]);
```

## 2. Preview.tsx — use `previewUrl` from Docker when provided

- Add prop: `previewUrl: string | null` (or get it from the same hook that provides `wsUrl`).
- If `previewUrl` is set, set the iframe `src` to `previewUrl` (Docker proxy URL).
- Else use existing WebContainer preview URL.

```tsx
// Example: iframe src
<iframe
  src={previewUrl ?? webContainerPreviewUrl ?? ""}
  title="Preview"
  // ...
/>
```

## 3. Provider selector in the parent (e.g. project page)

Use the feature flag so one code path chooses WebContainer vs Docker:

```tsx
import { PREVIEW_PROVIDER, isDockerProvider } from "@/features/preview/provider";
import { useDockerPreview } from "@/features/preview/hooks/useDockerPreview";
// ... your existing usePreview / useWebContainer hook

// In the component:
const docker = useDockerPreview({ projectId, enabled: isDockerProvider() });
const webcontainer = useWebContainerPreview(/* existing args */); // keep as-is

const previewUrl = isDockerProvider() ? docker.previewUrl : webcontainer.previewUrl;
const terminalWsUrl = isDockerProvider() ? docker.terminalWsUrl : null;

<Terminal wsUrl={terminalWsUrl} /* ... other props */ />
<Preview previewUrl={previewUrl} /* ... */ />
```

When `PREVIEW_PROVIDER=docker` (or `NEXT_PUBLIC_PREVIEW_PROVIDER=docker`), the Docker hook and URLs are used; otherwise WebContainer is used. No need to delete WebContainer code.
