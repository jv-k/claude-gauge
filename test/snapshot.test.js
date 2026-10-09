'use strict';

// Golden snapshots: each file in test/snapshots holds cases separated by a
// blank line. A case's first line is the switches, split on spaces, and the
// lines after it are the rows the status line prints for the payload below,
// colours stripped.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { render, parseArgs } = require('../dist/statusline.js');

const plain = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

// The model part names the API provider from the environment, so the suite
// runs without the caller's provider variables.
for (const name of Object.keys(process.env)) {
  if (/^CLAUDE_CODE_USE_|^ANTHROPIC_BASE_URL$/.test(name)) delete process.env[name];
}

// A fixed local noon, as in the status line suite.
const NOW = new Date(2026, 9, 7, 12, 0, 0).getTime();
const at = (ms) => Math.floor(ms / 1000);
const HOUR = 3600 * 1000;

// A payload with something for every labelled part.
const payload = {
  model: { display_name: 'Opus' },
  workspace: {
    current_dir: '/home/me/project',
    repo: { host: 'github.com', owner: 'jv-k', name: 'claude-gauge' },
    git_worktree: 'my-feature',
  },
  context_window: { context_window_size: 200000, used_percentage: 43 },
  cost: { total_duration_ms: 72 * 60_000, total_cost_usd: 1.234, total_lines_added: 156, total_lines_removed: 23 },
  effort: { level: 'high' },
  output_style: { name: 'explanatory' },
  agent: { name: 'reviewer' },
  prompt_cache: { warm: true, hit_ratio: 0.91 },
  rate_limits: {
    five_hour: { used_percentage: 9.4, resets_at: at(NOW + 2 * HOUR) },
    seven_day: { used_percentage: 41.2, resets_at: at(NOW + 72 * HOUR) },
    spend_limit: { used_percentage: 62.8 },
  },
};

const dir = path.join(__dirname, 'snapshots');
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.txt'));

test('there are golden snapshots to check', () => {
  assert.ok(files.includes('compact.txt'));
});

for (const file of files) {
  test(`the status line prints the golden snapshots in ${file}`, () => {
    const cases = fs.readFileSync(path.join(dir, file), 'utf8').trimEnd().split(/\n\n+/);
    assert.ok(cases.length > 0, file);
    for (const block of cases) {
      const [args, ...rows] = block.split('\n');
      const out = render(payload, { nowMs: NOW, branchOf: () => 'main', config: parseArgs(args.split(' ')) });
      assert.equal(plain(out), rows.join('\n'), args);
    }
  });
}
