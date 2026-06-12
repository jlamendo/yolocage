// .ycrc parser.
//
// Strict key=value with `#` comments. ONLY `~` (leading) and literal
// `$HOME` are expanded in values — no shell, no eval, no `$(…)` /
// backtick substitution. The threat model is hostile project-local
// `.ycrc` files: a malicious repo MUST NOT be able to execute
// `$(rm -rf ~)` just by being cloned. See README §"Security model".
//
// Multi-value keys (extra_bind_dirs) appear once per value; the cascade
// in lib/config.js unions them across layers.

'use strict';

const fs = require('fs');
const os = require('os');

// Keys whose value may legitimately appear multiple times in a single
// .ycrc. Anything not listed here: last occurrence wins.
const MULTI_VALUE_KEYS = new Set(['extra_bind_dirs', 'bind_dirs']);

// Path-shaped keys get ~/$HOME expansion applied to their values.
// Non-path values (memory=4g, type=claude) pass through untouched.
const PATH_KEYS = new Set([
  'workspace',
  'config_dir',
  'ssproxy_extensions',
  'bind_dirs',
  'extra_bind_dirs',
]);

function expandPathish(value) {
  if (typeof value !== 'string') return value;
  let v = value;
  // Leading `~` → $HOME. Only at start; `foo~bar` is left alone.
  if (v.startsWith('~/')) {
    v = os.homedir() + v.slice(1);
  } else if (v === '~') {
    v = os.homedir();
  }
  // Literal `$HOME` → $HOME. Not `${HOME}`, not `$HOME_DIR`, not any
  // other shell variable — that's the design. A hostile .ycrc can write
  // `$(rm -rf ~)` and it stays the literal 11-character string.
  v = v.replace(/\$HOME(?![A-Za-z0-9_])/g, os.homedir());
  return v;
}

function parseYcrc(text) {
  const out = {};
  // Track multi-value-key accumulators.
  for (const k of MULTI_VALUE_KEYS) out[k] = [];

  const lines = String(text || '').split(/\r?\n/);
  for (let lineno = 0; lineno < lines.length; lineno++) {
    let line = lines[lineno];
    // Strip comments: anything from `#` to EOL. We don't honour
    // escaped `#` — the .ycrc format is intentionally minimal.
    const hashIdx = line.indexOf('#');
    if (hashIdx >= 0) line = line.slice(0, hashIdx);
    line = line.trim();
    if (!line) continue;
    const eq = line.indexOf('=');
    if (eq < 0) {
      throw new Error(`.ycrc: malformed line ${lineno + 1}: ${JSON.stringify(line)} (expected key=value)`);
    }
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (!key) {
      throw new Error(`.ycrc: empty key at line ${lineno + 1}`);
    }
    if (PATH_KEYS.has(key)) {
      value = expandPathish(value);
    }
    if (MULTI_VALUE_KEYS.has(key)) {
      out[key].push(value);
    } else {
      out[key] = value;
    }
  }
  // Strip empty multi-value arrays so the cascade can treat "absent"
  // and "empty" identically.
  for (const k of MULTI_VALUE_KEYS) {
    if (out[k].length === 0) delete out[k];
  }
  return out;
}

function readYcrc(filepath) {
  let text;
  try {
    text = fs.readFileSync(filepath, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
  return parseYcrc(text);
}

module.exports = { parseYcrc, readYcrc, expandPathish, MULTI_VALUE_KEYS, PATH_KEYS };
