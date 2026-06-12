// Bind-spec parser.
//
// Accepted shapes:
//   host:container
//   host:container:ro
//   host:container:rw
//
// Trickiness: Mac paths can contain colons in volume names (rare) and
// Windows-style C:\… isn't supported, but the parser must not choke on
// "host paths that have colons" if the third-from-end token isn't a
// recognized mode. The algorithm:
//
//   - Split on `:`.
//   - If 2 tokens: host=tokens[0], container=tokens[1], mode=default.
//   - If 3+ tokens: check if the LAST token is `ro`/`rw`. If yes:
//       mode = last; container = second-to-last; host = everything else
//       joined by `:`.
//     Otherwise:
//       container = last; host = everything else joined by `:`;
//       mode = default.
//
// `~`-expansion happens on the host side (same rules as .ycrc).

'use strict';

const os = require('os');

const VALID_MODES = new Set(['ro', 'rw']);
const DEFAULT_MODE = 'rw';

function expandHomeOnHost(p) {
  if (typeof p !== 'string') return p;
  if (p.startsWith('~/')) return os.homedir() + p.slice(1);
  if (p === '~') return os.homedir();
  return p.replace(/\$HOME(?![A-Za-z0-9_])/g, os.homedir());
}

function parseBindSpec(spec) {
  if (typeof spec !== 'string' || spec.length === 0) {
    throw new Error(`bind-spec: empty or non-string spec`);
  }
  const tokens = spec.split(':');
  if (tokens.length < 2) {
    throw new Error(`bind-spec: invalid spec ${JSON.stringify(spec)} (need at least host:container)`);
  }

  let host, container, mode;
  if (tokens.length === 2) {
    [host, container] = tokens;
    mode = DEFAULT_MODE;
  } else {
    const last = tokens[tokens.length - 1];
    if (VALID_MODES.has(last)) {
      mode = last;
      container = tokens[tokens.length - 2];
      host = tokens.slice(0, tokens.length - 2).join(':');
    } else {
      mode = DEFAULT_MODE;
      container = last;
      host = tokens.slice(0, tokens.length - 1).join(':');
    }
  }

  if (!host) throw new Error(`bind-spec: empty host path in ${JSON.stringify(spec)}`);
  if (!container) throw new Error(`bind-spec: empty container path in ${JSON.stringify(spec)}`);
  if (!container.startsWith('/')) {
    throw new Error(`bind-spec: container path must be absolute, got ${JSON.stringify(container)}`);
  }
  host = expandHomeOnHost(host);

  return { host, container, mode };
}

function formatBindSpec(b) {
  return `${b.host}:${b.container}:${b.mode}`;
}

// Dedupe a list of bind specs by their host:container pair (mode is
// not part of the dedupe key — later mode wins). Preserves input
// order, dropping subsequent duplicates.
function dedupeBindList(list) {
  const seen = new Map(); // "host:container" -> index in out
  const out = [];
  for (const b of list) {
    const key = `${b.host}:${b.container}`;
    if (seen.has(key)) {
      // Later layer's mode wins.
      out[seen.get(key)] = b;
    } else {
      seen.set(key, out.length);
      out.push(b);
    }
  }
  return out;
}

module.exports = {
  parseBindSpec,
  formatBindSpec,
  dedupeBindList,
  expandHomeOnHost,
  VALID_MODES,
  DEFAULT_MODE,
};
