'use strict';

// The agents part and what the transcript reader finds for it: the
// subagents running now, and those finished in the last minute.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { render, parseArgs, readTranscriptActivity } = require('../dist/statusline.js');

const plain = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'claude-gauge-'));

const NOW = Date.parse('2026-10-09T12:00:00Z');
const at = (secondsAgo) => NOW - secondsAgo * 1000;

// Renders the agents part over the activity a reader returns.
const renderAgents = (agents, { nowMs = NOW, args = ['--show', 'agents'] } = {}) =>
  plain(
    render(
      { workspace: { current_dir: '/home/me/project' }, transcript_path: '/t.jsonl' },
      { config: parseArgs(args), nowMs, branchOf: () => 'main', transcript: () => ({ tools: { running: [], completed: {} }, agents }) },
    ),
  );

test('agents shows a running subagent with its type, model, description and elapsed time', () => {
  const agents = [{ type: 'Explore', model: 'Haiku 4.5', description: 'Find the config loader', startedAt: at(72) }];
  assert.equal(renderAgents(agents), '◐ Explore (Haiku 4.5) Find the config loader 1m');
});

test('agents shows up to three, those running first, then the most recently finished', () => {
  const agents = [
    { type: 'Plan', description: 'Plan the change', startedAt: at(300), endedAt: at(40) },
    { type: 'Explore', model: 'Haiku 4.5', description: 'Map the reader', startedAt: at(200) },
    { type: 'general-purpose', description: 'Check the docs', startedAt: at(100), endedAt: at(10), failed: true },
    { type: 'Explore', model: 'Sonnet 4.5', description: 'Find the tests', startedAt: at(30) },
  ];
  assert.equal(
    renderAgents(agents),
    '◐ Explore (Haiku 4.5) Map the reader 3m ◐ Explore (Sonnet 4.5) Find the tests 30s ✗ general-purpose Check the docs 1m',
  );
});

test('a finished subagent stays for about a minute, then drops out', () => {
  const agents = [{ type: 'Explore', description: 'Map the reader', startedAt: at(100), endedAt: at(55) }];
  assert.equal(renderAgents(agents), '✓ Explore Map the reader 45s');
  assert.equal(renderAgents(agents, { nowMs: NOW + 10_000 }), '');
});

test('a long description is cut, and what the transcript leaves out is left out', () => {
  const agents = [{ type: 'general-purpose', description: 'Read every test file and list the seams each one uses', startedAt: at(5) }];
  assert.equal(renderAgents(agents), '◐ general-purpose Read every test file and list… 5s');
  assert.equal(renderAgents([{ type: 'Explore' }]), '◐ Explore');
});

test('agents has nothing to show with no subagents, and the agent part still names the --agent agent', () => {
  assert.equal(renderAgents([]), '');
  const raw = render({ agent: { name: 'security-reviewer' } }, { config: parseArgs(['--show', 'agent']) });
  assert.equal(plain(raw), 'agent security-reviewer');
});

test('subagent types, models and descriptions print without their control codes', () => {
  const HOSTILE = '\x1b[2J\x1b]0;pwned\x07‮';
  const agents = [{ type: `Ex${HOSTILE}plore`, model: `Hai${HOSTILE}ku`, description: `Map ${HOSTILE}it`, startedAt: at(1) }];
  const raw = render(
    { workspace: { current_dir: '/home/me/project' }, transcript_path: '/t.jsonl' },
    { config: parseArgs(['--show', 'agents']), nowMs: NOW, transcript: () => ({ tools: { running: [], completed: {} }, agents }) },
  );
  assert.doesNotMatch(raw.replace(/\x1b\[[0-9;]*m/g, ''), /[\x00-\x1f\x7f-\x9f‮]/);
  assert.equal(plain(raw), '◐ Explore (Haiku) Map it 1s');
});

// Transcript records as Claude Code writes them for a subagent: the Agent
// tool call, its result, and for one run in the background, the task
// notification that says it finished.
const iso = (ms) => new Date(ms).toISOString();
const agentCall = (id, input, startedAt, { name = 'Agent', ...extra } = {}) => ({
  type: 'assistant',
  timestamp: iso(startedAt),
  ...extra,
  message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input: { prompt: 'Do the work.', ...input } }] },
});
const agentResult = (id, endedAt, toolUseResult, { isError = false } = {}) => ({
  type: 'user',
  timestamp: iso(endedAt),
  toolUseResult,
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'done', ...(isError ? { is_error: true } : {}) }] },
});
const notification = (id, status, endedAt) => ({
  type: 'user',
  timestamp: iso(endedAt),
  origin: { kind: 'task-notification' },
  message: {
    role: 'user',
    content: `<task-notification>\n<task-id>a1</task-id>\n<tool-use-id>${id}</tool-use-id>\n<status>${status}</status>\n<summary>Agent finished</summary>\n</task-notification>`,
  },
});
const prompt = (text, when) => ({ type: 'user', timestamp: iso(when), message: { role: 'user', content: text } });
const jsonl = (records) => records.map((r) => `${JSON.stringify(r)}\n`).join('');

// What the reader finds in a transcript of these records, with its state in
// a folder of its own.
function agentsIn(records, { dir = tmpDir(), append = [] } = {}) {
  const file = path.join(dir, 'session.jsonl');
  const stateDir = path.join(dir, 'state');
  fs.writeFileSync(file, jsonl(records));
  let activity = readTranscriptActivity(file, { stateDir });
  for (const more of append) {
    fs.appendFileSync(file, jsonl(more));
    activity = readTranscriptActivity(file, { stateDir });
  }
  return activity.agents;
}

test('the reader finds a subagent while it runs, and its model and end once its result comes', () => {
  const call = agentCall('t1', { subagent_type: 'Explore', description: 'Map the reader' }, at(90));
  const result = agentResult('t1', at(20), { status: 'completed', agentType: 'Explore', resolvedModel: 'claude-haiku-4-5-20251001' });
  assert.deepEqual(agentsIn([call], { append: [[result]] }), [
    { type: 'Explore', description: 'Map the reader', startedAt: at(90), model: 'Haiku 4.5', endedAt: at(20) },
  ]);
  assert.deepEqual(agentsIn([call]), [{ type: 'Explore', description: 'Map the reader', startedAt: at(90) }]);
});

test('a background subagent runs until its task notification, and a prompt does not end it', () => {
  const call = agentCall('t1', { subagent_type: 'Plan', description: 'Plan it', run_in_background: true }, at(90));
  const launched = agentResult('t1', at(89), { isAsync: true, status: 'async_launched', agentId: 'a1', resolvedModel: 'claude-sonnet-4-5' });
  const running = agentsIn([call, launched, prompt('carry on', at(60))]);
  assert.deepEqual(running, [{ type: 'Plan', description: 'Plan it', startedAt: at(90), model: 'Sonnet 4.5' }]);
  const done = agentsIn([call, launched, prompt('carry on', at(60)), notification('t1', 'completed', at(10))]);
  assert.deepEqual(done, [{ type: 'Plan', description: 'Plan it', startedAt: at(90), model: 'Sonnet 4.5', endedAt: at(10) }]);
  const killed = agentsIn([call, launched, notification('t1', 'killed', at(10))]);
  assert.equal(killed[0].failed, true);
});

test('a prompt ends a subagent that runs in the foreground, as stopped, and a result after it still counts', () => {
  const call = agentCall('t1', { subagent_type: 'Explore', description: 'Map it' }, at(90));
  const [stopped] = agentsIn([call, prompt('stop that', at(50))]);
  assert.deepEqual(stopped, { type: 'Explore', description: 'Map it', startedAt: at(90), endedAt: at(50), failed: true });
  const [finished] = agentsIn([call, prompt('stop that', at(50)), agentResult('t1', at(40), { status: 'completed' })]);
  assert.deepEqual(finished, { type: 'Explore', description: 'Map it', startedAt: at(90), endedAt: at(40) });
  const [failed] = agentsIn([call, agentResult('t1', at(40), {}, { isError: true })]);
  assert.equal(failed.failed, true);
});

test('the reader takes the Task name and the model switch, defaults the type, and leaves out subagents of subagents', () => {
  const agents = agentsIn([
    agentCall('t1', { description: 'Look around', model: 'sonnet' }, at(30), { name: 'Task' }),
    agentCall('t2', { subagent_type: 'Explore', description: 'Nested' }, at(20), { isSidechain: true }),
    agentCall('t3', { subagent_type: 'Explore', description: 'Inherits', model: 'inherit' }, at(10)),
  ]);
  assert.deepEqual(agents, [
    { type: 'general-purpose', description: 'Look around', model: 'Sonnet', startedAt: at(30) },
    { type: 'Explore', description: 'Inherits', startedAt: at(10) },
  ]);
});

test('the program shows the subagents a transcript names', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'session.jsonl');
  const started = Date.now() - 5000;
  fs.writeFileSync(file, jsonl([agentCall('t1', { subagent_type: 'Explore', description: 'Map the reader', model: 'haiku' }, started)]));
  const out = require('node:child_process').execFileSync(
    process.execPath,
    [path.join(__dirname, '..', 'dist', 'statusline.js'), '--show', 'agents'],
    {
      env: { ...process.env, CLAUDE_CONFIG_DIR: path.join(dir, 'config'), COLUMNS: '' },
      input: JSON.stringify({ workspace: { current_dir: dir }, transcript_path: file }),
      encoding: 'utf8',
    },
  );
  assert.match(plain(out), /^◐ Explore \(Haiku\) Map the reader \d+s\n$/);
});

test('a transcript state from before the agents part is read again from the start', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'session.jsonl');
  const stateDir = path.join(dir, 'state');
  fs.writeFileSync(file, jsonl([agentCall('t1', { subagent_type: 'Explore', description: 'Map it' }, at(30))]));
  readTranscriptActivity(file, { stateDir });
  // The state as claude-gauge wrote it before: version 1, with no agents.
  const [name] = fs.readdirSync(stateDir);
  const saved = JSON.parse(fs.readFileSync(path.join(stateDir, name), 'utf8'));
  delete saved.agents;
  fs.writeFileSync(path.join(stateDir, name), JSON.stringify({ ...saved, version: 1 }));
  assert.deepEqual(readTranscriptActivity(file, { stateDir }).agents, [{ type: 'Explore', description: 'Map it', startedAt: at(30) }]);
});

test('a long description is cut between characters, never inside an emoji', () => {
  const agents = [{ type: 'Explore', description: `${'a'.repeat(28)}😀 and more`, startedAt: at(5) }];
  assert.equal(renderAgents(agents), `◐ Explore ${'a'.repeat(28)}😀… 5s`);
});

test('a background subagent still runs when a prompt comes before its launch result', () => {
  const call = agentCall('t1', { subagent_type: 'Plan', description: 'Plan it', run_in_background: true }, at(90));
  const launched = agentResult('t1', at(40), { isAsync: true, status: 'async_launched', agentId: 'a1' });
  assert.deepEqual(agentsIn([call, prompt('carry on', at(60)), launched]), [{ type: 'Plan', description: 'Plan it', startedAt: at(90) }]);
});

test('a prompt the user types that starts like a task notification is still a prompt', () => {
  const call = agentCall('t1', { subagent_type: 'Explore', description: 'Map it' }, at(90));
  const typed = prompt('<task-notification>\n<tool-use-id>t1</tool-use-id>\n<status>completed</status>\n</task-notification>', at(50));
  assert.deepEqual(agentsIn([call, typed]), [{ type: 'Explore', description: 'Map it', startedAt: at(90), endedAt: at(50), failed: true }]);
});
