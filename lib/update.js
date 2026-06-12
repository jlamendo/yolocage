// `yc update` — refresh the yolocage CLI itself + the cage images.
//
// Two halves:
//   1. CLI binary: re-install yolocage via npm from the global registry.
//      We probe how the user is invoking yc (global npm install vs npx
//      run vs unknown) and either install/upgrade or print a helpful
//      no-op message.
//   2. Cage images: re-pull yolocage/claude:latest + yolocage/codex:latest
//      so the next cage launch starts from current bytes.
//
// Sudo handling mirrors lib/docker.js — npm global installs typically
// land in a path that requires root (/usr/local/lib/node_modules on
// many distros). We try without sudo first; on permission failure we
// retry with `sudo -n` (non-interactive) and fall through to a clear
// "please re-run with sudo" message if even that fails.
//
// Tests in test/update.test.js mock child_process to drive each branch.

'use strict';

const path = require('path');
const { spawnSync, execFileSync } = require('child_process');
const { runDocker } = require('./docker');
const { TYPE_DEFAULTS } = require('./types');

const PKG_NAME = 'yolocage';

// Identify how the current process was launched. Three classes matter:
//   - 'npx'        — running via `npx yolocage …`; the binary lives
//                    under a per-invocation cache dir. Re-installing is
//                    a no-op for the user; the next npx call fetches
//                    whatever's current.
//   - 'npm-global' — installed via `npm install -g yolocage`. This is
//                    the normal case; `npm install -g yolocage@latest`
//                    upgrades in place.
//   - 'unknown'    — running from source / linked checkout / unusual
//                    layout. Refuse to mutate; print a hint.
function detectInstallType(scriptPath) {
  const p = scriptPath || (require.main && require.main.filename) || __filename;
  if (p.includes(`${path.sep}_npx${path.sep}`)) return 'npx';
  if (p.includes(`${path.sep}node_modules${path.sep}${PKG_NAME}${path.sep}`)) {
    return 'npm-global';
  }
  return 'unknown';
}

function getCurrentVersion() {
  // Read our own package.json. Resolved relative to this file so the
  // function works equally for tests, npx, and global installs.
  return require(path.join(__dirname, '..', 'package.json')).version;
}

// Fetch the latest published version from npm. Throws on network or
// registry errors so the caller can present a clean diagnostic.
function getLatestVersion(deps) {
  deps = deps || {};
  const exec = deps.execFileSync || execFileSync;
  try {
    const out = exec('npm', ['view', PKG_NAME, 'version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return String(out).trim();
  } catch (e) {
    const reason = (e.stderr && String(e.stderr).trim()) || e.message;
    throw new Error(`failed to fetch latest version from npm registry: ${reason}`);
  }
}

// Install yolocage@<version> globally via npm. Returns { ok, sudoUsed }.
// On EACCES (npm global path needs root) we retry once with `sudo -n`.
function runNpmInstall(version, deps) {
  deps = deps || {};
  const spawn = deps.spawnSync || spawnSync;
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const target = `${PKG_NAME}@${version}`;

  stdout.write(`yolocage: installing ${target} via npm...\n`);
  const direct = spawn('npm', ['install', '-g', target], { stdio: 'inherit' });
  if (direct.status === 0) return { ok: true, sudoUsed: false };

  // Inspect the error. If it smells like a permission problem, retry
  // with sudo non-interactively. If sudo would prompt or doesn't help,
  // print actionable guidance and return failure.
  const stderrBuf = direct.stderr ? String(direct.stderr) : '';
  const looksLikePermission =
    stderrBuf.includes('EACCES') ||
    stderrBuf.includes('permission denied') ||
    stderrBuf.includes('EPERM') ||
    direct.status === 243;

  if (!looksLikePermission) return { ok: false, sudoUsed: false };

  stderr.write(
    'yolocage: npm install needs root for the global prefix; retrying with sudo\n'
  );
  const sudo = spawn('sudo', ['-n', 'npm', 'install', '-g', target], {
    stdio: 'inherit',
  });
  if (sudo.status === 0) return { ok: true, sudoUsed: true };

  stderr.write(
    'yolocage: passwordless sudo unavailable. Re-run with sudo:\n' +
      `    sudo npm install -g ${target}\n`
  );
  return { ok: false, sudoUsed: true };
}

function pullImages(deps) {
  deps = deps || {};
  const stdout = deps.stdout || process.stdout;
  const runner = deps.runDocker || runDocker;
  let worstStatus = 0;
  for (const t of Object.keys(TYPE_DEFAULTS)) {
    const def = TYPE_DEFAULTS[t];
    if (!def.v0) continue; // skip the opencode stub
    stdout.write(`yolocage: pulling ${def.image}\n`);
    const res = runner(['pull', def.image]);
    if (res.status !== 0) worstStatus = res.status || 1;
  }
  return worstStatus;
}

// The exported entry. Accepts an `opts` bag for testing:
//   - check       — only report the version delta, don't install
//   - pull        — also refresh cage images (default true)
//   - force       — install even if already on latest
//   - deps        — DI bag for tests (execFileSync, spawnSync, runDocker,
//                   stdout, stderr, scriptPath)
async function update(opts) {
  opts = opts || {};
  const stdout = (opts.deps && opts.deps.stdout) || process.stdout;
  const stderr = (opts.deps && opts.deps.stderr) || process.stderr;

  const current = getCurrentVersion();
  stdout.write(`yolocage: current version ${current}\n`);

  let latest;
  try {
    latest = getLatestVersion(opts.deps);
  } catch (e) {
    stderr.write(`yolocage: ${e.message}\n`);
    return 1;
  }
  stdout.write(`yolocage: latest version  ${latest}\n`);

  if (opts.check) return current === latest ? 0 : 1;

  if (current === latest && !opts.force) {
    stdout.write(`yolocage: already on latest (${latest})\n`);
    if (opts.pull !== false) pullImages(opts.deps);
    return 0;
  }

  const installType = detectInstallType(opts.deps && opts.deps.scriptPath);

  if (installType === 'npx') {
    stdout.write(
      'yolocage: running via npx — no install to update; the next ' +
        '`npx yolocage` fetches the latest from the registry\n'
    );
    if (opts.pull !== false) pullImages(opts.deps);
    return 0;
  }

  if (installType === 'unknown') {
    stderr.write(
      'yolocage: cannot auto-update — running from a source checkout or ' +
        'a non-standard install layout. Update yolocage manually (git ' +
        'pull, npm link, or whatever your workflow uses).\n'
    );
    if (opts.pull !== false) pullImages(opts.deps);
    return 1;
  }

  // npm-global: do the install.
  const result = runNpmInstall(latest, opts.deps);
  if (!result.ok) return 1;
  stdout.write(`yolocage: updated to ${latest}\n`);

  if (opts.pull !== false) pullImages(opts.deps);
  return 0;
}

module.exports = {
  update,
  // exposed for tests
  detectInstallType,
  getCurrentVersion,
  getLatestVersion,
  runNpmInstall,
  pullImages,
};
