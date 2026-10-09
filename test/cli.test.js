'use strict';

// The claude-gauge CLI, run as a process against a temporary Claude config
// folder, the way the plugin's slash commands run it: setup, configure,
// uninstall and update, with the choices given as switches. Paths are built
// with path.join and the CLI is spawned with process.execPath, so the suite
// runs the same on macOS, Linux and Windows.

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { commandFor } = require('../dist/settings.js');

const root = path.join(__dirname, '..');
const dist = path.join(root, 'dist');

const made = [];
test.after(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
});

// A Claude config folder of its own, with settings.json holding `settings`
// when given.
function configFolder(settings) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-gauge-cli-'));
  made.push(dir);
  if (settings !== undefined) fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(settings, null, 2) + '\n');
  return dir;
}

const run = (dir, args, cli = path.join(dist, 'cli.js')) =>
  spawnSync(process.execPath, [cli, ...args], { env: { ...process.env, CLAUDE_CONFIG_DIR: dir }, encoding: 'utf8' });

const settingsOf = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
const backupsIn = (dir) => fs.readdirSync(dir).filter((f) => /^settings\.json\.claude-gauge-.+\.bak$/.test(f)).sort();
const runtimeOf = (dir) => path.join(dir, 'claude-gauge', 'runtime');
const savedStatusLine = (dir) => path.join(dir, 'claude-gauge', '.state', 'previous-statusline.json');
const ok = (r) => assert.equal(r.status, 0, `exit ${r.status}\n${r.stdout}\n${r.stderr}`);

const cmd = (command) => ({ type: 'command', command });
const entry = (...commands) => ({ hooks: commands.map(cmd) });
const CLAUDE_HUD = "bash -c 'exec node ~/.claude/plugins/cache/claude-hud/claude-hud/0.1.0/dist/index.js'";

test('setup --yes on a fresh config folder installs both bars from a copy of the runtime', () => {
  const dir = configFolder();
  const r = run(dir, ['setup', '--yes']);
  ok(r);

  const runtime = runtimeOf(dir);
  for (const script of ['statusline.js', 'tokenline.js']) {
    assert.equal(fs.readFileSync(path.join(runtime, script), 'utf8'), fs.readFileSync(path.join(dist, script), 'utf8'));
  }
  // The npm route points at the copy, never at the package the CLI ran from,
  // which for npx is a cache that npm may prune.
  const settings = settingsOf(dir);
  assert.deepEqual(settings, {
    statusLine: cmd(commandFor(path.join(runtime, 'statusline.js'))),
    hooks: { Stop: [entry(commandFor(path.join(runtime, 'tokenline.js')))] },
  });
  assert.ok(!settings.statusLine.command.includes(dist.replace(/\\/g, '/')));
  assert.deepEqual(JSON.parse(fs.readFileSync(savedStatusLine(dir), 'utf8')), { statusLine: null });
  assert.deepEqual(backupsIn(dir), [], 'no settings.json to back up');
  assert.match(r.stdout, /new Claude Code session/);

  // The copied status line runs on its own.
  const payload = JSON.stringify({ model: { display_name: 'Opus' }, context_window: { used_percentage: 25 } });
  const line = spawnSync(process.execPath, [path.join(runtime, 'statusline.js')], {
    env: { ...process.env, CLAUDE_CONFIG_DIR: dir },
    input: payload,
    encoding: 'utf8',
  });
  assert.equal(line.status, 0);
  assert.match(line.stdout.replace(/\x1b\[[0-9;]*m/g, ''), /ctx 25%/);
});

test('setup writes the chosen switches, keeps every other key and refreshInterval, and backs up', () => {
  const before = {
    model: 'opus',
    statusLine: { type: 'command', command: 'node ~/.claude/claude-gauge/dist/statusline.js', refreshInterval: 60 },
    hooks: { Stop: [entry('afplay done.aiff')], PreToolUse: [{ matcher: 'Bash', hooks: [cmd('~/bin/guard.sh')] }] },
  };
  const dir = configFolder(before);
  const original = fs.readFileSync(path.join(dir, 'settings.json'), 'utf8');
  ok(run(dir, ['setup', '--status-line', '--show ctx,5h,7d --show time,model --segments 10', '--token-line=--window 1m']));

  const runtime = runtimeOf(dir);
  assert.deepEqual(settingsOf(dir), {
    model: 'opus',
    statusLine: {
      type: 'command',
      command: commandFor(path.join(runtime, 'statusline.js'), '--show ctx,5h,7d --show time,model --segments 10'),
      refreshInterval: 60,
    },
    hooks: {
      Stop: [entry('afplay done.aiff'), entry(commandFor(path.join(runtime, 'tokenline.js'), '--window 1m'))],
      PreToolUse: [{ matcher: 'Bash', hooks: [cmd('~/bin/guard.sh')] }],
    },
  });
  const backups = backupsIn(dir);
  assert.equal(backups.length, 1);
  assert.equal(fs.readFileSync(path.join(dir, backups[0]), 'utf8'), original);
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')), [], 'no temporary file left');
});

test('switches that hold shell syntax are quoted, so they cannot run a second command', () => {
  const dir = configFolder();
  ok(run(dir, ['setup', '--status-line', '--show ctx;touch pwned', '--no-token-line']));
  assert.match(settingsOf(dir).statusLine.command, / --show "ctx;touch" pwned$/);
  assert.equal(settingsOf(dir).hooks, undefined);
});

test('a status line that is not claude-gauge is replaced only with --replace, and claude-hud is named', () => {
  const mine = { type: 'command', command: '~/bin/my-status.sh', padding: 0 };
  const dir = configFolder({ statusLine: mine });
  const original = fs.readFileSync(path.join(dir, 'settings.json'), 'utf8');
  const refused = run(dir, ['setup', '--yes']);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /~\/bin\/my-status\.sh/);
  assert.match(refused.stderr, /--replace/);
  assert.equal(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'), original);
  assert.deepEqual(backupsIn(dir), []);

  const hud = configFolder({ statusLine: cmd(CLAUDE_HUD) });
  const hudRefused = run(hud, ['setup', '--yes']);
  assert.equal(hudRefused.status, 1);
  assert.match(hudRefused.stderr, /claude-hud/);
  ok(run(hud, ['setup', '--yes', '--replace']));
  assert.match(settingsOf(hud).statusLine.command, /runtime\/statusline\.js$/);
  assert.deepEqual(JSON.parse(fs.readFileSync(savedStatusLine(hud), 'utf8')), { statusLine: cmd(CLAUDE_HUD) });
});

test('re-running setup changes nothing and keeps the status line saved the first time', () => {
  const mine = cmd('~/bin/my-status.sh');
  const dir = configFolder({ statusLine: mine });
  ok(run(dir, ['setup', '--yes', '--replace']));
  const first = fs.readFileSync(path.join(dir, 'settings.json'), 'utf8');
  const again = run(dir, ['setup', '--yes']);
  ok(again);
  assert.equal(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'), first);
  assert.equal(backupsIn(dir).length, 1, 'an unchanged file gets no new backup');
  assert.deepEqual(JSON.parse(fs.readFileSync(savedStatusLine(dir), 'utf8')), { statusLine: mine });
});

test('uninstall restores the previous status line and removes only claude-gauge hooks', () => {
  const before = {
    model: 'opus',
    statusLine: { type: 'command', command: '~/bin/my-status.sh', refreshInterval: 5 },
    hooks: { Stop: [entry('afplay done.aiff')] },
  };
  const dir = configFolder(before);
  ok(run(dir, ['setup', '--yes', '--replace']));
  const r = run(dir, ['uninstall']);
  ok(r);
  assert.deepEqual(settingsOf(dir), before);
  assert.ok(!fs.existsSync(savedStatusLine(dir)), 'the saved status line is spent');
  assert.equal(backupsIn(dir).length, 2);

  const nothing = run(dir, ['uninstall']);
  ok(nothing);
  assert.match(nothing.stdout, /not in .*settings\.json/);
  assert.deepEqual(settingsOf(dir), before);
});

test('configure changes one bar in place and needs claude-gauge set up first', () => {
  const dir = configFolder({ hooks: { Stop: [entry('afplay done.aiff')] } });
  const early = run(dir, ['configure', '--token-line', '--window 1m']);
  assert.equal(early.status, 1);
  assert.match(early.stderr, /claude-gauge setup/);

  ok(run(dir, ['setup', '--yes']));
  const runtime = runtimeOf(dir);
  ok(run(dir, ['configure', '--token-line', '--window 1m --show req,ctx']));
  let settings = settingsOf(dir);
  assert.deepEqual(settings.hooks.Stop, [
    entry('afplay done.aiff'),
    entry(commandFor(path.join(runtime, 'tokenline.js'), '--window 1m --show req,ctx')),
  ]);
  assert.equal(settings.statusLine.command, commandFor(path.join(runtime, 'statusline.js')));

  ok(run(dir, ['configure', '--no-token-line']));
  settings = settingsOf(dir);
  assert.deepEqual(settings.hooks.Stop, [entry('afplay done.aiff')]);
  assert.equal(settings.statusLine.command, commandFor(path.join(runtime, 'statusline.js')));
});

test('update refreshes the runtime copy', () => {
  const dir = configFolder();
  const missing = run(dir, ['update']);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /claude-gauge setup/);

  ok(run(dir, ['setup', '--yes']));
  const copy = path.join(runtimeOf(dir), 'statusline.js');
  fs.writeFileSync(copy, '// an older release\n');
  ok(run(dir, ['update']));
  assert.equal(fs.readFileSync(copy, 'utf8'), fs.readFileSync(path.join(dist, 'statusline.js'), 'utf8'));
});

test('a git clone in the state folder runs from its own dist/, with no copy', () => {
  const dir = configFolder();
  const clone = path.join(dir, 'claude-gauge');
  fs.mkdirSync(path.join(clone, 'dist'), { recursive: true });
  for (const f of fs.readdirSync(dist)) fs.copyFileSync(path.join(dist, f), path.join(clone, 'dist', f));
  fs.copyFileSync(path.join(root, 'package.json'), path.join(clone, 'package.json'));
  const cli = path.join(clone, 'dist', 'cli.js');

  ok(run(dir, ['setup', '--yes'], cli));
  assert.equal(settingsOf(dir).statusLine.command, commandFor(path.join(clone, 'dist', 'statusline.js')));
  assert.ok(!fs.existsSync(runtimeOf(dir)));
  const update = run(dir, ['update'], cli);
  ok(update);
  assert.match(update.stdout, /git -C .* pull/);
});

test('writes go through a symlinked settings.json to its target', (t) => {
  const dir = configFolder();
  const dotfiles = configFolder({ model: 'opus' });
  const target = path.join(dotfiles, 'settings.json');
  try {
    fs.symlinkSync(target, path.join(dir, 'settings.json'), 'file');
  } catch (err) {
    // Windows without Developer Mode refuses to make a symlink.
    t.skip(`this OS made no symlink: ${err.code}`);
    return;
  }
  ok(run(dir, ['setup', '--yes']));
  assert.ok(fs.lstatSync(path.join(dir, 'settings.json')).isSymbolicLink(), 'the link is still a link');
  const written = JSON.parse(fs.readFileSync(target, 'utf8'));
  assert.equal(written.model, 'opus');
  assert.match(written.statusLine.command, /runtime\/statusline\.js$/);
  assert.equal(backupsIn(dir).length, 1, 'the backup sits beside the link');
  assert.deepEqual(fs.readdirSync(dotfiles).sort(), ['settings.json']);
});

test('settings.json that is not JSON is left alone', () => {
  const dir = configFolder();
  fs.writeFileSync(path.join(dir, 'settings.json'), '{ "model": "opus", }');
  const r = run(dir, ['setup', '--yes']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /settings\.json/);
  assert.equal(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'), '{ "model": "opus", }');
});

test('usage errors exit 2 and say what to run', () => {
  const dir = configFolder();
  const bare = run(dir, []);
  assert.equal(bare.status, 2);
  assert.match(bare.stderr, /setup \| configure \| uninstall \| update/);
  const noChoice = run(dir, ['setup']);
  assert.equal(noChoice.status, 2);
  assert.match(noChoice.stderr, /--yes/);
  assert.equal(run(dir, ['setup', '--colour']).status, 2);
  assert.equal(run(dir, ['launch']).status, 2);
  assert.equal(run(dir, ['setup', '--status-line']).status, 2, 'a switch that needs a value');
  ok(run(dir, ['--help']));
  assert.ok(!fs.existsSync(path.join(dir, 'settings.json')));
});
