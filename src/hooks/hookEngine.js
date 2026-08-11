'use strict';

const { createHookRegistry } = require('./hookRegistry');
const { createHookHandlerRegistry } = require('./hookHandlerRegistry');
const { createHookResolver } = require('./hookResolver');
const { createHookAudit } = require('./hookAudit');
const { createHookDispatcher } = require('./hookDispatcher');

function createHookEngine(options = {}) {
  const registry = options.registry || createHookRegistry({ store: options.definitionStore });
  const handlerRegistry = options.handlerRegistry || createHookHandlerRegistry();
  const resolver = options.resolver || createHookResolver({ registry, handlerRegistry });
  const audit = options.audit || createHookAudit({ store: options.auditStore });
  const dispatcher = options.dispatcher || createHookDispatcher({ resolver, handlerRegistry, audit });
  return {
    registry,
    handlerRegistry,
    resolver,
    dispatcher,
    audit,
    dispatch: input => dispatcher.dispatch(input)
  };
}

module.exports = { createHookEngine };
