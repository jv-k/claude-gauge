'use strict';

// The plugin route: the CLI run from a version folder in Claude Code's plugin
// cache, as the plugin's slash commands run it, and the launcher that setup
// points the settings at. Claude Code keeps each installed plugin version in
// <plugins>/cache/<marketplace>/<plugin>/<version>/ and deletes an old one
// some days after an update, so the settings must never name a version
// folder: the launcher finds the newest one each time it runs.

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { commandFor } = require('../dist/settings.js');
const { configFolder, runCli, settingsOf } = require('./helpers');

const root = path.join(__dirname, '..');
const dist = path.join(root, 'dist');

const versionsOf = (dir) => path.join(dir, 'plugins', 'cache', 'claude-gauge', 'claude-gauge');

// One installed plugin version, as Claude Code copies it into the cache: the
// repository with its built dist/.
function installVersion(dir, version) {
  const folder = path.join(versionsOf(dir), version);
  fs.mkdirSync(path.join(folder, 'dist'), { recursive: true });
  fs.mkdirSync(path.join(folder, '.claude-plugin'), { recursive: true });
  for (const f of fs.readdirSync(dist)) fs.copyFileSync(path.join(dist, f), path.join(folder, 'dist', f));
  fs.copyFileSync(path.join(root, 'package.json'), path.join(folder, 'package.json'));
  fs.copyFileSync(path.join(root, '.claude-plugin', 'plugin.json'), path.join(folder, '.claude-plugin', 'plugin.json'));
  return folder;
}

// A version whose two scripts print where they ran from, their switches and
// their input, so a test can tell which version the launcher picked.
function fakeVersion(dir, version) {
  const folder = path.join(versionsOf(dir), version);
  fs.mkdirSync(path.join(folder, 'dist'), { recursive: true });
  for (const script of ['statusline.js', 'tokenline.js']) {
    fs.writeFileSync(
      path.join(folder, 'dist', script),
      `let input = ''; process.stdin.on('data', (c) => (input += c)); process.stdin.on('end', () => {
  process.stdout.write(${JSON.stringify(version + ' ' + script)} + ' ' + process.argv.slice(2).join(' ') + ' <' + input + '>');
  process.exitCode = 3;
});\n`,
    );
  }
  return folder;
}

const runLauncher = (dir, script, args = [], input = '') =>
  spawnSync(process.execPath, [path.join(launcherOf(dir), script), ...args], { env: { ...process.env, CLAUDE_CONFIG_DIR: dir }, input, encoding: 'utf8' });

const launcherOf = (dir) => path.join(dir, 'claude-gauge', 'launcher');
const runtimeOf = (dir) => path.join(dir, 'claude-gauge', 'runtime');
const ok = (r) => assert.equal(r.status, 0, `exit ${r.status}\n${r.stdout}\n${r.stderr}`);
const cmd = (command) => ({ type: 'command', command });
const entry = (...commands) => ({ hooks: commands.map(cmd) });

test('setup run from the plugin cache points the settings at the launcher, never at a version folder', () => {
  const dir = configFolder({ model: 'opus' });
  const plugin = installVersion(dir, '1.0.0');
  ok(runCli(dir, ['setup', '--status-line', '--show ctx,5h,7d --segments 10', '--token-line', '--window 1m'], { cli: path.join(plugin, 'dist', 'cli.js') }));

  const launcher = launcherOf(dir);
  assert.deepEqual(settingsOf(dir), {
    model: 'opus',
    statusLine: cmd(commandFor(path.join(launcher, 'statusline.js'), '--show ctx,5h,7d --segments 10')),
    hooks: { Stop: [entry(commandFor(path.join(launcher, 'tokenline.js'), '--window 1m'))] },
  });
  assert.ok(!JSON.stringify(settingsOf(dir)).replace(/\\\\/g, '/').includes('plugins/cache'), 'no version folder in the settings');
  assert.ok(!fs.existsSync(runtimeOf(dir)), 'the plugin route copies no runtime');
});

test('the three commands write the same settings on the plugin route as on the terminal route, but for the script folder', () => {
  // Each run is the commands one slash command session would run, in order.
  const sessions = [
    [['setup', '--status-line', '--show ctx,5h,7d --show time,model --theme pastel', '--token-line', '--show req,ctx --window 1m', '--replace']],
    [['setup', '--yes', '--replace'], ['configure', '--status-line', '--segments 10', '--no-token-line'], ['configure', '--token-line', '--window 1m']],
    [['setup', '--status-line', '', '--no-token-line', '--replace'], ['configure', '--no-status-line'], ['uninstall']],
    [['setup', '--yes', '--replace'], ['uninstall']],
  ];
  for (const commands of sessions) {
    const before = { statusLine: cmd('~/bin/my-status.sh'), hooks: { Stop: [entry('afplay done.aiff')] } };
    const npm = configFolder(before);
    const viaPlugin = configFolder(before);
    const pluginCli = path.join(installVersion(viaPlugin, '1.0.0'), 'dist', 'cli.js');
    for (const args of commands) {
      ok(runCli(npm, args));
      ok(runCli(viaPlugin, args, { cli: pluginCli }));
      const asLauncher = JSON.stringify(settingsOf(npm)).split(runtimeOf(npm).replace(/\\/g, '/')).join(launcherOf(viaPlugin).replace(/\\/g, '/'));
      assert.deepEqual(settingsOf(viaPlugin), JSON.parse(asLauncher), args.join(' '));
    }
  }
});

test('the launcher runs the installed status line with the switches and input Claude Code gives it', () => {
  const dir = configFolder();
  const plugin = installVersion(dir, '1.0.0');
  ok(runCli(dir, ['setup', '--yes'], { cli: path.join(plugin, 'dist', 'cli.js') }));

  const payload = JSON.stringify({ model: { display_name: 'Opus' }, context_window: { used_percentage: 25 } });
  const line = runLauncher(dir, 'statusline.js', ['--show', 'ctx,model'], payload);
  assert.equal(line.status, 0, line.stderr);
  assert.match(line.stdout.replace(/\x1b\[[0-9;]*m/g, ''), /ctx 25%.*Opus/);
  const direct = spawnSync(process.execPath, [path.join(plugin, 'dist', 'statusline.js'), '--show', 'ctx,model'], {
    env: { ...process.env, CLAUDE_CONFIG_DIR: dir },
    input: payload,
    encoding: 'utf8',
  });
  assert.equal(line.stdout, direct.stdout);
});

test('the launcher picks the newest installed version, by version number, then by install time', () => {
  const dir = configFolder();
  const plugin = installVersion(dir, '1.0.0');
  ok(runCli(dir, ['setup', '--yes'], { cli: path.join(plugin, 'dist', 'cli.js') }));
  fakeVersion(dir, '1.9.0');
  fakeVersion(dir, '1.10.0');

  // 1.10.0 is newer than 1.9.0, though it sorts first as text. The exit
  // status, the switches and the input pass through.
  const r = runLauncher(dir, 'statusline.js', ['--show', 'ctx'], '{"a":1}');
  assert.equal(r.stdout, '1.10.0 statusline.js --show ctx <{"a":1}>');
  assert.equal(r.status, 3);
  assert.match(runLauncher(dir, 'tokenline.js').stdout, /^1\.10\.0 tokenline\.js/);

  // Claude Code marks the version an update replaced with .orphaned_at
  // before it deletes it.
  fs.writeFileSync(path.join(versionsOf(dir), '1.10.0', '.orphaned_at'), String(Date.now()));
  assert.match(runLauncher(dir, 'statusline.js').stdout, /^1\.9\.0 /);

  // A plugin with no version in its manifest is installed under a commit
  // SHA, which says nothing about order: the newest folder wins.
  const empty = configFolder();
  ok(runCli(empty, ['setup', '--yes'], { cli: path.join(installVersion(empty, '0123456789ab'), 'dist', 'cli.js') }));
  const older = fakeVersion(empty, 'aaaaaaaaaaaa');
  const newer = fakeVersion(empty, 'ffffffffffff');
  const time = (s) => new Date(Date.UTC(2026, 0, 1) + s * 1000);
  fs.utimesSync(path.join(versionsOf(empty), '0123456789ab'), time(0), time(0));
  fs.utimesSync(newer, time(2), time(2));
  fs.utimesSync(older, time(1), time(1));
  assert.match(runLauncher(empty, 'statusline.js').stdout, /^ffffffffffff /);
});

test('the launcher prints nothing and exits 0 when no version is installed', () => {
  const dir = configFolder();
  const plugin = installVersion(dir, '1.0.0');
  ok(runCli(dir, ['setup', '--yes'], { cli: path.join(plugin, 'dist', 'cli.js') }));
  fs.rmSync(path.join(dir, 'plugins'), { recursive: true, force: true });
  for (const script of ['statusline.js', 'tokenline.js']) {
    const r = runLauncher(dir, script, [], '{}');
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
    assert.equal(r.stderr, '');
  }
  // A version folder without the script is not an installed version either.
  fs.mkdirSync(path.join(versionsOf(dir), '2.0.0'), { recursive: true });
  assert.equal(runLauncher(dir, 'statusline.js').stdout, '');

  // Nor is one that `/plugin uninstall` marked for deletion: Claude Code
  // keeps the folder for some days after it writes .orphaned_at.
  const gone = fakeVersion(dir, '1.0.0');
  assert.match(runLauncher(dir, 'statusline.js').stdout, /^1\.0\.0 /);
  fs.writeFileSync(path.join(gone, '.orphaned_at'), String(Date.now()));
  const r = runLauncher(dir, 'statusline.js', [], '{}');
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
});

test('configure and uninstall from the plugin cache keep the launcher and restore the status line', () => {
  const before = { statusLine: cmd('~/bin/my-status.sh'), hooks: { Stop: [entry('afplay done.aiff')] } };
  const dir = configFolder(before);
  const cli = path.join(installVersion(dir, '1.0.0'), 'dist', 'cli.js');
  ok(runCli(dir, ['setup', '--yes', '--replace'], { cli }));
  ok(runCli(dir, ['configure', '--status-line', '--segments 10'], { cli }));
  assert.equal(settingsOf(dir).statusLine.command, commandFor(path.join(launcherOf(dir), 'statusline.js'), '--segments 10'));
  ok(runCli(dir, ['uninstall'], { cli }));
  assert.deepEqual(settingsOf(dir), before);
});

test('update from the plugin cache says the plugin updates itself', () => {
  const dir = configFolder();
  const cli = path.join(installVersion(dir, '1.0.0'), 'dist', 'cli.js');
  ok(runCli(dir, ['setup', '--yes'], { cli }));
  const r = runCli(dir, ['update'], { cli });
  ok(r);
  assert.match(r.stdout, /\/plugin/);
  assert.match(r.stdout, /newest/);
});
