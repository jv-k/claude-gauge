# A real terminal screenshot of claude-gauge --help, for the pills, the
# colours and the columns. Run from the repo root after `pnpm build`:
#   vhs docs/qa/help/help.tape
Set Shell bash
Set FontSize 14
Set Width 1300
Set Height 1000
Set Padding 20
Set Theme "Catppuccin Mocha"
Hide
Type "export PS1='$ ' && clear"
Enter
Show
Type "node dist/cli.js --help"
Enter
Sleep 2s
Screenshot docs/qa/help/help.png
Sleep 500ms
