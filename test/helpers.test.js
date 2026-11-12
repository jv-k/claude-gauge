'use strict';

// The suites use the helpers they share, rather than make by hand what a
// helper already makes.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// A tempDir call with the default prefix, which says nothing of what the
// folder is for.
const plainFolder = String.raw`tempDir\((?:'claude-gauge-')?\)`;

// The lines of `source` that make a folder with the default prefix and use it
// as CLAUDE_CONFIG_DIR: straight into the variable, into a binding or key
// named config, or into a binding the file then passes as CLAUDE_CONFIG_DIR.
// A folder that is a config folder and something more, such as the wizard's
// git repository, takes a prefix of its own and is not one of these.
function handMadeConfigFolders(source) {
  const lines = source.split('\n');
  const passed = (name) => new RegExp(String.raw`CLAUDE_CONFIG_DIR(?::|\s*=)\s*${name}\b`).test(source);
  const found = [];
  lines.forEach((line, i) => {
    if (!new RegExp(plainFolder).test(line)) return;
    const bound = line.match(new RegExp(String.raw`(?:const|let)\s+(\w+)\s*=\s*${plainFolder}`));
    if (/CLAUDE_CONFIG_DIR|\bconfig\b/.test(line) || (bound && passed(bound[1]))) found.push(`${i + 1}: ${line.trim()}`);
  });
  return found;
}

test('the check finds each shape of hand-made config folder, and passes configFolder() and other folders', () => {
  const made = (line) => handMadeConfigFolders(line).length;
  assert.equal(made("const env = { ...process.env, CLAUDE_CONFIG_DIR: tempDir('claude-gauge-') };"), 1);
  assert.equal(made('const config = tempDir();'), 1);
  assert.equal(made("const [home, config] = [tempDir('claude-gauge-'), tempDir('claude-gauge-')];"), 1);
  assert.equal(made("latestRun('node', { config: tempDir('claude-gauge-'), home });"), 1);
  assert.equal(made("const tmp = tempDir('claude-gauge-');\nconst env = { CLAUDE_CONFIG_DIR: tmp };"), 1);
  assert.equal(made('const config = configFolder();'), 0);
  assert.equal(made("const home = tempDir('claude-gauge-');"), 0);
  assert.equal(made("const dir = tempDir('claude-gauge-wizard-');\nconst options = { env: { CLAUDE_CONFIG_DIR: dir } };"), 0);
  assert.equal(made("const dir = tempDir();\nconst env = { CLAUDE_CONFIG_DIR: path.join(dir, 'config') };"), 0);
});

test('the suites make each Claude config folder with configFolder(), not with tempDir() by hand', () => {
  // This file's own samples are the shapes the check looks for.
  const found = fs
    .readdirSync(__dirname)
    .filter((name) => name.endsWith('.test.js') && name !== path.basename(__filename))
    .flatMap((name) => handMadeConfigFolders(fs.readFileSync(path.join(__dirname, name), 'utf8')).map((line) => `${name}:${line}`));
  assert.deepEqual(found, []);
});
