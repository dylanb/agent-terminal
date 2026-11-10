## 5. Spawning the shell with the user's configuration

A PTY-attached shell detects an interactive session automatically. The remaining question is **which startup files load**, which depends on login vs. non-login — and the convention differs by platform:

- **Linux:** native terminals launch a **non-login interactive** shell, which sources `~/.bashrc`.
- **macOS:** Terminal.app/iTerm launch a **login** shell, which sources `~/.bash_profile` (then `~/.bash_login` / `~/.profile`).

The app matches what the user already gets in their native terminal: a login shell (`-l`) on macOS, plain interactive on Linux. The shell is the user's own (`$SHELL`), overridable with `APP_SHELL`, with `bash` as the last resort. It never passes `--rcfile` or `--noprofile`, which would defeat "use the user's configuration".

- **Working directory.** The shell starts in the resolved launch root L (§23.4), which also feeds the viewer (§20.1) and todo scope (§16.3).
- **Agents read the terminal they see.** Claude Code, Codex, etc. choose their rendering from `TERM`, window size, and color support, so the PTY advertises `xterm-256color` with truecolor and resizes live. Claude Code 2.x and Codex draw on the **alternate screen**; older scrolling-transcript agents stay on the normal buffer. Both are handled (§7.4, §8.1, §21.1).
- **GUI launches start with a barren `PATH`.** Opened from Launchpad or a `.desktop` file, Electron lacks the user's interactive `PATH` (nvm/asdf shims, `~/.local/bin`, Homebrew) — exactly where agent CLIs are installed. macOS is covered by the login shell. On Linux, `PATH` set only in `~/.profile` would be missing, so the app probes the user's own resolved shell once at startup and merges any new entries, never replacing inherited ones (an active venv/direnv). Probing a hardcoded `bash` would miss a non-bash user's shell-specific `PATH`.
- **Shell integration (§15.5).** Command capture needs OSC 133 marks installed *after* the user's rc files. `PROMPT_COMMAND` is bash's only post-rc env seam, so the integration script is sourced from it; it self-heals each prompt and degrades silently in a shell that inherits the env without the file. Opt out with `APP_SHELL_INTEGRATION=0` or a non-bash shell. Accepted limit: an rc that *overwrites* (not appends to) `PROMPT_COMMAND` removes the hook, and command capture is then unavailable.
- **Why a shell at all (not the agent directly).** The user's shell config provides the `PATH`, credential helpers, and aliases agent CLIs depend on, and a shell lets the user choose, restart, or switch agents within one session.
- **The shell IS the session.** When the shell exits, the app terminates rather than lingering. **Exception — startup-failure grace:** a shell that exits within `APP_STARTUP_EXIT_GRACE_MS` of spawn (default 1000 ms) is treated as a startup failure (broken rc, bad `APP_SHELL`), and the window stays open so the `[process exited: N]` diagnostic is visible instead of the window flashing and vanishing. A relaunch in the same launch root spawns a fresh shell; per-directory state (monitor captures §8.4, todos §16.3, flow progression §19.1) is restored, the dead shell's processes and env are not.

  ```mermaid
  stateDiagram-v2
      [*] --> Running : shell spawned
      Running --> StartupFailureVisible : shell exits, uptime < grace
      Running --> Terminating : shell exits, uptime >= grace
      Terminating --> [*] : close window, teardown, quit
      note right of StartupFailureVisible : window stays open, diagnostic visible
  ```

- **Quitting waits for the shell's exit.** Closing the window hangs up a running shell, and the app's quit is held until that shell's exit has been delivered to the main process: node-pty delivers the exit through a callback that aborts the process when it lands during teardown. A shell still running after `APP_SHELL_QUIT_GRACE_MS` (default 2000 ms), such as one that ignores the hang-up, is killed: until its exit is delivered the app cannot finish exiting, because node-pty's thread waiting on the shell holds the process.

- **Controller registration comes first.** The shell is not spawned until the controller confirms the terminal's registration (§23.6).

---
