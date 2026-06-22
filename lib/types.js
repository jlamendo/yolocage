// Type defaults table. The shortcut form (`yc claude`) and named-cage
// `--type=…` flag pick from these. v0 ships claude + codex.
//
// Each entry's `bindDirs` describes the default mounts for a fresh cage:
//   workspace: a host path mounted at /workspace (default = cwd)
//   configDir: a host path for the agent's per-user config (claude.ai login
//              cache + codex auth). Replaceable via --config-dir.
//
// `cmd` is the in-container command line the entrypoint exec()s by default.
// CLI pass-through args (`yc claude -- --resume`) are appended after.
//
// Images are published from .github/workflows/publish-images.yml to
// ghcr.io/jlamendo/yolocage-<name> as multi-arch (linux/amd64 +
// linux/arm64) manifests. `:latest` follows main; pinned tags are
// optionally emitted via the workflow_dispatch input.

'use strict';

const path = require('path');
const os = require('os');

const HOME = os.homedir();

const TYPE_DEFAULTS = {
  claude: {
    v0: true,
    image: 'ghcr.io/jlamendo/yolocage-claude:latest',
    configDirHost: path.join(HOME, '.claude'),
    configDirContainer: '/home/agent/.claude',
    // --continue auto-resumes the most recent in-cwd conversation; harmless on
    // first run (claude falls back to a fresh session). With per-cwd persistent
    // cages, this is what the operator wants by default — `yc claude` always
    // either resumes or starts fresh, never re-introduces itself mid-project.
    cmd: ['claude', '--continue', '--dangerously-skip-permissions'],
  },
  codex: {
    v0: true,
    image: 'ghcr.io/jlamendo/yolocage-codex:latest',
    configDirHost: path.join(HOME, '.codex'),
    configDirContainer: '/home/agent/.codex',
    cmd: ['codex', '--full-auto'],
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
