'use strict';

// plan() turns the settings Claude Code reads, and the user's choices, into
// the next settings and the status line to save for uninstall. It is pure:
// JSON in, JSON out, so these tests need no files.

const test = require('node:test');
const assert = require('node:assert/strict');
const { plan } = require('../dist/settings.js');

const SL = 'node /home/u/.claude/claude-gauge/runtime/statusline.js';
const SL2 = 'node /home/u/.claude/claude-gauge/runtime/statusline.js --segments 10';
const TL = 'node /home/u/.claude/claude-gauge/runtime/tokenline.js';
const TL2 = 'node /home/u/.claude/claude-gauge/runtime/tokenline.js --window 1m';

const cmd = (command) => ({ type: 'command', command });
const entry = (...commands) => ({ hooks: commands.map(cmd) });

const CLAUDE_HUD =
  "bash -c 'plugin_dir=$(ls -td \"${CLAUDE_CONFIG_DIR:-$HOME/.claude}\"/plugins/cache/claude-hud/claude-hud/*/ 2>/dev/null | head -1); exec node \"${plugin_dir}dist/index.js\"'";

test('fresh install: adds the status line and the Stop hook, and saves that there was no status line', () => {
  const p = plan({}, { statusLine: SL, tokenLine: TL });
  assert.deepEqual(p.settings, { statusLine: cmd(SL), hooks: { Stop: [entry(TL)] } });
  assert.deepEqual(p.backup, { statusLine: null });
  assert.equal(p.found, 'none');
  assert.equal(p.blocked, false);
  assert.equal(p.changed, true);
});

test('fresh install of one bar leaves the other out', () => {
  assert.deepEqual(plan({}, { statusLine: SL }).settings, { statusLine: cmd(SL) });
  const tokenOnly = plan({}, { tokenLine: TL });
  assert.deepEqual(tokenOnly.settings, { hooks: { Stop: [entry(TL)] } });
  assert.equal(tokenOnly.backup, undefined);
});

test('existing status line: left alone without consent, and saved for uninstall when replaced', () => {
  const mine = { type: 'command', command: '~/bin/my-status.sh', refreshInterval: 5, padding: 0 };
  const current = { model: 'opus', statusLine: mine };

  const asked = plan(current, { statusLine: SL, tokenLine: TL });
  assert.equal(asked.found, 'other');
  assert.equal(asked.blocked, true);
  assert.equal(asked.changed, false);
  assert.deepEqual(asked.settings, current);
  assert.equal(asked.backup, undefined);

  const replaced = plan(current, { statusLine: SL, tokenLine: TL, replace: true });
  assert.equal(replaced.blocked, false);
  assert.deepEqual(replaced.settings, {
    model: 'opus',
    statusLine: { type: 'command', command: SL, refreshInterval: 5, padding: 0 },
    hooks: { Stop: [entry(TL)] },
  });
  assert.deepEqual(replaced.backup, { statusLine: mine });
});

test("claude-hud's status line is recognised, and offered for replacement like any other", () => {
  const current = { statusLine: cmd(CLAUDE_HUD) };
  const asked = plan(current, { statusLine: SL });
  assert.equal(asked.found, 'claude-hud');
  assert.equal(asked.blocked, true);
  const replaced = plan(current, { statusLine: SL, replace: true });
  assert.equal(replaced.found, 'claude-hud');
  assert.deepEqual(replaced.settings.statusLine, cmd(SL));
  assert.deepEqual(replaced.backup, { statusLine: cmd(CLAUDE_HUD) });
});

test('a token line alone installs beside a status line that is not ours, without consent', () => {
  const current = { statusLine: cmd(CLAUDE_HUD) };
  const p = plan(current, { tokenLine: TL });
  assert.equal(p.blocked, false);
  assert.deepEqual(p.settings, { statusLine: cmd(CLAUDE_HUD), hooks: { Stop: [entry(TL)] } });
});

test("other hooks are kept, and claude-gauge's entry goes after them", () => {
  const current = {
    hooks: {
      Stop: [entry('afplay /System/Library/Sounds/Glass.aiff')],
      PreToolUse: [{ matcher: 'Bash', hooks: [cmd('~/bin/guard.sh')] }],
    },
  };
  const p = plan(current, { tokenLine: TL });
  assert.deepEqual(p.settings.hooks, {
    Stop: [entry('afplay /System/Library/Sounds/Glass.aiff'), entry(TL)],
    PreToolUse: [{ matcher: 'Bash', hooks: [cmd('~/bin/guard.sh')] }],
  });
});

test("re-run: updates claude-gauge's entries in place, keeps refreshInterval, and saves no new backup", () => {
  const current = {
    statusLine: { type: 'command', command: 'node ~/.claude/claude-gauge/dist/statusline.js', refreshInterval: 60 },
    hooks: {
      Stop: [entry('node ~/.claude/claude-gauge/tokenline.js'), entry('afplay done.aiff')],
      SessionStart: [entry('node ~/.claude/claude-gauge/dist/tokenline.js --instruct')],
    },
  };
  const p = plan(current, { statusLine: SL2, tokenLine: TL2 });
  assert.equal(p.found, 'claude-gauge');
  assert.equal(p.backup, undefined);
  assert.deepEqual(p.settings, {
    statusLine: { type: 'command', command: SL2, refreshInterval: 60 },
    hooks: {
      Stop: [entry(TL2), entry('afplay done.aiff')],
      SessionStart: [entry('node ~/.claude/claude-gauge/dist/tokenline.js --instruct')],
    },
  });

  const again = plan(p.settings, { statusLine: SL2, tokenLine: TL2 });
  assert.deepEqual(again.settings, p.settings);
  assert.equal(again.changed, false);
  assert.equal(again.backup, undefined);
});

test('re-run collapses duplicate token line hooks into one', () => {
  const current = { hooks: { Stop: [entry(TL), entry('afplay done.aiff', TL)] } };
  assert.deepEqual(plan(current, { tokenLine: TL2 }).settings.hooks, {
    Stop: [entry(TL2), entry('afplay done.aiff')],
  });
});

test('Windows paths are recognised as claude-gauge too', () => {
  const current = { statusLine: cmd('node C:\\Users\\u\\.claude\\claude-gauge\\runtime\\statusline.js') };
  assert.equal(plan(current, { statusLine: SL }).found, 'claude-gauge');
});

test('removing one bar: null takes out only that bar', () => {
  const installed = plan({ hooks: { Stop: [entry('afplay done.aiff')] } }, { statusLine: SL, tokenLine: TL }).settings;
  assert.deepEqual(plan(installed, { tokenLine: null }).settings, {
    statusLine: cmd(SL),
    hooks: { Stop: [entry('afplay done.aiff')] },
  });
  const noStatus = plan(installed, { statusLine: null, previous: null });
  assert.deepEqual(noStatus.settings, { hooks: { Stop: [entry('afplay done.aiff'), entry(TL)] } });
  assert.equal(noStatus.dropBackup, true);
});

test('uninstall restores the saved status line and removes only claude-gauge hooks', () => {
  const mine = { type: 'command', command: '~/bin/my-status.sh', refreshInterval: 5 };
  const before = {
    model: 'opus',
    statusLine: mine,
    hooks: { Stop: [entry('afplay done.aiff')] },
  };
  const installed = plan(before, { statusLine: SL, tokenLine: TL, replace: true });
  const withInstruct = structuredClone(installed.settings);
  withInstruct.hooks.SessionStart = [entry('node ~/.claude/claude-gauge/dist/statusline.js --instruct')];
  withInstruct.hooks.Stop[0].hooks.push(cmd('node ~/.claude/claude-gauge/dist/tokenline.js'));

  const p = plan(withInstruct, { uninstall: true, previous: installed.backup.statusLine });
  assert.deepEqual(p.settings, before);
  assert.equal(p.dropBackup, true);
  assert.equal(p.found, 'claude-gauge');
});

test('uninstall after a fresh install gives back the empty settings', () => {
  const installed = plan({}, { statusLine: SL, tokenLine: TL });
  assert.deepEqual(plan(installed.settings, { uninstall: true, previous: installed.backup.statusLine }).settings, {});
});

test('uninstall keeps empty hook lists the user had, and a status line set since', () => {
  const current = { statusLine: cmd('~/bin/my-status.sh'), hooks: { Stop: [] } };
  const p = plan(current, { uninstall: true, previous: null });
  assert.deepEqual(p.settings, current);
  assert.equal(p.changed, false);
  assert.equal(p.found, 'other');
  // The saved status line has no use once claude-gauge is gone.
  assert.equal(p.dropBackup, true);
});

test('leaves its input alone', () => {
  const current = { statusLine: cmd(CLAUDE_HUD), hooks: { Stop: [entry(TL)] } };
  const copy = structuredClone(current);
  plan(current, { statusLine: SL, tokenLine: TL2, replace: true });
  plan(current, { uninstall: true, previous: null });
  assert.deepEqual(current, copy);
});

test('refuses hooks it cannot read rather than overwrite them', () => {
  assert.throws(() => plan({ hooks: { Stop: { hooks: [] } } }, { tokenLine: TL }), /hooks\.Stop/);
  assert.throws(() => plan({ hooks: [] }, { tokenLine: TL }), /hooks/);
  assert.throws(() => plan({ statusLine: 'node x.js' }, { statusLine: SL }), /statusLine/);
});
