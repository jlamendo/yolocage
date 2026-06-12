// Configuration cascade.
//
// Precedence (lowest → highest):
//   1. type defaults (claude / codex)
//   2. ~/.ycrc
//   3. ./.ycrc
//   4. CLI flags
//
// Per-key cascade rule (matches the table in README.md §"Cascade semantics"):
//
//   type, image, workspace, config_dir, memory, cpus, tmux,
//   ssproxy_extensions          → replace (later wins entirely)
//   bind_dirs                   → replace (later layer wins entirely)
//   extra_bind_dirs             → append + dedupe by host:container
//
// The output is a fully-resolved plain-object cage spec ready for
// lib/docker.js to translate into a `docker run` argv.

'use strict';

const path = require('path');
const os = require('os');

const { getType } = require('./types');
const { readYcrc } = require('./ycrc');
const { parseBindSpec, dedupeBindList } = require('./bind-spec');

const REPLACE_KEYS = new Set([
  'type',
  'image',
  'workspace',
  'config_dir',
  'memory',
  'cpus',
  'tmux',
  'ssproxy_extensions',
  'bind_dirs', // replace, not append
]);

const APPEND_KEYS = new Set(['extra_bind_dirs']);

// Resolve a raw cascade-merged spec into a normalized cage spec. The
// raw spec carries .ycrc-shaped strings; the normalized spec carries
// the values we'll hand to docker.
function normalize(raw) {
  const type = raw.type || 'claude';
  const td = getType(type);

  const workspace = raw.workspace
    ? path.resolve(raw.workspace)
    : path.resolve(process.cwd());

  const configDirHost = raw.config_dir
    ? path.resolve(raw.config_dir)
    : td.configDirHost;

  // bind_dirs (replace): if the user set it, use ONLY those + the
  // workspace + the config_dir. If unset, generate the type defaults.
  let bindDirs;
  if (Array.isArray(raw.bind_dirs) && raw.bind_dirs.length > 0) {
    bindDirs = raw.bind_dirs.map(parseBindSpec);
  } else {
    bindDirs = [
      { host: workspace, container: '/workspace', mode: 'rw' },
      { host: configDirHost, container: td.configDirContainer, mode: 'rw' },
    ];
  }

  const extraBindDirs = (raw.extra_bind_dirs || []).map(parseBindSpec);
  const allBinds = dedupeBindList([...bindDirs, ...extraBindDirs]);

  const tmux = parseBool(raw.tmux);

  return {
    type,
    image: raw.image || td.image,
    workspace,
    configDirHost,
    configDirContainer: td.configDirContainer,
    bindDirs: allBinds,
    memory: raw.memory || null,
    cpus: raw.cpus || null,
    tmux,
    ssproxyExtensions: raw.ssproxy_extensions || null,
    cmd: td.cmd.slice(),
    passthrough: Array.isArray(raw.passthrough) ? raw.passthrough.slice() : [],
  };
}

function parseBool(v) {
  if (typeof v === 'boolean') return v;
  if (v === undefined || v === null || v === '') return false;
  const s = String(v).toLowerCase();
  return s === 'true' || s === '1' || s === 'yes' || s === 'on';
}

// Merge `incoming` into `acc`. Replace keys clobber; append keys union.
function mergeLayer(acc, incoming) {
  if (!incoming) return acc;
  for (const k of Object.keys(incoming)) {
    if (APPEND_KEYS.has(k)) {
      const prev = Array.isArray(acc[k]) ? acc[k] : [];
      const next = Array.isArray(incoming[k]) ? incoming[k] : [incoming[k]];
      acc[k] = [...prev, ...next];
    } else if (REPLACE_KEYS.has(k)) {
      if (incoming[k] !== undefined) acc[k] = incoming[k];
    } else {
      // Unknown key — preserve last-wins like REPLACE for forward compat.
      if (incoming[k] !== undefined) acc[k] = incoming[k];
    }
  }
  return acc;
}

// Build the cascade.
//   opts.type          — explicit type from argv ('claude'|'codex'|...)
//   opts.homeYcrcPath  — typically ~/.ycrc
//   opts.projectYcrcPath — typically ./.ycrc (cwd)
//   opts.cliLayer      — already-parsed object from commander
function resolveCascade(opts) {
  const acc = {};

  // Layer 1: type baseline — sets `type` only. Defaults for workspace
  // / config_dir flow through normalize() based on cwd + $HOME.
  if (opts.type) mergeLayer(acc, { type: opts.type });

  // Layer 2: ~/.ycrc
  let home = null;
  try {
    home = readYcrc(opts.homeYcrcPath);
  } catch (e) {
    throw new Error(`error reading ${opts.homeYcrcPath}: ${e.message}`);
  }
  if (home) mergeLayer(acc, home);

  // Layer 3: ./.ycrc
  let project = null;
  try {
    project = readYcrc(opts.projectYcrcPath);
  } catch (e) {
    throw new Error(`error reading ${opts.projectYcrcPath}: ${e.message}`);
  }
  if (project) mergeLayer(acc, project);

  // Layer 4: CLI flags
  if (opts.cliLayer) mergeLayer(acc, opts.cliLayer);

  return normalize(acc);
}

module.exports = {
  resolveCascade,
  normalize,
  mergeLayer,
  parseBool,
  REPLACE_KEYS,
  APPEND_KEYS,
};
