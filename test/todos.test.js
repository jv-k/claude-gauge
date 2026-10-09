'use strict';

// The todos part and what the transcript reader finds for it: the todo in
// progress, and how many of the session's todos are done.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { render, parseArgs, readTranscriptActivity } = require('../dist/statusline.js');

const plain = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'claude-gauge-'));

// Renders the todos part over the activity a reader returns.
const renderTodos = (todos, args = ['--show', 'todos']) =>
  plain(
    render(
      { workspace: { current_dir: '/home/me/project' }, transcript_path: '/t.jsonl' },
      { config: parseArgs(args), branchOf: () => 'main', transcript: () => ({ tools: { running: [], completed: {} }, agents: [], todos }) },
    ),
  );

test('todos shows the todo in progress, by its active form, and how many are done', () => {
  const todos = [
    { content: 'Read the reader', status: 'completed' },
    { content: 'Write the tests', activeForm: 'Writing the tests', status: 'in_progress' },
    { content: 'Update the README', status: 'pending' },
  ];
  assert.equal(renderTodos(todos), '◐ Writing the tests 1/3');
});

test('todos has nothing to show with no todos', () => {
  assert.equal(renderTodos([]), '');
});

test('with none in progress, todos shows the count, with a check once all are done', () => {
  const todos = [
    { content: 'Read the reader', status: 'completed' },
    { content: 'Write the tests', status: 'pending' },
  ];
  assert.equal(renderTodos(todos), 'todos 1/2');
  assert.equal(renderTodos(todos, ['--show', 'todos', '--no-labels']), '1/2');
  assert.equal(renderTodos(todos.map((t) => ({ ...t, status: 'completed' }))), '✓ todos 2/2');
});

test('a todo with no active form shows its content, and a long one is cut', () => {
  assert.equal(renderTodos([{ content: 'Write the tests', status: 'in_progress' }]), '◐ Write the tests 0/1');
  const long = [{ content: 'Read every test file and list the seams each one uses', status: 'in_progress' }];
  assert.equal(renderTodos(long), '◐ Read every test file and list… 0/1');
});

test('todo text prints without its control codes', () => {
  const HOSTILE = '\x1b[2J\x1b]0;pwned\x07‮';
  const raw = render(
    { workspace: { current_dir: '/home/me/project' }, transcript_path: '/t.jsonl' },
    {
      config: parseArgs(['--show', 'todos']),
      transcript: () => ({ tools: { running: [], completed: {} }, todos: [{ content: `Wr${HOSTILE}ite`, activeForm: `Wri${HOSTILE}ting`, status: 'in_progress' }] }),
    },
  );
  assert.doesNotMatch(plain(raw), /[\x00-\x1f\x7f-\x9f‮]/);
  assert.equal(plain(raw), '◐ Writing 0/1');
});

// Transcript records as Claude Code writes them for the todo tools: a call,
// and its result.
let calls = 0;
const call = (name, input, extra = {}) => {
  const id = `toolu_${++calls}`;
  return { id, record: { type: 'assistant', ...extra, message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } } };
};
const result = (id, toolUseResult, { content = 'ok', isError = false } = {}) => ({
  type: 'user',
  toolUseResult,
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, ...(isError ? { is_error: true } : {}) }] },
});
// A call and the result that says it worked.
const done = (name, input, toolUseResult = {}, extra = {}) => {
  const c = call(name, input, extra);
  return [c.record, result(c.id, toolUseResult)];
};
const jsonl = (records) => records.map((r) => `${JSON.stringify(r)}\n`).join('');

// What the reader finds in a transcript of these records, with its state in
// a folder of its own.
function todosIn(records, { dir = tmpDir(), append = [] } = {}) {
  const file = path.join(dir, 'session.jsonl');
  const stateDir = path.join(dir, 'state');
  fs.writeFileSync(file, jsonl(records));
  let activity = readTranscriptActivity(file, { stateDir });
  for (const more of append) {
    fs.appendFileSync(file, jsonl(more));
    activity = readTranscriptActivity(file, { stateDir });
  }
  return activity.todos;
}

const todoWrite = (todos) => done('TodoWrite', { todos });

test('the reader takes the todo list from the latest TodoWrite', () => {
  const first = todoWrite([
    { content: 'Read the reader', activeForm: 'Reading the reader', status: 'in_progress' },
    { content: 'Write the tests', activeForm: 'Writing the tests', status: 'pending' },
  ]);
  const second = todoWrite([
    { content: 'Read the reader', activeForm: 'Reading the reader', status: 'completed' },
    { content: 'Write the tests', activeForm: 'Writing the tests', status: 'in_progress' },
  ]);
  assert.deepEqual(todosIn(first), [
    { content: 'Read the reader', activeForm: 'Reading the reader', status: 'in_progress' },
    { content: 'Write the tests', activeForm: 'Writing the tests', status: 'pending' },
  ]);
  assert.deepEqual(todosIn(first, { append: [second] }), [
    { content: 'Read the reader', activeForm: 'Reading the reader', status: 'completed' },
    { content: 'Write the tests', activeForm: 'Writing the tests', status: 'in_progress' },
  ]);
  assert.deepEqual(todosIn([...first, ...todoWrite([])]), []);
});

test('a TodoWrite counts once its result says it worked, and malformed todos drop out', () => {
  const c = call('TodoWrite', { todos: [{ content: 'Write the tests', status: 'pending' }] });
  assert.deepEqual(todosIn([c.record]), []);
  assert.deepEqual(todosIn([c.record, result(c.id, {}, { isError: true })]), []);
  const odd = todoWrite([{ content: 'Write the tests', status: 'someday' }, { status: 'pending' }, 'Update the README', { content: '  ' }]);
  assert.deepEqual(todosIn(odd), [{ content: 'Write the tests', status: 'pending' }]);
});

test('the todos of a subagent are left out', () => {
  assert.deepEqual(todosIn(done('TodoWrite', { todos: [{ content: 'Nested', status: 'pending' }] }, {}, { isSidechain: true })), []);
});

// A TaskCreate call and the result that names the new task's id.
const taskCreate = (taskId, input) => done('TaskCreate', { description: 'The details.', ...input }, { task: { id: taskId, subject: input.subject } });
const taskUpdate = (taskId, input, toolUseResult = { success: true, taskId, updatedFields: Object.keys(input) }) =>
  done('TaskUpdate', { taskId, ...input }, toolUseResult);

test('the reader adds a task from TaskCreate and changes it with TaskUpdate', () => {
  const created = [
    ...taskCreate('1', { subject: 'Read the reader', activeForm: 'Reading the reader' }),
    ...taskCreate('2', { subject: 'Write the tests' }),
  ];
  assert.deepEqual(todosIn(created), [
    { content: 'Read the reader', activeForm: 'Reading the reader', status: 'pending' },
    { content: 'Write the tests', status: 'pending' },
  ]);
  const worked = [
    ...taskUpdate('1', { status: 'in_progress' }),
    ...taskUpdate('1', { status: 'completed' }),
    ...taskUpdate('2', { status: 'in_progress', subject: 'Write the reader tests', activeForm: 'Writing the reader tests' }),
  ];
  assert.deepEqual(todosIn(created, { append: [worked] }), [
    { content: 'Read the reader', activeForm: 'Reading the reader', status: 'completed' },
    { content: 'Write the reader tests', activeForm: 'Writing the reader tests', status: 'in_progress' },
  ]);
});

test('a deleted task drops out, and an update to a task the reader never saw changes nothing', () => {
  const created = [...taskCreate('1', { subject: 'Read the reader' }), ...taskCreate('2', { subject: 'Write the tests' })];
  assert.deepEqual(todosIn([...created, ...taskUpdate('1', { status: 'deleted' }), ...taskUpdate('9', { status: 'completed' })]), [
    { content: 'Write the tests', status: 'pending' },
  ]);
});

test('a task tool changes nothing when its result says it failed', () => {
  const failedCreate = call('TaskCreate', { subject: 'Read the reader', description: 'x' });
  assert.deepEqual(todosIn([failedCreate.record, result(failedCreate.id, undefined, { content: 'Error', isError: true })]), []);
  const created = taskCreate('1', { subject: 'Read the reader' });
  const refused = taskUpdate('1', { status: 'completed' }, { success: false, taskId: '1', updatedFields: [], error: 'Task not found' });
  assert.deepEqual(todosIn([...created, ...refused]), [{ content: 'Read the reader', status: 'pending' }]);
});

test("the reader takes a new task's id from the result text when the result has no data", () => {
  const c = call('TaskCreate', { subject: 'Read the reader', description: 'x' });
  const created = result(c.id, undefined, { content: 'Task #7 created successfully: Read the reader' });
  assert.deepEqual(todosIn([c.record, created, ...taskUpdate('7', { status: 'in_progress' })]), [
    { content: 'Read the reader', status: 'in_progress' },
  ]);
});

test('the program shows the todo in progress from a transcript', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'session.jsonl');
  fs.writeFileSync(file, jsonl([...taskCreate('1', { subject: 'Read the reader', activeForm: 'Reading the reader' }), ...taskUpdate('1', { status: 'in_progress' })]));
  const out = require('node:child_process').execFileSync(
    process.execPath,
    [path.join(__dirname, '..', 'dist', 'statusline.js'), '--show', 'todos'],
    {
      env: { ...process.env, CLAUDE_CONFIG_DIR: path.join(dir, 'config'), COLUMNS: '' },
      input: JSON.stringify({ workspace: { current_dir: dir }, transcript_path: file }),
      encoding: 'utf8',
    },
  );
  assert.equal(plain(out), '◐ Reading the reader 0/1\n');
});

test('a transcript state from before the todos part is read again from the start', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'session.jsonl');
  const stateDir = path.join(dir, 'state');
  fs.writeFileSync(file, jsonl(todoWrite([{ content: 'Write the tests', status: 'pending' }])));
  readTranscriptActivity(file, { stateDir });
  // The state as claude-gauge wrote it before: version 2, with no todos.
  const [name] = fs.readdirSync(stateDir);
  const saved = JSON.parse(fs.readFileSync(path.join(stateDir, name), 'utf8'));
  delete saved.todos;
  delete saved.todoCalls;
  fs.writeFileSync(path.join(stateDir, name), JSON.stringify({ ...saved, version: 2 }));
  assert.deepEqual(readTranscriptActivity(file, { stateDir }).todos, [{ content: 'Write the tests', status: 'pending' }]);
});
