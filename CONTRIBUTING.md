# Contributing to claude-gauge

Thank you for your help. This project follows the [Code of Conduct](CODE_OF_CONDUCT.md).

## Before you start

For a small fix, open a pull request. For anything larger, such as a new part, a new switch or a change to what a bar shows, open an issue first, so that the change is agreed before you write it. A new issue gets the `needs-triage` label until the maintainer reads it.

Do not report a vulnerability in a public issue. See [SECURITY.md](SECURITY.md).

## Set up

You need Node.js 18 or later, git, and [pnpm](https://pnpm.io) 10. The `packageManager` field in `package.json` names the exact pnpm version, so `corepack enable` gives you that version.

```sh
git clone https://github.com/jv-k/claude-gauge.git
cd claude-gauge
pnpm install
pnpm test
```

`pnpm test` builds first, then runs the suites in `test/` against the build with Node's built-in test runner. `pnpm typecheck` checks the sources without a build.

[Bun](https://bun.sh) is optional. When Bun is installed, the parity suite also runs the TypeScript sources under Bun and checks that they print the same bytes as the build. Without Bun, those checks skip.

## Where things are

| Path | Holds |
| --- | --- |
| `src/statusline.ts` | The status line. |
| `src/tokenline.ts` | The token line. |
| `dist/` | The two built files that users' settings run. `pnpm build` writes them, and they are committed. |
| `test/` | The suites, one per line, and the parity suite, which checks the README examples against the build. |
| `README.md` | The user docs: every part and every switch. |
| `INSTALL-WITH-CLAUDE.md` | The steps Claude follows when a user asks it to install claude-gauge. |
| `docs/agents/` | How agent skills use the issue tracker, the triage labels and the domain docs. |

## Rules for a change

- **Rebuild `dist/`.** A change to `src/` needs `pnpm build`, and the changed files in `dist/` go in the same commit. A clone runs `dist/` without a build, so a stale `dist/` ships old code.
- **Keep the runtime free of dependencies.** The two scripts use only Node.js built-ins. A status line that fails to load leaves the footer blank.
- **Keep Node.js 18.** Use no API that Node.js 18 does not have. The `@types/node` version in `package.json` makes `pnpm typecheck` catch most of these.
- **Ignore what is unknown.** An unknown switch or part name is ignored, so that a typo never breaks a user's status line or turn. New parsing keeps that rule.
- **Keep switches the only configuration.** Each line reads its switches from the `command` in the user's settings. There is no configuration file.
- **Keep tests out of the real config folder.** A test that renders the status line sets `CLAUDE_CONFIG_DIR` to a temporary folder, because a terminal render saves usage into the config folder.
- **Update the docs with the code.** A new or changed part or switch updates the tables in `README.md`. If it changes a README example, update the parity suite too. If it changes how Claude installs claude-gauge, update `INSTALL-WITH-CLAUDE.md`.
- **Test new behaviour.** Add a test to the suite for the line you change.

## Branches

While 1.0 is in progress, branch from `integration/1.0` and open the pull request against `integration/1.0`. That branch collects the 1.0 work, and it merges into `main` when 1.0 is ready.

`main` is what users run. Installs clone `main` and update with `git pull`, so a merge into `main` reaches users on their next pull, whether or not a release follows.

Name a branch after the type of change and its topic, for example `feat/instruct-hook` or `docs/contributor-docs-24`.

## Commits

Commit subjects follow [Conventional Commits](https://www.conventionalcommits.org): `type: summary`, or `type(scope): summary`. The types in use are `feat`, `fix`, `docs`, `refactor`, `test` and `chore`. A scope is optional.

Write the summary in the imperative and in lower case, with no full stop at the end. Name the effect a user sees, not the code you changed:

```text
feat: show the status line where Claude Code runs none, with --latest
fix: quote forwarded switches in the --instruct command
```

Put one change in each commit. Close an issue from the commit body or the pull request body with `Closes #123`. For two issues, write `Closes #1, closes #2`, because GitHub reads `Closes #1, #2` as a close of #1 only.

These subjects matter after the merge. Pull requests merge with a merge commit, so each commit lands in the history of `main`, and [VerBump](https://github.com/jv-k/VerBump) reads them to suggest the next version and to write the changelog.

## Pull requests

Keep each pull request to one concern. The [pull request template](.github/pull_request_template.md) holds the checklist. Lead the body with what changed and why, and link the issue.

The maintainer, `@jv-k`, is the code owner of every file, so GitHub requests a review from the maintainer on each pull request.

## Report a bug or ask for a feature

Use the [issue forms](https://github.com/jv-k/claude-gauge/issues/new/choose). For a bug, the command from your settings and the host you run Claude Code in (the terminal CLI, the VS Code extension or the desktop app) are the two answers that help most.

## Releases

The maintainer cuts releases. [RELEASING.md](RELEASING.md) gives the steps.
