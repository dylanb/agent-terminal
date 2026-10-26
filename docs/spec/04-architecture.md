## 4. Architecture

Two processes, connected by Electron IPC. `node-pty` and the shadow terminal run in the **main process**: node-pty is a native module and must, and the shadow lives beside it so monitoring and injection work no matter what the renderer is doing. The renderer hosts the **terminal pane** and the **monitor pane**.

```mermaid
flowchart LR
    subgraph Main["Main process (Node)"]
        PTY["node-pty<br/>(interactive shell → agent CLI)"]
        SHADOW["@xterm/headless<br/>shadow screen model<br/>(modes, alt-screen, buffer,<br/>quiescence detector)"]
        SCAN["semantic scanner<br/>(adapters + generic,<br/>active→quiet · §15.2/§15.3)"]
        CMD["command tracker<br/>(OSC 133 spans · §15.5)"]
        STORE["event store<br/>stamp + replay"]
        INJ["injection API<br/>wrapForPaste + submit"]
    end
    subgraph Renderer["Renderer process (Chromium)"]
        subgraph TermPane["Terminal pane"]
            XT["xterm.js terminal"]
            SELMODEL["selection model<br/>(app-owned text, follows xterm)"]
        end
        subgraph MonPane["Monitor pane (second UI)"]
            LIST["captured + semantic blocks + status"]
            ACT["Insert / Insert & submit"]
        end
    end
    Preload["preload<br/>(contextBridge API)"]

    PTY -- "output bytes (tee)" --> SHADOW
    PTY -- "output bytes" --> Preload --> XT
    XT -- "keystrokes / paste data" --> Preload --> PTY
    XT -- "selection change" --> SELMODEL
    STORE -- "monitor:event (stamped)" --> Preload --> LIST
    LIST -- "monitor:replay" --> Preload --> STORE
    SHADOW -- "monitor:update (status)" --> Preload --> LIST
    SHADOW -- "active→quiet scan" --> SCAN
    SCAN -- "monitor:event (semantic)" --> STORE
    SHADOW -- "OSC 133 marks" --> CMD
    CMD -- "closed-span ranges + hosted-agent presence" --> SCAN
    ACT -- "agent:inject {text, submit}" --> Preload --> INJ --> PTY
```

### Why it is shaped this way

- **One output stream, two consumers.** Every PTY byte goes to the renderer's xterm and to the shadow, so the shadow is always an accurate model of the screen the user sees, independent of the renderer (§8).
- **PTY and shadow resize together.** A resize that reaches one and not the other makes captures mis-wrap, so the main-process resize handler always moves both.
- **Injection never touches the renderer.** The monitor pane's actions go to main, which reads the live paste mode from the shadow (§9.3). This is what lets injection work while the terminal pane is unfocused, scrolled away, or (later) in another process.
- **The scanner and the command tracker are main-process only.** The scanner reads the shadow on the active→quiet transition (§8.3) and only detects — it never acts on what it finds (§15.2/§15.3). The OSC 133 command tracker's closed spans keep command output from being mistaken for an agent prompt (§15.6) and drive hosted-agent presence (§27.2).
- **The flow audit recorder is observe-only** (§25): it never injects and never throws into the flow path.

---
