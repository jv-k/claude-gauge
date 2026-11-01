'use strict';

// The release workflow publishes a full tag such as v1.0.0 to npm as latest,
// and a pre-release tag such as v1.0.0-rc.1 under the dist-tag next, as a
// GitHub pre-release (docs/adr/0001). scripts/release-tag.js makes that call.

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { releaseTag } = require('../scripts/release-tag.js');

const script = path.join(__dirname, '..', 'scripts', 'release-tag.js');

test('releaseTag reads a full release tag', () => {
  assert.deepEqual(releaseTag('v1.0.0'), { version: '1.0.0', prerelease: false });
  assert.deepEqual(releaseTag('v12.30.4'), { version: '12.30.4', prerelease: false });
});

test('releaseTag reads a pre-release tag', () => {
  assert.deepEqual(releaseTag('v1.0.0-rc.1'), { version: '1.0.0-rc.1', prerelease: true });
  assert.deepEqual(releaseTag('v2.0.0-beta.3'), { version: '2.0.0-beta.3', prerelease: true });
  assert.deepEqual(releaseTag('v2.0.0-alpha'), { version: '2.0.0-alpha', prerelease: true });
  assert.deepEqual(releaseTag('v2.0.0-0.3.7'), { version: '2.0.0-0.3.7', prerelease: true });
});

test('releaseTag refuses a tag that is not a version', () => {
  for (const tag of ['v1.0', '1.0.0', 'v1.0.0.0', 'v1.0.0-', 'v1.0.0-rc..1', 'v1.0.0-rc.1+build.5', 'v01.0.0', 'v1.0.0-rc.01', 'vx.y.z', '']) {
    assert.equal(releaseTag(tag), null, tag);
  }
});

function run(args) {
  return spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
}

// The workflow appends the output to $GITHUB_OUTPUT.
test('the script prints prerelease=false for a full release tag', () => {
  const result = run(['v1.0.0']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'prerelease=false\n');
});

test('the script prints prerelease=true for a pre-release tag', () => {
  const result = run(['v1.0.0-rc.1']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'prerelease=true\n');
});

test('the script fails, and says why, for a tag that is not a version', () => {
  const result = run(['v1.0.0-rc.1+build.5']);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /v1\.0\.0-rc\.1\+build\.5/);
});

test('the script fails without a tag', () => {
  const result = run([]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /usage/i);
});
