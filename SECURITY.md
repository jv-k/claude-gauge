# Security policy

## Report a vulnerability

Do not report a vulnerability in a public issue. Send an email to git@jvk.to with "claude-gauge security" in the subject. Tell us the version (the tag, or the commit from `git -C ~/.claude/claude-gauge rev-parse --short HEAD`), the command from your settings, and the steps that show the problem.

Expect a first reply within 7 days. This project has one maintainer, so a fix can take longer than the first reply. We credit you in the fix unless you ask us not to.

Remove secrets from your report. A transcript or a settings file can hold API keys, tokens and private conversation.

## Supported versions

claude-gauge has no release yet. Installs track `main`, so fixes land on `main`. After 1.0.0, fixes land on the latest release.

## What is in scope

claude-gauge runs inside Claude Code on each render and at the end of each turn. These properties make a bug worth a private report.

**It prints text it did not write.** The status line prints text from Claude Code's input, from the session transcript and from git: the model name, the session name, folder names, the repository name and the branch name. It also prints the text of `--text` and the output of the `--command` command. Text from any of these that puts terminal control codes on the screen, other than the colours claude-gauge writes itself, is in scope.

**It writes into Claude's context.** With `--instruct`, each line prints an instruction into Claude's context, and that instruction names a shell command that Claude runs on every reply. Any input that changes that command or that instruction beyond the switches the user configured is in scope. Examples are a switch value, a path or an environment variable that breaks out of its quoting.

**It reads private files.** With `--latest`, the lines read the session transcript, which holds the whole conversation. The status line writes one file, `claude-gauge/.state/usage.json` under the Claude config folder, and that file holds only usage figures. Anything that copies transcript content out, writes outside that folder, or reads a file the user did not point it at is in scope.

**It runs few programs.** The status line runs `git` with a one-second timeout, and `vm_stat` with the same timeout on macOS for the `ram` part. It runs the `--command` command only when the user names one and a row shows the `command` part, and stops it after 500 ms. Neither line makes a network request. A path that runs another program, runs the `--command` command without both, lets it run past its timeout, or makes a network request is in scope.

## What is out of scope

- Vulnerabilities in Claude Code, Node.js, Bun or git. Report those to their maintainers. If one affects claude-gauge in a particular way, tell us how.
- A command that the user put in their own settings.
- Missing hardening with no demonstrated impact.
