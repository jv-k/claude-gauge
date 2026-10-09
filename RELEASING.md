# Releasing claude-gauge

A release puts a version on `main` and publishes it. Two tools share the work:

- On your machine, [VerBump](https://github.com/jv-k/VerBump) sets the version in `package.json`, adds a section to `CHANGELOG.md` (the first release creates the file), commits, tags the commit `vX.Y.Z`, and pushes the commit and the tag.
- On GitHub, the `release` workflow (`.github/workflows/release.yml`) starts when the tag arrives. It tests the tagged commit, creates the GitHub release with the tag's `CHANGELOG.md` section as its body, and publishes the package to npm with provenance.

Installs that clone `main` update with `git pull`, so those users get a change when it merges into `main`, not when a release is cut. npm users get it from the release.

## Set up once

The owner of jv-k/claude-gauge does this before the first release.

1. On [npmjs.com](https://www.npmjs.com), create an access token that can publish `claude-gauge`: a granular token with read and write access to the package, or an automation token. Set its expiry date in your calendar.
2. In the repository, go to **Settings**, then **Secrets and variables**, then **Actions**. Add a repository secret named `NPM_TOKEN` with the token as its value.

The workflow gives the token to `npm publish` and to nothing else. When the token expires, make a new one and replace the secret. The workflow's own `GITHUB_TOKEN` creates the GitHub release, so that step needs no secret.

## Before you start

- Install VerBump. It is not a dev dependency of this repo. Use one of these:

  ```sh
  brew install jv-k/tap/verbump
  pnpm add -g @jv-k/verbump
  curl -fsSL https://raw.githubusercontent.com/jv-k/VerBump/main/install.sh | bash
  ```

  VerBump needs git and jq.
- Make sure that you can push to jv-k/claude-gauge, because VerBump pushes the commit and the tag.
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

`pnpm bump-release` runs `verbump --push origin`. The run goes through these steps:

1. VerBump checks that the tree is clean and that `main` is not behind `origin`.
2. It runs `pnpm test`, the `PRE_BUMP_CMD` in `.verbumprc`. The tests build `dist/` and run every suite. If a test fails, the release stops before VerBump changes a file.
3. It reads the Conventional Commits since the last tag and suggests the next version. You confirm it or enter another one.
4. It writes the version to `package.json`, adds the new section to `CHANGELOG.md`, commits, and tags `vX.Y.Z`. It pauses so that you can edit the new section before the commit. The section becomes the release notes.
5. It pushes the commit and the tag to `origin`.

VerBump does not create the GitHub release. The tag starts the `release` workflow, which goes through these steps:

6. It checks that the tag is `v` followed by the version in `package.json`.
7. It runs `pnpm test` on the tagged commit, with a fresh build of `dist/`.
8. It takes the section for the version from `CHANGELOG.md`. The section starts at the `## X.Y.Z` heading and stops at the next `##` heading. If the section is missing or empty, the workflow fails here.
9. It creates the GitHub release `vX.Y.Z` with the section as its body. If the release already exists, it leaves the release as it is.
10. It runs `npm publish --provenance`. npm publishes `dist/`, `README.md`, `LICENSE` and `package.json`, and links the package to the workflow run that built it.

Watch the run in the **Actions** tab, or with `gh run watch`. When it passes, the release is on the [releases page](https://github.com/jv-k/claude-gauge/releases) and on [npm](https://www.npmjs.com/package/claude-gauge).

To set the version yourself, add `-v` to `pnpm bump-release`. For the first release, which goes from `0.0.0` to `1.0.0`:

```sh
pnpm bump-release --dry-run -v 1.0.0
pnpm bump-release -v 1.0.0
```

`--major`, `--minor` and `--patch` force one bump level instead.

The workflow starts only for a tag in the form `vX.Y.Z`. It does not start for a pre-release tag such as `v1.0.0-rc.1`.

## If a step fails

Before step 5, nothing is public.

- If the tests fail in step 2, fix the cause on a branch, merge it, and start again.
- If a later step fails before the push, `verbump --undo X.Y.Z` deletes the local tag. The bump commit stays. While it is not pushed, `git reset --hard HEAD~1` removes it. Then start again.

After step 5, the tag is public, so do not move it or tag the version again. Read the failed step in the run's log.

- If the tests fail in step 7, or the version check fails in step 6, nothing is published. Fix the cause on a branch, merge it, and release the next patch version.
- If the section is missing or empty in step 8, nothing is published. A rerun reads the same tagged `CHANGELOG.md`, so it fails again. Release the next patch version, and check its section when VerBump pauses in step 4.
- If `npm publish` fails in step 10, the GitHub release exists already. The usual causes are a missing or expired `NPM_TOKEN`. Fix the secret, then rerun the failed job from the run's page, or with `gh run rerun <run-id> --failed`. Step 9 leaves the release as it is, and step 10 publishes.

`--no-hooks` skips the test gate in step 2 for one run. Use it only when the gate itself is broken. The workflow still runs the tests in step 7.
