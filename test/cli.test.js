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
const { colorEnabled } = require('../dist/wordmark.js');

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

// Runs the CLI with `env` added. The colour variables are only as `env` sets
// them, so a NO_COLOR or FORCE_COLOR in the shell that runs the suite changes
// nothing.
function run(dir, args, { cli = path.join(dist, 'cli.js'), env = {} } = {}) {
  const base = { ...process.env, CLAUDE_CONFIG_DIR: dir };
  for (const name of ['NO_COLOR', 'FORCE_COLOR', 'CLICOLOR_FORCE']) delete base[name];
  return spawnSync(process.execPath, [cli, ...args], { env: { ...base, ...env }, encoding: 'utf8' });
}

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

  ok(run(dir, ['setup', '--yes'], { cli }));
  assert.equal(settingsOf(dir).statusLine.command, commandFor(path.join(clone, 'dist', 'statusline.js')));
  assert.ok(!fs.existsSync(runtimeOf(dir)));
  const update = run(dir, ['update'], { cli });
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
  assert.equal(run(dir, ['setup', '--colour']).status, 2);
  assert.equal(run(dir, ['launch']).status, 2);
  assert.equal(run(dir, ['setup', '--status-line']).status, 2, 'a switch that needs a value');
  ok(run(dir, ['--help']));
  assert.ok(!fs.existsSync(path.join(dir, 'settings.json')));
});

// The claude-gauge wordmark: figlet's "future" font, three rows of one 3-cell
// chunk per character. The middle row ends in a space.
const WORDMARK = [
  '┏━╸╻  ┏━┓╻ ╻╺┳┓┏━╸   ┏━╸┏━┓╻ ╻┏━╸┏━╸',
  '┃  ┃  ┣━┫┃ ┃ ┃┃┣╸ ╺━╸┃╺┓┣━┫┃ ┃┃╺┓┣╸ ',
  '┗━╸┗━╸╹ ╹┗━┛╺┻┛┗━╸   ┗━┛╹ ╹┗━┛┗━┛┗━╸',
];

test('--help starts with the wordmark, then a blank line, then the usage', () => {
  const r = run(configFolder(), ['--help'], { env: { NO_COLOR: '1' } });
  ok(r);
  assert.ok(r.stdout.startsWith(`${WORDMARK.join('\n')}\n\nUsage: claude-gauge <setup | configure`), r.stdout);
});

// The wordmark in colour: one 256-colour code in front of each chunk, the 11
// letters in rainbow order and the hyphen grey, and a reset at each row's end.
const COLORS = [196, 202, 208, 214, 226, 118, 244, 82, 39, 27, 93, 163];
const RAINBOW = WORDMARK.map((row) => row.match(/.{3}/g).map((chunk, i) => `\x1b[38;5;${COLORS[i]}m${chunk}`).join('') + '\x1b[0m');

test('FORCE_COLOR or CLICOLOR_FORCE draws the wordmark a colour a letter, the hyphen grey, with a reset at each row end', () => {
  for (const colour of [{ FORCE_COLOR: '1' }, { CLICOLOR_FORCE: '1' }]) {
    const r = run(configFolder(), ['--help'], { env: colour });
    ok(r);
    assert.ok(r.stdout.startsWith(`${RAINBOW.join('\n')}\n\nUsage: claude-gauge `), JSON.stringify(colour) + JSON.stringify(r.stdout.slice(0, 400)));
  }
});

test('the wordmark is plain text off a terminal, with a FORCE_COLOR of 0, or with NO_COLOR, which beats FORCE_COLOR', () => {
  const plain = `${WORDMARK.join('\n')}\n\nUsage: claude-gauge `;
  for (const colour of [{}, { FORCE_COLOR: '0' }, { CLICOLOR_FORCE: '0' }, { NO_COLOR: '1', FORCE_COLOR: '1' }]) {
    const r = run(configFolder(), ['--help'], { env: colour });
    ok(r);
    assert.ok(r.stdout.startsWith(plain), JSON.stringify(colour) + JSON.stringify(r.stdout.slice(0, 400)));
  }
  const empty = run(configFolder(), ['--help'], { env: { NO_COLOR: '', FORCE_COLOR: '1' } });
  assert.ok(empty.stdout.startsWith(RAINBOW[0]), 'an empty NO_COLOR is no NO_COLOR');
});

// A spawned CLI never writes to a terminal, so the gate's terminal cases are
// checked on the gate itself, with a stand-in stream.
test('the colour gate colours a terminal, unless NO_COLOR is set, and a pipe only when forced', () => {
  const terminal = { isTTY: true };
  const pipe = { isTTY: false };
  assert.equal(colorEnabled(terminal, {}), true);
  assert.equal(colorEnabled(terminal, { NO_COLOR: '1' }), false);
  assert.equal(colorEnabled(terminal, { NO_COLOR: '1', FORCE_COLOR: '1' }), false);
  assert.equal(colorEnabled(terminal, { NO_COLOR: '' }), true);
  assert.equal(colorEnabled(pipe, {}), false);
  assert.equal(colorEnabled({}, {}), false, 'a stream with no isTTY');
  assert.equal(colorEnabled(pipe, { FORCE_COLOR: '1' }), true);
  assert.equal(colorEnabled(pipe, { CLICOLOR_FORCE: '1' }), true);
  assert.equal(colorEnabled(pipe, { FORCE_COLOR: '0' }), false);
  assert.equal(colorEnabled(pipe, { FORCE_COLOR: '' }), false);
});

test('a bare claude-gauge prints the wordmark and the usage, on stderr, and exits 2', () => {
  const bare = run(configFolder(), [], { env: { NO_COLOR: '1' } });
  assert.equal(bare.status, 2);
  assert.ok(bare.stderr.startsWith(`${WORDMARK.join('\n')}\n\nUsage: claude-gauge <setup | configure`), bare.stderr);
  assert.equal(bare.stdout, '');
});

test('the usage after a mistake starts with the wordmark, coloured by the gate on stderr', () => {
  const noCommand = run(configFolder(), ['--replace'], { env: { NO_COLOR: '1' } });
  assert.equal(noCommand.status, 2);
  assert.ok(noCommand.stderr.startsWith(`claude-gauge: Name a command.\n\n${WORDMARK.join('\n')}\n\nUsage: claude-gauge `), noCommand.stderr);
  const unknown = run(configFolder(), ['launch'], { env: { FORCE_COLOR: '1' } });
  assert.equal(unknown.status, 2);
  assert.ok(unknown.stderr.startsWith(`claude-gauge: Unknown command: launch\n\n${RAINBOW.join('\n')}\n\nUsage: claude-gauge `), JSON.stringify(unknown.stderr.slice(0, 400)));
  assert.equal(unknown.stdout, '');
});

test('a hand-formatted settings.json keeps its tab indent and CRLF line ends', () => {
  const dir = configFolder();
  fs.writeFileSync(path.join(dir, 'settings.json'), '{\r\n\t"model": "opus"\r\n}\r\n');
  ok(run(dir, ['setup', '--yes']));
  const text = fs.readFileSync(path.join(dir, 'settings.json'), 'utf8');
  assert.match(text, /^\{\r\n\t"model": "opus",\r\n\t"statusLine": \{\r\n\t\t"type": "command",/);
  assert.ok(!/[^\r]\n/.test(text), 'every line ends in CRLF');
});

test('configure stops at hooks it cannot read, with a message, not a crash', () => {
  const dir = configFolder({ statusLine: cmd('node ~/.claude/claude-gauge/dist/statusline.js'), hooks: { Stop: { hooks: [] } } });
  const r = run(dir, ['configure', '--token-line', '']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /hooks\.Stop .*Fix it by hand/);
});

test('a failed uninstall keeps the saved status line for the next try', (t) => {
  if (process.platform === 'win32' || process.getuid?.() === 0) {
    t.skip('needs a folder that POSIX permissions can make read-only');
    return;
  }
  const dir = configFolder();
  const dotfiles = configFolder({ statusLine: cmd('~/bin/my-status.sh') });
  fs.symlinkSync(path.join(dotfiles, 'settings.json'), path.join(dir, 'settings.json'));
  ok(run(dir, ['setup', '--yes', '--replace']));
  fs.chmodSync(dotfiles, 0o555);
  try {
    const r = run(dir, ['uninstall']);
    assert.equal(r.status, 1);
  } finally {
    fs.chmodSync(dotfiles, 0o755);
  }
  assert.deepEqual(JSON.parse(fs.readFileSync(savedStatusLine(dir), 'utf8')), { statusLine: cmd('~/bin/my-status.sh') });
  ok(run(dir, ['uninstall']));
  assert.deepEqual(settingsOf(dir), { statusLine: cmd('~/bin/my-status.sh') });
});

test('uninstall stops at a saved status line it cannot read, and keeps the settings and the file', () => {
  const dir = configFolder({ statusLine: cmd('~/bin/my-status.sh') });
  ok(run(dir, ['setup', '--yes', '--replace']));
  const before = fs.readFileSync(path.join(dir, 'settings.json'), 'utf8');
  fs.writeFileSync(savedStatusLine(dir), '{ "statusLine": ');
  const r = run(dir, ['uninstall']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /previous-statusline\.json .*Fix or delete it by hand/);
  assert.equal(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'), before);
  assert.equal(fs.readFileSync(savedStatusLine(dir), 'utf8'), '{ "statusLine": ');
});

// The wizard, driven through the process with answers piped on stdin. PATH
// holds only `bin`, so gh is there only when a test puts a fake one in.
const ask = (dir, args, answers, { bin = emptyBin(), env = {} } = {}) =>
  spawnSync(process.execPath, [path.join(dist, 'cli.js'), ...args], {
    env: { ...process.env, CLAUDE_CONFIG_DIR: dir, PATH: bin, Path: bin, ...env },
    input: answers.map((a) => `${a}\n`).join(''),
    encoding: 'utf8',
  });

function emptyBin() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-gauge-bin-'));
  made.push(dir);
  return dir;
}

// A folder holding a fake gh that logs each call's arguments, one call a line.
function fakeGh() {
  const bin = emptyBin();
  const log = path.join(bin, 'calls.log');
  fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\necho "$*" >> '${log}'\n`, { mode: 0o755 });
  return { bin, calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : []) };
}

const plainText = (s) => s.replace(/\x1b\[[0-9;]*m/g, '').replace(/\x1b\]8;;[^\x07]*\x07/g, '');

test('setup with no switches asks, and one yes installs both bars as --yes does', () => {
  const dir = configFolder();
  const r = ask(dir, ['setup'], ['y']);
  ok(r);
  const runtime = runtimeOf(dir);
  assert.deepEqual(settingsOf(dir), {
    statusLine: cmd(commandFor(path.join(runtime, 'statusline.js'))),
    hooks: { Stop: [entry(commandFor(path.join(runtime, 'tokenline.js')))] },
  });
  const out = plainText(r.stdout);
  assert.match(out, /ctx 43% /, 'a preview from the sample payload');
  assert.match(out, /Use the defaults/);
  assert.match(out, /new Claude Code session/);
  assert.doesNotMatch(out, /Star /, 'no gh, no star offer');
});

test('the setup and configure questions start with the wordmark and a blank line', () => {
  const dir = configFolder();
  const setup = ask(dir, ['setup'], ['y'], { env: { NO_COLOR: '1' } });
  ok(setup);
  assert.ok(setup.stdout.startsWith(`${WORDMARK.join('\n')}\n\nThe status line with the defaults:\n`), setup.stdout);
  const configure = ask(dir, ['configure'], ['y'], { env: { NO_COLOR: '1' } });
  ok(configure);
  assert.ok(configure.stdout.startsWith(`${WORDMARK.join('\n')}\n\nThe status line as set up now:\n`), configure.stdout);
  const coloured = ask(dir, ['configure'], ['y'], { env: { NO_COLOR: '', FORCE_COLOR: '1' } });
  ok(coloured);
  assert.ok(coloured.stdout.startsWith(`${RAINBOW.join('\n')}\n\nThe status line as set up now:\n`), JSON.stringify(coloured.stdout.slice(0, 400)));
});

test('the commands run with switches print no wordmark, so scripts and the slash commands get short output', () => {
  const dir = configFolder();
  for (const args of [['setup', '--yes'], ['configure', '--status-line', '--segments 10'], ['configure', '--no-token-line'], ['update'], ['uninstall']]) {
    const r = run(dir, args, { env: { FORCE_COLOR: '1' } });
    ok(r);
    const out = plainText(r.stdout + r.stderr);
    assert.ok(WORDMARK.every((row) => !out.includes(row.trimEnd())), `${args.join(' ')} printed the wordmark:\n${out}`);
  }
});

test('the wizard previews the payload the status line saved', () => {
  const dir = configFolder();
  fs.mkdirSync(path.join(dir, 'claude-gauge', '.state'), { recursive: true });
  const saved = { model: { display_name: 'Saved Model' }, context_window: { used_percentage: 77 } };
  fs.writeFileSync(path.join(dir, 'claude-gauge', '.state', 'last-payload.json'), JSON.stringify(saved));
  const r = ask(dir, ['setup'], ['n', '1', 'model,ctx', '', 'mono', 'n', '', '', '']);
  ok(r);
  const out = plainText(r.stdout);
  assert.match(out, /Saved Model/);
  assert.match(out, /  Saved Model │ 77% /, 'the preview redrawn without labels');
});

test('the customise path writes the switches chosen, and can leave the token line out', () => {
  const dir = configFolder();
  ok(ask(dir, ['setup'], ['n', '2', 'ctx,5h', 'model', '10', 'pastel', 'n', 'n', 'y']));
  assert.deepEqual(settingsOf(dir), {
    statusLine: cmd(commandFor(path.join(runtimeOf(dir), 'statusline.js'), '--show ctx,5h --show model --segments 10 --theme pastel --no-labels')),
  });
});

test('the token line parts the wizard is given go into the Stop hook command, and Enter adds no --show', () => {
  const tokenLine = (dir) => settingsOf(dir).hooks.Stop[0].hooks[0].command;
  const script = (dir) => path.join(runtimeOf(dir), 'tokenline.js');
  const enter = configFolder();
  ok(ask(enter, ['setup'], ['n', '', '', '', '', '', '', '', '', 'y']));
  assert.equal(tokenLine(enter), commandFor(script(enter)));

  const fewer = configFolder();
  const r = ask(fewer, ['setup'], ['n', '', '', '', '', '', '', '', 'req,bogus', 'req,out,ctx', 'y']);
  ok(r);
  assert.match(r.stdout, /Unknown part: bogus/);
  assert.equal(tokenLine(fewer), commandFor(script(fewer), '--show req,out,ctx'));

  // configure starts from that --show and keeps the --window set up.
  ok(run(fewer, ['configure', '--token-line', '--show req,out,ctx --window 1m']));
  const again = ask(fewer, ['configure'], ['n', '', '', '', '', '', '', '', 'ctx', 'y']);
  ok(again);
  assert.match(again.stdout, /Token line parts.*\[req,out,ctx\]/);
  assert.equal(tokenLine(fewer), commandFor(script(fewer), '--show ctx --window 1m'));
});

test('a no at the last question, or answers that end early, change nothing', () => {
  const dir = configFolder();
  const declined = ask(dir, ['setup'], ['n', '', '', '', '', '', '', '', '', 'n']);
  ok(declined);
  assert.match(declined.stdout, /Nothing changed/);
  const ended = ask(dir, ['setup'], []);
  assert.equal(ended.status, 1);
  assert.match(ended.stderr, /answers ended/);
  assert.ok(!fs.existsSync(path.join(dir, 'settings.json')));
  assert.ok(!fs.existsSync(runtimeOf(dir)));
});

test('the wizard asks before it replaces a status line that is not claude-gauge', () => {
  const mine = { type: 'command', command: '~/bin/my-status.sh' };
  const dir = configFolder({ statusLine: mine });
  const original = fs.readFileSync(path.join(dir, 'settings.json'), 'utf8');
  const kept = ask(dir, ['setup'], ['n']);
  ok(kept);
  assert.match(kept.stdout, /my-status\.sh/);
  assert.match(kept.stdout, /Nothing changed/);
  assert.equal(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'), original);

  ok(ask(dir, ['setup'], ['y', 'y']));
  assert.match(settingsOf(dir).statusLine.command, /statusline\.js$/);
  assert.deepEqual(JSON.parse(fs.readFileSync(savedStatusLine(dir), 'utf8')), { statusLine: mine });
});

test('configure with no switches runs the wizard on a set-up config, and offers no star', () => {
  const dir = configFolder();
  assert.equal(ask(dir, ['configure'], ['y']).status, 1, 'not set up yet');
  ok(run(dir, ['setup', '--yes']));
  const gh = fakeGh();
  const r = ask(dir, ['configure'], ['n', '1', 'ctx', '', '', '', '', '', 'y'], { bin: gh.bin });
  ok(r);
  assert.equal(settingsOf(dir).statusLine.command, commandFor(path.join(runtimeOf(dir), 'statusline.js'), '--show ctx'));
  assert.doesNotMatch(r.stdout, /Star /);
  assert.deepEqual(gh.calls(), []);
});

test('configure starts from the bars set up: a yes keeps the status line and adds no token line', () => {
  const dir = configFolder();
  ok(run(dir, ['setup', '--status-line', '--segments 10 --theme mono', '--no-token-line']));
  const before = fs.readFileSync(path.join(dir, 'settings.json'), 'utf8');
  const r = ask(dir, ['configure'], ['y']);
  ok(r);
  assert.match(r.stdout, /Keep the current bars/);
  assert.match(r.stdout, /Nothing to change/);
  assert.equal(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'), before);
  assert.equal(settingsOf(dir).hooks, undefined);
});

test('a yes to keeping the bars leaves a command written by hand exactly as it is, and copies no scripts', () => {
  const statusLine = "FORCE_COLOR=1 node ~/.claude/claude-gauge/statusline.js --text 'a b' --segments 10";
  const dir = configFolder({ statusLine: cmd(statusLine), hooks: { Stop: [entry('node ~/.claude/claude-gauge/tokenline.js'), entry('node ~/.claude/claude-gauge/tokenline.js --window 1m')] } });
  const before = fs.readFileSync(path.join(dir, 'settings.json'), 'utf8');
  const r = ask(dir, ['configure'], ['y']);
  ok(r);
  assert.match(r.stdout, /Nothing to change/);
  assert.equal(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'), before);
  assert.ok(!fs.existsSync(runtimeOf(dir)), 'no scripts copied');
});

test('configure keeps a quoted value and a switch it does not know, whichever path the answers take', () => {
  const dir = configFolder();
  const script = (name) => path.join(runtimeOf(dir), name);
  const status = ['--show', 'text,ctx', '--text', 'my label', '--frobnicate'];
  ok(run(dir, ['setup', '--yes']));
  const settings = settingsOf(dir);
  settings.statusLine.command = commandFor(script('statusline.js'), status);
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(settings, null, 2) + '\n');
  const before = fs.readFileSync(path.join(dir, 'settings.json'), 'utf8');

  ok(ask(dir, ['configure'], ['y']));
  assert.equal(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'), before);

  // One row set up, a bar size changed, the rest kept with Enter.
  ok(ask(dir, ['configure'], ['n', '', '', '10', '', '', '', '', 'y']));
  assert.deepEqual(settingsOf(dir), {
    statusLine: cmd(commandFor(script('statusline.js'), ['--show', 'text,ctx', '--segments', '10', '--text', 'my label', '--frobnicate'])),
    hooks: { Stop: [entry(commandFor(script('tokenline.js')))] },
  });
});

test('setup ends by offering to star the repo with gh, and stars it only on a yes', { skip: process.platform === 'win32' && 'the fake gh is a shell script' }, () => {
  const declined = fakeGh();
  const no = ask(configFolder(), ['setup'], ['y', 'n'], { bin: declined.bin });
  ok(no);
  assert.match(no.stdout, /Star jv-k\/claude-gauge/);
  assert.deepEqual(declined.calls().filter((c) => !c.startsWith('--version')), []);

  const accepted = fakeGh();
  const yes = ask(configFolder(), ['setup'], ['y', 'y'], { bin: accepted.bin });
  ok(yes);
  assert.deepEqual(accepted.calls().filter((c) => !c.startsWith('--version')), ['api --method PUT user/starred/jv-k/claude-gauge']);
  assert.match(yes.stdout, /Thank you/);
});
