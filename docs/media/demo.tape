# The README's demo GIF of the setup wizard, for VHS
# (https://github.com/charmbracelet/vhs). Do not run it on its own:
# scripts/media.sh runs it after `pnpm build`, with DEMO_HOME set to a fresh
# folder, so the wizard writes its settings there and not in ~/.claude.

Output docs/media/demo.gif
Require node

Set Shell bash
Set FontSize 14
Set Width 1660
Set Height 760
Set Padding 24
Set Theme "Catppuccin Mocha"
Set TypingSpeed 60ms
Set Framerate 20
Set PlaybackSpeed 1
Set CursorBlink false

# Out of sight, the shell gets ready. Home and the config folder become the
# fresh folder. Only node stays on the PATH, so setup does not offer to star
# the repo with gh. claude-gauge runs the build of this checkout. Without
# DEMO_HOME, the chain stops at its first step and nothing is written.
Hide
Type 'cd "${DEMO_HOME:?run scripts/media.sh}/my-app" && export HOME="$DEMO_HOME" CLAUDE_CONFIG_DIR="$DEMO_HOME/.claude" PATH="$DEMO_HOME/bin" PS1="\[\e[0;35m\]❯\[\e[0m\] " FORCE_COLOR=1 && claude-gauge() { node "$DEMO_CLI" "$@"; } && printf "\\e[H\\e[2J"'
Enter
Sleep 500ms
Type "claude-gauge setup"
Enter

# The first frame shows the command, the wordmark and the defaults.
# VHS reads text only from the top of the scrollback. So this wait, before
# the wizard scrolls, is the only wait that looks for text. The steps after
# it wait with sleeps. The wizard keeps a key typed before its question is
# ready.
Wait+Screen@10s /Use the defaults/
Show
Sleep 3s

# Take the customise path.
Down
Sleep 900ms
Enter

# Rows: move to 3, then back to 2, and accept 2.
Sleep 1.2s
Down
Sleep 900ms
Up
Sleep 900ms
Enter

# Row 1 as it is.
Sleep 1.2s
Enter

# Row 2: untick time, and watch the preview redraw. The list starts at ctx,
# and time is the fourth part in it. A new part before time moves it.
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

# Look through the themes, and take pastel, the fourth theme.
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
