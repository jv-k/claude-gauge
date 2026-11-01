'use strict';

// The release workflow starts on a full tag such as v1.0.0 and on a
// pre-release tag such as v1.0.0-rc.1. A full tag publishes to npm as latest
// and makes a normal GitHub release. A pre-release tag publishes under the
// dist-tag next and makes a GitHub pre-release (docs/adr/0001). The workflow
// runs only on GitHub, so these tests read .github/workflows/release.yml: they
// match tags against its filters by GitHub's rules, and run the shell of its
// release and publish steps with stand-ins for gh and npm.

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const workflow = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'release.yml'), 'utf8');

// The patterns of `on.push.tags`, written as one flow sequence.
function tagFilters() {
  const match = /^ {4}tags: \[(.*)\]$/m.exec(workflow);
  assert.ok(match, 'release.yml has no on.push.tags line');
  return match[1].split(',').map((item) => item.trim().replace(/^'(.*)'$/, '$1'));
}

// A regular expression for a GitHub filter pattern: `*` is any run of
// characters but `/`, `**` any run at all, `+` one or more and `?` zero or one
// of the character before, `[...]` one character of the set, and every other
// character itself.
// https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#filter-pattern-cheat-sheet
function filterRegExp(pattern) {
  let source = '';
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === '*' && pattern[i + 1] === '*') {
      source += '.*';
      i++;
    } else if (char === '*') source += '[^/]*';
    else if (char === '+' || char === '?') source += char;
    else if (char === '[') {
      const end = pattern.indexOf(']', i);
      source += pattern.slice(i, end + 1);
      i = end;
    } else source += char.replace(/[\\^$.|(){}]/g, '\\$&');
  }
  return new RegExp(`^${source}$`);
}

const starts = (tag) => tagFilters().some((pattern) => filterRegExp(pattern).test(tag));

test('the workflow starts on a full release tag and on a pre-release tag', () => {
  for (const tag of ['v1.0.0', 'v12.30.4', 'v1.0.0-rc.1', 'v2.0.0-beta.3']) {
    assert.ok(starts(tag), `${tag} does not start the workflow`);
  }
});

test('the workflow does not start on a tag that is not a version', () => {
  for (const tag of ['v1.0', '1.0.0', '1.0.0-rc.1', 'v1.0.0.0', 'vx.y.z', 'v1.0.0-rc/1']) {
    assert.ok(!starts(tag), `${tag} starts the workflow`);
  }
});

// The `run: |` shell of the step named `name`.
function stepScript(name) {
  const lines = workflow.split('\n');
  const start = lines.indexOf(`      - name: ${name}`);
  assert.ok(start >= 0, `release.yml has no step named ${name}`);
  const end = lines.findIndex((line, i) => i > start && /^ {6}- /.test(line));
  const step = lines.slice(start, end < 0 ? lines.length : end);
  const run = step.indexOf('        run: |');
  assert.ok(run >= 0, `the step ${name} has no run: | block`);
  return step
    .slice(run + 1)
    .filter((line) => line.startsWith('          ') || line === '')
    .map((line) => line.slice(10))
    .join('\n');
}

// The `env:` value that the step named `name` gives `key`.
function stepEnv(name, key) {
  const lines = workflow.split('\n');
  const start = lines.indexOf(`      - name: ${name}`);
  const end = lines.findIndex((line, i) => i > start && /^ {6}- /.test(line));
  const step = lines.slice(start, end < 0 ? lines.length : end).join('\n');
  const match = new RegExp(`^ {10}${key}: (.*)$`, 'm').exec(step);
  return match ? match[1] : null;
}

test('the release and publish steps read whether the tag is a pre-release', () => {
  const read = 'Read whether the tag is a pre-release';
  assert.match(workflow, new RegExp(`- name: ${read}\\n {8}id: tag\\n {8}run: node scripts/release-tag\\.js "\\$\\{GITHUB_REF_NAME\\}" >> "\\$\\{GITHUB_OUTPUT\\}"`));
  // Both read it before anything is public.
  assert.ok(workflow.indexOf(read) < workflow.indexOf('Create the GitHub release'));
  for (const step of ['Create the GitHub release', 'Publish to npm with provenance']) {
    assert.equal(stepEnv(step, 'PRERELEASE'), '${{ steps.tag.outputs.prerelease }}', step);
  }
});

// Runs the shell of a step in bash, with gh and npm replaced by scripts that
// log their arguments, and returns the logged commands. `gh release view`
// fails unless `existing` is set, as it does for a release not yet made.
function runStep(name, env, { existing = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-gauge-release-step-'));
  const bin = path.join(dir, 'bin');
  const log = path.join(dir, 'commands.log');
  fs.mkdirSync(bin);
  for (const command of ['gh', 'npm']) {
    const view = command === 'gh' ? `[ "$1 $2" = "release view" ] && exit ${existing ? 0 : 1}\n` : '';
    fs.writeFileSync(path.join(bin, command), `#!/bin/sh\n${view}echo "${command} $*" >> "${log}"\n`, { mode: 0o755 });
  }
  const result = spawnSync('bash', ['-e', '-c', stepScript(name)], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, RUNNER_TEMP: dir, ...env },
  });
  assert.equal(result.status, 0, result.stderr);
  const commands = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : [];
  return commands.map((line) => line.replaceAll(dir, '$RUNNER_TEMP'));
}

// The stand-ins are POSIX shell scripts, and the workflow runs on Linux.
const shell = { skip: process.platform === 'win32' && 'the release steps run in bash on Linux' };

test('a full release tag publishes as before: latest on npm, a normal GitHub release', shell, () => {
  const env = { GITHUB_REF_NAME: 'v1.0.0', PRERELEASE: 'false' };
  assert.deepEqual(runStep('Publish to npm with provenance', env), ['npm publish --provenance --access public']);
  assert.deepEqual(runStep('Create the GitHub release', env), [
    'gh release create v1.0.0 --verify-tag --title v1.0.0 --notes-file $RUNNER_TEMP/notes.md',
  ]);
});

test('a pre-release tag publishes under next, as a GitHub pre-release', shell, () => {
  const env = { GITHUB_REF_NAME: 'v1.0.0-rc.1', PRERELEASE: 'true' };
  assert.deepEqual(runStep('Publish to npm with provenance', env), ['npm publish --provenance --access public --tag next']);
  assert.deepEqual(runStep('Create the GitHub release', env), [
    'gh release create v1.0.0-rc.1 --verify-tag --prerelease --title v1.0.0-rc.1 --notes-file $RUNNER_TEMP/notes.md',
  ]);
});

test('a rerun leaves a GitHub release that exists already', shell, () => {
  for (const PRERELEASE of ['true', 'false']) {
    assert.deepEqual(runStep('Create the GitHub release', { GITHUB_REF_NAME: 'v1.0.0-rc.1', PRERELEASE }, { existing: true }), []);
  }
});
