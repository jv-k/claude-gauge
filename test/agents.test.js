'use strict';

// The agents part and what the transcript reader finds for it: the
// subagents running now, and those finished in the last minute.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { render, parseArgs, readTranscriptActivity } = require('../dist/statusline.js');

const { plain, tempDir, countingFs } = require('./helpers');

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

// Issue #60: a background subagent whose own transcript has not changed for
// 10 minutes shows a dim ? in place of the running mark.
test('a background subagent whose transcript changed 11 minutes ago shows a dim ?, and one 9 minutes ago still runs', () => {
  const background = (minutesUnchanged) => [
    { type: 'Plan', description: 'Plan it', startedAt: at(1200), background: true, activeAt: at(minutesUnchanged * 60) },
  ];
  assert.equal(renderAgents(background(9)), '◐ Plan Plan it 20m');
  assert.equal(renderAgents(background(11)), '? Plan Plan it 20m');
  assert.equal(renderAgents(background(10)), '? Plan Plan it 20m');
  const raw = render(
    { workspace: { current_dir: '/home/me/project' }, transcript_path: '/t.jsonl' },
    { config: parseArgs(['--show', 'agents']), nowMs: NOW, transcript: () => ({ tools: { running: [], completed: {} }, agents: background(11) }) },
  );
  // The default theme's grey, its muted colour.
  assert.ok(raw.startsWith('\x1b[0;90m?'), `the ? is not dim: ${JSON.stringify(raw)}`);
});

test('a stale background subagent goes back to running when its transcript changes, and shows finished once notified', () => {
  const stale = { type: 'Plan', description: 'Plan it', startedAt: at(1200), background: true, activeAt: at(660) };
  assert.equal(renderAgents([stale]), '? Plan Plan it 20m');
  assert.equal(renderAgents([{ ...stale, activeAt: at(5) }]), '◐ Plan Plan it 20m');
  assert.equal(renderAgents([{ ...stale, endedAt: at(2) }]), '✓ Plan Plan it 19m');
});

test('a foreground subagent, and a background one with no transcript found, run however long their transcript is unchanged', () => {
  const foreground = { type: 'Explore', description: 'Map it', startedAt: at(1200), activeAt: at(660) };
  assert.equal(renderAgents([foreground]), '◐ Explore Map it 20m');
  const unseen = { type: 'Plan', description: 'Plan it', startedAt: at(1200), background: true };
  assert.equal(renderAgents([unseen]), '◐ Plan Plan it 20m');
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
function agentsIn(records, { dir = tempDir(), append = [] } = {}) {
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
  assert.deepEqual(running, [{ type: 'Plan', description: 'Plan it', startedAt: at(90), background: true, model: 'Sonnet 4.5' }]);
  const done = agentsIn([call, launched, prompt('carry on', at(60)), notification('t1', 'completed', at(10))]);
  assert.deepEqual(done, [{ type: 'Plan', description: 'Plan it', startedAt: at(90), background: true, model: 'Sonnet 4.5', endedAt: at(10) }]);
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
  const dir = tempDir();
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
  const dir = tempDir();
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
  assert.deepEqual(agentsIn([call, prompt('carry on', at(60)), launched]), [{ type: 'Plan', description: 'Plan it', startedAt: at(90), background: true }]);
});

test('a prompt the user types that starts like a task notification is still a prompt', () => {
  const call = agentCall('t1', { subagent_type: 'Explore', description: 'Map it' }, at(90));
  const typed = prompt('<task-notification>\n<tool-use-id>t1</tool-use-id>\n<status>completed</status>\n</task-notification>', at(50));
  assert.deepEqual(agentsIn([call, typed]), [{ type: 'Explore', description: 'Map it', startedAt: at(90), endedAt: at(50), failed: true }]);
});

// A session folder as Claude Code writes one for a subagent: beside the
// session transcript, a folder of the same name holds subagents/, with the
// subagent's own transcript, agent-<id>.jsonl, and agent-<id>.meta.json,
// which names the Agent call that started it.
function sessionWithSubagent(records, { agentId = 'a1b2c3', toolUseId = 't1', subagent } = {}) {
  const dir = tempDir();
  const file = path.join(dir, 'session.jsonl');
  fs.writeFileSync(file, jsonl(records));
  const folder = path.join(dir, 'session', 'subagents');
  fs.mkdirSync(folder, { recursive: true });
  const meta = path.join(folder, `agent-${agentId}.meta.json`);
  fs.writeFileSync(meta, JSON.stringify({ agentType: 'Explore', description: 'Map the reader', toolUseId }));
  const transcript = path.join(folder, `agent-${agentId}.jsonl`);
  if (subagent) fs.writeFileSync(transcript, jsonl(subagent));
  return { dir, file, transcript, stateDir: path.join(dir, 'state') };
}
const subagentReply = (model, when) => ({
  type: 'assistant',
  isSidechain: true,
  agentId: 'a1b2c3',
  timestamp: iso(when),
  message: { role: 'assistant', model, id: `m-${when}`, content: [{ type: 'text', text: 'Looking.' }] },
});

test('a running subagent shows the model its own transcript names, before its result comes', () => {
  const call = agentCall('t1', { subagent_type: 'Explore', description: 'Map the reader' }, at(72));
  const { file, stateDir } = sessionWithSubagent([call], { subagent: [subagentReply('claude-haiku-4-5-20251001', at(70))] });
  const shown = plain(
    render(
      { workspace: { current_dir: '/home/me/project' }, transcript_path: file },
      { config: parseArgs(['--show', 'agents']), nowMs: NOW, transcript: (f) => readTranscriptActivity(f, { stateDir }) },
    ),
  );
  assert.equal(shown, '◐ Explore (Haiku 4.5) Map the reader 1m');
});

test("the reader reads only the bytes a running subagent's transcript gained, and gives its last change time", () => {
  const call = agentCall('t1', { subagent_type: 'Explore', description: 'Map the reader' }, at(72));
  const { file, transcript, stateDir } = sessionWithSubagent([call], { subagent: [subagentReply('claude-haiku-4-5-20251001', at(70))] });
  const first = countingFs();
  const [running] = readTranscriptActivity(file, { stateDir, fs: first }).agents;
  assert.equal(first.bytes, fs.statSync(file).size + fs.statSync(transcript).size);
  assert.equal(running.model, 'Haiku 4.5');
  assert.equal(running.activeAt, fs.statSync(transcript).mtimeMs);

  // Nothing new in either transcript: nothing read again, and the reader's
  // state keeps its place at the end of the subagent's transcript.
  const second = countingFs();
  assert.equal(readTranscriptActivity(file, { stateDir, fs: second }).agents[0].model, 'Haiku 4.5');
  assert.equal(second.bytes, 0);
  const stateFile = path.join(stateDir, `${createHash('sha1').update(transcript).digest('hex')}.json`);
  assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8')).offset, fs.statSync(transcript).size);

  // A new response on another model: only its bytes are read.
  const appended = jsonl([subagentReply('claude-sonnet-4-5', at(10))]);
  fs.appendFileSync(transcript, appended);
  const third = countingFs();
  assert.equal(readTranscriptActivity(file, { stateDir, fs: third }).agents[0].model, 'Sonnet 4.5');
  assert.equal(third.bytes, Buffer.byteLength(appended));
});

test('a subagent with no transcript of its own, one that names no model, or a meta file for another call, shows as before', () => {
  const call = agentCall('t1', { subagent_type: 'Explore', description: 'Map the reader' }, at(72));
  const before = [{ type: 'Explore', description: 'Map the reader', startedAt: at(72) }];
  const missing = sessionWithSubagent([call]);
  assert.deepEqual(readTranscriptActivity(missing.file, { stateDir: missing.stateDir }).agents, before);
  const silent = sessionWithSubagent([call], { subagent: [prompt('Map the reader.', at(71))] });
  const [agent] = readTranscriptActivity(silent.file, { stateDir: silent.stateDir }).agents;
  assert.deepEqual({ ...agent, activeAt: undefined }, { ...before[0], activeAt: undefined });
  const other = sessionWithSubagent([call], { toolUseId: 't9', subagent: [subagentReply('claude-haiku-4-5', at(70))] });
  assert.deepEqual(readTranscriptActivity(other.file, { stateDir: other.stateDir }).agents, before);
});

test("the reader stops reading a subagent's transcript once it has finished", () => {
  const call = agentCall('t1', { subagent_type: 'Explore', description: 'Map the reader' }, at(72));
  const { file, transcript, stateDir } = sessionWithSubagent([call], { subagent: [subagentReply('claude-haiku-4-5', at(70))] });
  readTranscriptActivity(file, { stateDir });
  const result = jsonl([agentResult('t1', at(20), { status: 'completed', resolvedModel: 'claude-haiku-4-5' })]);
  fs.appendFileSync(file, result);
  fs.appendFileSync(transcript, jsonl([subagentReply('claude-sonnet-4-5', at(19))]));
  const io = countingFs();
  const [done] = readTranscriptActivity(file, { stateDir, fs: io }).agents;
  assert.deepEqual(done, { type: 'Explore', description: 'Map the reader', startedAt: at(72), model: 'Haiku 4.5', endedAt: at(20) });
  // Only the session transcript's new result is read.
  assert.equal(io.bytes, Buffer.byteLength(result));
});

// Issue #133: a subagent that ends with no model named, as one in the
// foreground that a prompt stops or one in the background whose launch and
// notification name none, keeps the model its own transcript last named,
// without the reader opening that transcript again.
test('a finished subagent keeps the model its transcript named when its end names none, and its transcript is not read again', () => {
  const renderFrom = (file, stateDir, io) =>
    plain(
      render(
        { workspace: { current_dir: '/home/me/project' }, transcript_path: file },
        { config: parseArgs(['--show', 'agents']), nowMs: NOW, transcript: (f) => readTranscriptActivity(f, { stateDir, fs: io }) },
      ),
    );
  const endsWith = (records, end, render) => {
    const { file, transcript, stateDir } = sessionWithSubagent(records, { subagent: [subagentReply('claude-haiku-4-5-20251001', at(70))] });
    readTranscriptActivity(file, { stateDir });
    const ended = jsonl(end);
    fs.appendFileSync(file, ended);
    fs.appendFileSync(transcript, jsonl([subagentReply('claude-sonnet-4-5', at(19))]));
    const io = countingFs();
    const [done] = readTranscriptActivity(file, { stateDir, fs: io }).agents;
    // Only the session transcript's new lines are read.
    assert.equal(io.bytes, Buffer.byteLength(ended));
    assert.equal(renderFrom(file, stateDir, countingFs()), render);
    return done;
  };

  const foreground = agentCall('t1', { subagent_type: 'Explore', description: 'Map the reader' }, at(72));
  assert.deepEqual(endsWith([foreground], [prompt('stop that', at(20))], '✗ Explore (Haiku 4.5) Map the reader 52s'), {
    type: 'Explore',
    description: 'Map the reader',
    startedAt: at(72),
    model: 'Haiku 4.5',
    endedAt: at(20),
    failed: true,
  });
  const interrupted = agentResult('t1', at(20), { status: 'interrupted' });
  assert.equal(endsWith([foreground], [interrupted], '✗ Explore (Haiku 4.5) Map the reader 52s').model, 'Haiku 4.5');

  const background = agentCall('t1', { subagent_type: 'Plan', description: 'Plan it', run_in_background: true }, at(72));
  const launched = agentResult('t1', at(71), { isAsync: true, status: 'async_launched', agentId: 'a1b2c3' });
  assert.deepEqual(endsWith([background, launched], [notification('t1', 'completed', at(20))], '✓ Plan (Haiku 4.5) Plan it 52s'), {
    type: 'Plan',
    description: 'Plan it',
    startedAt: at(72),
    background: true,
    model: 'Haiku 4.5',
    endedAt: at(20),
  });
});

test('a background subagent is found by the agent id its launch result names', () => {
  const call = agentCall('t1', { subagent_type: 'Plan', description: 'Plan it', run_in_background: true }, at(90));
  const launched = agentResult('t1', at(89), { isAsync: true, status: 'async_launched', agentId: 'a1b2c3' });
  const { file, stateDir } = sessionWithSubagent([call, launched], { toolUseId: null, subagent: [subagentReply('claude-sonnet-4-5', at(80))] });
  assert.equal(readTranscriptActivity(file, { stateDir }).agents[0].model, 'Sonnet 4.5');
});

test("the reader reads each subagent's meta file once, even one that names no Agent call of the session", () => {
  const call = agentCall('t1', { subagent_type: 'Explore', description: 'Map the reader' }, at(72));
  const { file, stateDir } = sessionWithSubagent([call], { toolUseId: 't9' });
  const metaReads = () => {
    const io = { ...fs, metas: 0 };
    io.readFileSync = (p, ...rest) => {
      if (String(p).endsWith('.meta.json')) io.metas++;
      return fs.readFileSync(p, ...rest);
    };
    return io;
  };
  const first = metaReads();
  readTranscriptActivity(file, { stateDir, fs: first });
  assert.equal(first.metas, 1);
  const second = metaReads();
  readTranscriptActivity(file, { stateDir, fs: second });
  assert.equal(second.metas, 0);
});

test("a subagent transcript that cannot be read after its stat shows as before, and the session's activity stays", () => {
  const call = agentCall('t1', { subagent_type: 'Explore', description: 'Map the reader' }, at(72));
  const { file, transcript, stateDir } = sessionWithSubagent([call], { subagent: [subagentReply('claude-haiku-4-5', at(70))] });
  const io = { ...fs };
  io.openSync = (target, ...rest) => {
    if (target === transcript) throw Object.assign(new Error('gone'), { code: 'ENOENT' });
    return fs.openSync(target, ...rest);
  };
  const { agents } = readTranscriptActivity(file, { stateDir, fs: io });
  assert.deepEqual(agents, [{ type: 'Explore', description: 'Map the reader', startedAt: at(72) }]);
});

test('with no agents part to show, the reader leaves the subagents folder and transcripts unread', () => {
  const call = agentCall('t1', { subagent_type: 'Explore', description: 'Map the reader' }, at(72));
  const { file, stateDir } = sessionWithSubagent([call], { subagent: [subagentReply('claude-haiku-4-5', at(70))] });
  const io = countingFs();
  // The reader catches a listing error, so the test counts the listings.
  let listings = 0;
  io.readdirSync = (...args) => {
    listings += 1;
    return fs.readdirSync(...args);
  };
  const [agent] = readTranscriptActivity(file, { stateDir, fs: io, subagents: false }).agents;
  assert.equal(listings, 0, 'the subagents folder was listed');
  assert.deepEqual(agent, { type: 'Explore', description: 'Map the reader', startedAt: at(72) });
  assert.equal(io.bytes, fs.statSync(file).size);

  let asked;
  render(
    { workspace: { current_dir: '/home/me/project' }, transcript_path: file },
    {
      config: parseArgs(['--show', 'tools']),
      nowMs: NOW,
      transcript: (f, options) => {
        asked = options;
        return readTranscriptActivity(f, { stateDir, ...options });
      },
    },
  );
  assert.deepEqual(asked, { subagents: false });
});

// Issue #60 through the reader: the background flag and the transcript's last
// change time reach the part, which reads the render clock.
test('through the reader, a background subagent whose transcript changed 11 minutes ago shows a dim ?, and a foreground one still runs', () => {
  const renderFrom = ({ file, stateDir }) =>
    plain(
      render(
        { workspace: { current_dir: '/home/me/project' }, transcript_path: file },
        { config: parseArgs(['--show', 'agents']), nowMs: NOW, transcript: (f) => readTranscriptActivity(f, { stateDir }) },
      ),
    );
  const unchangedFor = (session, seconds) => {
    fs.utimesSync(session.transcript, at(seconds) / 1000, at(seconds) / 1000);
    return session;
  };
  const call = agentCall('t1', { subagent_type: 'Plan', description: 'Plan it', run_in_background: true }, at(1200));
  const launched = agentResult('t1', at(1199), { isAsync: true, status: 'async_launched', agentId: 'a1b2c3' });
  const background = () => sessionWithSubagent([call, launched], { subagent: [subagentReply('claude-sonnet-4-5', at(1190))] });

  const stale = unchangedFor(background(), 660);
  const [agent] = readTranscriptActivity(stale.file, { stateDir: stale.stateDir }).agents;
  assert.equal(agent.background, true);
  assert.equal(renderFrom(stale), '? Plan (Sonnet 4.5) Plan it 20m');
  assert.equal(renderFrom(unchangedFor(background(), 540)), '◐ Plan (Sonnet 4.5) Plan it 20m');

  const unseen = sessionWithSubagent([call, launched]);
  assert.equal(renderFrom(unseen), '◐ Plan Plan it 20m');

  const foreground = agentCall('t1', { subagent_type: 'Explore', description: 'Map it' }, at(1200));
  assert.equal(renderFrom(unchangedFor(sessionWithSubagent([foreground], { subagent: [subagentReply('claude-haiku-4-5', at(1190))] }), 660)), '◐ Explore (Haiku 4.5) Map it 20m');
});
