'use strict';

// The session counter parts and what the transcript reader finds for them:
// how many times the conversation was compacted, how long since Claude last
// replied, and the output speed of the last response.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { render, parseArgs, readTranscriptActivity } = require('../dist/statusline.js');

const plain = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'claude-gauge-'));

const NOW = Date.parse('2026-10-09T12:00:00Z');
const ago = (seconds) => NOW - seconds * 1000;

// Renders the given parts over the activity a reader returns.
const renderSession = (activity, args, { nowMs = NOW } = {}) =>
  plain(
    render(
      { workspace: { current_dir: '/home/me/project' }, transcript_path: '/t.jsonl' },
      {
        config: parseArgs(args),
        nowMs,
        branchOf: () => 'main',
        transcript: () => ({ tools: { running: [], completed: {} }, agents: [], todos: [], compactions: 0, ...activity }),
      },
    ),
  );

test('compactions counts the times the conversation was compacted', () => {
  assert.equal(renderSession({ compactions: 2 }, ['--show', 'compactions']), 'compactions 2');
  assert.equal(renderSession({ compactions: 1 }, ['--show', 'compactions', '--compact']), 'cmp 1');
  assert.equal(renderSession({ compactions: 1 }, ['--show', 'compactions', '--no-labels']), '1');
});

test('compactions has nothing to show before the first compaction', () => {
  assert.equal(renderSession({ compactions: 0 }, ['--show', 'compactions']), '');
  // A reader handed in from JavaScript may leave the count out.
  assert.equal(renderSession({ compactions: undefined }, ['--show', 'compactions']), '');
});

test('reply shows the time since the last reply', () => {
  assert.equal(renderSession({ lastReplyAt: ago(45) }, ['--show', 'reply']), 'reply 45s ago');
  assert.equal(renderSession({ lastReplyAt: ago(3 * 3600 + 120) }, ['--show', 'reply']), 'reply 3h2m ago');
  assert.equal(renderSession({ lastReplyAt: ago(45) }, ['--show', 'reply', '--no-labels']), '45s ago');
  // A reply stamped a little ahead of this machine's clock counts as just now.
  assert.equal(renderSession({ lastReplyAt: NOW + 5000 }, ['--show', 'reply']), 'reply 0s ago');
});

test('reply has nothing to show before the first reply', () => {
  assert.equal(renderSession({}, ['--show', 'reply']), '');
});

test('speed shows the output tokens per second of the last response', () => {
  assert.equal(renderSession({ speed: 84.4 }, ['--show', 'speed']), '84 tok/s');
  assert.equal(renderSession({ speed: 6.25 }, ['--show', 'speed']), '6.3 tok/s');
  assert.equal(renderSession({}, ['--show', 'speed']), '');
});

test('the session counters show together on one row', () => {
  const activity = { compactions: 1, lastReplyAt: ago(90), speed: 120 };
  assert.equal(renderSession(activity, ['--show', 'compactions,reply,speed']), 'compactions 1 │ reply 1m ago │ 120 tok/s');
});

// Transcript records as Claude Code writes them. A response arrives as one
// assistant record per content block, each with the message's id and its
// final usage; the record before it, a prompt or a tool result, is what
// asked for it.
const stamp = (ms) => new Date(ms).toISOString();
const prompt = (ms, text = 'go') => ({ type: 'user', timestamp: stamp(ms), message: { role: 'user', content: text } });
const toolResult = (ms, id) => ({
  type: 'user',
  timestamp: stamp(ms),
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] },
});
const block = (ms, id, outputTokens, content, extra = {}) => ({
  type: 'assistant',
  timestamp: stamp(ms),
  ...extra,
  message: { id, role: 'assistant', model: 'claude-opus-5-5', content: [content], usage: { input_tokens: 10, output_tokens: outputTokens } },
});
const text = (ms, id, outputTokens, extra) => block(ms, id, outputTokens, { type: 'text', text: 'Done.' }, extra);
const toolUse = (ms, id, outputTokens, callId) => block(ms, id, outputTokens, { type: 'tool_use', id: callId, name: 'Read', input: { file_path: '/a' } });
const compacted = (ms, extra = {}) => ({
  type: 'system',
  subtype: 'compact_boundary',
  content: 'Conversation compacted',
  timestamp: stamp(ms),
  compactMetadata: { trigger: 'auto', preTokens: 180000 },
  ...extra,
});
const jsonl = (records) => records.map((r) => `${JSON.stringify(r)}\n`).join('');

// What the reader finds in a transcript of these records, with its state in
// a folder of its own; each batch in append is added and read in turn.
function activityIn(records, { append = [] } = {}) {
  const dir = tmpDir();
  const file = path.join(dir, 'session.jsonl');
  const stateDir = path.join(dir, 'state');
  fs.writeFileSync(file, jsonl(records));
  let activity = readTranscriptActivity(file, { stateDir });
  for (const more of append) {
    fs.appendFileSync(file, jsonl(more));
    activity = readTranscriptActivity(file, { stateDir });
  }
  return activity;
}

// The reply fields of an activity, leaving out those it does not have.
const pick = ({ lastReplyAt, speed }) => ({ ...(lastReplyAt !== undefined ? { lastReplyAt } : {}), ...(speed !== undefined ? { speed } : {}) });

test('the reader counts the compactions in the session', () => {
  assert.equal(activityIn([prompt(ago(600))]).compactions, 0);
  const once = [prompt(ago(600)), compacted(ago(500))];
  assert.equal(activityIn(once).compactions, 1);
  assert.equal(activityIn(once, { append: [[prompt(ago(400)), compacted(ago(300))]] }).compactions, 2);
});

test("a subagent's compactions are left out", () => {
  assert.equal(activityIn([compacted(ago(500), { isSidechain: true })]).compactions, 0);
});

test('the reader takes the last reply time and speed from the last response', () => {
  // 100 tokens, from the prompt at -60s to the last block at -58s: 50 tok/s.
  const first = [prompt(ago(60)), text(ago(59), 'msg_1', 100), toolUse(ago(58), 'msg_1', 100, 'toolu_1')];
  assert.deepEqual(pick(activityIn(first)), { lastReplyAt: ago(58), speed: 50 });
  // The next response is timed from the tool result that asked for it.
  const second = [toolResult(ago(30), 'toolu_1'), text(ago(26), 'msg_2', 200)];
  assert.deepEqual(pick(activityIn(first, { append: [second] })), { lastReplyAt: ago(26), speed: 50 });
});

test('a response read over two renders is timed from its start', () => {
  const start = [prompt(ago(60)), text(ago(59), 'msg_1', 120)];
  const end = [toolUse(ago(56), 'msg_1', 120, 'toolu_1')];
  assert.deepEqual(pick(activityIn(start, { append: [end] })), { lastReplyAt: ago(56), speed: 30 });
});

test('a reply with no tokens or no time to time keeps the last speed', () => {
  const timed = [prompt(ago(60)), text(ago(58), 'msg_1', 100)];
  // An API error Claude Code writes as a reply of its own has no usage.
  const synthetic = text(ago(40), 'msg_2', 0, {});
  synthetic.message.model = '<synthetic>';
  assert.deepEqual(pick(activityIn([...timed, synthetic])), { lastReplyAt: ago(58), speed: 50 });
  // A response with no record before it cannot be timed.
  assert.deepEqual(pick(activityIn([text(ago(10), 'msg_1', 100)])), { lastReplyAt: ago(10) });
});

test("a subagent's replies are left out", () => {
  const nested = [prompt(ago(60)), text(ago(58), 'msg_1', 100), text(ago(5), 'msg_2', 100, { isSidechain: true })];
  assert.deepEqual(pick(activityIn(nested)), { lastReplyAt: ago(58), speed: 50 });
});

test('the program shows the session counters from a transcript', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'session.jsonl');
  const now = Date.now();
  fs.writeFileSync(file, jsonl([prompt(now - 600_000), compacted(now - 500_000), prompt(now - 130_000), text(now - 125_000, 'msg_1', 400)]));
  const out = require('node:child_process').execFileSync(
    process.execPath,
    [path.join(__dirname, '..', 'dist', 'statusline.js'), '--show', 'compactions,reply,speed'],
    {
      env: { ...process.env, CLAUDE_CONFIG_DIR: path.join(dir, 'config'), COLUMNS: '' },
      input: JSON.stringify({ workspace: { current_dir: dir }, transcript_path: file }),
      encoding: 'utf8',
    },
  );
  assert.equal(plain(out), 'compactions 1 │ reply 2m ago │ 80 tok/s\n');
});

test('a transcript state from before the session counters is read again from the start', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'session.jsonl');
  const stateDir = path.join(dir, 'state');
  fs.writeFileSync(file, jsonl([prompt(ago(600)), compacted(ago(500))]));
  readTranscriptActivity(file, { stateDir });
  // The state as claude-gauge wrote it before: version 3, with no counters.
  const [name] = fs.readdirSync(stateDir);
  const saved = JSON.parse(fs.readFileSync(path.join(stateDir, name), 'utf8'));
  for (const key of Object.keys(saved)) if (!['version', 'file', 'dev', 'ino', 'offset', 'pending', 'completed', 'agents', 'todos', 'todoCalls'].includes(key)) delete saved[key];
  fs.writeFileSync(path.join(stateDir, name), JSON.stringify({ ...saved, version: 3 }));
  assert.equal(readTranscriptActivity(file, { stateDir }).compactions, 1);
});
