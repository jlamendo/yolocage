#!/usr/bin/env node
// yc — yolocage CLI. Two surfaces:
//
//   Shortcut form (one-shot, ephemeral):
//     yc                    → default type (claude) in $(pwd)
//     yc claude             → explicit
//     yc codex              → codex instead
//     yc claude -- --resume → pass-through args after `--`
//
//   Subcommand form (named cages, persistent):
//     yc create NAME --type=…
//     yc run NAME
//     yc list
//     yc rm NAME
//     yc logs NAME
//     yc pull
//     yc help
//
// Argv dispatch happens here BEFORE commander runs because the shortcut
// form would otherwise collide with commander's "unknown command" path.

'use strict';

const path = require('path');
const os = require('os');
const { Command } = require('commander');

const { resolveCascade } = require('./lib/config');
const { isKnownType, getType, TYPE_DEFAULTS } = require('./lib/types');
const crypto = require('crypto');
const {
  buildRunArgs,
  runDocker,
  dockerArgv,
  cageExists,
  cageRunning,
} = require('./lib/docker');
const { update: runUpdate } = require('./lib/update');

const SUBCOMMANDS = new Set(['create', 'run', 'list', 'rm', 'logs', 'pull', 'update', 'help']);

// Detect shortcut vs subcommand form. Returns:
//   { mode: 'shortcut', type, passthrough }    or
//   { mode: 'subcommand', argv }
function classifyArgv(argv) {
  // argv: process.argv.slice(2)
  // Shortcut cases:
  //   []                           → claude
  //   ['claude'|'codex'|'opencode'] → that type
  //   ['claude', '--', ...]        → claude + passthrough
  // Help flags forward to commander.
  if (argv.length === 0) {
    return { mode: 'shortcut', type: 'claude', passthrough: [] };
  }
  const first = argv[0];
  if (first === '--help' || first === '-h' || first === '--version' || first === '-V') {
    return { mode: 'subcommand', argv };
  }
  if (SUBCOMMANDS.has(first)) {
    return { mode: 'subcommand', argv };
  }
  if (isKnownType(first)) {
    // `yc claude [-- passthrough...]`
    const rest = argv.slice(1);
    let passthrough = [];
    if (rest.length > 0) {
      if (rest[0] === '--') {
        passthrough = rest.slice(1);
      } else {
        // Tokens after `yc claude` without a `--` separator are
        // unexpected in shortcut form. Treat anything starting with
        // `-` as passthrough (user forgot `--`), otherwise error.
        if (rest.every((r) => r.startsWith('-'))) {
          passthrough = rest;
        } else {
          throw new Error(
            `unexpected positional arg(s) after "yc ${first}": ${JSON.stringify(rest)}. ` +
              `Use "yc ${first} -- ${rest.join(' ')}" to pass through.`
          );
        }
      }
    }
    return { mode: 'shortcut', type: first, passthrough };
  }
  // Unknown first token — let commander handle the error message.
  return { mode: 'subcommand', argv };
}

function homeYcrcPath() {
  return path.join(os.homedir(), '.ycrc');
}

function projectYcrcPath() {
  return path.join(process.cwd(), '.ycrc');
}

function assertSafeCwdForShortcut() {
  const cwd = path.resolve(process.cwd());
  const home = path.resolve(os.homedir());
  if (cwd === home) {
    throw new Error(
      `refusing to run shortcut form in $HOME (${cwd}). ` +
        `cd into a project directory, or use "yc create NAME --bind-workspace=…" for an explicit workspace.`
    );
  }
  if (cwd === '/' || cwd === path.parse(cwd).root) {
    throw new Error(`refusing to run shortcut form at filesystem root (${cwd}).`);
  }
}

// Derive a deterministic cage name from the cwd + agent type. Same dir +
// same type → same name → `yc claude` re-runs attach to the same cage.
// Different cwds with the same basename get disambiguated by the 8-hex hash
// of the full path. Output respects docker container name rules
// (^[a-zA-Z0-9][a-zA-Z0-9_.-]*$).
function getCwdCageName(type, cwd) {
  cwd = cwd || process.cwd();
  const raw = path.basename(cwd).toLowerCase();
  // Squash anything that isn't a docker-name char to '-', then trim leading
  // and trailing punctuation so the result starts with a letter or digit.
  let basename = raw
    .replace(/[^a-z0-9._-]/g, '-')
    .replace(/^[-._]+/, '')
    .replace(/[-._]+$/, '')
    .substring(0, 32);
  if (!basename) basename = 'cage';
  const hash = crypto.createHash('sha256').update(cwd).digest('hex').substring(0, 8);
  return `yc-${type}-${basename}-${hash}`;
}

function runShortcut(type, passthrough) {
  assertSafeCwdForShortcut();
  // Validate type (throws on opencode/unknown).
  getType(type);
  const cageName = getCwdCageName(type);

  // Branch 1: cage is already running. Attach to it and let the user
  // rejoin the existing claude/codex session. docker attach's default
  // detach key (Ctrl-P Ctrl-Q) leaves the cage running; Ctrl-C exits
  // claude which stops the cage.
  if (cageRunning(cageName)) {
    process.stderr.write(
      `yc: cage '${cageName}' already running; attaching ` +
        '(Ctrl-P Ctrl-Q to detach, Ctrl-C exits claude)\n'
    );
    const res = runDocker(['attach', cageName]);
    process.exit(res.status == null ? 1 : res.status);
  }

  // Branch 2: cage exists but is stopped. Start it back up; the entrypoint
  // re-runs the original CMD which (for claude) includes --continue so the
  // prior in-cwd session is restored.
  if (cageExists(cageName)) {
    process.stderr.write(`yc: resuming cage '${cageName}'\n`);
    const res = runDocker(['start', '-ai', cageName]);
    process.exit(res.status == null ? 1 : res.status);
  }

  // Branch 3: no cage yet for this cwd + type. Create + start + attach in
  // one docker run. Persistent (no --rm) so subsequent `yc claude` in this
  // dir lands in branches 1 or 2.
  const spec = resolveCascade({
    type,
    homeYcrcPath: homeYcrcPath(),
    projectYcrcPath: projectYcrcPath(),
    cliLayer: { type, passthrough },
  });
  process.stderr.write(`yc: creating cage '${cageName}' for ${process.cwd()}\n`);
  const { argv: runArgs, cmd } = buildRunArgs(spec, {
    rm: false,
    interactive: true,
    name: cageName,
  });
  const res = runDocker([...runArgs, ...cmd]);
  process.exit(res.status == null ? 1 : res.status);
}

function buildCliLayer(opts) {
  // Translate commander option flags → cascade-shaped object.
  const out = {};
  if (opts.type) out.type = opts.type;
  if (opts.image) out.image = opts.image;
  if (opts.bindWorkspace) out.workspace = path.resolve(opts.bindWorkspace);
  if (opts.configDir) out.config_dir = path.resolve(opts.configDir);
  if (opts.memory) out.memory = opts.memory;
  if (opts.cpus) out.cpus = opts.cpus;
  if (opts.tmux !== undefined) out.tmux = !!opts.tmux;
  if (opts.ssproxyExtensions) out.ssproxy_extensions = path.resolve(opts.ssproxyExtensions);
  if (opts.bindDirs && opts.bindDirs.length) out.bind_dirs = opts.bindDirs;
  if (opts.extraBindDirs && opts.extraBindDirs.length) out.extra_bind_dirs = opts.extraBindDirs;
  return out;
}

function commandCreate(name, opts) {
  assertCageName(name);
  if (opts.bindDirs && opts.bindDirs.length && !opts.configDir) {
    // bind_dirs replaces type defaults entirely, so the user must
    // also tell us where the config dir lives (otherwise we have no
    // mount for ~/.claude or ~/.codex). This guards against the common
    // foot-gun "I overrode everything and now the login is gone".
    throw new Error(
      `--bind-dirs replaces all default mounts. Add --config-dir=PATH so claude/codex can find its login state.`
    );
  }
  const cliLayer = buildCliLayer(opts);
  const spec = resolveCascade({
    type: opts.type,
    homeYcrcPath: homeYcrcPath(),
    projectYcrcPath: projectYcrcPath(),
    cliLayer,
  });
  const { argv: runArgs, cmd } = buildRunArgs(spec, {
    rm: false,
    interactive: false,
    detach: true,
    name,
    volName: `${name}-mitmproxy`,
  });
  const res = runDocker([...runArgs, ...cmd]);
  process.exit(res.status == null ? 1 : res.status);
}

function commandRun(name) {
  assertCageName(name);
  const res = runDocker(['exec', '-it', name, 'bash', '-l']);
  process.exit(res.status == null ? 1 : res.status);
}

function commandList() {
  const res = runDocker(['ps', '-a', '--filter', 'label=yolocage=1', '--format', 'table {{.Names}}\t{{.Status}}\t{{.Image}}']);
  process.exit(res.status == null ? 1 : res.status);
}

function commandRm(name) {
  assertCageName(name);
  const res = runDocker(['rm', '-f', name]);
  process.exit(res.status == null ? 1 : res.status);
}

function commandLogs(name) {
  assertCageName(name);
  const res = runDocker(['logs', '-f', name]);
  process.exit(res.status == null ? 1 : res.status);
}

function commandPull() {
  // Pull both type defaults' images. Tolerates missing tags by not
  // exiting on the first failure.
  let lastStatus = 0;
  for (const t of Object.keys(TYPE_DEFAULTS)) {
    if (!TYPE_DEFAULTS[t].v0) continue;
    const res = runDocker(['pull', TYPE_DEFAULTS[t].image]);
    if (res.status !== 0) lastStatus = res.status;
  }
  process.exit(lastStatus == null ? 1 : lastStatus);
}

function assertCageName(name) {
  if (!name || !/^[a-z0-9][a-z0-9_.-]{0,62}$/i.test(name)) {
    throw new Error(`invalid cage name: ${JSON.stringify(name)} (must match docker container name rules)`);
  }
}

function buildProgram() {
  const program = new Command();
  program
    .name('yc')
    .description('yolocage — sandboxed claude-code / codex with built-in egress credential scrubber')
    .version('0.1.0');

  program
    .command('create <name>')
    .description('Create + start a named cage')
    .option('--type <type>', 'agent type (claude|codex)')
    .option('--image <ref>', 'override default image (repo:tag)')
    .option('--bind-workspace <path>', 'host path mounted at /workspace')
    .option('--config-dir <path>', 'host path for the agent config dir (~/.claude / ~/.codex)')
    .option('--bind-dirs <spec>', 'replace default mounts (repeatable; host:container[:mode])', collectInto, [])
    .option('--extra-bind-dirs <spec>', 'append extra mounts (repeatable; host:container[:mode])', collectInto, [])
    .option('--ssproxy-extensions <path>', 'custom scrub-pattern file')
    .option('--tmux', 'run agent inside tmux')
    .option('--no-tmux', 'disable tmux (default)')
    .option('--memory <amount>', 'docker --memory (e.g. 4g)')
    .option('--cpus <amount>', 'docker --cpus (e.g. 2)')
    .action(commandCreate);

  program
    .command('run <name>')
    .description('Attach to a running named cage')
    .action(commandRun);

  program.command('list').description('List all yolocage cages').action(commandList);
  program.command('rm <name>').description('Destroy a named cage').action(commandRm);
  program.command('logs <name>').description('Tail logs of a named cage').action(commandLogs);
  program.command('pull').description('Pull / refresh yolocage images').action(commandPull);

  program
    .command('update')
    .description('Update yolocage itself + refresh cage images')
    .option('--check', 'only report the version delta; do not install')
    .option('--no-pull', 'skip the docker image refresh after binary update')
    .option('--force', 'install even if already on the latest version')
    .action(async (opts) => {
      const exit = await runUpdate({
        check: !!opts.check,
        pull: opts.pull !== false,
        force: !!opts.force,
      });
      process.exit(exit || 0);
    });

  return program;
}

function collectInto(value, prev) {
  prev.push(value);
  return prev;
}

function main(argv) {
  const userArgv = (argv || process.argv).slice(2);
  let cls;
  try {
    cls = classifyArgv(userArgv);
  } catch (e) {
    process.stderr.write(`yc: ${e.message}\n`);
    process.exit(2);
    return;
  }
  if (cls.mode === 'shortcut') {
    try {
      runShortcut(cls.type, cls.passthrough);
    } catch (e) {
      process.stderr.write(`yc: ${e.message}\n`);
      process.exit(2);
    }
    return;
  }
  // Subcommand form: hand to commander.
  const program = buildProgram();
  try {
    program.parse(['node', 'yc.js', ...cls.argv]);
  } catch (e) {
    process.stderr.write(`yc: ${e.message}\n`);
    process.exit(2);
  }
}

if (require.main === module) {
  main(process.argv);
}

module.exports = {
  classifyArgv,
  buildProgram,
  buildCliLayer,
  assertSafeCwdForShortcut,
  assertCageName,
  getCwdCageName,
  main,
};
