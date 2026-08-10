'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { add } = require('../src/math');

test('add returns the sum of two numbers', () => {
  assert.strictEqual(add(2, 3), 5);
});
