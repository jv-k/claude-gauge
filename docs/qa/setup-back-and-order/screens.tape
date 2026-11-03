# Screenshots of the setup questions in a real terminal, for the spacing,
# the dim and bold text and the marked part. Run from the repo root after
# `pnpm build`:  vhs docs/qa/setup-back-and-order/screens.tape
# It runs setup on the .try config folder, which `pnpm try:reset` deletes.

Set Shell bash
Set FontSize 14
Set Width 1400
Set Height 1000
Set Padding 20
Set Theme "Catppuccin Mocha"
Set TypingSpeed 10ms

Hide
Type "rm -rf .try && export PS1='$ ' && clear"
Enter
Show
Type "node scripts/try.js cli setup"
Enter
Wait+Screen@15s /Use the defaults/
Sleep 1s
Screenshot docs/qa/setup-back-and-order/vhs-1-defaults.png
Down
Enter
Sleep 1.5s
Screenshot docs/qa/setup-back-and-order/vhs-2-rows.png
Down
Sleep 800ms
Screenshot docs/qa/setup-back-and-order/vhs-2b-three-rows.png
Up
Sleep 500ms
Enter
Sleep 1.5s
Right
Sleep 1s
Screenshot docs/qa/setup-back-and-order/vhs-3-row-editor.png
Right
Right
Sleep 800ms
Screenshot docs/qa/setup-back-and-order/vhs-4-add-slot.png
Enter
Sleep 1.2s
Enter
Sleep 1.2s
Space
Sleep 800ms
Screenshot docs/qa/setup-back-and-order/vhs-5-rows-order.png
Space
Enter
Sleep 1.2s
Sleep 1s
Screenshot docs/qa/setup-back-and-order/vhs-8-bar-style.png
Right
Up
Sleep 1s
Screenshot docs/qa/setup-back-and-order/vhs-9-bar-style-ctx.png
Escape
Sleep 4s
Screenshot docs/qa/setup-back-and-order/vhs-6-steps-list.png
Down
Sleep 1s
Screenshot docs/qa/setup-back-and-order/vhs-7-after-key.png
Ctrl+C
Sleep 1s
