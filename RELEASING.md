# Releasing claude-gauge

A release puts a version on `main` and publishes it. Two tools share the work:

- On your machine, [VerBump](https://github.com/jv-k/VerBump) sets the version in `package.json`, adds a section to `CHANGELOG.md` (the first release creates the file), commits, tags the commit `vX.Y.Z`, and pushes the commit and the tag.
- On GitHub, the `release` workflow (`.github/workflows/release.yml`) starts when the tag arrives. It tests the tagged commit, creates the GitHub release with the tag's `CHANGELOG.md` section as its body, and publishes the package to npm with provenance.

Installs that clone `main` update with `git pull`, so those users get a change when it merges into `main`, not when a release is cut. npm users get it from the release.

## Set up once

The package is `@jv-k/claude-gauge`, under the owner's npm scope. npm refuses to publish the unscoped name `claude-gauge` with `403 Forbidden`, although no package has that name, and only npm support can say why. The scope changes only the npm name: the commands, the plugin, the repository and `~/.claude/claude-gauge/` keep the name `claude-gauge`.

The workflow publishes to npm through a [trusted publisher](https://docs.npmjs.com/trusted-publishers). On npmjs.com, the package `@jv-k/claude-gauge` names the `release` workflow of jv-k/claude-gauge as its trusted publisher. For each run, npm then takes the workflow's OIDC (OpenID Connect) token from GitHub in place of an npm token. So the project stores no npm token, and the repository has no `NPM_TOKEN` secret. The workflow's own `GITHUB_TOKEN` creates the GitHub release, so that step needs no secret either.

npm adds a trusted publisher only to a package that already exists, and a new trusted publisher expires if it does not publish within 2 days. So the owner of jv-k/claude-gauge does these steps in this order for the first release:

1. From your terminal, publish a placeholder version, `@jv-k/claude-gauge@0.0.1`, so that the package exists on npm. Commit and push nothing for it: `package.json` on `main` stays at `0.0.0` until VerBump sets `1.0.0`. The owner published this placeholder on 2026-10-10, so this step is done.
2. Just before you cut 1.0.0, open the **Settings** page of `@jv-k/claude-gauge` on [npmjs.com](https://www.npmjs.com/package/@jv-k/claude-gauge), and add a trusted publisher for GitHub Actions with these four fields. All of them are case-sensitive and must be exact. npm does not check them when you save, so a mistake shows only when the workflow publishes.

   | Field | Value |
   | --- | --- |
   | Organization or user | `jv-k` |
   | Repository | `claude-gauge` |
   | Workflow filename | `release.yml` |
   | Environment name | Leave it empty. |

3. Under the allowed actions, tick **npm publish**. The workflow runs a direct `npm publish`, and a trusted publisher added after 3 September 2026 allows only `npm stage publish` until you tick it.
4. Cut 1.0.0 (see [Cut a release](#cut-a-release)) within 2 days. If the first publish does not succeed within 2 days, the trusted publisher expires. Then delete it, add it again, and publish within 2 days.
5. When 1.0.0 is on npm, deprecate the placeholder:

   ```sh
   npm deprecate @jv-k/claude-gauge@0.0.1 "A placeholder. Install @jv-k/claude-gauge 1.0.0 or later."
   ```

After the first release, the trusted publisher stays in place, and later releases need no setup.

## Before you start

- Install VerBump. It is not a dev dependency of this repo. Use one of these:

  ```sh
  brew install jv-k/tap/verbump
  pnpm add -g @jv-k/verbump
  curl -fsSL https://raw.githubusercontent.com/jv-k/VerBump/main/install.sh | bash
  ```

  VerBump needs git and jq.
- Make sure that you can push to jv-k/claude-gauge, because VerBump pushes the commit and the tag.
- Release from `main`. When the work for the release is on an integration branch, merge that branch into `main` first.
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
4. It writes the version to `package.json`, adds the new section to `CHANGELOG.md`, commits, and tags `vX.Y.Z`. The section becomes the release notes. The dry run shows the section first. To edit it before the commit, add `-l` (`--pause-changelog`) to `pnpm bump-release`, and VerBump waits while you edit.
5. It pushes the commit and the tag to `origin`.

VerBump does not create the GitHub release. The tag starts the `release` workflow, which goes through these steps:

6. It checks that npm is 11.5.1 or later, which trusted publishing needs, and that the tag is `v` followed by the version in `package.json`.
7. It runs `pnpm test` on the tagged commit, with a fresh build of `dist/`.
8. It takes the section for the version from `CHANGELOG.md`. The section starts at the `## X.Y.Z` heading and stops at the next `##` heading. If the section is missing or empty, the workflow fails here.
9. It creates the GitHub release `vX.Y.Z` with the section as its body. If the release already exists, it leaves the release as it is.
10. It runs `npm publish --provenance`. npm accepts the publish through the trusted publisher, publishes `dist/`, `README.md`, `LICENSE` and `package.json`, and links the package to the workflow run that built it.

Watch the run in the **Actions** tab, or with `gh run watch`. When it passes, the release is on the [releases page](https://github.com/jv-k/claude-gauge/releases) and on [npm](https://www.npmjs.com/package/@jv-k/claude-gauge).

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

- If the tests fail in step 7, or a check fails in step 6, nothing is published. Fix the cause on a branch, merge it, and release the next patch version. If the npm check fails, the Node version in `.github/workflows/release.yml` bundles an npm older than 11.5.1, so raise the Node version there.
- If the section is missing or empty in step 8, nothing is published. A rerun reads the same tagged `CHANGELOG.md`, so it fails again. Release the next patch version, and check its section in the dry run first.
- If `npm publish` fails in step 10, the GitHub release exists already. The usual causes are in the trusted publisher on npmjs.com:
  - A field does not match the repository or the workflow exactly. npm then cannot sign in, and fails with `ENEEDAUTH` ("Unable to authenticate"), `E401` or `E404`. Check the four fields in [Set up once](#set-up-once), and check that `repository.url` in `package.json` names jv-k/claude-gauge.
  - The trusted publisher expired, because its first publish did not succeed within 2 days. Delete it and add it again.
  - **npm publish** is not ticked under the allowed actions.

  The job also needs npm 11.5.1 or later, the `id-token: write` permission and a GitHub-hosted runner. Step 6 checks npm, and the workflow sets the other two. Fix the cause, then rerun the failed job from the run's page, or with `gh run rerun <run-id> --failed`. Step 9 leaves the release as it is, and step 10 publishes.

`--no-hooks` skips the test gate in step 2 for one run. Use it only when the gate itself is broken. The workflow still runs the tests in step 7.
