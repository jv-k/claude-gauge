# Releasing claude-gauge

A release puts a version on `main`. It sets the version in `package.json`, adds a section to `CHANGELOG.md` (the first release creates the file), tags the commit `vX.Y.Z`, and publishes a GitHub release for the tag. [VerBump](https://github.com/jv-k/VerBump) does all four in one run.

The package is private, so a release publishes nothing to npm. Installs clone `main` and update with `git pull`, so users get a change when it merges into `main`, not when a release is cut.

## Before you start

- Install VerBump. It is not a dev dependency of this repo. Use one of these:

  ```sh
  brew install jv-k/tap/verbump
  pnpm add -g @jv-k/verbump
  curl -fsSL https://raw.githubusercontent.com/jv-k/VerBump/main/install.sh | bash
  ```

  VerBump needs git and jq.
- Sign in to the `gh` CLI with an account that can push to jv-k/claude-gauge. VerBump uses `gh` to publish the GitHub release.
- Release from `main`. While 1.0 is in progress, the work is on `integration/1.0`, so merge that branch into `main` first.
- Pull `main`, and make sure the working tree is clean.
- Run `pnpm install`, then `pnpm build`, then `git status`. The build must leave `dist/` unchanged. The `dist` workflow commits the build to `main` after each merge, so a change in `dist/` means that its run for the last merge has not finished or has failed. Wait for the run, or fix it and run it again, then pull `main`.

## Cut a release

Preview the release first. A dry run prints every step and changes nothing:

```sh
pnpm bump-release --dry-run
```

Then cut it:

```sh
pnpm bump-release
```

`pnpm bump-release` runs `verbump --release --push origin`. The run goes through these steps:

1. VerBump checks that the tree is clean and that `main` is not behind `origin`.
2. It runs `pnpm test`, the `PRE_BUMP_CMD` in `.verbumprc`. The tests build `dist/` and run every suite. If a test fails, the release stops before VerBump changes a file.
3. It reads the Conventional Commits since the last tag and suggests the next version. You confirm it or enter another one.
4. It writes the version to `package.json`, adds the new section to `CHANGELOG.md`, commits, and tags `vX.Y.Z`.
5. It pushes the commit and the tag to `origin`, and publishes the GitHub release with `gh`.

To set the version yourself, add `-v` to `pnpm bump-release`. For the first release, which goes from `0.0.0` to `1.0.0`:

```sh
pnpm bump-release --dry-run -v 1.0.0
pnpm bump-release -v 1.0.0
```

`--major`, `--minor` and `--patch` force one bump level instead.

## If a step fails

Before step 5, nothing is public.

- If the tests fail in step 2, fix the cause on a branch, merge it, and start again.
- If a later step fails before the push, `verbump --undo X.Y.Z` deletes the local tag. The bump commit stays. While it is not pushed, `git reset --hard HEAD~1` removes it. Then start again.
- If the push succeeds but the GitHub release fails, publish the release for the tag by hand with `gh release create vX.Y.Z`.

`--no-hooks` skips the test gate for one run. Use it only when the gate itself is broken.
