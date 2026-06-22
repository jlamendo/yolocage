// Docker shell-out helpers.
//
// All docker invocations route through here. The module probes once on
// first use for whether the current user can talk to the docker daemon
// without sudo; if not, every command is prefixed with `sudo`. The
// fix-it message ("add yourself to the docker group with …") is printed
// at most once per process.
//
// Tests mock `child_process` to drive the probe branches.

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

// Touch any bind specs tagged `kind: 'file'` into existence on the host.
// `docker run -v <host>:<container>` auto-creates an empty DIRECTORY
// at the host path when it's missing (long-standing footgun); single-
// file binds (e.g. claude's ~/.claude.json) need an actual file there
// or the mount goes wrong. No-op for paths that already exist; no-op
// for entries without the `kind: 'file'` tag. Best-effort: an EACCES
// or similar isn't fatal — docker will surface its own error later.
function materializeFileBinds(spec) {
  for (const b of spec.bindDirs || []) {
    if (b.kind !== 'file') continue;
    if (fs.existsSync(b.host)) continue;
    try {
      fs.mkdirSync(path.dirname(b.host), { recursive: true });
      fs.writeFileSync(b.host, '', { mode: 0o600 });
    } catch (_e) {
      // swallow — surface as docker's own error if it matters
    }
  }
}

let _sudoChecked = false;
let _useSudo = false;
let _noticePrinted = false;

function _probe(env) {
  if (_sudoChecked) return _useSudo;
  _sudoChecked = true;

  // DOCKER_HOST suggests the user is talking to a non-local daemon
  // (rootless, ssh:// tunnel, etc.) — don't try sudo in that case;
  // the env tells us they've already wired it up themselves.
  if (env.DOCKER_HOST) {
    _useSudo = false;
    return _useSudo;
  }

  // First try docker info as the calling user.
  const direct = spawnSync('docker', ['info'], { stdio: 'ignore', env });
  if (direct.status === 0) {
    _useSudo = false;
    return _useSudo;
  }

  // Try sudo. If sudo isn't installed or password-prompts, this fails
  // and we fall through to "use direct + let the error tell the user".
  const sudo = spawnSync('sudo', ['-n', 'docker', 'info'], { stdio: 'ignore', env });
  if (sudo.status === 0) {
    _useSudo = true;
    return _useSudo;
  }

  // Couldn't reach docker either way. Don't trip sudo — let the next
  // docker call surface the real error to the user.
  _useSudo = false;
  return _useSudo;
}

function maybeSudo(env) {
  return _probe(env || process.env);
}

// Reset the module-level cache. For tests and re-init flows; not part
// of the public CLI surface.
function _resetProbeCache() {
  _sudoChecked = false;
  _useSudo = false;
  _noticePrinted = false;
}

function _printNoticeOnce(stderr) {
  if (_noticePrinted) return;
  _noticePrinted = true;
  stderr.write(
    'yolocage: docker requires sudo on this system. To skip this, add ' +
      'yourself to the docker group:\n' +
      '    sudo usermod -aG docker $USER && newgrp docker\n'
  );
}

// Build the docker argv for a given cage spec. Returns:
//   { argv: [...], cmd: [...] }   for piping into spawnSync(argv[0], argv.slice(1).concat(cmd))
function buildRunArgs(spec, opts) {
  opts = opts || {};
  materializeFileBinds(spec);
  const args = ['run'];
  if (opts.rm !== false) args.push('--rm');
  if (opts.interactive !== false) args.push('-it');
  if (opts.detach) args.push('-d');
  if (opts.name) args.push('--name', opts.name);

  // Per-cage docker volume for mitmproxy CA + state. Shared across
  // create/run for named cages so the CA persists.
  const volName = opts.volName || (opts.name ? `${opts.name}-mitmproxy` : 'yolocage-mitmproxy-ephemeral');
  args.push('-v', `${volName}:/home/agent/.mitmproxy`);

  for (const b of spec.bindDirs) {
    args.push('-v', `${b.host}:${b.container}:${b.mode}`);
  }

  if (spec.memory) args.push('--memory', spec.memory);
  if (spec.cpus) args.push('--cpus', String(spec.cpus));

  // Workdir defaults to /workspace.
  args.push('-w', '/workspace');

  // Env: tmux toggle + extensions path.
  args.push('-e', `YC_TMUX=${spec.tmux ? '1' : '0'}`);
  if (spec.ssproxyExtensions) {
    // The host file is mounted RO into a stable container location.
    args.push('-v', `${spec.ssproxyExtensions}:/etc/yolocage/scrub-extensions.json:ro`);
    args.push('-e', 'SSPROXY_EXTENSIONS=/etc/yolocage/scrub-extensions.json');
  }

  args.push(spec.image);
  const cmd = [...spec.cmd, ...(spec.passthrough || [])];
  return { argv: args, cmd };
}

// Compose the final argv with sudo prefix as needed.
function dockerArgv(args, env) {
  env = env || process.env;
  if (maybeSudo(env)) return ['sudo', '-n', 'docker', ...args];
  return ['docker', ...args];
}

// Does a container with this name exist (running OR stopped)?
// Uses `docker container inspect` which exits 0 for any state.
function cageExists(name, opts) {
  opts = opts || {};
  const env = opts.env || process.env;
  const argv = dockerArgv(['container', 'inspect', name], env);
  const res = spawnSync(argv[0], argv.slice(1), { stdio: 'ignore', env });
  return res.status === 0;
}

// Is the container with this name in the Running state? Returns false
// for non-existent OR stopped containers.
function cageRunning(name, opts) {
  opts = opts || {};
  const env = opts.env || process.env;
  const argv = dockerArgv(
    ['container', 'inspect', '-f', '{{.State.Running}}', name],
    env
  );
  const res = spawnSync(argv[0], argv.slice(1), {
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
    encoding: 'utf8',
  });
  if (res.status !== 0) return false;
  return String(res.stdout || '').trim() === 'true';
}

// Run a docker command synchronously, inheriting stdio. Returns the
// exit status; callers may pass {stdio: 'pipe'} for captured output.
function runDocker(args, opts) {
  opts = opts || {};
  const env = opts.env || process.env;
  const stderr = opts.stderr || process.stderr;
  if (maybeSudo(env)) _printNoticeOnce(stderr);
  const argv = dockerArgv(args, env);
  const res = spawnSync(argv[0], argv.slice(1), {
    stdio: opts.stdio || 'inherit',
    env,
  });
  return res;
}

module.exports = {
  maybeSudo,
  buildRunArgs,
  dockerArgv,
  runDocker,
  cageExists,
  cageRunning,
  _resetProbeCache,
};
