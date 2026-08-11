'use strict';

let registry = null;
let resolver = null;

function setSkillRuntime(nextRegistry, nextResolver) {
  registry = nextRegistry || null;
  resolver = nextResolver || null;
}

function getSkillRuntime() {
  return { registry, resolver };
}

module.exports = { setSkillRuntime, getSkillRuntime };
