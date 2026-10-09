'use strict';

// The release workflow takes the GitHub release's body from the CHANGELOG
// section of the tagged version, and fails when that section is missing.

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { releaseNotes } = require('../scripts/release-notes.js');

const script = path.join(__dirname, '..', 'scripts', 'release-notes.js');

// VerBump writes a flat heading, or a linked one in its grouped style.
const changelog = [
  '## [1.1.0](https://github.com/jv-k/claude-gauge/compare/v1.0.0...v1.1.0) (2026-11-02)',
  '',
  '### Features',
  '',
  '- show the cost',
  '',
  '## 1.0.0 (2026-10-20)',
  '- feat: first release',
  '- fix: quote the switches',
  '',
  '## 0.9.0 (2026-10-01)',
  '- chore: the beta',
  '',
].join('\n');

test('releaseNotes returns the section of the tagged version, without its heading', () => {
  assert.equal(releaseNotes(changelog, 'v1.0.0'), '- feat: first release\n- fix: quote the switches');
});

test('releaseNotes reads a linked heading', () => {
  assert.equal(releaseNotes(changelog, 'v1.1.0'), '### Features\n\n- show the cost');
});

test('releaseNotes reads the last section to the end of the file', () => {
  assert.equal(releaseNotes(changelog, 'v0.9.0'), '- chore: the beta');
});

test('releaseNotes accepts a version without the v prefix', () => {
  assert.equal(releaseNotes(changelog, '1.0.0'), '- feat: first release\n- fix: quote the switches');
});

test('releaseNotes returns null when the version has no section', () => {
  assert.equal(releaseNotes(changelog, 'v2.0.0'), null);
});

test('releaseNotes does not match a version that only starts with the tagged one', () => {
  assert.equal(releaseNotes('## 1.0.10 (2026-12-01)\n- later\n', 'v1.0.1'), null);
});

test('releaseNotes does not match the version inside a section body', () => {
  assert.equal(releaseNotes('## 1.1.0 (2026-11-02)\n- 1.0.0 had a bug\n', 'v1.0.0'), null);
});

test('releaseNotes handles CRLF line ends', () => {
  assert.equal(releaseNotes('## 1.0.0 (2026-10-20)\r\n- first\r\n', 'v1.0.0'), '- first');
});

function run(args) {
  return spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
}

function tempChangelog(text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-gauge-release-'));
  const file = path.join(dir, 'CHANGELOG.md');
  fs.writeFileSync(file, text);
  return file;
}

test('the script prints the section of the tagged version', () => {
  const result = run(['v1.0.0', tempChangelog(changelog)]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '- feat: first release\n- fix: quote the switches\n');
});

test('the script fails, and says why, when the version has no section', () => {
  const file = tempChangelog(changelog);
  const result = run(['v2.0.0', file]);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /2\.0\.0/);
  assert.match(result.stderr, /CHANGELOG\.md/);
  // The tag is public by then, so the way on is the next version.
  assert.match(result.stderr, /next/);
});

test('the script fails when the section is empty', () => {
  const result = run(['v1.0.0', tempChangelog('## 1.0.0 (2026-10-20)\n\n## 0.9.0 (2026-10-01)\n- beta\n')]);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
});

test('the script fails when the changelog does not exist', () => {
  const result = run(['v1.0.0', path.join(os.tmpdir(), 'claude-gauge-no-such-dir', 'CHANGELOG.md')]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /CHANGELOG\.md/);
});

test('the script fails without a tag', () => {
  const result = run([]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /usage/i);
});
