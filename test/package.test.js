'use strict';

// The release workflow publishes the package to npm from a version tag, so
// package.json must be publishable and must ship the built lines. VerBump
// only bumps, tags and pushes: the workflow creates the GitHub release.

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

test('package.json is publishable', () => {
  assert.notEqual(pkg.private, true);
  assert.ok(pkg.name);
  assert.ok(pkg.version);
});

test('package.json names the repository by URL, as npm provenance needs', () => {
  assert.equal(pkg.repository.url, 'git+https://github.com/jv-k/claude-gauge.git');
});

test('every bin entry is a built line that Node runs', () => {
  const bins = Object.entries(pkg.bin || {});
  assert.ok(bins.length > 0, 'package.json has no bin');
  for (const [name, file] of bins) {
    assert.match(file, /^dist\/[^/]+\.js$/, `${name} points outside dist/`);
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    assert.ok(text.startsWith('#!/usr/bin/env node\n'), `${file} has no node shebang`);
  }
});

test('bump-release leaves the GitHub release to the release workflow', () => {
  assert.doesNotMatch(pkg.scripts['bump-release'], /--release\b/);
  assert.match(pkg.scripts['bump-release'], /--push origin/);
});

// What npm publish would upload, from npm's own file list. dist/ is in
// .gitignore on integration/1.0, so this proves the files field wins.
function packedFiles() {
  const out = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    // npm is npm.cmd on Windows, which runs only through a shell (#3 plans
    // CI there).
    shell: process.platform === 'win32',
  });
  return JSON.parse(out)[0].files.map((f) => f.path).sort();
}

test('the package ships the built lines, and no sources or tests', () => {
  const files = packedFiles();
  for (const file of ['dist/statusline.js', 'dist/tokenline.js', 'package.json', 'README.md', 'LICENSE']) {
    assert.ok(files.includes(file), `the package lacks ${file}`);
  }
  const extra = files.filter((f) => !f.startsWith('dist/') && !['package.json', 'README.md', 'LICENSE'].includes(f));
  assert.deepEqual(extra, []);
});
