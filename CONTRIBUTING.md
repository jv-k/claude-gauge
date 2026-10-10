# Contributing to claude-gauge

Thank you for your help. This project follows the [Code of Conduct](CODE_OF_CONDUCT.md).

## Before you start

For a small fix, open a pull request. For anything larger, such as a new part, a new switch or a change to what a bar shows, open an issue first, so that the change is agreed before you write it. A new issue gets the `needs-triage` label until the maintainer reads it.

Do not report a vulnerability in a public issue. See [SECURITY.md](SECURITY.md).

## Set up

You need Node.js 18 or later, git, and [pnpm](https://pnpm.io) 10. The `packageManager` field in `package.json` names the exact pnpm version, so `corepack enable` gives you that version. Node.js 25 and later do not include Corepack, so on those versions run `npm install -g corepack` first.

```sh
git clone https://github.com/jv-k/claude-gauge.git
cd claude-gauge
pnpm install
pnpm test
```

`pnpm test` builds first, then runs the suites in `test/` against the build with Node's built-in test runner. `pnpm typecheck` checks the sources without a build. `pnpm lint` runs [Biome](https://biomejs.dev)'s linter over the sources, the suites and the scripts. `biome.jsonc` names the rules it turns off, and why.

[Bun](https://bun.sh) is optional. When Bun is installed, the parity suite also runs the TypeScript sources under Bun and checks that they print the same bytes as the build. Without Bun, those checks skip. With `REQUIRE_BUN=1` set, they fail instead, with a message that Bun is required but missing. The Bun jobs in the `test` workflow set it.

## Where things are

| Path | Holds |
| --- | --- |
| `src/statusline.ts` | The status line. |
| `src/tokenline.ts` | The token line. |
| `src/cli.ts` | The `claude-gauge` command: `setup`, `configure`, `uninstall` and `update`. With no bar switches, `setup` and `configure` run the wizard. |
| `src/wizard.ts` | The wizard's questions, with a preview of the status line after each answer, and the offer to star the repo. `configure` starts it from the switches set up now, and `setup` from the defaults. It returns the bars' switches and writes no file. |
| `src/settings.ts` | `plan()`, which works out the next `settings.json` from the current one and the user's choices, without reading or writing a file. |
| `src/settings-file.ts` | Reads `settings.json`, and writes it atomically, through a symlink, after a timestamped backup. |
| `src/launcher.ts` | The plugin route's launcher. `setup`, run from the plugin, copies it into the state folder and points the settings at it, and it runs the scripts from the newest installed plugin version. |
| `dist/` | The built files: the two scripts that users' settings run, the launcher, and the `claude-gauge` command. `pnpm build` writes them. The `dist` workflow commits them to `main`. |
| `test/` | The suites, one per line, one each for `plan()`, the `claude-gauge` command and its wizard, the plugin suites, which check the plugin route and launcher and the plugin's manifests and commands, and the git suite, which checks the git parts against injected and real git output; the parity suite, which checks the reference examples against the build; the README sync suite, which checks the status line tables and the claude-hud table in `docs/reference.md` against the registry, its `claude-gauge` switch table against the command's usage text, and the README's default parts table against the default rows; the snapshot suite, which checks the status line against the golden snapshots in `test/snapshots/`; the themes suite, which checks the default rows in every theme against the golden snapshots in `test/snapshots/themes/`; and the release suites, which check the release notes script, what npm would publish and that npx runs it, and that no doc names the package without its `@jv-k` scope. |
| `scripts/release-notes.js` | Prints a version's section of `CHANGELOG.md`, which the `release` workflow uses as the GitHub release notes. It is not part of the package. |
| `scripts/test.js` | Runs every suite in `test/` with Node's test runner, the same way on Node 18, 20 and 22 and on every system. `pnpm test` runs it after the build. It is not part of the package. |
| `README.md` | The user docs: every part and every switch, both install routes, and the claude-hud migration table. |
| `docs/reference.md` | The full reference: every part, switch and theme, the other install routes, and the claude-hud option map. The README links to it. |
| `docs/media/` | The README's wordmark, its hero image of a Claude Code session with the status line, and its demo GIF of the setup wizard. They are not part of the package. |
| `.claude-plugin/` | The plugin marketplace that `/plugin marketplace add jv-k/claude-gauge` reads, and the plugin's manifest. The repository root is the plugin. |
| `commands/` | The plugin's slash commands: `/claude-gauge:setup`, `/claude-gauge:configure` and `/claude-gauge:uninstall`. Each has Claude ask its questions, then runs the `claude-gauge` command. |
| `INSTALL-WITH-CLAUDE.md` | The steps Claude follows when a user asks it to install claude-gauge. |
| `.github/workflows/` | The `dist` workflow, which commits the build to `main`; the `test` workflow, which runs the suites on Node 18, 20 and 22 and on Bun, each on Linux, macOS and Windows, with the typecheck, the linter and a coverage report, on each pull request into `integration/1.0` or `main` and each push to `main`; and the `release` workflow, which publishes a release from a version tag. |
| `docs/agents/` | How agent skills use the issue tracker, the triage labels and the domain docs. |

## Rules for a change

- **Leave `dist/` out of the commit.** `dist/` is generated. Commit the change to `src/` only. A branch cut from `integration/1.0` ignores `dist/`. `main` tracks it, so a branch cut from `main` tracks it too, and `pnpm build` or `pnpm test` changes it there: run `git restore dist/` before you commit. A check fails a pull request that adds or changes files in `dist/`. After each merge to `main`, the `dist` workflow builds and tests `dist/`, and commits it to `main` as a bot commit marked `[auto]`.
- **Keep the runtime free of dependencies.** The two scripts use only Node.js built-ins. A status line that fails to load leaves the footer blank.
- **Keep Node.js 18.** Use no API that Node.js 18 does not have. The `@types/node` version in `package.json` makes `pnpm typecheck` catch most of these.
- **Ignore what is unknown.** An unknown switch or part name is ignored, so that a typo never breaks a user's status line or turn. New parsing in the two lines keeps that rule. The `claude-gauge` command is the exception: it writes the user's settings, so it refuses an unknown command or switch.
- **Keep switches the only configuration.** Each line reads its switches from the `command` in the user's settings. There is no configuration file.
- **Keep tests out of the real config folder.** A test that renders the status line sets `CLAUDE_CONFIG_DIR` to a temporary folder, because a terminal render saves usage into the config folder.
- **Update the docs with the code.** A new or changed part or switch updates the tables in `docs/reference.md`. Each status line part goes in `PART_REGISTRY`, each switch in `SWITCHES` and each theme in `THEME_REGISTRY` in `src/statusline.ts`, and the README sync suite fails until the reference's tables name the same parts, switches and themes. A change to the default rows also updates the README's default parts table. A switch of the `claude-gauge` command goes in its `USAGE` text in `src/cli.ts`, and the same suite fails until the switch table under "From npm" in `docs/reference.md` names the same switches. A new or changed theme also changes its golden snapshot: rewrite the snapshots with `pnpm build && UPDATE_SNAPSHOTS=1 node --test test/themes.test.js`, and check the diff before you commit it. If it changes an example in the README or the reference, update the parity suite too. If it changes how Claude installs claude-gauge, update `INSTALL-WITH-CLAUDE.md`.
- **Test new behaviour.** Add a test to the suite for the line you change.

## Branches

While 1.0 is in progress, branch from `integration/1.0` and open the pull request against `integration/1.0`. That branch collects the 1.0 work, and it merges into `main` when 1.0 is ready.

`main` is what users run. Installs clone `main` and update with `git pull`, so a merge into `main` reaches those users on their next pull, whether or not a release follows. npm users get a change when a release publishes it.

Name a branch after the type of change and its topic, for example `feat/instruct-hook` or `docs/contributor-docs-24`.

## Commits

Commit subjects follow [Conventional Commits](https://www.conventionalcommits.org): `type: summary`, or `type(scope): summary`. The types in use are `feat`, `fix`, `docs`, `refactor` and `chore`. Use `test` for a change to the tests only. A scope is optional.

Write the summary in the imperative and in lower case, with no full stop at the end. Name the effect a user sees, not the code you changed:

```text
feat: show the status line where Claude Code runs none, with --latest
fix: quote forwarded switches in the --instruct command
```

Put one change in each commit. Close an issue with `Closes #123` in the footer of the commit, or in the pull request body. For two issues, write `Closes #1, closes #2`, because GitHub reads `Closes #1, #2` as a close of #1 only.

These subjects matter after the merge. Pull requests merge with a merge commit, so each commit lands in the history of `main`, and [VerBump](https://github.com/jv-k/VerBump) reads them to suggest the next version and to write the changelog.

## Pull requests

Keep each pull request to one concern. The [pull request template](.github/pull_request_template.md) holds the checklist. Lead the body with what changed and why, and link the issue.

The maintainer, `@jv-k`, is the code owner of every file, so GitHub requests a review from the maintainer on each pull request.

## Report a bug or ask for a feature

Use the [issue forms](https://github.com/jv-k/claude-gauge/issues/new/choose). For a bug, the command from your settings and the host you run Claude Code in (the terminal CLI, the VS Code extension or the desktop app) are the two answers that help most.

## Releases

The maintainer cuts releases. [RELEASING.md](RELEASING.md) gives the steps.
