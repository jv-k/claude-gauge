'use strict';

// The tools part and the transcript reader behind it. The reader reads a
// transcript only when a transcript part is shown, and only the bytes
// appended since the last render.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { render, parseArgs, readTranscriptActivity } = require('../dist/statusline.js');

const { plain, tempDir } = require('./helpers');

const CWD = '/home/me/project';
// A path relative to CWD as the part prints it, with this system's separator.
const rel = (p) => p.replaceAll('/', path.sep);

// Transcript records as Claude Code writes them: a tool call in an assistant
// message, its result in the next user message.
const toolUse = (id, name, input = {}, extra = {}) => ({
  type: 'assistant',
  ...extra,
  message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
});
const toolResult = (id, extra = {}) => ({
  type: 'user',
  ...extra,
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] },
});
const prompt = (text) => ({ type: 'user', message: { role: 'user', content: text } });
const jsonl = (records) => records.map((r) => `${JSON.stringify(r)}\n`).join('');

// Renders the given switches over a payload whose transcript is file, read
// by reader (the real one by default, with its state in stateDir, a folder
// of its own unless one is given, so a test never writes the real one).
const renderTools = (file, { args = ['--show', 'tools'], stateDir = path.join(tempDir(), 'state'), reader } = {}) =>
  plain(
    render(
      { workspace: { current_dir: CWD }, transcript_path: file },
      { config: parseArgs(args), branchOf: () => 'main', transcript: reader ?? ((f) => readTranscriptActivity(f, { stateDir })) },
    ),
  );

// The real fs, counting the transcript bytes it reads.
function countingFs() {
  const io = { ...fs, bytes: 0 };
  io.readSync = (...args) => {
    const n = fs.readSync(...args);
    io.bytes += n;
    return n;
  };
  return io;
}

test('tools shows the running tool with its target, and completed tools with counts', () => {
  const activity = { tools: { running: [{ name: 'Edit', target: `${CWD}/src/a.ts` }], completed: { Read: 12, Bash: 3 } } };
  assert.equal(renderTools('/t.jsonl', { reader: () => activity }), `◐ Edit ${rel('src/a.ts')} ✓ Read ×12 ✓ Bash ×3`);
});

test('tools reads them from the transcript', () => {
  const dir = tempDir();
  const file = path.join(dir, 'session.jsonl');
  const reads = Array.from({ length: 12 }, (_, i) => [toolUse(`r${i}`, 'Read', { file_path: `${CWD}/f${i}.ts` }), toolResult(`r${i}`)]).flat();
  fs.writeFileSync(file, jsonl([prompt('go'), ...reads, toolUse('e1', 'Edit', { file_path: `${CWD}/src/a.ts` })]));
  assert.equal(renderTools(file, { stateDir: path.join(dir, 'state') }), `◐ Edit ${rel('src/a.ts')} ✓ Read ×12`);
});

test('no transcript read happens when no transcript part is shown', () => {
  let reads = 0;
  const reader = () => {
    reads++;
    return { tools: { running: [], completed: {} } };
  };
  renderTools('/t.jsonl', { args: [], reader });
  renderTools('/t.jsonl', { args: ['--show', 'ctx,model', '--show', 'dir'], reader });
  assert.equal(reads, 0);
  renderTools('/t.jsonl', { args: ['--show', 'model', '--show', 'tools'], reader });
  assert.equal(reads, 1);
});

test('the reader reads only the bytes appended since the last render', () => {
  const dir = tempDir();
  const stateDir = path.join(dir, 'state');
  const file = path.join(dir, 'session.jsonl');
  fs.writeFileSync(file, jsonl([prompt('go'), toolUse('a', 'Read', { file_path: `${CWD}/a.ts` }), toolResult('a')]));

  const first = countingFs();
  readTranscriptActivity(file, { stateDir, fs: first });
  assert.equal(first.bytes, fs.statSync(file).size);

  const appended = jsonl([toolUse('b', 'Bash', { command: 'pnpm test' })]);
  fs.appendFileSync(file, appended);
  const second = countingFs();
  const activity = readTranscriptActivity(file, { stateDir, fs: second });
  assert.equal(second.bytes, Buffer.byteLength(appended));
  assert.deepEqual(activity.tools, { running: [{ name: 'Bash', target: 'pnpm test' }], completed: { Read: 1 } });

  // Nothing new: nothing read.
  const third = countingFs();
  readTranscriptActivity(file, { stateDir, fs: third });
  assert.equal(third.bytes, 0);
});

test('a line still being written is read once it is complete', () => {
  const dir = tempDir();
  const stateDir = path.join(dir, 'state');
  const file = path.join(dir, 'session.jsonl');
  const line = JSON.stringify(toolUse('a', 'Grep', { pattern: 'TODO' }));
  fs.writeFileSync(file, line.slice(0, 20));
  assert.deepEqual(readTranscriptActivity(file, { stateDir }).tools, { running: [], completed: {} });
  fs.appendFileSync(file, `${line.slice(20)}\n`);
  assert.deepEqual(readTranscriptActivity(file, { stateDir }).tools, { running: [{ name: 'Grep', target: 'TODO' }], completed: {} });
});

test('a line longer than one read, with characters split across reads, is read whole', () => {
  const dir = tempDir();
  const file = path.join(dir, 'session.jsonl');
  const big = { ...toolResult('a'), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: 'é✓'.repeat(100_000) }] } };
  fs.writeFileSync(file, jsonl([toolUse('a', 'Read', { file_path: `${CWD}/big.txt` }), big, toolUse('b', 'Edit', { file_path: `${CWD}/é.ts` })]));
  assert.equal(renderTools(file), '◐ Edit é.ts ✓ Read ×1');
});

test('a truncated transcript is read again from the start', () => {
  const dir = tempDir();
  const stateDir = path.join(dir, 'state');
  const file = path.join(dir, 'session.jsonl');
  fs.writeFileSync(file, jsonl([toolUse('a', 'Read'), toolResult('a'), toolUse('b', 'Read'), toolResult('b')]));
  readTranscriptActivity(file, { stateDir });

  fs.truncateSync(file, 0);
  fs.appendFileSync(file, jsonl([toolUse('c', 'Edit'), toolResult('c')]));
  const io = countingFs();
  assert.deepEqual(readTranscriptActivity(file, { stateDir, fs: io }).tools, { running: [], completed: { Edit: 1 } });
  assert.equal(io.bytes, fs.statSync(file).size);
});

test('a replaced transcript is read again from the start, even when it is longer', () => {
  const dir = tempDir();
  const stateDir = path.join(dir, 'state');
  const file = path.join(dir, 'session.jsonl');
  fs.writeFileSync(file, jsonl([toolUse('a', 'Read'), toolResult('a')]));
  readTranscriptActivity(file, { stateDir });

  const next = path.join(dir, 'next.jsonl');
  fs.writeFileSync(next, jsonl([toolUse('b', 'Write'), toolResult('b'), toolUse('c', 'Write'), toolResult('c'), toolUse('d', 'Glob', { pattern: '**/*.ts' })]));
  fs.renameSync(next, file);
  const io = countingFs();
  assert.deepEqual(readTranscriptActivity(file, { stateDir, fs: io }).tools, {
    running: [{ name: 'Glob', target: '**/*.ts' }],
    completed: { Write: 2 },
  });
  assert.equal(io.bytes, fs.statSync(file).size);
});

test('a new prompt ends the tools still marked running, and subagent records are left out', () => {
  const dir = tempDir();
  const file = path.join(dir, 'session.jsonl');
  fs.writeFileSync(
    file,
    jsonl([
      toolUse('a', 'Bash', { command: 'sleep 100' }),
      prompt('stop that'),
      toolUse('s', 'Read', {}, { isSidechain: true }),
      toolResult('s', { isSidechain: true }),
      toolUse('w', 'WebFetch', { url: 'https://example.com/docs' }),
    ]),
  );
  assert.equal(renderTools(file, { stateDir: path.join(dir, 'state') }), '◐ WebFetch https://example.com/docs');
});

test('a result that arrives after a prompt still counts', () => {
  const dir = tempDir();
  const file = path.join(dir, 'session.jsonl');
  fs.writeFileSync(file, jsonl([toolUse('a', 'Bash', { command: 'make' }), prompt('<local-command-stdout>done</local-command-stdout>'), toolResult('a')]));
  assert.equal(renderTools(file), '✓ Bash ×1');
});

test('a task notification is not a prompt: the tools running then still show as running', () => {
  const dir = tempDir();
  const file = path.join(dir, 'session.jsonl');
  const notification = {
    type: 'user',
    origin: { kind: 'task-notification' },
    message: { role: 'user', content: '<task-notification>\n<task-id>b1</task-id>\n<tool-use-id>x</tool-use-id>\n<status>completed</status>\n</task-notification>' },
  };
  fs.writeFileSync(file, jsonl([toolUse('a', 'Bash', { command: 'make' }), notification]));
  assert.equal(renderTools(file), '◐ Bash make');
});

test('every call in a parallel batch counts, however many run at once', () => {
  const dir = tempDir();
  const file = path.join(dir, 'session.jsonl');
  const ids = Array.from({ length: 25 }, (_, i) => `r${i}`);
  fs.writeFileSync(file, jsonl([...ids.map((id) => toolUse(id, 'Read')), ...ids.map((id) => toolResult(id))]));
  assert.equal(renderTools(file), '✓ Read ×25');
  // Calls a prompt ended are kept only up to a cap, oldest dropped first, so
  // a result that never comes cannot grow the state for ever.
  fs.writeFileSync(file, jsonl([...ids.map((id) => toolUse(id, 'Bash')), prompt('stop'), ...ids.map((id) => toolResult(id))]));
  assert.equal(renderTools(file), '✓ Bash ×20');
});

test('tools shows the five most used tools, and long targets cut to 30 characters', () => {
  const completed = { Read: 1, Edit: 9, Bash: 4, Grep: 4, Glob: 2, Write: 7 };
  const running = [{ name: 'Bash', target: 'pnpm exec tsc --noEmit --pretty false --project tsconfig.json' }];
  assert.equal(
    renderTools('/t.jsonl', { reader: () => ({ tools: { running, completed } }) }),
    '◐ Bash pnpm exec tsc --noEmit --pret… ✓ Edit ×9 ✓ Write ×7 ✓ Bash ×4 ✓ Grep ×4 ✓ Glob ×2',
  );
  // A path keeps its end, where the file name is.
  const deep = [{ name: 'Read', target: `${CWD}/src/components/settings/panels/advanced.tsx` }];
  assert.equal(renderTools('/t.jsonl', { reader: () => ({ tools: { running: deep, completed: {} } }) }), `◐ Read …${rel('/settings/panels/advanced.tsx')}`);
});

test('tools has nothing to show without a transcript or tool calls', () => {
  let reads = 0;
  const reader = () => (reads++, { tools: { running: [], completed: {} } });
  assert.equal(plain(render({}, { config: parseArgs(['--show', 'tools,model']), transcript: reader })), '');
  assert.equal(reads, 0);
  assert.equal(renderTools('/t.jsonl', { reader }), '');
  // A missing transcript file is nothing to show, not a failure.
  const dir = tempDir();
  assert.equal(renderTools(path.join(dir, 'gone.jsonl'), { stateDir: path.join(dir, 'state') }), '');
});

test('tool names and targets from the transcript print without their control codes', () => {
  const HOSTILE = '\x1b[2J\x1b]0;pwned\x07‮';
  const activity = { tools: { running: [{ name: `Ed${HOSTILE}it`, target: `src/${HOSTILE}a.ts` }], completed: { [`Re${HOSTILE}ad`]: 2 } } };
  const raw = render({ workspace: { current_dir: CWD }, transcript_path: '/t.jsonl' }, { config: parseArgs(['--show', 'tools']), transcript: () => activity });
  assert.doesNotMatch(raw.replace(/\x1b\[[0-9;]*m/g, ''), /[\x00-\x1f\x7f-\x9f‮]/);
  assert.equal(plain(raw), '◐ Edit src/a.ts ✓ Read ×2');
});

test('the program keeps its transcript state under CLAUDE_CONFIG_DIR', () => {
  const dir = tempDir();
  const configDir = path.join(dir, 'config');
  const file = path.join(dir, 'session.jsonl');
  fs.writeFileSync(file, jsonl([toolUse('a', 'Read', { file_path: path.join(dir, 'a.ts') }), toolResult('a')]));
  const payload = JSON.stringify({ workspace: { current_dir: dir }, transcript_path: file });
  const run = (args) =>
    plain(
      execFileSync(process.execPath, [path.join(__dirname, '..', 'dist', 'statusline.js'), ...args], {
        env: { ...process.env, CLAUDE_CONFIG_DIR: configDir, COLUMNS: '' },
        input: payload,
        encoding: 'utf8',
      }),
    );
  // No transcript part shown: no state.
  run(['--show', 'dir']);
  assert.equal(fs.existsSync(path.join(configDir, 'claude-gauge', '.state', 'transcripts')), false);
  assert.equal(run(['--show', 'tools']), '✓ Read ×1\n');
  const states = fs.readdirSync(path.join(configDir, 'claude-gauge', '.state', 'transcripts'));
  assert.equal(states.length, 1);
});
