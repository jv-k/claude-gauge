Derives from epic #123, "Epic: ship the post-1.0 backlog", and the agent brief on each of its sub-issues.

# Close-out plan for epic #123

This plan takes the sixteen sub-issues of #123 from `ready-for-agent` to a release on `main`. Run every command from the root of the repository. The ship-loop and ship-it skills are installed at `~/.agents/skills/`.

The sub-issues, in order: #105, #77, #122, #112, #116, #52, #45, #62, #59, #60, #51, #118, #119, #41, #103, #99. These pairs wait for each other through GitHub issue dependencies: #122 → #112 → #116, #59 → #60 and #51, #118 → #119, #103 → #99.

- [x] **1. Triage and set up the epic**
  - Touches: the GitHub issues, the project board, `integration/123-backlog`, PR #124.
  - Done when: each sub-issue has an agent brief, the `ready-for-agent` label and a card in "Ready for Agent". The integration branch is on origin, a ruleset blocks its deletion, and the draft PR #124 goes into `main`.

- [ ] **2. Preflight**
  - Touches: nothing. The dry run spends nothing.
  - Commands:

    ```sh
    git switch main && git pull --ff-only
    command -v vhs                      # #99 needs VHS on the PATH
    bash ~/.agents/skills/ship-loop/ship-loop.sh --dry-run \
      --epic 123 --base integration/123-backlog --max 16 --sweeps 4
    ```

  - Done when: the preflight prints no stop line. It lists the sixteen sub-issues, with no worktree already in flight under `.claude/worktrees/`. If it warns about `gh` permissions, add `Bash(gh issue *)`, `Bash(gh project *)`, `Bash(gh pr *)`, `Bash(gh run *)`, `Bash(gh repo *)`, `Bash(gh api *)` and `Bash(gh label *)` to `permissions.allow` in `~/.claude/settings.json`, then run the dry run again.

- [ ] **3. Run the shift**
  - Touches: one branch, worktree and pull request per sub-issue. Each pull request merges into `integration/123-backlog`.
  - Command, in a plain terminal:

    ```sh
    bash ~/.agents/skills/ship-loop/ship-loop.sh \
      --epic 123 --base integration/123-backlog --max 16 --sweeps 4 --budget 20
    ```

    Four sweeps cover the longest chain of waits (#122 → #112 → #116), with one sweep to spare.
  - Done when: the script exits, and its last line names a `summary.json`. Exit 0 means that it stopped by design, 1 that it stopped on failures, and 2 that it stopped on a rate limit.

- [ ] **4. Watch the shift**
  - Touches: nothing.
  - Commands:

    ```sh
    bash ~/.agents/skills/ship-it/ship-it-status.sh --inspect
    gh pr list --base integration/123-backlog --state all \
      --json number,title,state --jq '.[] | "#\(.number) \(.state) \(.title)"'
    gh api repos/jv-k/claude-gauge/issues/123/sub_issues \
      --jq '.[] | "#\(.number) \(.state) \(.title)"'
    ```

  - Done when: every sub-issue is closed, or has a parked or failed pass that step 5 handles.

- [ ] **5. Handle parks, failures and rate limits**
  - Touches: the worktrees and pull requests of the passes that did not ship.
  - Commands:

    ```sh
    jq '{stop, stop_reason, exit, review_ready, issues: (.issues | map_values({outcome, pr, stage}))}' \
      <summary.json from step 3>
    # Continue the worktrees that a stopped shift owns, in a new shift:
    bash ~/.agents/skills/ship-loop/ship-loop.sh \
      --epic 123 --base integration/123-backlog --max 16 --sweeps 4 --adopt <shift id>
    ```

    The shift id is the shift's folder name under `.claude/ship-loop/`. To resume one issue by hand, run `/ship-it` in a Claude Code session and name the issue. When a pass parks on a decision, answer it on the issue as a triage comment, then resume.
  - Done when: every sub-issue is closed, and each one's pull request has merged into `integration/123-backlog`.

- [ ] **6. Check the integration branch by hand**
  - Touches: nothing. Each command uses a temporary config folder, so your own settings do not change.
  - Commands:

    ```sh
    git switch integration/123-backlog && git pull --ff-only
    pnpm install && pnpm test && git restore dist/
    pnpm build
    CLAUDE_CONFIG_DIR="$(mktemp -d)" node dist/cli.js setup      # #103: arrow keys, checkbox list, live preview
    echo | CLAUDE_CONFIG_DIR="$(mktemp -d)" node dist/cli.js setup  # #103: piped input still uses the readline wizard
    node dist/cli.js --help                                     # #118: pill header in colour
    NO_COLOR=1 node dist/cli.js --help                          # #118: the same output as before
    CLAUDE_CONFIG_DIR="$(mktemp -d)" node dist/cli.js update     # #119: the folder prints in green
    open docs/media/demo.gif                                    # #99: wordmark first, then the Ink wizard
    ls docs/adr/                                                # ADRs from #59, #60, #51, #41 and #103
    claude --settings '{"statusLine":{"type":"command","command":"node '"$PWD"'/dist/statusline.js --right model,effort"}}'
                                                                # #45: the right end shows, with no "…"
    git restore dist/
    ```

  - Done when: each check shows what its comment says. File an issue for each check that fails, and fix it before step 7.

- [ ] **7. Merge the epic into `main`**
  - Touches: `PLAN.md` (removed), PR #124, `main`.
  - Commands:

    ```sh
    git rm PLAN.md && git commit -m "docs: remove the close-out plan for #123" && git push
    gh pr edit 124 --body-file <body that lists each sub-issue's pull request>
    gh pr ready 124
    gh pr checks 124 --watch
    gh pr merge 124 --merge
    ```

    Write the body in the form of #121: one line per merged pull request, then an "After the merge" section.
  - Done when: PR #124 is merged with a merge commit, and the `test` workflow passed on its head.

- [ ] **8. Wait for the `dist` build on `main`**
  - Touches: `dist/` on `main`, through the `dist` workflow.
  - Commands:

    ```sh
    gh run list --workflow dist.yml --branch main --limit 1
    gh run watch <run id>
    git switch main && git pull --ff-only
    pnpm install && pnpm build && git status --short    # must print nothing
    ```

  - Done when: the `dist` run passed, and a local build leaves `dist/` unchanged.

- [ ] **9. Close the epic and tidy up**
  - Touches: #123, its board card, local branches and worktrees.
  - Commands:

    ```sh
    gh issue close 123 --comment "All sixteen sub-issues are closed, and #124 merged integration/123-backlog into main."
    project=$(gh project view 21 --owner jv-k --format json --jq .id)
    item=$(gh project item-list 21 --owner jv-k --limit 300 --format json \
      --jq '.items[] | select(.content.number==123) | .id')
    gh project field-list 21 --owner jv-k --format json \
      --jq '.fields[] | select(.name=="Status") | "field \(.id)", (.options[] | "\(.name) \(.id)")'
    gh project item-edit --project-id "$project" --id "$item" \
      --field-id <Status field id> --single-select-option-id <Done option id>
    git worktree list
    bash ~/.agents/skills/ship-it/ship-it-status.sh
    git branch -d integration/123-backlog
    ```

    The ruleset keeps `integration/123-backlog` on origin. That is intended. Remove only the worktrees under `.claude/worktrees/` that the status script shows as shipped.
  - Done when: #123 is closed, its card is in "Done", and `git worktree list` shows only the main checkout.

- [ ] **10. Cut the release**
  - Touches: `package.json`, `CHANGELOG.md`, a `vX.Y.Z` tag, the GitHub release and npm.
  - Commands:

    ```sh
    pnpm bump-release --dry-run      # read the suggested version and the changelog section
    pnpm bump-release                # or -v X.Y.Z to set it yourself
    gh run watch "$(gh run list --workflow release.yml --limit 1 --json databaseId --jq '.[0].databaseId')"
    npm view @jv-k/claude-gauge dist-tags
    ```

    The epic adds `feat` commits, so VerBump suggests a minor version. To test the pre-release path from #41 first, run `pnpm bump-release --dry-run -v X.Y.Z-rc.1` and check that VerBump accepts the version. Then cut it, and check that `npm view @jv-k/claude-gauge dist-tags` shows it under `next` and leaves `latest` as it was.
  - Done when: the `release` workflow passed, the GitHub release exists, and `latest` on npm is the new version.
