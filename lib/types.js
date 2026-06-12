// Type defaults table. The shortcut form (`yc claude`) and named-cage
// `--type=…` flag pick from these. v0 ships claude + codex enabled; opencode
// is sketched in but `v0:false` so the CLI errors cleanly if the operator
// asks for it.
//
// Each entry's `bindDirs` describes the default mounts for a fresh cage:
//   workspace: a host path mounted at /workspace (default = cwd)
//   configDir: a host path for the agent's per-user config (claude.ai login
//              cache + codex auth). Replaceable via --config-dir.
//
// `cmd` is the in-container command line the entrypoint exec()s by default.
// CLI pass-through args (`yc claude -- --resume`) are appended after.

'use strict';

const path = require('path');
const os = require('os');

const HOME = os.homedir();

const TYPE_DEFAULTS = {
  claude: {
    v0: true,
    image: 'yolocage/claude:dev',
    configDirHost: path.join(HOME, '.claude'),
    configDirContainer: '/home/agent/.claude',
    cmd: ['claude', '--dangerously-skip-permissions'],
  },
  codex: {
    v0: true,
    image: 'yolocage/codex:dev',
    configDirHost: path.join(HOME, '.codex'),
    configDirContainer: '/home/agent/.codex',
    cmd: ['codex', '--full-auto'],
  },
  opencode: {
    v0: false,
    image: 'yolocage/opencode:dev',
    configDirHost: path.join(HOME, '.config', 'opencode'),
    configDirContainer: '/home/agent/.config/opencode',
    cmd: ['opencode'],
  },
};

function isKnownType(type) {
  return Object.prototype.hasOwnProperty.call(TYPE_DEFAULTS, type);
}

function getType(type) {
  if (!isKnownType(type)) {
    throw new Error(`unknown --type=${type} (known: ${Object.keys(TYPE_DEFAULTS).join(', ')})`);
  }
  const t = TYPE_DEFAULTS[type];
  if (!t.v0) {
    throw new Error(`--type=${type} support coming in v2 (v0 ships claude + codex only)`);
  }
  return t;
}

module.exports = { TYPE_DEFAULTS, getType, isKnownType };
