---
description: Take claude-gauge out of your Claude Code settings and put back the status line it replaced
allowed-tools: Bash(node:*)
---

# Uninstall claude-gauge

You are taking claude-gauge out of the user's Claude Code settings. The claude-gauge command does it: it removes claude-gauge's status line and its hooks, puts back the status line that setup replaced, if there was one, and keeps a backup of the settings. Never edit `settings.json` yourself.

## 1. Run uninstall

```sh
node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" uninstall
```

If it exits 1, show the user its message and stop. The message says what to fix.

## 2. Report

Tell the user, in a few lines:

- what the command took out and what it put back, with the backup path it printed;
- that the change shows from the next Claude Code session;
- that the plugin itself is still installed, and that `/plugin uninstall claude-gauge@claude-gauge` removes it;
- that the folder the command named still holds claude-gauge's launcher and saved usage figures, and that deleting it removes them too.
