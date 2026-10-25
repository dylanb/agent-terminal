export const STARTUP_CARD = {
  label: 'Startup paused',
  heading: 'Waiting for the controller',
  explanation:
    'Start Agent Terminal Controller to continue. This terminal will connect automatically. If the controller is already running, restart it. If this terminal still waits, update both apps to their latest builds.',
  macosStep: 'macOS: Open Agent Terminal Controller (agent-terminal-controller.app) from your Applications folder.',
  linuxStep:
    'Linux: Open Agent Terminal Controller (agent-terminal-controller) from your applications menu, or run its AppImage.',
  closeHint: 'You can close this window while waiting.',
  statusLine: 'Not connected yet. This terminal will start on its own once the controller confirms.',
} as const;

export const STARTUP_CARD_READING_ORDER = [
  STARTUP_CARD.label,
  STARTUP_CARD.heading,
  STARTUP_CARD.explanation,
  STARTUP_CARD.macosStep,
  STARTUP_CARD.linuxStep,
  STARTUP_CARD.closeHint,
  STARTUP_CARD.statusLine,
] as const;

export const INSTALLED_APP_NAMES = ['agent-terminal-controller.app', 'agent-terminal-controller'] as const;
