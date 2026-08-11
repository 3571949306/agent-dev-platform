'use strict';

const PRICE_UNITS = new Set(['per_token', 'per_1k_tokens', 'per_1m_tokens']);
const UNIT_MULTIPLIER = Object.freeze({ per_token: 1000000, per_1k_tokens: 1000, per_1m_tokens: 1 });

function normalizeCurrency(value) {
  return typeof value === 'string' && value.trim() ? value.trim().toUpperCase() : null;
}

function normalizePriceUnit(value) {
  return PRICE_UNITS.has(value) ? value : 'unknown';
}

function toPerMillion(value, unit) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  const multiplier = UNIT_MULTIPLIER[unit];
  return multiplier ? value * multiplier : null;
}

function priceBasisKey(pricing) {
  if (!pricing || !pricing.currency || pricing.unit !== 'per_1m_tokens') return null;
  return `${pricing.currency}|${pricing.unit}`;
}

module.exports = { PRICE_UNITS, UNIT_MULTIPLIER, normalizeCurrency, normalizePriceUnit, toPerMillion, priceBasisKey };
