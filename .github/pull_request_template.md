<!-- Keep this short. CONTRIBUTING.md has the rules. -->

## What changed and why

<!-- Lead with the change and the problem it solves. Link the issue with "Closes #123". -->

## Checklist

- [ ] The base branch is the one CONTRIBUTING.md names: `integration/1.0` while 1.0 is in progress.
- [ ] Commit subjects follow Conventional Commits, and each one names the effect a user sees.
- [ ] `pnpm typecheck` and `pnpm test` pass.
- [ ] A change to `src/` has a rebuilt `dist/` (`pnpm build`) in the same commit.
- [ ] New behaviour has a test.
- [ ] A new or changed part or switch updates the tables in `README.md`, and `INSTALL-WITH-CLAUDE.md` where it applies.
- [ ] The runtime still has no dependencies.

## Notes for the reviewer

<!-- Anything to look at closely, or anything you are unsure about. Delete this section if there is nothing. -->
