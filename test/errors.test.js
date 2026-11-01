'use strict';

// The errors that claude-gauge throws on purpose keep their values apart from
// their text, so the CLI can print each value green on a colour terminal
// while the plain message stays the text that logs and tests read.

const test = require('node:test');
const assert = require('node:assert/strict');
const { GaugeError, message, plain } = require('../dist/errors.js');
const { styles } = require('../dist/styles.js');

const GREEN = '\x1b[0;32m';
const RESET = '\x1b[0m';

test('the plain message is the template with its values in place', () => {
  const err = new GaugeError(message`There is no copy of claude-gauge in ${'/tmp/x'} to update.`);
  assert.ok(err instanceof Error);
  assert.equal(err.message, 'There is no copy of claude-gauge in /tmp/x to update.');
});

test('render paints each value green with colour on, and gives the plain message with colour off', () => {
  const err = new GaugeError(message`${'a.json'} is not valid JSON (${plain('Unexpected token')}), so ${'b'} stays.`);
  assert.equal(err.render(styles(true)), `${GREEN}a.json${RESET} is not valid JSON (Unexpected token), so ${GREEN}b${RESET} stays.`);
  assert.equal(err.render(styles(false)), err.message);
});

test('a value over several lines is painted line by line, so each line resets its own colour', () => {
  const err = new GaugeError(message`runs:\n  ${'one\ntwo'}`);
  assert.equal(err.message, 'runs:\n  one\ntwo');
  assert.equal(err.render(styles(true)), `runs:\n  ${GREEN}one${RESET}\n${GREEN}two${RESET}`);
});

test('a subclass keeps the class and the render', () => {
  class Special extends GaugeError {}
  const err = new Special(message`x ${'y'}`);
  assert.ok(err instanceof GaugeError);
  assert.equal(err.render(styles(true)), `x ${GREEN}y${RESET}`);
});
