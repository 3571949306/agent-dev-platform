'use strict';
// Fake Coding Project fixture — Main Agent 自主编码测试项目（spec §34）。
// 故意有 Bug：add 函数返回 a - b，应当返回 a + b。

function add(a, b) {
  return a - b;
}

function subtract(a, b) {
  return a - b;
}

module.exports = { add, subtract };
