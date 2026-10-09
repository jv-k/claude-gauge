'use strict';

// Golden snapshots: the default two rows in every --theme preset, colour
// codes and all, so a change to a theme's colours shows in review as a
// changed file. Each file in test/snapshots/themes/ is one theme, with ESC
// written as \e and BEL as \a so that the codes read as text.
//
// After a deliberate change, rewrite the files and review the diff:
//
//   pnpm build && UPDATE_SNAPSHOTS=1 node --test test/themes.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { render, parseArgs, THEMES } = require('../dist/statusline.js');

const dir = path.join(__dirname, 'snapshots', 'themes');
// Never in CI, where a rewrite would pass whatever the build prints.
const update = Boolean(process.env.UPDATE_SNAPSHOTS) && !process.env.CI;

// A fixed local noon, as in the status line suite, and a payload that fills
// every part of the default rows, with the pace marker past its early window.
const NOW = new Date(2026, 9, 7, 12, 0, 0).getTime();
const at = (ms) => Math.floor(ms / 1000);
const HOUR = 3600 * 1000;
const payload = {
  model: { display_name: 'Opus 5.5' },
  workspace: { current_dir: '/home/me/project', repo: { host: 'github.com', owner: 'jv-k', name: 'claude-gauge' } },
  context_window: { context_window_size: 200000, used_percentage: 43 },
  cost: { total_duration_ms: 72 * 60_000 },
  effort: { level: 'high' },
  rate_limits: {
    five_hour: { used_percentage: 9.4, resets_at: at(NOW + 2 * HOUR) },
    seven_day: { used_percentage: 41.2, resets_at: at(NOW + 3 * 24 * HOUR) },
  },
};

// On the host "host", so the repo's link to the folder is the same on every
// machine. Windows resolves /home/me/project onto the current drive, so the
// drive letter comes out of the link there.
const snapshot = (theme) =>
  render(payload, { nowMs: NOW, statusOf: () => '# branch.head main\n', hostname: 'host', config: parseArgs(['--theme', theme]) })
    .replace(/file:\/\/host\/[A-Za-z]:\//g, 'file://host/')
    .replaceAll('\x1b', '\\e')
    .replaceAll('\x07', '\\a') + '\n';

const file = (theme) => path.join(dir, `${theme}.txt`);

if (update) {
  fs.mkdirSync(dir, { recursive: true });
  for (const f of fs.readdirSync(dir)) fs.rmSync(path.join(dir, f));
  for (const theme of THEMES) fs.writeFileSync(file(theme), snapshot(theme));
}

test('every theme has a snapshot, and every snapshot a theme', () => {
  assert.deepEqual(fs.readdirSync(dir).sort(), THEMES.map((t) => `${t}.txt`).sort());
});

for (const theme of THEMES) {
  test(`the default rows in the ${theme} theme match their snapshot`, () => {
    assert.equal(snapshot(theme), fs.readFileSync(file(theme), 'utf8'));
  });
}
