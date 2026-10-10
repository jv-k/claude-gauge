'use strict';

// The skills part and what the transcript reader finds for it: the skills
// the session used, and the MCP servers it called, with those whose latest
// call failed marked.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { render, parseArgs, readTranscriptActivity } = require('../dist/statusline.js');

const { plain, tempDir } = require('./helpers');

// Renders the skills part over the activity a reader returns.
const renderSkills = ({ skills = [], mcp = [] }, args = ['--show', 'skills']) =>
  render(
    { workspace: { current_dir: '/home/me/project' }, transcript_path: '/t.jsonl' },
    { config: parseArgs(args), branchOf: () => 'main', transcript: () => ({ tools: { running: [], completed: {} }, agents: [], todos: [], skills, mcp }) },
  );

test('skills shows the skills used, newest first, then the MCP servers called', () => {
  const out = renderSkills({ skills: ['tdd', 'code-review'], mcp: [{ name: 'linear' }, { name: 'github' }] });
  assert.equal(plain(out), 'skills code-review tdd mcp github linear');
});

test('skills has nothing to show when the session used no skill and called no MCP server', () => {
  assert.equal(renderSkills({}), '');
});

test('skills shows either half alone, and drops its labels with --no-labels', () => {
  assert.equal(plain(renderSkills({ skills: ['tdd'] })), 'skills tdd');
  assert.equal(plain(renderSkills({ mcp: [{ name: 'github' }] })), 'mcp github');
  assert.equal(plain(renderSkills({ skills: ['tdd'], mcp: [{ name: 'github' }] }, ['--show', 'skills', '--no-labels'])), 'tdd github');
});

test('a server whose latest call failed shows first, in red with a cross', () => {
  const out = renderSkills({ mcp: [{ name: 'linear', failed: true }, { name: 'github' }, { name: 'slack' }] });
  assert.equal(plain(out), 'mcp ✗ linear slack github');
  assert.match(out, /\x1b\[0;31m✗ linear/);
});

test('skills shows three of each, keeps every failing server, and cuts a long name', () => {
  const skills = ['a', 'b', 'c', 'd'];
  const mcp = [{ name: 'one', failed: true }, { name: 'two' }, { name: 'three' }, { name: 'four', failed: true }, { name: 'five', failed: true }, { name: 'six', failed: true }];
  assert.equal(plain(renderSkills({ skills, mcp })), 'skills d c b mcp ✗ six ✗ five ✗ four ✗ one');
  assert.equal(plain(renderSkills({ mcp: [{ name: 'plugin_small-business_shopify_storefront' }] })), 'mcp plugin_small-business_shopify…');
});

test('skill and server names print without their control codes', () => {
  const HOSTILE = '\x1b[2J\x1b]0;pwned\x07‮';
  const raw = renderSkills({ skills: [`t${HOSTILE}dd`], mcp: [{ name: `git${HOSTILE}hub`, failed: true }] });
  assert.doesNotMatch(plain(raw), /[\x00-\x1f\x7f-\x9f‮]/);
  assert.equal(plain(raw), 'skills tdd mcp ✗ github');
});

// Transcript records as Claude Code writes them: a tool call, its result,
// and a skill the user runs as a slash command.
let calls = 0;
const call = (name, input, extra = {}) => {
  const id = `toolu_${++calls}`;
  return { id, record: { type: 'assistant', ...extra, message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } } };
};
const result = (id, { content = 'ok', isError = false, toolUseResult } = {}) => ({
  type: 'user',
  ...(toolUseResult !== undefined ? { toolUseResult } : {}),
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, ...(isError ? { is_error: true } : {}) }] },
});
// A call and its result.
const done = (name, input, options, extra) => {
  const c = call(name, input, extra);
  return [c.record, result(c.id, options)];
};
const skill = (name, options = { toolUseResult: { success: true, commandName: name } }) => done('Skill', { skill: name }, options);
const mcpCall = (tool, options) => done(tool, { query: 'x' }, options);
const failed = { content: 'Error: the server did not answer', isError: true };
// A skill the user runs by name: the command, then the skill's text, which
// Claude Code adds as a meta message.
const typed = (name, { skillText = true } = {}) => [
  { type: 'user', message: { role: 'user', content: `<command-message>${name}</command-message>\n<command-name>/${name}</command-name>\n<command-args></command-args>` } },
  ...(skillText
    ? [{ type: 'user', isMeta: true, message: { role: 'user', content: [{ type: 'text', text: `Base directory for this skill: /home/me/.claude/skills/${name}\n\n# ${name}` }] } }]
    : []),
];
const jsonl = (records) => records.map((r) => `${JSON.stringify(r)}\n`).join('');

// What the reader finds in a transcript of these records, with its state in
// a folder of its own.
function activityIn(records, { dir = tempDir(), append = [] } = {}) {
  const file = path.join(dir, 'session.jsonl');
  const stateDir = path.join(dir, 'state');
  fs.writeFileSync(file, jsonl(records));
  let activity = readTranscriptActivity(file, { stateDir });
  for (const more of append) {
    fs.appendFileSync(file, jsonl(more));
    activity = readTranscriptActivity(file, { stateDir });
  }
  return { skills: activity.skills, mcp: activity.mcp };
}

test('the reader lists the skills Claude ran with the Skill tool, in the order last used', () => {
  assert.deepEqual(activityIn([...skill('tdd'), ...skill('code-review'), ...skill('tdd')]).skills, ['code-review', 'tdd']);
});

test('a skill counts once its result says it ran', () => {
  const c = call('Skill', { skill: 'tdd' });
  assert.deepEqual(activityIn([c.record]).skills, []);
  assert.deepEqual(activityIn([c.record, result(c.id, { content: 'Unknown skill: tdd', isError: true })]).skills, []);
  assert.deepEqual(activityIn(skill('tdd', { toolUseResult: { success: false } })).skills, []);
});

test('the reader lists a skill the user runs as a slash command, but not a built-in command', () => {
  assert.deepEqual(activityIn([...typed('ship-it'), ...typed('clear', { skillText: false }), ...skill('tdd')]).skills, ['ship-it', 'tdd']);
});

test('the reader lists the MCP servers the session called, in the order last used', () => {
  const records = [
    ...mcpCall('mcp__github__search_issues'),
    ...mcpCall('mcp__claude_ai_Linear__list_issues'),
    ...mcpCall('mcp__github__get_issue'),
    ...done('Read', { file_path: '/a.ts' }),
  ];
  assert.deepEqual(activityIn(records).mcp, [{ name: 'claude_ai_Linear' }, { name: 'github' }]);
});

test('a server shows from its first call, before the result comes', () => {
  assert.deepEqual(activityIn([call('mcp__github__search_issues', {}).record]).mcp, [{ name: 'github' }]);
});

test('a server whose latest call failed is marked, until a call to it works', () => {
  const broken = mcpCall('mcp__linear__list_issues', failed);
  assert.deepEqual(activityIn(broken).mcp, [{ name: 'linear', failed: true }]);
  assert.deepEqual(activityIn([...broken, ...mcpCall('mcp__linear__get_issue')]).mcp, [{ name: 'linear' }]);
  // A failure seen in a later render marks a server that worked before.
  assert.deepEqual(activityIn(mcpCall('mcp__linear__get_issue'), { append: [broken] }).mcp, [{ name: 'linear', failed: true }]);
});

test('a call the user interrupted does not mark its server', () => {
  const c = call('mcp__linear__list_issues', {});
  const prompt = { type: 'user', message: { role: 'user', content: 'stop' } };
  assert.deepEqual(activityIn([c.record, prompt]).mcp, [{ name: 'linear' }]);
});

test('a call the user or a permission rule stopped neither marks its server nor clears its mark', () => {
  const stops = [
    { content: "The user doesn't want to proceed with this tool use. The tool use was rejected.", isError: true, toolUseResult: 'User rejected tool use' },
    { content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }], isError: true },
    { content: 'Permission to use mcp__linear__list_issues has been denied.', isError: true },
  ];
  for (const stop of stops) {
    assert.deepEqual(activityIn(mcpCall('mcp__linear__list_issues', stop)).mcp, [{ name: 'linear' }], JSON.stringify(stop.content));
    const broken = mcpCall('mcp__linear__list_issues', failed);
    assert.deepEqual(activityIn([...broken, ...mcpCall('mcp__linear__get_issue', stop)]).mcp, [{ name: 'linear', failed: true }]);
  }
});

test("a subagent's skills and MCP calls are left out", () => {
  const side = { isSidechain: true };
  const records = [...done('Skill', { skill: 'tdd' }, undefined, side), ...done('mcp__github__get_issue', {}, failed, side)];
  assert.deepEqual(activityIn(records), { skills: [], mcp: [] });
});

test('the program shows the skills and servers from a transcript', () => {
  const dir = tempDir();
  const file = path.join(dir, 'session.jsonl');
  fs.writeFileSync(file, jsonl([...skill('tdd'), ...mcpCall('mcp__linear__list_issues', failed), ...mcpCall('mcp__github__get_issue')]));
  const out = require('node:child_process').execFileSync(
    process.execPath,
    [path.join(__dirname, '..', 'dist', 'statusline.js'), '--show', 'skills'],
    {
      env: { ...process.env, CLAUDE_CONFIG_DIR: path.join(dir, 'config'), COLUMNS: '' },
      input: JSON.stringify({ workspace: { current_dir: dir }, transcript_path: file }),
      encoding: 'utf8',
    },
  );
  assert.equal(plain(out), 'skills tdd mcp ✗ linear github\n');
});

test('a transcript state from before the skills part is read again from the start', () => {
  const dir = tempDir();
  const file = path.join(dir, 'session.jsonl');
  const stateDir = path.join(dir, 'state');
  fs.writeFileSync(file, jsonl(skill('tdd')));
  readTranscriptActivity(file, { stateDir });
  // The state as claude-gauge wrote it before: version 3, with no skills.
  const [name] = fs.readdirSync(stateDir);
  const saved = JSON.parse(fs.readFileSync(path.join(stateDir, name), 'utf8'));
  delete saved.skills;
  delete saved.mcp;
  fs.writeFileSync(path.join(stateDir, name), JSON.stringify({ ...saved, version: 3 }));
  assert.deepEqual(readTranscriptActivity(file, { stateDir }).skills, ['tdd']);
});
