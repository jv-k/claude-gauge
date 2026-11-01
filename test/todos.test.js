'use strict';

// The todos part and what the transcript reader finds for it: the todo in
// progress, and how many of the session's todos are done.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { render, parseArgs, readTranscriptActivity } = require('../dist/statusline.js');

const { plain, tempDir } = require('./helpers');

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
function todosIn(records, { dir = tempDir(), append = [] } = {}) {
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

// A TaskList call and its result, as Claude Code writes it: the tasks in its
// data, which is all the reader reads.
const taskList = (tasks) =>
  done('TaskList', {}, { tasks: tasks.map((t) => ({ owner: undefined, blockedBy: [], ...t })) });

test('a TaskList result replaces the list, and later task calls apply on top of it', () => {
  const listed = taskList([
    { id: '1', subject: 'Read the reader', status: 'completed' },
    { id: '2', subject: 'Write the tests', status: 'in_progress' },
    { id: '3', subject: 'Update the README', status: 'pending' },
  ]);
  const before = [...taskCreate('9', { subject: 'Gone from the list' }), ...todoWrite([{ content: 'An old todo', status: 'pending' }])];
  assert.deepEqual(todosIn([...before, ...listed]), [
    { content: 'Read the reader', status: 'completed' },
    { content: 'Write the tests', status: 'in_progress' },
    { content: 'Update the README', status: 'pending' },
  ]);
  assert.equal(renderTodos(todosIn(listed)), '◐ Write the tests 1/3');
  const after = [...taskUpdate('3', { status: 'completed' }), ...taskCreate('4', { subject: 'Ship it' })];
  assert.deepEqual(todosIn(listed, { append: [after] }), [
    { content: 'Read the reader', status: 'completed' },
    { content: 'Write the tests', status: 'in_progress' },
    { content: 'Update the README', status: 'completed' },
    { content: 'Ship it', status: 'pending' },
  ]);
  assert.deepEqual(todosIn([...before, ...taskList([])]), []);
});

test('a TaskList keeps the active form the reader knew for a task', () => {
  const created = taskCreate('1', { subject: 'Read the reader', activeForm: 'Reading the reader' });
  const listed = taskList([{ id: '1', subject: 'Read the reader', status: 'in_progress' }]);
  assert.deepEqual(todosIn([...created, ...listed]), [{ content: 'Read the reader', activeForm: 'Reading the reader', status: 'in_progress' }]);
});

// A TaskGet call and its result: the task, or null when there is none.
const taskGet = (taskId, task) =>
  done('TaskGet', { taskId }, { task: task && { id: taskId, description: 'The details.', blocks: [], blockedBy: [], ...task } });

test('a TaskGet result adds a task the reader did not know, and changes one it did', () => {
  const created = taskCreate('1', { subject: 'Read the reader', activeForm: 'Reading the reader' });
  assert.deepEqual(todosIn([...created, ...taskGet('7', { subject: 'Made in an earlier session', status: 'completed' })]), [
    { content: 'Read the reader', activeForm: 'Reading the reader', status: 'pending' },
    { content: 'Made in an earlier session', status: 'completed' },
  ]);
  assert.deepEqual(todosIn([...created, ...taskGet('1', { subject: 'Read the whole reader', status: 'in_progress' })]), [
    { content: 'Read the whole reader', activeForm: 'Reading the reader', status: 'in_progress' },
  ]);
  assert.deepEqual(todosIn([...created, ...taskGet('8', null)]), [{ content: 'Read the reader', activeForm: 'Reading the reader', status: 'pending' }]);
  // A null result for a task the reader knew: another session deleted it.
  assert.deepEqual(todosIn([...created, ...taskGet('1', null)]), []);
  // A result with no task data at all changes nothing.
  assert.deepEqual(todosIn([...created, ...done('TaskGet', { taskId: '1' }, {})]), [
    { content: 'Read the reader', activeForm: 'Reading the reader', status: 'pending' },
  ]);
});

test('an update to an unknown task applies once a later TaskList or TaskGet names it', () => {
  const update = taskUpdate('5', { status: 'completed' });
  assert.deepEqual(todosIn(update), []);
  assert.deepEqual(todosIn([...update, ...taskGet('5', { subject: 'Made elsewhere', status: 'completed' })]), [
    { content: 'Made elsewhere', status: 'completed' },
  ]);
  const listed = taskList([{ id: '5', subject: 'Made elsewhere', status: 'pending' }]);
  assert.deepEqual(todosIn([...listed, ...taskUpdate('5', { status: 'completed' })]), [{ content: 'Made elsewhere', status: 'completed' }]);
});

// A call a subagent makes and its result, both subagent records.
const inSubagent = (records) => records.map((r) => ({ ...r, isSidechain: true }));

test("a subagent's TaskCreate and TaskUpdate change the list, and its other records do not", () => {
  const created = [...taskCreate('1', { subject: 'Read the reader' }), ...taskCreate('2', { subject: 'Write the tests' })];
  const subagent = inSubagent([
    ...taskUpdate('1', { status: 'completed' }),
    ...taskCreate('3', { subject: 'Found by the subagent' }),
    ...taskList([{ id: '9', subject: 'Listed by the subagent', status: 'pending' }]),
    ...taskGet('8', { subject: 'Read by the subagent', status: 'pending' }),
    ...todoWrite([{ content: 'Its own todo', status: 'pending' }]),
  ]);
  const todos = todosIn(created, { append: [subagent] });
  assert.deepEqual(todos, [
    { content: 'Read the reader', status: 'completed' },
    { content: 'Write the tests', status: 'pending' },
    { content: 'Found by the subagent', status: 'pending' },
  ]);
  assert.equal(renderTodos(todos), 'todos 1/3');
});

test("a subagent's records leave the other transcript parts as they were", () => {
  const dir = tempDir();
  const file = path.join(dir, 'session.jsonl');
  const records = [...taskCreate('1', { subject: 'Read the reader' })];
  fs.writeFileSync(file, jsonl(records));
  const before = readTranscriptActivity(file, { stateDir: path.join(dir, 'before') });
  fs.writeFileSync(file, jsonl([...records, ...inSubagent([...taskUpdate('1', { status: 'in_progress' }), ...done('Read', { file_path: '/x' })])]));
  const after = readTranscriptActivity(file, { stateDir: path.join(dir, 'after') });
  assert.deepEqual({ ...after, todos: before.todos }, before);
  assert.deepEqual(after.todos, [{ content: 'Read the reader', status: 'in_progress' }]);
});

test('the program shows the todo in progress from a transcript', () => {
  const dir = tempDir();
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

test('a transcript state from before the reader read TaskList is read again from the start', () => {
  const dir = tempDir();
  const file = path.join(dir, 'session.jsonl');
  const stateDir = path.join(dir, 'state');
  fs.writeFileSync(file, jsonl(taskList([{ id: '1', subject: 'Read the reader', status: 'completed' }])));
  readTranscriptActivity(file, { stateDir });
  // The state as claude-gauge wrote it before: version 5, blind to TaskList.
  const [name] = fs.readdirSync(stateDir);
  const saved = JSON.parse(fs.readFileSync(path.join(stateDir, name), 'utf8'));
  fs.writeFileSync(path.join(stateDir, name), JSON.stringify({ ...saved, version: 5, todos: [] }));
  assert.deepEqual(readTranscriptActivity(file, { stateDir }).todos, [{ content: 'Read the reader', status: 'completed' }]);
});

test('a transcript state from before the todos part is read again from the start', () => {
  const dir = tempDir();
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
