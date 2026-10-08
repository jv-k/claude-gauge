<!-- Keep this short. CONTRIBUTING.md has the rules. -->

## What changed and why

<!-- Lead with the change and the problem it solves. Link the issue with "Closes #123". -->

## Checklist

- [ ] The base branch is the one that CONTRIBUTING.md names.
- [ ] Commit subjects follow Conventional Commits, and each one names the effect a user sees.
- [ ] `pnpm typecheck` and `pnpm test` pass.
- [ ] The pull request adds or changes no files in `dist/`. The `dist` workflow builds it on `main`.
- [ ] New behaviour has a test.
- [ ] A new or changed part or switch updates the tables in `README.md`, and `INSTALL-WITH-CLAUDE.md` where it applies.
- [ ] The runtime still has no dependencies.

For a feature, also tick this item:

- [ ] The pull request links the issue that it implements, and the acceptance criteria of that issue have tests.

For a fix, also tick this item:

- [ ] A test fails without the fix and passes with it.

Delete the blocks that do not apply.

## Notes for the reviewer

<!-- Anything to look at closely, or anything you are unsure about. Delete this section if there is nothing. -->
