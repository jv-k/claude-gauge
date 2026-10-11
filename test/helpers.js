'use strict';

// The helpers the suites share. This file holds no tests: scripts/test.js and
// the Bun job run only the test/*.test.js files, so it never shows in a run.

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');
const dist = path.join(root, 'dist');

// The text as a terminal shows it: the SGR colour codes and the OSC 8 link
// wrappers taken out.
const plain = (s) => s.replace(/\x1b\[[0-9;]*m/g, '').replace(/\x1b\]8;;[^\x07]*\x07/g, '');

// A temporary folder of its own, removed when the process ends.
const made = [];
process.once('exit', () => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
});
function tempDir(prefix = 'claude-gauge-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(dir);
  return dir;
}

// A Claude config folder of its own, with settings.json holding `settings`
// when given.
function configFolder(settings) {
  const dir = tempDir('claude-gauge-config-');
  if (settings !== undefined) fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(settings, null, 2) + '\n');
  return dir;
}

// Runs the CLI against the config folder `dir`, with `env` added and `input`
// on stdin. The build's CLI unless `cli` names another, such as a copy in a
// plugin version folder. The colour variables are only as `env` sets them, so
// a NO_COLOR or FORCE_COLOR in the shell that runs the suite changes nothing.
// The rest of the suite's environment passes through, NODE_V8_COVERAGE
// included, so the Coverage job counts the lines the CLI runs here.
function runCli(dir, args, { cli = path.join(dist, 'cli.js'), env = {}, input } = {}) {
  const base = { ...process.env, CLAUDE_CONFIG_DIR: dir };
  for (const name of ['NO_COLOR', 'FORCE_COLOR', 'CLICOLOR_FORCE']) delete base[name];
  return spawnSync(process.execPath, [cli, ...args], { env: { ...base, ...env }, input, encoding: 'utf8' });
}

// Passes when the CLI exited 0, else fails with what it printed.
const ok = (r) => assert.equal(r.status, 0, `exit ${r.status}\n${r.stdout}\n${r.stderr}`);

// Where setup copies the two scripts to, under the config folder `dir`.
const runtimeOf = (dir) => path.join(dir, 'claude-gauge', 'runtime');

const settingsOf = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));

// A command entry as settings.json holds one, and a hook entry of commands.
const cmd = (command) => ({ type: 'command', command });
const entry = (...commands) => ({ hooks: commands.map(cmd) });

// The CLI's source, which holds the USAGE text that `claude-gauge --help`
// prints. The suites read the source because dist/ exports no USAGE.
const cliSource = () => fs.readFileSync(path.join(root, 'src', 'cli.ts'), 'utf8');

// A switch as the CLI and the two bars spell one: --yes, --show, --12h.
const SWITCH = '--[a-z0-9][a-z0-9-]*';

// Every switch named in `text`, in order.
const switchesIn = (text) => [...text.matchAll(new RegExp(SWITCH, 'g'))].map((m) => m[0]);

// The switch `text` starts with, or undefined.
const switchAt = (text) => new RegExp(`^${SWITCH}`).exec(text)?.[0];

// The switches in the CLI's USAGE text: each line of it that starts with a
// switch, such as `  --replace   ...`, or with a short name and then the
// switch, such as `  -y, --yes   ...`.
function usageSwitches(source) {
  const usage = /const USAGE = `([^`]*)`/.exec(source);
  if (!usage) throw new Error('src/cli.ts has no USAGE text');
  return [...usage[1].matchAll(new RegExp(`^ +(?:-[a-z0-9], +)?(${SWITCH})`, 'gm'))].map((m) => m[1]);
}

module.exports = { root, dist, plain, tempDir, configFolder, runCli, ok, runtimeOf, settingsOf, cmd, entry, cliSource, switchesIn, switchAt, usageSwitches };
