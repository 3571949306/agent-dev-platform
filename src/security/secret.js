'use strict';
/**
 * Secret storage for API keys.
 * In Electron: uses safeStorage (OS-level encryption via DPAPI on Windows).
 * Outside Electron (unit tests / node): falls back to weak base64 obfuscation
 * so the app boots; this fallback is NOT secure and must never be used in prod.
 */
const crypto = require('crypto');

let safeStorage = null;
try {
  safeStorage = require('electron').safeStorage;
} catch {
  safeStorage = null;
}

let usingSafe = !!(safeStorage && safeStorage.isEncryptionAvailable && safeStorage.isEncryptionAvailable());

function encrypt(plain) {
  if (plain === null || plain === undefined || plain === '') return '';
  if (usingSafe) {
    try {
      const buf = safeStorage.encryptString(String(plain));
      return 'enc:' + buf.toString('base64');
    } catch {
      // fall through to obf
    }
  }
  return 'obf:' + Buffer.from(String(plain), 'utf8').toString('base64');
}

function decrypt(stored) {
  if (!stored) return '';
  if (stored.startsWith('enc:')) {
    const buf = Buffer.from(stored.slice(4), 'base64');
    return safeStorage.decryptString(buf);
  }
  if (stored.startsWith('obf:')) {
    return Buffer.from(stored.slice(4), 'base64').toString('utf8');
  }
  return stored;
}

// Never log the plaintext key. Mask middle with ****.
function mask(plain) {
  if (!plain) return '';
  if (plain.length <= 8) return plain[0] + '****' + plain[plain.length - 1];
  return plain.slice(0, 4) + '*'.repeat(Math.min(plain.length - 8, 12)) + plain.slice(-4);
}

// Detect a likely secret so UI can warn if stored in plaintext by mistake.
function looksSecret(plain) {
  if (!plain) return false;
  return /sk-[A-Za-z0-9]/.test(plain) || /^xox/.test(plain) || plain.startsWith('ghp_') || plain.startsWith('AIza');
}

module.exports = { encrypt, decrypt, mask, looksSecret, isUsingSafe: () => usingSafe };
