#!/usr/bin/env bash
# Renders the README's still pictures in docs/media/ from the built status
# line, with freeze (https://github.com/charmbracelet/freeze). Run it after
# `pnpm build` when the bars or the themes change.
set -euo pipefail
cd "$(dirname "$0")/.."
out=docs/media
now=$(date +%s)
export FORCE_COLOR=1 COLUMNS=100

# A payload with the README's figures, half-way through the 5-hour window.
payload() {
  local five=$1 seven=${2:-41}
  printf '{"model":{"display_name":"Opus 5.5"},"workspace":{"current_dir":"%s"},"context_window":{"context_window_size":200000,"used_percentage":43},"cost":{"total_duration_ms":4320000},"effort":{"level":"high"},"rate_limits":{"five_hour":{"used_percentage":%s,"resets_at":%s},"seven_day":{"used_percentage":%s,"resets_at":%s}}}' \
    "$PWD" "$five" $((now + 9000)) "$seven" $((now + 3 * 86400))
}
status() { payload "${@:2}" | node dist/statusline.js $1; }

shot() {
  freeze --language ansi --window --padding 20,28 --margin 0 --border.radius 8 \
    --font.size 15 --line-height 1.5 --background '#1e1e2e' -o "$out/$1.png"
}

# The pace marker in each of its six colours. Half the window has passed, so
# the projection is twice the usage.
{
  for row in '20 below 50%' '30 50–75%' '40 75–90%' '47 90–100%' '55 100–120%' '70 above 120%'; do
    read -r pct label <<<"$row"
    printf '%s   \e[0;90mprojected %s\e[0m\n' "$(status '--show 5h --no-reset --segments 10' "$pct")" "$label"
  done
} | shot pace

# The default rows in each theme.
{
  for theme in default pastel high-contrast mono; do
    printf '\e[0;90m--theme %s\e[0m\n' "$theme"
    status "--theme $theme" 9
    echo
  done
} | sed '$d' | shot themes
