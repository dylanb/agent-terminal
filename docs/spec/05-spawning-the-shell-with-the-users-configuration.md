## 5. Spawning the shell with the user's configuration

This is the requirement most easily gotten subtly wrong.

A PTY-attached shell detects an interactive session automatically (it has a controlling TTY). The remaining question is **which startup files load**, which depends on login vs. non-login — and the convention differs by platform:

- **Linux:** native terminals launch a **non-login interactive** shell, which sources `~/.bashrc`.
- **macOS:** Terminal.app/iTerm launch a **login** shell, which sources `~/.bash_profile` (then `~/.bash_login` / `~/.profile`).

To match what the user already experiences in their native terminal, branch on platform:

```js
const os = require('os');
const isMac = process.platform === 'darwin';

// Default to the user's own login shell; APP_SHELL overrides, bash is the last resort (v2.79).
const shellPath = process.env.APP_SHELL || process.env.SHELL || 'bash';
const shellArgs = isMac ? ['-l'] : [];   // login on macOS, plain interactive on Linux

const ptyProcess = pty.spawn(shellPath, shellArgs, {
  name: 'xterm-256color',                // sets TERM; matches xterm.js capabilities
  cols: 80,
  rows: 24,
  cwd: process.env.HOME || os.homedir(),
  env: {
    ...process.env,
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
  },
});
```

**Notes / gotchas**
- The `cwd` is the **resolved launch root L** (§23.4), not always `$HOME`: a launched instance roots its shell at a caller-supplied target directory when one is given and usable, else at F (`$HOME`). The same L feeds the viewer (§20.1) and todo scope (§16.3). The flow global dir (§18.1) is **not** an L surface — it stays at the per-user home, independent of L.
- `name: 'xterm-256color'` makes `node-pty` advertise the right terminfo; without it, color and key handling degrade.
- The session defaults to the user's own login shell via `$SHELL` (v2.79); `APP_SHELL` overrides it and `bash` is the last-resort fallback when `$SHELL` is unset. macOS ships bash 3.2 at `/bin/bash`; if the user wants bash but a modern Homebrew build (`/opt/homebrew/bin/bash` on Apple Silicon, `/usr/local/bin/bash` on Intel), they point `APP_SHELL` at it.
- Do **not** pass `--rcfile` or `--noprofile`; that would defeat "use the user's default configuration."
- The locale-dependent vars (`LANG`, `LC_*`) are inherited via `...process.env`, which keeps Unicode/emoji rendering correct.
- **GUI launches start with a barren environment.** When the app is opened from Launchpad or a Linux `.desktop` file rather than a terminal, Electron's `process.env` lacks the user's interactive `PATH` (nvm/asdf shims, `~/.local/bin`, Homebrew) — and agent CLIs are typically npm-installed onto exactly those paths. macOS is covered: the `-l` login shell re-evaluates the profile inside the PTY. On Linux the non-login shell sources `~/.bashrc`, which rebuilds `PATH` for most nvm/asdf setups — but `PATH` set only in `~/.profile` (login-only) will be missing. **Verify that `claude`/`codex` resolve in a GUI-launched session on Linux**; if not, probe once at startup with the user's own resolved shell (`APP_SHELL || $SHELL || bash`, run `-l -c 'echo $PATH'`) and seed the PTY env with the result — asking a hardcoded `bash` would miss a non-bash `$SHELL` user's shell-specific PATH. (Launching from a terminal has the inverse issue — a pre-polluted inherited env — which is acceptable: it matches what a nested shell would see.)
- **Shell-integration hook (§15.5, added v2.5).** To segment command output, the spawn env gets `APP_TERM_INTEGRATION=<app-owned script path>` and `PROMPT_COMMAND=source "$APP_TERM_INTEGRATION"`. `PROMPT_COMMAND` is bash's only **post-rc** env seam, so the script loads *after* the user's startup files — preserving the "use the user's own configuration" rule above (still no `--rcfile`/`--noprofile`). The script installs OSC 133 marks (`A`/`B` via PS1, `C` via PS0, `D;exit` via a precmd), self-heals each prompt, and degrades silently if a foreign/non-bash shell inherits the env without the file. Opt out with `APP_SHELL_INTEGRATION=0` or a non-bash `APP_SHELL`. Known, accepted limit: an rc that *overwrites* (not appends to) `PROMPT_COMMAND` removes the hook — command capture then becomes unavailable, with no heuristic fallback this phase.
- **Why a shell at all (not the agent directly):** the user's shell config provides their PATH, credentials helpers, and aliases that agent CLIs depend on; and a shell lets the user choose/restart/switch agents within one session. Direct-spawn of an agent binary is a possible later optimization, not the foundation.
- **The shell IS the session — its exit terminates the app (v2.95).** When the PTY's shell exits (`exit`, Ctrl-D, or the process dying), the app terminates rather than lingering: `pty:exit` fires (the renderer's reaction is transient, §9.2) and main closes the window, running teardown and quitting. **Exception — startup-failure grace:** a shell that exits in *less than* `startupExitGraceMs` after spawn (default 1000 ms, `APP_STARTUP_EXIT_GRACE_MS`; an uptime of exactly the grace terminates) is treated as a startup failure (broken rc, bad `APP_SHELL`, instant crash); the app stays open so the `[process exited: N]` diagnostic is visible instead of the window flashing and vanishing undiagnosably. A relaunch in the same launch root L spawns a **fresh** shell with a clean terminal — the dead shell's processes, in-shell env, and unwritten history are not restored. Curated pane state that persists per-directory (monitor capture events `<L>/.agent-terminal/monitor-events.json` §8.4, todos §16.3, flow progression §19.1) is restored on relaunch in the same directory, independent of how the prior instance terminated.

  ```mermaid
  stateDiagram-v2
      [*] --> Running : shell spawned
      Running --> StartupFailureVisible : shell exits, uptime < grace
      Running --> Terminating : shell exits, uptime >= grace
      Terminating --> [*] : close window, teardown, quit
      note right of StartupFailureVisible : window stays open, diagnostic visible
  ```
- **Agent CLIs care about the terminal they see.** Claude Code, Codex, etc. read `TERM`, the window size, and color support to choose their rendering. The settings above (xterm-256color, truecolor, live resize) are what they expect. Note: agents differ in which buffer they draw to — **Claude Code 2.x and Codex both take the alternate screen** (full-screen TUI), while older scrolling-transcript agents stay on the **normal** buffer. Both cases are handled by this design — see the alt-screen notes in §7.4 and §8.2, and the on-demand alt capture in §21.1.

---


### Controller registration prerequisite (#218)

Before shell spawning or flow initialization, show the waiting window and obtain confirmed initial controller registration (§23.6). Input and flow-start requests cannot release this prerequisite. A closed waiting window cancels registration. After acceptance, perform the existing shell/flow initialization once and preserve early PTY output until the renderer installs its listeners.
