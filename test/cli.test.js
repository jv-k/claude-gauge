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
const path = require('node:path');
const { commandFor } = require('../dist/settings.js');
const { colorEnabled } = require('../dist/wordmark.js');

const { root, dist, plain, configFolder, runCli, ok, runtimeOf, settingsOf, cmd, entry, tempDir, packageAt, fakeTool } = require('./helpers');

const backupsIn = (dir) => fs.readdirSync(dir).filter((f) => /^settings\.json\.claude-gauge-.+\.bak$/.test(f)).sort();
const savedStatusLine = (dir) => path.join(dir, 'claude-gauge', '.state', 'previous-statusline.json');
const CLAUDE_HUD = "bash -c 'exec node ~/.claude/plugins/cache/claude-hud/claude-hud/0.1.0/dist/index.js'";


// The switches the defaults give each line: setup --yes, and a yes to the
// defaults in the questions, write them.
const DEFAULTS = ['--bar-style', 'dots'];

test('setup --yes on a fresh config folder installs both bars from a copy of the runtime', () => {
  const dir = configFolder();
  const r = runCli(dir, ['setup', '--yes']);
  ok(r);

  const runtime = runtimeOf(dir);
  for (const script of ['statusline.js', 'tokenline.js']) {
    assert.equal(fs.readFileSync(path.join(runtime, script), 'utf8'), fs.readFileSync(path.join(dist, script), 'utf8'));
  }
  // The npm route points at the copy, never at the package the CLI ran from,
  // which for npx is a cache that npm may prune.
  const settings = settingsOf(dir);
  assert.deepEqual(settings, {
    statusLine: cmd(commandFor(path.join(runtime, 'statusline.js'), DEFAULTS)),
    hooks: { Stop: [entry(commandFor(path.join(runtime, 'tokenline.js'), DEFAULTS))] },
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
  assert.match(plain(line.stdout), /ctx 25%/);
});

test('a bar switch value is split at runs of white space, with empty words dropped', () => {
  const dir = configFolder();
  ok(runCli(dir, ['setup', '--status-line', '  --show   ctx,5h \t--segments 10  ', '--token-line= --window\t1m ']));

  const runtime = runtimeOf(dir);
  assert.deepEqual(settingsOf(dir), {
    statusLine: cmd(commandFor(path.join(runtime, 'statusline.js'), ['--show', 'ctx,5h', '--segments', '10'])),
    hooks: { Stop: [entry(commandFor(path.join(runtime, 'tokenline.js'), ['--window', '1m']))] },
  });
});

test('setup writes the chosen switches, keeps every other key and refreshInterval, and backs up', () => {
  const before = {
    model: 'opus',
    statusLine: { type: 'command', command: 'node ~/.claude/claude-gauge/dist/statusline.js', refreshInterval: 60 },
    hooks: { Stop: [entry('afplay done.aiff')], PreToolUse: [{ matcher: 'Bash', hooks: [cmd('~/bin/guard.sh')] }] },
  };
  const dir = configFolder(before);
  const original = fs.readFileSync(path.join(dir, 'settings.json'), 'utf8');
  ok(runCli(dir, ['setup', '--status-line', '--show ctx,5h,7d --show time,model --segments 10', '--token-line=--window 1m']));

  const runtime = runtimeOf(dir);
  assert.deepEqual(settingsOf(dir), {
    model: 'opus',
    statusLine: {
      type: 'command',
      command: commandFor(path.join(runtime, 'statusline.js'), ['--show', 'ctx,5h,7d', '--show', 'time,model', '--segments', '10']),
      refreshInterval: 60,
    },
    hooks: {
      Stop: [entry('afplay done.aiff'), entry(commandFor(path.join(runtime, 'tokenline.js'), ['--window', '1m']))],
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
  ok(runCli(dir, ['setup', '--status-line', '--show ctx;touch pwned', '--no-token-line']));
  assert.match(settingsOf(dir).statusLine.command, / --show "ctx;touch" pwned$/);
  assert.equal(settingsOf(dir).hooks, undefined);
});

test('a status line that is not claude-gauge is replaced only with --replace, and claude-hud is named', () => {
  const mine = { type: 'command', command: '~/bin/my-status.sh', padding: 0 };
  const dir = configFolder({ statusLine: mine });
  const original = fs.readFileSync(path.join(dir, 'settings.json'), 'utf8');
  const refused = runCli(dir, ['setup', '--yes']);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /~\/bin\/my-status\.sh/);
  assert.match(refused.stderr, /--replace/);
  assert.equal(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'), original);
  assert.deepEqual(backupsIn(dir), []);

  const hud = configFolder({ statusLine: cmd(CLAUDE_HUD) });
  const hudRefused = runCli(hud, ['setup', '--yes']);
  assert.equal(hudRefused.status, 1);
  assert.match(hudRefused.stderr, /claude-hud/);
  ok(runCli(hud, ['setup', '--yes', '--replace']));
  assert.match(settingsOf(hud).statusLine.command, /runtime\/statusline\.js --bar-style dots$/);
  assert.deepEqual(JSON.parse(fs.readFileSync(savedStatusLine(hud), 'utf8')), { statusLine: cmd(CLAUDE_HUD) });

  // A command that is not a string still prints as it was written.
  const odd = configFolder({ statusLine: { type: 'command', command: 42 } });
  const oddRefused = runCli(odd, ['setup', '--yes']);
  assert.equal(oddRefused.status, 1);
  assert.match(oddRefused.stderr, /another status line:\n {2}.*42\n/);
});

test('re-running setup changes nothing and keeps the status line saved the first time', () => {
  const mine = cmd('~/bin/my-status.sh');
  const dir = configFolder({ statusLine: mine });
  ok(runCli(dir, ['setup', '--yes', '--replace']));
  const first = fs.readFileSync(path.join(dir, 'settings.json'), 'utf8');
  const again = runCli(dir, ['setup', '--yes']);
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
  ok(runCli(dir, ['setup', '--yes', '--replace']));
  const r = runCli(dir, ['uninstall']);
  ok(r);
  assert.deepEqual(settingsOf(dir), before);
  assert.ok(!fs.existsSync(savedStatusLine(dir)), 'the saved status line is spent');
  assert.equal(backupsIn(dir).length, 2);

  const nothing = runCli(dir, ['uninstall']);
  ok(nothing);
  assert.match(nothing.stdout, /not in .*settings\.json/);
  assert.deepEqual(settingsOf(dir), before);
});

test('configure changes one bar in place and needs claude-gauge set up first', () => {
  const dir = configFolder({ hooks: { Stop: [entry('afplay done.aiff')] } });
  const early = runCli(dir, ['configure', '--token-line', '--window 1m']);
  assert.equal(early.status, 1);
  assert.match(early.stderr, /claude-gauge setup/);

  ok(runCli(dir, ['setup', '--yes']));
  const runtime = runtimeOf(dir);
  ok(runCli(dir, ['configure', '--token-line', '--window 1m --show req,ctx']));
  let settings = settingsOf(dir);
  assert.deepEqual(settings.hooks.Stop, [
    entry('afplay done.aiff'),
    entry(commandFor(path.join(runtime, 'tokenline.js'), ['--window', '1m', '--show', 'req,ctx'])),
  ]);
  assert.equal(settings.statusLine.command, commandFor(path.join(runtime, 'statusline.js'), DEFAULTS));

  ok(runCli(dir, ['configure', '--no-token-line']));
  settings = settingsOf(dir);
  assert.deepEqual(settings.hooks.Stop, [entry('afplay done.aiff')]);
  assert.equal(settings.statusLine.command, commandFor(path.join(runtime, 'statusline.js'), DEFAULTS));
});

test('update refreshes the runtime copy', () => {
  const dir = configFolder();
  const missing = runCli(dir, ['update']);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /claude-gauge setup/);

  ok(runCli(dir, ['setup', '--yes']));
  const copy = path.join(runtimeOf(dir), 'statusline.js');
  fs.writeFileSync(copy, '// an older release\n');
  ok(runCli(dir, ['update']));
  assert.equal(fs.readFileSync(copy, 'utf8'), fs.readFileSync(path.join(dist, 'statusline.js'), 'utf8'));
});

const posixOnly = { skip: process.platform === 'win32' && 'the fake tools are shell scripts' };

// PATH holds only `bin`, so the tools that update runs are the test's fakes.
const pathOf = (bin) => ({ PATH: bin, Path: bin });

test('update from npx runs the newest release, which copies its scripts in place', posixOnly, () => {
  const dir = configFolder();
  const cli = packageAt(path.join(tempDir(), '_npx', 'a1b2', 'node_modules', '@jv-k', 'claude-gauge'));
  ok(runCli(dir, ['setup', '--yes'], { cli }));
  const npx = fakeTool('npx', { body: '[ "$1" = --yes ] && echo "in place: $CLAUDE_GAUGE_UPDATE_IN_PLACE" >> "$0.log"' });

  const dry = runCli(dir, ['update', '--dry-run'], { cli, env: pathOf(npx.bin) });
  ok(dry);
  assert.match(dry.stdout, /npx installed claude-gauge\. Would run:\n.*npx --yes @jv-k\/claude-gauge@latest update/);
  assert.deepEqual(npx.calls(), []);

  ok(runCli(dir, ['update'], { cli, env: pathOf(npx.bin) }));
  assert.deepEqual(npx.calls(), ['--version', 'in place: 1', '--yes @jv-k/claude-gauge@latest update']);

  // The release that npx runs has the variable set, and copies itself.
  const copy = path.join(runtimeOf(dir), 'statusline.js');
  fs.writeFileSync(copy, '// an older release\n');
  ok(runCli(dir, ['update'], { cli, env: { ...pathOf(npx.bin), CLAUDE_GAUGE_UPDATE_IN_PLACE: '1' } }));
  assert.equal(fs.readFileSync(copy, 'utf8'), fs.readFileSync(path.join(dist, 'statusline.js'), 'utf8'));
  assert.equal(npx.calls().length, 3);
});

test('update from a global npm install upgrades it, then copies the new scripts in', posixOnly, () => {
  const dir = configFolder();
  const modules = path.join(tempDir(), 'lib', 'node_modules');
  const cli = packageAt(path.join(modules, '@jv-k', 'claude-gauge'));
  ok(runCli(dir, ['setup', '--yes'], { cli }));
  const npm = fakeTool('npm', { body: `[ "$1" = root ] && echo '${modules}' && exit 0` });
  const copy = path.join(runtimeOf(dir), 'statusline.js');
  fs.writeFileSync(copy, '// an older release\n');

  const r = runCli(dir, ['update'], { cli, env: pathOf(npm.bin) });
  ok(r);
  assert.deepEqual(npm.calls(), ['--version', 'install -g @jv-k/claude-gauge@latest']);
  assert.match(r.stdout, /A global npm install installed claude-gauge\. Running:/);
  assert.match(r.stdout, /Updated claude-gauge in /);
  assert.equal(fs.readFileSync(copy, 'utf8'), fs.readFileSync(path.join(dist, 'statusline.js'), 'utf8'));
});

test('update exits 2 when the tool is not on PATH, and 1 when the tool fails', posixOnly, () => {
  const dir = configFolder();
  const cli = packageAt(path.join(tempDir(), '_npx', 'a1b2', 'node_modules', '@jv-k', 'claude-gauge'));
  ok(runCli(dir, ['setup', '--yes'], { cli }));

  const missing = runCli(dir, ['update'], { cli, env: pathOf(tempDir()) });
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /npx is not on PATH, so run npx --yes @jv-k\/claude-gauge@latest update by hand\./);
  assert.doesNotMatch(missing.stderr, /Usage:/);

  const failing = fakeTool('npx', { status: 1, body: '[ "$1" = --version ] && exit 0' });
  const failed = runCli(dir, ['update'], { cli, env: pathOf(failing.bin) });
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /npx --yes @jv-k\/claude-gauge@latest update failed\./);
});

test('update --dry-run from a checkout names the copy and changes nothing', () => {
  const dir = configFolder();
  ok(runCli(dir, ['setup', '--yes']));
  const copy = path.join(runtimeOf(dir), 'statusline.js');
  fs.writeFileSync(copy, '// an older release\n');
  const r = runCli(dir, ['update', '--dry-run']);
  ok(r);
  assert.match(r.stdout, /Would copy claude-gauge .* into /);
  assert.equal(fs.readFileSync(copy, 'utf8'), '// an older release\n');
  assert.equal(runCli(dir, ['setup', '--dry-run']).status, 2);
});

test('a git clone in the state folder runs from its own dist/, with no copy', () => {
  const dir = configFolder();
  const clone = path.join(dir, 'claude-gauge');
  fs.mkdirSync(path.join(clone, 'dist'), { recursive: true });
  for (const f of fs.readdirSync(dist)) fs.copyFileSync(path.join(dist, f), path.join(clone, 'dist', f));
  fs.copyFileSync(path.join(root, 'package.json'), path.join(clone, 'package.json'));
  const cli = path.join(clone, 'dist', 'cli.js');

  ok(runCli(dir, ['setup', '--yes'], { cli }));
  assert.equal(settingsOf(dir).statusLine.command, commandFor(path.join(clone, 'dist', 'statusline.js'), DEFAULTS));
  assert.ok(!fs.existsSync(runtimeOf(dir)));
  const update = runCli(dir, ['update'], { cli });
  ok(update);
  assert.match(update.stdout, /git -C .* pull/);

  // npx finds the clone in the state folder, and runs nothing either.
  fs.mkdirSync(path.join(clone, '.git'));
  const npxCli = packageAt(path.join(tempDir(), '_npx', 'a1b2', 'node_modules', '@jv-k', 'claude-gauge'));
  const fromNpx = runCli(dir, ['update'], { cli: npxCli });
  ok(fromNpx);
  assert.match(fromNpx.stdout, /git -C .* pull/);
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
  ok(runCli(dir, ['setup', '--yes']));
  assert.ok(fs.lstatSync(path.join(dir, 'settings.json')).isSymbolicLink(), 'the link is still a link');
  const written = JSON.parse(fs.readFileSync(target, 'utf8'));
  assert.equal(written.model, 'opus');
  assert.match(written.statusLine.command, /runtime\/statusline\.js --bar-style dots$/);
  assert.equal(backupsIn(dir).length, 1, 'the backup sits beside the link');
  assert.deepEqual(fs.readdirSync(dotfiles).sort(), ['settings.json']);
});

test('settings.json that is not JSON is left alone', () => {
  const dir = configFolder();
  fs.writeFileSync(path.join(dir, 'settings.json'), '{ "model": "opus", }');
  const r = runCli(dir, ['setup', '--yes']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /settings\.json/);
  assert.equal(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'), '{ "model": "opus", }');
});

test('usage errors exit 2 and say what to run', () => {
  const dir = configFolder();
  const bare = runCli(dir, []);
  assert.equal(bare.status, 2);
  assert.match(bare.stderr, /setup \| configure \| uninstall \| update/);
  assert.equal(runCli(dir, ['setup', '--colour']).status, 2);
  assert.equal(runCli(dir, ['launch']).status, 2);
  assert.equal(runCli(dir, ['setup', '--status-line']).status, 2, 'a switch that needs a value');
  ok(runCli(dir, ['--help']));
  assert.ok(!fs.existsSync(path.join(dir, 'settings.json')));
});

// The claude-gauge wordmark: figlet's "future" font, three rows of one 3-cell
// chunk per character. The middle row ends in a space.
const WORDMARK = [
  '┏━╸╻  ┏━┓╻ ╻╺┳┓┏━╸   ┏━╸┏━┓╻ ╻┏━╸┏━╸',
  '┃  ┃  ┣━┫┃ ┃ ┃┃┣╸ ╺━╸┃╺┓┣━┫┃ ┃┃╺┓┣╸ ',
  '┗━╸┗━╸╹ ╹┗━┛╺┻┛┗━╸   ┗━┛╹ ╹┗━┛┗━┛┗━╸',
];

// The line under the wordmark in the usage: the version, then the
// project's page.
const VERSION = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const REPO_URL = 'https://github.com/jv-k/claude-gauge';
const HEADER = `v${VERSION}  ${REPO_URL}`;

test('--help starts with the wordmark, then the version and the project page, a blank line, and the usage', () => {
  const r = runCli(configFolder(), ['--help'], { env: { NO_COLOR: '1' } });
  ok(r);
  assert.ok(r.stdout.startsWith(`${WORDMARK.join('\n')}\n${HEADER}\n\nUsage: claude-gauge <setup | configure`), r.stdout);
});

// The wordmark in colour: a 24-bit colour code in front of each cell, from a
// coral, pink and violet gradient that each row starts 2 columns further
// along, so it runs on a diagonal, and a reset at each row's end.
const STOPS = [
  [242, 119, 74],
  [224, 69, 146],
  [139, 92, 246],
];
const gradient = (t) => {
  const at = t * (STOPS.length - 1);
  const i = Math.min(Math.floor(at), STOPS.length - 2);
  return STOPS[i].map((from, c) => Math.round(from + (STOPS[i + 1][c] - from) * (at - i)));
};
const SPAN = WORDMARK[0].length - 1 + 2 * (WORDMARK.length - 1);
const GRADIENT = WORDMARK.map(
  (row, y) =>
    [...row].map((cell, x) => `\x1b[38;2;${gradient((x + 2 * y) / SPAN).join(';')}m${cell}`).join('') + '\x1b[0m',
);

test('FORCE_COLOR or CLICOLOR_FORCE draws the wordmark in a diagonal gradient, with a reset at each row end', () => {
  for (const colour of [{ FORCE_COLOR: '1' }, { CLICOLOR_FORCE: '1' }]) {
    const r = runCli(configFolder(), ['--help'], { env: colour });
    ok(r);
    assert.ok(r.stdout.startsWith(`${GRADIENT.join('\n')}\n`), JSON.stringify(colour) + JSON.stringify(r.stdout.slice(0, 400)));
  }
});

test('the wordmark is plain text off a terminal, with a FORCE_COLOR of 0, or with NO_COLOR, which beats FORCE_COLOR', () => {
  const usage = `${WORDMARK.join('\n')}\n${HEADER}\n\nUsage: claude-gauge `;
  for (const colour of [{}, { FORCE_COLOR: '0' }, { CLICOLOR_FORCE: '0' }, { NO_COLOR: '1', FORCE_COLOR: '1' }]) {
    const r = runCli(configFolder(), ['--help'], { env: colour });
    ok(r);
    assert.ok(r.stdout.startsWith(usage), JSON.stringify(colour) + JSON.stringify(r.stdout.slice(0, 400)));
  }
  const empty = runCli(configFolder(), ['--help'], { env: { NO_COLOR: '', FORCE_COLOR: '1' } });
  assert.ok(empty.stdout.startsWith(GRADIENT[0]), 'an empty NO_COLOR is no NO_COLOR');
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

// The command's look, after jv-k/VerBump's lib/styles.sh: inverted bold
// pills, coloured icons, green values and dim defaults.
const SGR = {
  section: '\x1b[7;1;36m',
  question: '\x1b[7;1;35m',
  errorPill: '\x1b[7;1;31m',
  warnPill: '\x1b[7;1;33m',
  ok: '\x1b[0;32m',
  warn: '\x1b[1;33m',
  error: '\x1b[0;31m',
  info: '\x1b[0;36m',
  dim: '\x1b[2m',
  reset: '\x1b[0m',
};
const pill = (text, code = SGR.section) => `${code} ${text} ${SGR.reset}`;
const icon = (code, glyph) => `${code}${glyph}${SGR.reset} `;
const green = (text) => `${SGR.ok}${text}${SGR.reset}`;
const OK = icon(SGR.ok, '✔');
const INFO = icon(SGR.info, 'ℹ');
const ERROR = icon(SGR.error, '✖');

// In colour the usage sits under a USAGE pill, as a command's result sits
// under its own, so its first line drops the Usage: that the pill now says.
// Under the wordmark, the version in a pill and the page as a link; the
// usage's names are green, and its placeholders dim.
const dim = (text) => `${SGR.dim}${text}${SGR.reset}`;
const HEADER_COLOUR = `${pill(`v${VERSION}`)}  \x1b]8;;${REPO_URL}\x07${green(REPO_URL)}\x1b]8;;\x07`;
const FORM_COLOUR = `${green('claude-gauge ')}${dim('<setup | configure | uninstall | update>')}${green(' ')}${dim('[switches]')}`;
const USAGE_PILL = `${GRADIENT.join('\n')}\n${HEADER_COLOUR}\n\n${pill('USAGE')}\n${FORM_COLOUR}\n`;

test('--version or -v prints the version alone', () => {
  const dir = configFolder();
  for (const flag of ['--version', '-v']) {
    const r = runCli(dir, [flag]);
    ok(r);
    assert.equal(r.stdout, `claude-gauge ${VERSION}\n`, flag);
  }
});

test('--help puts each section under its heading, with its names in a column and what they do wrapped to the terminal in the next', () => {
  const dir = configFolder();
  const wide = runCli(dir, ['--help'], { env: { NO_COLOR: '1', COLUMNS: '120' } });
  ok(wide);
  assert.match(wide.stdout, /\nCommands:\n {2}setup {7}add the status line/);
  assert.match(wide.stdout, /\nSwitches for update:\n {2}--dry-run {3}print the commands/, 'a column as wide as the section needs');
  assert.match(wide.stdout, /\nOther switches:\n {2}-h, --help {6}print this help\n {2}-v, --version {3}print the version of claude-gauge\n$/);
  assert.doesNotMatch(wide.stdout, /With none of the bar switches|under Options/);
  const narrow = runCli(dir, ['--help'], { env: { NO_COLOR: '1', COLUMNS: '50' } });
  ok(narrow);
  const usage = narrow.stdout.slice(narrow.stdout.indexOf('Commands:'));
  for (const line of usage.split('\n')) assert.ok(line.length <= 49, `${JSON.stringify(line)} fits in 50 columns`);
  assert.match(usage, /\n {2}setup {7}add the status line and the token\n {14}line to Claude Code's settings;/, 'what a command does wraps in its own column');
});

test('--help in colour puts a USAGE pill between the wordmark and the usage', () => {
  for (const colour of [{ FORCE_COLOR: '1' }, { CLICOLOR_FORCE: '1' }]) {
    const r = runCli(configFolder(), ['--help'], { env: colour });
    ok(r);
    assert.ok(r.stdout.startsWith(USAGE_PILL), JSON.stringify(colour) + JSON.stringify(r.stdout.slice(0, 400)));
    assert.doesNotMatch(r.stdout, /Usage:/);
  }
});

test('a bare claude-gauge in colour prints the USAGE pill over the usage, on stderr', () => {
  const bare = runCli(configFolder(), [], { env: { FORCE_COLOR: '1' } });
  assert.equal(bare.status, 2);
  assert.ok(bare.stderr.startsWith(USAGE_PILL), JSON.stringify(bare.stderr.slice(0, 400)));
});

test('a bare claude-gauge prints the wordmark and the usage, on stderr, and exits 2', () => {
  const bare = runCli(configFolder(), [], { env: { NO_COLOR: '1' } });
  assert.equal(bare.status, 2);
  assert.ok(bare.stderr.startsWith(`${WORDMARK.join('\n')}\n${HEADER}\n\nUsage: claude-gauge <setup | configure`), bare.stderr);
  assert.equal(bare.stdout, '');
});

test('the usage after a mistake starts with the wordmark, coloured by the gate on stderr', () => {
  const noCommand = runCli(configFolder(), ['--replace'], { env: { NO_COLOR: '1' } });
  assert.equal(noCommand.status, 2);
  assert.ok(noCommand.stderr.startsWith(`\nERROR\n✖ Name a command.\n\n${WORDMARK.join('\n')}\n${HEADER}\n\nUsage: claude-gauge `), noCommand.stderr);
  const unknown = runCli(configFolder(), ['launch'], { env: { FORCE_COLOR: '1' } });
  assert.equal(unknown.status, 2);
  assert.ok(unknown.stderr.startsWith(`\n${pill('ERROR', SGR.errorPill)}\n${ERROR}Unknown command: launch\n\n${USAGE_PILL}`), JSON.stringify(unknown.stderr.slice(0, 400)));
  assert.equal(unknown.stdout, '');
});

test('a hand-formatted settings.json keeps its tab indent and CRLF line ends', () => {
  const dir = configFolder();
  fs.writeFileSync(path.join(dir, 'settings.json'), '{\r\n\t"model": "opus"\r\n}\r\n');
  ok(runCli(dir, ['setup', '--yes']));
  const text = fs.readFileSync(path.join(dir, 'settings.json'), 'utf8');
  assert.match(text, /^\{\r\n\t"model": "opus",\r\n\t"statusLine": \{\r\n\t\t"type": "command",/);
  assert.ok(!/[^\r]\n/.test(text), 'every line ends in CRLF');
});

test('configure stops at hooks it cannot read, with a message, not a crash', () => {
  const dir = configFolder({ statusLine: cmd('node ~/.claude/claude-gauge/dist/statusline.js'), hooks: { Stop: { hooks: [] } } });
  const r = runCli(dir, ['configure', '--token-line', '']);
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
  ok(runCli(dir, ['setup', '--yes', '--replace']));
  fs.chmodSync(dotfiles, 0o555);
  try {
    const r = runCli(dir, ['uninstall']);
    assert.equal(r.status, 1);
  } finally {
    fs.chmodSync(dotfiles, 0o755);
  }
  assert.deepEqual(JSON.parse(fs.readFileSync(savedStatusLine(dir), 'utf8')), { statusLine: cmd('~/bin/my-status.sh') });
  ok(runCli(dir, ['uninstall']));
  assert.deepEqual(settingsOf(dir), { statusLine: cmd('~/bin/my-status.sh') });
});

test('uninstall stops at a saved status line it cannot read, and keeps the settings and the file', () => {
  const dir = configFolder({ statusLine: cmd('~/bin/my-status.sh') });
  ok(runCli(dir, ['setup', '--yes', '--replace']));
  const before = fs.readFileSync(path.join(dir, 'settings.json'), 'utf8');
  fs.writeFileSync(savedStatusLine(dir), '{ "statusLine": ');
  const r = runCli(dir, ['uninstall']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /previous-statusline\.json .*Fix or delete it by hand/);
  assert.equal(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'), before);
  assert.equal(fs.readFileSync(savedStatusLine(dir), 'utf8'), '{ "statusLine": ');
});

// The wizard, driven through the process with answers piped on stdin. PATH
// holds only `bin`, so gh is there only when a test puts a fake one in.
const ask = (dir, args, answers, { bin = emptyBin(), env = {} } = {}) =>
  runCli(dir, args, { env: { PATH: bin, Path: bin, ...env }, input: answers.map((a) => `${a}\n`).join('') });

const emptyBin = () => tempDir('claude-gauge-bin-');

// A folder holding a fake gh that logs each call's arguments, one call a line.
function fakeGh() {
  const bin = emptyBin();
  const log = path.join(bin, 'calls.log');
  fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\necho "$*" >> '${log}'\n`, { mode: 0o755 });
  return { bin, calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : []) };
}

test('setup with no switches asks, and one yes installs both bars as --yes does', () => {
  const dir = configFolder();
  const r = ask(dir, ['setup'], ['y']);
  ok(r);
  const runtime = runtimeOf(dir);
  assert.deepEqual(settingsOf(dir), {
    statusLine: cmd(commandFor(path.join(runtime, 'statusline.js'), DEFAULTS)),
    hooks: { Stop: [entry(commandFor(path.join(runtime, 'tokenline.js'), DEFAULTS))] },
  });
  const out = plain(r.stdout);
  assert.match(out, /ctx 43% /, 'a preview from the sample payload');
  assert.match(out, /Use the defaults/);
  assert.match(out, /new Claude Code session/);
  assert.doesNotMatch(out, /Star /, 'no gh, no star offer');
});

test('the setup and configure questions start with the wordmark and a blank line', () => {
  const dir = configFolder();
  const setup = ask(dir, ['setup'], ['y'], { env: { NO_COLOR: '1' } });
  ok(setup);
  assert.ok(setup.stdout.startsWith(`${WORDMARK.join('\n')}\n\nSETUP\n\nStatus line, with the defaults\n\n`), setup.stdout);
  const configure = ask(dir, ['configure'], ['keep'], { env: { NO_COLOR: '1' } });
  ok(configure);
  assert.ok(configure.stdout.startsWith(`${WORDMARK.join('\n')}\n\nCONFIGURE\n\nStatus line, as set up now\n\n`), configure.stdout);
  const coloured = ask(dir, ['configure'], ['keep'], { env: { NO_COLOR: '', FORCE_COLOR: '1' } });
  ok(coloured);
  assert.ok(coloured.stdout.startsWith(`${GRADIENT.join('\n')}\n\n${pill('CONFIGURE')}\n\n\x1b[2mStatus line, as set up now\x1b[0m\n\n`), JSON.stringify(coloured.stdout.slice(0, 400)));
});

test('the commands run with switches print no wordmark, so scripts and the slash commands get short output', () => {
  const dir = configFolder();
  for (const args of [['setup', '--yes'], ['configure', '--status-line', '--segments 10'], ['configure', '--no-token-line'], ['update'], ['uninstall']]) {
    const r = runCli(dir, args, { env: { FORCE_COLOR: '1' } });
    ok(r);
    const out = plain(r.stdout + r.stderr);
    assert.ok(WORDMARK.every((row) => !out.includes(row.trimEnd())), `${args.join(' ')} printed the wordmark:\n${out}`);
  }
});

test('the wizard previews the payload the status line saved', () => {
  const dir = configFolder();
  fs.mkdirSync(path.join(dir, 'claude-gauge', '.state'), { recursive: true });
  const saved = { model: { display_name: 'Saved Model' }, context_window: { used_percentage: 77 } };
  fs.writeFileSync(path.join(dir, 'claude-gauge', '.state', 'last-payload.json'), JSON.stringify(saved));
  const r = ask(dir, ['setup'], ['n', '1', 'model,ctx', '', '', 'mono', 'n', '', '', '']);
  ok(r);
  const out = plain(r.stdout);
  assert.match(out, /Saved Model/);
  assert.match(out, /  Saved Model │ 77% /, 'the preview redrawn without labels');
});

test('the customise path writes the switches chosen, and can leave the token line out', () => {
  const dir = configFolder();
  ok(ask(dir, ['setup'], ['n', '2', 'ctx,5h', 'model', 'classic', '10', 'pastel', 'n', 'n', 'y']));
  assert.deepEqual(settingsOf(dir), {
    statusLine: cmd(commandFor(path.join(runtimeOf(dir), 'statusline.js'), ['--show', 'ctx,5h', '--show', 'model', '--segments', '10', '--theme', 'pastel', '--no-labels'])),
  });
});

test('the token line parts the wizard is given go into the Stop hook command, and Enter adds no --show', () => {
  const tokenLine = (dir) => settingsOf(dir).hooks.Stop[0].hooks[0].command;
  const script = (dir) => path.join(runtimeOf(dir), 'tokenline.js');
  const enter = configFolder();
  ok(ask(enter, ['setup'], ['n', '', '', '', 'classic', '', '', '', '', '', 'y']));
  assert.equal(tokenLine(enter), commandFor(script(enter)));

  const fewer = configFolder();
  const r = ask(fewer, ['setup'], ['n', '', '', '', 'classic', '', '', '', '', 'req,bogus', 'req,out,ctx', 'y']);
  ok(r);
  assert.match(r.stdout, /Unknown part: bogus/);
  assert.equal(tokenLine(fewer), commandFor(script(fewer), ['--show', 'req,out,ctx']));

  // configure starts from that --show and keeps the --window set up.
  ok(runCli(fewer, ['configure', '--token-line', '--show req,out,ctx --window 1m']));
  const again = ask(fewer, ['configure'], ['change', '', '', '', '', '', '', '', '', 'ctx', 'y']);
  ok(again);
  assert.match(again.stdout, /Token line parts.*\[req,out,ctx\]/);
  assert.equal(tokenLine(fewer), commandFor(script(fewer), ['--show', 'ctx', '--window', '1m']));
});

test('setup asks no context window question, and configure keeps the --window set up exactly as it is', () => {
  const tokenLine = (dir) => settingsOf(dir).hooks.Stop[0].hooks[0].command;
  const script = (dir) => path.join(runtimeOf(dir), 'tokenline.js');
  const dir = configFolder();
  const r = ask(dir, ['setup'], ['n', '', '', '', 'classic', '', '', '', '', 'req,out,ctx', 'y']);
  ok(r);
  assert.doesNotMatch(r.stdout, /context window/i);
  assert.equal(tokenLine(dir), commandFor(script(dir), ['--show', 'req,out,ctx']));

  // A --window set up by hand stays, as written, whether the parts change or not.
  ok(runCli(dir, ['configure', '--token-line', '--window=1M --show req,out,ctx']));
  ok(ask(dir, ['configure'], ['change', '', '', '', '', '', '', '', '', '', 'y']));
  assert.equal(tokenLine(dir), commandFor(script(dir), ['--window=1M', '--show', 'req,out,ctx']));
  const changed = ask(dir, ['configure'], ['change', '', '', '', '', '', '', '', '', 'ctx', 'y']);
  ok(changed);
  assert.doesNotMatch(changed.stdout, /context window/i);
  assert.equal(tokenLine(dir), commandFor(script(dir), ['--show', 'ctx', '--window=1M']));
});

test('a no at the last question, or answers that end early, change nothing', () => {
  const dir = configFolder();
  const declined = ask(dir, ['setup'], ['n', '', '', '', 'classic', '', '', '', '', '', 'n']);
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
  assert.match(kept.stdout, /\nWARNING\n! .*settings\.json already runs another status line:\n  ↳ ~\/bin\/my-status\.sh\n/, 'a yellow pill, a !, and the command under it');
  assert.match(kept.stdout, /Nothing changed/);
  assert.equal(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'), original);

  ok(ask(dir, ['setup'], ['y', 'y']));
  assert.match(settingsOf(dir).statusLine.command, /statusline\.js --bar-style dots$/);
  assert.deepEqual(JSON.parse(fs.readFileSync(savedStatusLine(dir), 'utf8')), { statusLine: mine });
});

test('configure with no switches runs the wizard on a set-up config, and offers no star', () => {
  const dir = configFolder();
  assert.equal(ask(dir, ['configure'], ['keep']).status, 1, 'not set up yet');
  ok(runCli(dir, ['setup', '--yes']));
  const gh = fakeGh();
  // From the defaults, in dots: no cells question.
  const r = ask(dir, ['configure'], ['change', '1', 'ctx', '', '', '', '', '', 'y'], { bin: gh.bin });
  ok(r);
  assert.equal(settingsOf(dir).statusLine.command, commandFor(path.join(runtimeOf(dir), 'statusline.js'), ['--show', 'ctx', ...DEFAULTS]));
  assert.doesNotMatch(r.stdout, /Star /);
  assert.deepEqual(gh.calls(), []);
});

test('configure starts from the bars set up: a yes keeps the status line and adds no token line', () => {
  const dir = configFolder();
  ok(runCli(dir, ['setup', '--status-line', '--segments 10 --theme mono', '--no-token-line']));
  const before = fs.readFileSync(path.join(dir, 'settings.json'), 'utf8');
  const r = ask(dir, ['configure'], ['keep']);
  ok(r);
  assert.match(r.stdout, /Keep the current lines/);
  assert.match(r.stdout, /Nothing to change/);
  assert.equal(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'), before);
  assert.equal(settingsOf(dir).hooks, undefined);
});

test('a yes to keeping the bars leaves a command written by hand exactly as it is, and copies no scripts', () => {
  const statusLine = "FORCE_COLOR=1 node ~/.claude/claude-gauge/statusline.js --text 'a b' --segments 10";
  const dir = configFolder({ statusLine: cmd(statusLine), hooks: { Stop: [entry('node ~/.claude/claude-gauge/tokenline.js'), entry('node ~/.claude/claude-gauge/tokenline.js --window 1m')] } });
  const before = fs.readFileSync(path.join(dir, 'settings.json'), 'utf8');
  const r = ask(dir, ['configure'], ['keep']);
  ok(r);
  assert.match(r.stdout, /Nothing to change/);
  assert.equal(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'), before);
  assert.ok(!fs.existsSync(runtimeOf(dir)), 'no scripts copied');
});

test('configure keeps a quoted value and a switch it does not know, whichever path the answers take', () => {
  const dir = configFolder();
  const script = (name) => path.join(runtimeOf(dir), name);
  const status = ['--show', 'text,ctx', '--text', 'my label', '--frobnicate'];
  ok(runCli(dir, ['setup', '--yes']));
  const settings = settingsOf(dir);
  settings.statusLine.command = commandFor(script('statusline.js'), status);
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(settings, null, 2) + '\n');
  const before = fs.readFileSync(path.join(dir, 'settings.json'), 'utf8');

  ok(ask(dir, ['configure'], ['keep']));
  assert.equal(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'), before);

  // One row set up, a bar size changed, the rest kept with Enter.
  ok(ask(dir, ['configure'], ['change', '', '', '', '10', '', '', '', '', 'y']));
  assert.deepEqual(settingsOf(dir), {
    statusLine: cmd(commandFor(script('statusline.js'), ['--show', 'text,ctx', '--segments', '10', '--text', 'my label', '--frobnicate'])),
    hooks: { Stop: [entry(commandFor(script('tokenline.js')))] },
  });
});

test('setup ends by offering to star the repo with gh, and stars it on a yes or Enter', { skip: process.platform === 'win32' && 'the fake gh is a shell script' }, () => {
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

  const enter = fakeGh();
  ok(ask(configFolder(), ['setup'], ['y', ''], { bin: enter.bin }));
  assert.deepEqual(enter.calls().filter((c) => !c.startsWith('--version')), ['api --method PUT user/starred/jv-k/claude-gauge'], 'Enter stars the repo');
});

test('with colour on, each command prints a pill header, icons and green values', () => {
  const dir = configFolder();
  const env = { FORCE_COLOR: '1' };
  const script = (name) => path.join(runtimeOf(dir), name);

  const setup = runCli(dir, ['setup', '--yes'], { env });
  ok(setup);
  assert.ok(setup.stdout.startsWith(`\n${pill('SETUP')}\n`), JSON.stringify(setup.stdout));
  assert.ok(setup.stdout.includes(`${OK}Status line: ${green(commandFor(script('statusline.js'), DEFAULTS))}\n`), JSON.stringify(setup.stdout));
  assert.ok(setup.stdout.includes(`${OK}Token line: ${green(commandFor(script('tokenline.js'), DEFAULTS))}\n`), JSON.stringify(setup.stdout));
  assert.ok(setup.stdout.includes(`${INFO}Start a new Claude Code session`), JSON.stringify(setup.stdout));

  const configure = runCli(dir, ['configure', '--no-token-line'], { env });
  ok(configure);
  assert.ok(configure.stdout.startsWith(`\n${pill('CONFIGURE')}\n`), JSON.stringify(configure.stdout));
  assert.ok(configure.stdout.includes(`${INFO}Token line: not set up\n`), JSON.stringify(configure.stdout));
  assert.ok(configure.stdout.includes(`${INFO}Backup of the previous settings: ${SGR.ok}`), JSON.stringify(configure.stdout));

  const update = runCli(dir, ['update'], { env });
  ok(update);
  assert.ok(update.stdout.startsWith(`\n${pill('UPDATE')}\n`), JSON.stringify(update.stdout));
  const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.ok(update.stdout.includes(`${OK}Updated claude-gauge in ${green(runtimeOf(dir))} to ${green(version)}.\n`), JSON.stringify(update.stdout));

  const uninstall = runCli(dir, ['uninstall'], { env });
  ok(uninstall);
  assert.ok(uninstall.stdout.startsWith(`\n${pill('UNINSTALL')}\n`), JSON.stringify(uninstall.stdout));
  assert.ok(uninstall.stdout.includes(`${OK}Took claude-gauge out of ${green(path.join(dir, 'settings.json'))}.\n`), JSON.stringify(uninstall.stdout));

  // An error: a red pill and a red ✖, on stderr.
  const failed = runCli(configFolder(), ['update'], { env });
  assert.equal(failed.status, 1);
  assert.ok(failed.stderr.startsWith(`\n${pill('ERROR', SGR.errorPill)}\n${ERROR}There is no copy`), JSON.stringify(failed.stderr));
  assert.equal(failed.stdout, '');
});

// The values in an error are green too, as they are in a result (#119).
test('an error in colour prints its values green: the folder update cannot find, and a settings file that is not valid JSON', () => {
  const env = { FORCE_COLOR: '1' };
  const empty = configFolder();
  const missing = runCli(empty, ['update'], { env });
  assert.equal(missing.status, 1);
  assert.ok(
    missing.stderr.startsWith(`\n${pill('ERROR', SGR.errorPill)}\n${ERROR}There is no copy of claude-gauge in ${green(runtimeOf(empty))} to update. Run claude-gauge setup first.\n`),
    JSON.stringify(missing.stderr),
  );

  const dir = configFolder();
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, '{ not json');
  const broken = runCli(dir, ['setup', '--yes'], { env });
  assert.equal(broken.status, 1);
  assert.ok(broken.stderr.startsWith(`\n${pill('ERROR', SGR.errorPill)}\n${ERROR}${green(file)} is not valid JSON (`), JSON.stringify(broken.stderr));
  // Node's own words stay plain: the only green is the path.
  assert.equal(broken.stderr.split(SGR.ok).length, 2, JSON.stringify(broken.stderr));

  // A status line that is not claude-gauge's: the command under the path is
  // green on its own ↳ line.
  const other = configFolder({ statusLine: { type: 'command', command: '~/bin/my-status.sh' } });
  const blocked = runCli(other, ['setup', '--yes'], { env });
  assert.equal(blocked.status, 1);
  assert.ok(
    blocked.stderr.includes(`${ERROR}${green(path.join(other, 'settings.json'))} already runs another status line:\n  ${SGR.dim}↳ ${green('~/bin/my-status.sh')}${SGR.reset}\n`),
    JSON.stringify(blocked.stderr),
  );

  // A known command and a known switch in a mistake are values too, but a
  // word claude-gauge does not know stays plain.
  const stray = runCli(empty, ['update', '--replace'], { env });
  assert.equal(stray.status, 2);
  assert.ok(stray.stderr.includes(`${ERROR}${green('update')} takes no ${green('--replace')}\n`), JSON.stringify(stray.stderr));
  const bare = runCli(empty, ['setup', '--status-line'], { env });
  assert.equal(bare.status, 2);
  assert.ok(bare.stderr.includes(`${ERROR}${green('--status-line')} needs a value: `), JSON.stringify(bare.stderr));

  // With colour off the same errors are the plain text.
  const offStray = runCli(empty, ['update', '--replace'], { env: { NO_COLOR: '1' } });
  assert.ok(offStray.stderr.startsWith('\nERROR\n✖ update takes no --replace\n'), offStray.stderr);
  const off = runCli(dir, ['setup', '--yes'], { env: { NO_COLOR: '1' } });
  assert.ok(off.stderr.startsWith(`\nERROR\n✖ ${file} is not valid JSON (`), off.stderr);
  assert.ok(!/\x1b/.test(off.stderr), JSON.stringify(off.stderr));
});

test('with NO_COLOR, or piped with no force variable, the output has no escape codes, and each pill reads as plain text', () => {
  for (const env of [{}, { NO_COLOR: '1', FORCE_COLOR: '1' }]) {
    const dir = configFolder();
    const script = (name) => path.join(runtimeOf(dir), name);
    const setup = runCli(dir, ['setup', '--yes'], { env });
    ok(setup);
    assert.equal(
      setup.stdout,
      [
        '',
        'SETUP',
        `✔ Status line: ${commandFor(script('statusline.js'), DEFAULTS)}`,
        `✔ Token line: ${commandFor(script('tokenline.js'), DEFAULTS)}`,
        'ℹ Start a new Claude Code session to pick up the changes.',
        '',
      ].join('\n'),
      JSON.stringify(env),
    );
    const runs = [
      runCli(dir, ['configure', '--status-line', '--segments 10'], { env }),
      runCli(dir, ['update'], { env }),
      runCli(dir, ['uninstall'], { env }),
      runCli(dir, ['update', '--bogus'], { env }),
      runCli(configFolder(), ['update'], { env }),
      ask(configFolder(), ['setup'], ['maybe', 'n', '', '', '', '', '', '', '', '', '', 'y'], { env }),
    ];
    for (const r of runs) assert.ok(!/\x1b/.test(r.stdout + r.stderr), JSON.stringify(r.stdout + r.stderr));
    assert.match(runs[1].stdout, /^\nUPDATE\n✔ Updated claude-gauge in /);
    assert.match(runs[2].stdout, /^\nUNINSTALL\n✔ Took claude-gauge out of /);
    assert.ok(runs[3].stderr.startsWith('\nERROR\n✖ Unknown switch: --bogus\n'), runs[3].stderr);
    assert.ok(runs[4].stderr.startsWith('\nERROR\n✖ There is no copy of claude-gauge in '), runs[4].stderr);
    assert.match(runs[5].stdout, /\nCONFIRM\nUse the defaults/);
    assert.match(runs[5].stdout, /\nSTATUS LINE\n/);
    assert.match(runs[5].stdout, /\nINPUT\nHow many status line rows/);
    assert.match(runs[5].stdout, /\nDONE\n✔ Status line: /);
  }
});

test('the wizard with colour on: magenta question pills, dim defaults in brackets, and a yellow ! before a retry', () => {
  const r = ask(configFolder(), ['setup'], ['maybe', 'y'], { env: { FORCE_COLOR: '1' } });
  ok(r);
  assert.ok(r.stdout.includes(`\n${pill('SETUP')}\n`), JSON.stringify(r.stdout));
  assert.ok(r.stdout.includes(`\n${pill('CONFIRM', SGR.question)}\nUse the defaults: both lines, with the parts above? ${SGR.dim}[Y/n]${SGR.reset} `), JSON.stringify(r.stdout));
  assert.ok(r.stdout.includes(`${icon(SGR.warn, '!')}Answer y or n.\n`), JSON.stringify(r.stdout));
  assert.ok(r.stdout.includes(`\n${pill('DONE')}\n${OK}Status line: `), JSON.stringify(r.stdout));
});

test('a piped answer is written after its question, so a retry starts a line of its own', () => {
  const r = ask(configFolder(), ['setup'], ['maybe', 'y'], { env: { NO_COLOR: '1' } });
  ok(r);
  assert.ok(r.stdout.includes('[Y/n] maybe\n! Answer y or n.\nUse the defaults: both lines, with the parts above? [Y/n] y\n'), JSON.stringify(r.stdout));
});
