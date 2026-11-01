# The README's demo GIF of the setup wizard, for VHS
# (https://github.com/charmbracelet/vhs). Do not run it on its own:
# scripts/media.sh runs it after `pnpm build`, with DEMO_HOME set to a fresh
# folder, so the wizard writes its settings there and not in ~/.claude.

Output docs/media/demo.gif
Require node

Set Shell bash
Set FontSize 16
Set Width 1060
Set Height 720
Set Padding 24
Set Theme "Catppuccin Mocha"
Set TypingSpeed 60ms
Set Framerate 20
Set PlaybackSpeed 1
Set CursorBlink false

# Out of sight: home and the config folder become the fresh folder, gh goes
# off the PATH so setup does not offer to star the repo, and claude-gauge
# runs this checkout's build. Without DEMO_HOME the chain stops at its first
# step, claude-gauge is not defined, and nothing is written.
Hide
Type 'cd "${DEMO_HOME:?run scripts/media.sh}/my-app" && export HOME="$DEMO_HOME" CLAUDE_CONFIG_DIR="$DEMO_HOME/.claude" PATH="$DEMO_HOME/bin:/usr/bin:/bin" PS1="\[\e[0;35m\]❯\[\e[0m\] " FORCE_COLOR=1 && claude-gauge() { node "$DEMO_CLI" "$@"; } && clear'
Enter
Sleep 500ms
Type "claude-gauge setup"
Show

# The command is on the first frame, and the wordmark follows it.
Sleep 700ms
Enter

# The wordmark and the defaults. Take the customise path. VHS reads its
# screen from the top of the scrollback, so only this first wait, before the
# wizard scrolls, can look for text; the waits after it are sleeps, and the
# wizard keeps keys typed before a question is ready.
Wait+Screen@10s /Use the defaults/
Sleep 2.5s
Down
Sleep 900ms
Enter

# Two rows, as now: look at three, and come back.
Sleep 1.2s
Down
Sleep 900ms
Up
Sleep 900ms
Enter

# Row 1 as it is.
Sleep 1.2s
Enter

# Row 2: untick the clock, and watch the preview redraw.
Sleep 1.2s
Down
Sleep 400ms
Down
Sleep 400ms
Down
Sleep 600ms
Space
Sleep 1.5s
Enter

# A larger bar.
Sleep 1.2s
Down
Sleep 1.5s
Enter

# Look through the themes, and take pastel.
Sleep 1.2s
Down
Sleep 1.2s
Down
Sleep 1.2s
Down
Sleep 1.5s
Enter

# Keep the labels and the token line, with its default parts and window.
Sleep 1s
Enter
Sleep 1s
Enter
Sleep 1s
Enter
Sleep 1s
Enter

# Write them, and show the result.
Sleep 1.2s
Enter
Sleep 4s
