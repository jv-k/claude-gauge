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
mine="${rows[*]} --bar-style classic,ctx=dots,5h=hairline,7d=hairline,ram=spark --theme high-contrast --no-labels"
token_line='--bar-style dots'

# A payload with the README's figures, half-way through the 5-hour window,
# with thinking, fast mode, a spend limit and the session's cost, so every
# part in the rows shows.
payload() {
  local five=$1 seven=${2:-41}
  printf '{"session_id":"demo","model":{"display_name":"Opus 5.5"},"workspace":{"current_dir":"%s"},"context_window":{"context_window_size":200000,"used_percentage":43},"cost":{"total_duration_ms":4320000,"total_cost_usd":3.06},"effort":{"level":"high"},"thinking":{"enabled":true},"fast_mode":true,"rate_limits":{"five_hour":{"used_percentage":%s,"resets_at":%s},"seven_day":{"used_percentage":%s,"resets_at":%s},"spend_limit":{"used_percentage":31,"used_usd":62,"limit_usd":200}}}' \
    "$PWD" "$five" $((now + 9000)) "$seven" $((now + 3 * 86400))
}
status() { payload "${@:2}" | node dist/statusline.js $1; }

shot() {
  freeze --language ansi --window --padding 20,28 --margin 0 --border.radius 8 \
    --font.size 15 --line-height 1.5 --background '#1e1e2e' -o "$out/$1.png"
}

# The pace marker in each of its six colours, on the 5-hour bar as the
# owner's setup draws it. Half the window has passed, so the projection is
# twice the usage.
{
  for row in '20 below 50%' '30 50–75%' '40 75–90%' '47 90–100%' '55 100–120%' '70 above 120%'; do
    read -r pct label <<<"$row"
    printf '%s   \e[0;90mprojected %s\e[0m\n' "$(status '--show 5h --no-reset --bar-style hairline --no-labels' "$pct")" "$label"
  done
} | shot pace

# The README's wordmark, from the CLI's rows, in the CLI's gradient: one
# picture for a dark page and one for a light page.
for variant in dark light; do
  node scripts/wordmark.js "$variant" | rsvg-convert -o "$out/wordmark-$variant.png"
done

# The owner's rows in each theme.
{
  for theme in default pastel high-contrast mono ocean forest sunset neon dracula one-dark solarized-dark monokai nord; do
    printf '\e[0;90m--theme %s\e[0m\n' "$theme"
    status "$mine --theme $theme" 9
    echo
  done
} | sed '$d' | shot themes

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
