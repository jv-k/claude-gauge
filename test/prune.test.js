'use strict';

// Issue #51: the transcript reader's state files are pruned by age. A render
// removes those no render has touched for 30 days, at most once a day, behind
// a stamp file in the state folder.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { pruneTranscriptStates, readTranscriptActivity } = require('../dist/statusline.js');

const { tempDir, configFolder } = require('./helpers');

const NOW = Date.parse('2026-10-11T12:00:00Z');
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

// A state file as the reader names one: the SHA-1 of the transcript's path.
const stateName = (transcript) => `${createHash('sha1').update(transcript).digest('hex')}.json`;

// Writes a file in dir last changed at the given time, and returns its path.
function fileAt(dir, name, ms) {
  const file = path.join(dir, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, '{}');
  fs.utimesSync(file, ms / 1000, ms / 1000);
  return file;
}

// The reader's folder, transcripts in a state folder of its own, and the
// stamp file beside it.
function stateFolder() {
  const dir = path.join(tempDir(), 'transcripts');
  return { dir, stamp: `${dir}.pruned` };
}

test('a state file last changed 31 days ago is removed, and one changed 29 days ago stays', () => {
  const { dir } = stateFolder();
  const old = fileAt(dir, stateName('/old.jsonl'), NOW - 31 * DAY);
  const recent = fileAt(dir, stateName('/recent.jsonl'), NOW - 29 * DAY);
  pruneTranscriptStates(dir, NOW);
  assert.equal(fs.existsSync(old), false);
  assert.equal(fs.existsSync(recent), true);
});

test('with a stamp file 2 hours old, no state file is removed, whatever its age', () => {
  const { dir, stamp } = stateFolder();
  fileAt(path.dirname(stamp), path.basename(stamp), NOW - 2 * HOUR);
  const ancient = fileAt(dir, stateName('/ancient.jsonl'), NOW - 400 * DAY);
  const old = fileAt(dir, stateName('/old.jsonl'), NOW - 31 * DAY);
  pruneTranscriptStates(dir, NOW);
  assert.equal(fs.existsSync(ancient), true);
  assert.equal(fs.existsSync(old), true);
  assert.equal(fs.statSync(stamp).mtimeMs, NOW - 2 * HOUR);
});

test('with a stamp file 25 hours old, the prune runs and the stamp file is updated', () => {
  const { dir, stamp } = stateFolder();
  fileAt(path.dirname(stamp), path.basename(stamp), NOW - 25 * HOUR);
  const old = fileAt(dir, stateName('/old.jsonl'), NOW - 31 * DAY);
  pruneTranscriptStates(dir, NOW);
  assert.equal(fs.existsSync(old), false);
  assert.equal(fs.statSync(stamp).mtimeMs, NOW);
});

test('with no stamp file, the prune runs and writes one', () => {
  const { dir, stamp } = stateFolder();
  const old = fileAt(dir, stateName('/old.jsonl'), NOW - 31 * DAY);
  pruneTranscriptStates(dir, NOW);
  assert.equal(fs.existsSync(old), false);
  assert.equal(fs.statSync(stamp).mtimeMs, NOW);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('a prune that hits a missing file, or a missing folder, does not throw and prunes the rest', () => {
  const { dir, stamp } = stateFolder();
  const old = fileAt(dir, stateName('/old.jsonl'), NOW - 31 * DAY);
  const raced = fileAt(dir, stateName('/raced.jsonl'), NOW - 31 * DAY);
  const gone = stateName('/gone.jsonl');
  // Another render removes one file between the listing and its stat, and
  // another between its stat and its removal.
  const io = { ...fs };
  io.readdirSync = (...args) => [gone, ...fs.readdirSync(...args)];
  io.rmSync = (file, ...rest) => {
    if (file === raced) {
      fs.rmSync(file);
      throw Object.assign(new Error('gone'), { code: 'ENOENT' });
    }
    return fs.rmSync(file, ...rest);
  };
  assert.doesNotThrow(() => pruneTranscriptStates(dir, NOW, { fs: io }));
  assert.equal(fs.existsSync(old), false);
  assert.equal(fs.statSync(stamp).mtimeMs, NOW);
  assert.doesNotThrow(() => pruneTranscriptStates(path.join(dir, 'missing'), NOW));
});

test("only the reader's state files are pruned, not other files in its folder", () => {
  const { dir, stamp } = stateFolder();
  const other = fileAt(dir, 'notes.json', NOW - 31 * DAY);
  fileAt(path.dirname(stamp), path.basename(stamp), NOW - 40 * DAY);
  pruneTranscriptStates(dir, NOW);
  assert.equal(fs.existsSync(other), true);
  assert.equal(fs.statSync(stamp).mtimeMs, NOW);
});

// A session transcript with one running subagent, and the subagent's own
// transcript and meta file in the folder Claude Code writes beside it.
function sessionWithSubagent() {
  const dir = tempDir();
  const file = path.join(dir, 'session.jsonl');
  const call = { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Agent', input: { subagent_type: 'Explore', description: 'Map it' } }] } };
  fs.writeFileSync(file, `${JSON.stringify(call)}\n`);
  const folder = path.join(dir, 'session', 'subagents');
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'agent-a1.meta.json'), JSON.stringify({ toolUseId: 't1' }));
  const transcript = path.join(folder, 'agent-a1.jsonl');
  const reply = { type: 'assistant', isSidechain: true, message: { role: 'assistant', model: 'claude-haiku-4-5', content: [] } };
  fs.writeFileSync(transcript, `${JSON.stringify(reply)}\n`);
  return { file, transcript, stateDir: path.join(dir, 'state') };
}

test('a render that uses a state file updates its last change time, even when its transcript gained nothing', () => {
  const { file, transcript, stateDir } = sessionWithSubagent();
  assert.equal(readTranscriptActivity(file, { stateDir }).agents[0].model, 'Haiku 4.5');
  const states = [file, transcript].map((t) => path.join(stateDir, stateName(t)));
  for (const state of states) fs.utimesSync(state, (NOW - 31 * DAY) / 1000, (NOW - 31 * DAY) / 1000);

  const before = Date.now();
  readTranscriptActivity(file, { stateDir });
  for (const state of states) assert.ok(fs.statSync(state).mtimeMs >= before - 1000, `${path.basename(state)} was not touched`);
  // So a live session's state files outlast the prune.
  pruneTranscriptStates(stateDir, Date.now());
  for (const state of states) assert.equal(fs.existsSync(state), true);
});

test('a render prunes the state folder under the Claude config folder, after it prints, in the terminal and with --latest', () => {
  for (const args of [['--show', 'model'], ['--latest', '--show', 'model']]) {
    const config = configFolder();
    const dir = path.join(config, 'claude-gauge', '.state', 'transcripts');
    const old = fileAt(dir, stateName('/old.jsonl'), Date.now() - 31 * DAY);
    const recent = fileAt(dir, stateName('/recent.jsonl'), Date.now() - 29 * DAY);
    const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'dist', 'statusline.js'), ...args], {
      cwd: config,
      env: { ...process.env, CLAUDE_CONFIG_DIR: config, CLAUDE_CODE_SESSION_ID: '' },
      input: JSON.stringify({ model: { display_name: 'Opus' } }),
      encoding: 'utf8',
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stderr, '');
    assert.equal(fs.existsSync(old), false, `${args.join(' ')} left the old state file`);
    assert.equal(fs.existsSync(recent), true);
    assert.ok(fs.existsSync(path.join(config, 'claude-gauge', '.state', 'transcripts.pruned')));
  }
});

test('a render prunes the saved window sizes by the same rule, with a stamp of their own', () => {
  for (const args of [['--show', 'model'], ['--latest', '--show', 'model']]) {
    const config = configFolder();
    const dir = path.join(config, 'claude-gauge', '.state', 'windows');
    const old = fileAt(dir, stateName('old-session'), Date.now() - 31 * DAY);
    const recent = fileAt(dir, stateName('recent-session'), Date.now() - 29 * DAY);
    const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'dist', 'statusline.js'), ...args], {
      cwd: config,
      env: { ...process.env, CLAUDE_CONFIG_DIR: config, CLAUDE_CODE_SESSION_ID: '' },
      input: JSON.stringify({ model: { display_name: 'Opus' } }),
      encoding: 'utf8',
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.existsSync(old), false, `${args.join(' ')} left the old window file`);
    assert.equal(fs.existsSync(recent), true);
    assert.ok(fs.existsSync(path.join(config, 'claude-gauge', '.state', 'windows.pruned')));
  }
});

test('with no reader folder yet, the prune still writes the stamp, so the next render makes one stat and nothing more', () => {
  const { dir, stamp } = stateFolder();
  pruneTranscriptStates(dir, NOW);
  assert.equal(fs.statSync(stamp).mtimeMs, NOW);
  assert.equal(fs.existsSync(dir), false);

  const calls = [];
  const io = { ...fs };
  for (const name of ['statSync', 'readdirSync', 'rmSync', 'writeFileSync', 'utimesSync']) {
    io[name] = (...args) => {
      calls.push(name);
      return fs[name](...args);
    };
  }
  pruneTranscriptStates(dir, NOW + HOUR, { fs: io });
  assert.deepEqual(calls, ['statSync']);
});
