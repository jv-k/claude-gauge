#!/usr/bin/env bash
# Renders the README's pictures in docs/media/ from the build: the still
# pictures from the status line with freeze
# (https://github.com/charmbracelet/freeze), and the demo GIF of the setup
# wizard from docs/media/demo.tape with VHS
# (https://github.com/charmbracelet/vhs), and the wordmark with rsvg-convert
# (librsvg). Run it after `pnpm build` when the
# bars, the themes or the wizard change.
set -euo pipefail
cd "$(dirname "$0")/.."
root=$PWD
out=docs/media
now=$(date +%s)
export FORCE_COLOR=1 COLUMNS=100

# Every render runs in a fresh home folder with its own config folder, so the
# script never writes the real ~/.claude. The folder has a fixed name, because
# the GIF shows its path. If the folder exists, the script stops.
demo=/tmp/claude-gauge-demo
if [ -e "$demo" ]; then
  echo "scripts/media.sh: $demo exists. Remove it, then run the script again." >&2
  exit 1
fi
mkdir -p "$demo/bin" "$demo/my-app" "$demo/.claude" "$demo/stills"
trap 'rm -rf "${demo:?}"' EXIT
export CLAUDE_CONFIG_DIR="$demo/stills"

# The owner's own setup, which every picture shows: a fixed copy, so the
# pictures are the same on any machine. Change it here, and in the
# settings.json written below for the GIF, when the owner's setup changes.
rows=(--show ctx,5h,7d,ram --show time,duration,repo,branch,model,effort,thinking,fast,spend,today)
# Every picture draws the bars in dots and the neon theme; only the hero shows
# the labels.
look=(--bar-style dots --theme neon)
mine="${rows[*]} ${look[*]} --no-labels"
token_line='--bar-style dots'

# A payload with the README's figures, half-way through the 5-hour window,
# with thinking, fast mode, a spend limit and the session's cost, so every
# part in the rows shows.
payload() {
  local five=$1 seven=${2:-41}
  printf '{"session_id":"demo","model":{"display_name":"Opus 5.5"},"workspace":{"current_dir":"%s"},"context_window":{"context_window_size":200000,"used_percentage":43},"cost":{"total_duration_ms":4320000,"total_cost_usd":3.06},"effort":{"level":"high"},"thinking":{"enabled":true},"fast_mode":true,"rate_limits":{"five_hour":{"used_percentage":%s,"resets_at":%s},"seven_day":{"used_percentage":%s,"resets_at":%s},"spend_limit":{"used_percentage":31,"used_usd":62,"limit_usd":200}}}' \
    "$PWD" "$five" $((now + 9000)) "$seven" $((now + 3 * 86400))
}
status() { payload "${@:2}" | node "$root/dist/statusline.js" $1; }

shot() {
  freeze --language ansi --window --padding 20,28 --margin 0 --border.radius 8 \
    --font.size 15 --line-height 1.5 --background '#1e1e2e' -o "$out/$1.png"
}

# The hero: the bottom of a Claude Code session, with the owner's rows under
# the prompt, with labels, every bar in dots and the neon theme. The session
# runs in a repository of its own on main, so the rows show that and not the
# branch the script runs on.
hero="$demo/claude-gauge"
git init -q -b main "$hero"
git -C "$hero" remote add origin https://github.com/jv-k/claude-gauge.git
git -C "$hero" -c user.name=demo -c user.email=demo@example.com commit -q --allow-empty -m init
{
  rule=$(printf '─%.0s' $(seq 1 100))
  printf '\e[0;90m%s\e[0m\n' "$rule"
  printf '\e[1m❯\e[0m \e[0;90mTry "create a util logging.py that..."\e[0m\n'
  printf '\e[0;90m%s\e[0m\n' "$rule"
  (cd "$hero" && payload 9 | node "$root/dist/statusline.js" "${rows[@]}" "${look[@]}")
  printf '\e[0;93m⏵⏵ auto mode on\e[0;90m (shift+tab to cycle)\e[0m\n'
} | shot hero

# The pace marker in each of its six colours, on the 5-hour bar in dots and
# neon. Half the window has passed, so the projection is
# twice the usage.
{
  for row in '20 below 50%' '30 50–75%' '40 75–90%' '47 90–100%' '55 100–120%' '70 above 120%'; do
    read -r pct label <<<"$row"
    printf '%s   \e[0;90mprojected %s\e[0m\n' "$(status "--show 5h --no-reset ${look[*]} --no-labels" "$pct")" "$label"
  done
} | shot pace

# The README's wordmark, from the CLI's rows, in the CLI's gradient: one
# picture for a dark page and one for a light page.
for variant in dark light; do
  node scripts/wordmark.js "$variant" | rsvg-convert -o "$out/wordmark-$variant.png"
done

# The owner's rows in each theme, in the hero's repository on main.
{
  cd "$hero"
  for theme in default pastel high-contrast mono ocean forest sunset neon dracula one-dark solarized-dark monokai nord; do
    printf '\e[0;90m--theme %s\e[0m\n' "$theme"
    status "$mine --theme $theme" 9
    echo
  done
} | sed '$d' | (cd "$root" && shot themes)

# The setup wizard, recorded from docs/media/demo.tape, with the owner's
# setup in place, so setup offers to keep, change or start over. Only node is
# on its PATH, so setup does not find gh and offer to star the repo. The
# status line saves the payload, so the preview shows the README's figures.
ln -s "$(command -v node)" "$demo/bin/node"
runtime="$demo/.claude/claude-gauge/runtime"
printf '{"statusLine":{"type":"command","command":"node %s/statusline.js %s"},"hooks":{"Stop":[{"hooks":[{"type":"command","command":"node %s/tokenline.js %s"}]}]}}\n' \
  "$runtime" "$mine" "$runtime" "$token_line" >"$demo/.claude/settings.json"
payload 9 | CLAUDE_CONFIG_DIR="$demo/.claude" node dist/statusline.js $mine >/dev/null
env -u COLUMNS DEMO_HOME="$demo" DEMO_CLI="$PWD/dist/cli.js" vhs "$out/demo.tape"
