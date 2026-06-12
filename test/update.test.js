'use strict';

// Unit tests for `yc update`. All child_process is dependency-injected
// via the deps bag so tests stay hermetic — no real npm or docker calls.

const path = require('path');
const {
  update,
  detectInstallType,
  getCurrentVersion,
  getLatestVersion,
  runNpmInstall,
  pullImages,
} = require('../lib/update');

class WritableSink {
  constructor() {
    this.buf = '';
  }
  write(s) {
    this.buf += s;
  }
}

describe('detectInstallType', () => {
  test('classifies npx invocation by _npx path segment', () => {
    const p = path.join('/root/.npm/_npx/abc123', 'node_modules', 'yolocage', 'yc.js');
    expect(detectInstallType(p)).toBe('npx');
  });

  test('classifies npm global install', () => {
    const p = path.join('/usr/local/lib/node_modules/yolocage/yc.js');
    expect(detectInstallType(p)).toBe('npm-global');
  });

  test('falls through to unknown for source checkout', () => {
    expect(detectInstallType('/home/dev/projects/yolocage/yc.js')).toBe('unknown');
  });
});

describe('getCurrentVersion', () => {
  test('reads from our own package.json', () => {
    const v = getCurrentVersion();
    expect(typeof v).toBe('string');
    expect(v).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe('getLatestVersion', () => {
  test('parses npm view output, trimming whitespace', () => {
    const fakeExec = jest.fn().mockReturnValue('  0.4.2\n');
    const v = getLatestVersion({ execFileSync: fakeExec });
    expect(v).toBe('0.4.2');
    expect(fakeExec).toHaveBeenCalledWith(
      'npm',
      ['view', 'yolocage', 'version'],
      expect.any(Object)
    );
  });

  test('throws a clean error on registry failure', () => {
    const fakeExec = jest.fn().mockImplementation(() => {
      const e = new Error('npm view failed');
      e.stderr = 'ENOTFOUND registry.npmjs.org\n';
      throw e;
    });
    expect(() => getLatestVersion({ execFileSync: fakeExec })).toThrow(
      /failed to fetch latest version/
    );
  });
});

describe('runNpmInstall', () => {
  test('succeeds without sudo when npm install returns 0', () => {
    const fakeSpawn = jest.fn().mockReturnValue({ status: 0 });
    const sink = new WritableSink();
    const result = runNpmInstall('0.2.0', {
      spawnSync: fakeSpawn,
      stdout: sink,
      stderr: sink,
    });
    expect(result).toEqual({ ok: true, sudoUsed: false });
    expect(fakeSpawn).toHaveBeenCalledTimes(1);
    expect(fakeSpawn.mock.calls[0][0]).toBe('npm');
    expect(fakeSpawn.mock.calls[0][1]).toContain('yolocage@0.2.0');
  });

  test('retries with sudo on EACCES from npm', () => {
    const fakeSpawn = jest
      .fn()
      .mockReturnValueOnce({ status: 1, stderr: Buffer.from('EACCES permission denied') })
      .mockReturnValueOnce({ status: 0 });
    const sink = new WritableSink();
    const stderr = new WritableSink();
    const result = runNpmInstall('0.2.0', {
      spawnSync: fakeSpawn,
      stdout: sink,
      stderr,
    });
    expect(result).toEqual({ ok: true, sudoUsed: true });
    expect(fakeSpawn.mock.calls[1][0]).toBe('sudo');
    expect(stderr.buf).toMatch(/needs root/);
  });

  test('returns failure when even sudo install fails', () => {
    const fakeSpawn = jest
      .fn()
      .mockReturnValueOnce({ status: 1, stderr: Buffer.from('EACCES') })
      .mockReturnValueOnce({ status: 1 });
    const sink = new WritableSink();
    const stderr = new WritableSink();
    const result = runNpmInstall('0.2.0', {
      spawnSync: fakeSpawn,
      stdout: sink,
      stderr,
    });
    expect(result).toEqual({ ok: false, sudoUsed: true });
    expect(stderr.buf).toMatch(/sudo npm install -g yolocage@0\.2\.0/);
  });

  test('does not retry sudo on non-permission failure', () => {
    const fakeSpawn = jest.fn().mockReturnValue({
      status: 1,
      stderr: Buffer.from('ENOTFOUND registry.npmjs.org'),
    });
    const sink = new WritableSink();
    const result = runNpmInstall('0.2.0', {
      spawnSync: fakeSpawn,
      stdout: sink,
      stderr: sink,
    });
    expect(result).toEqual({ ok: false, sudoUsed: false });
    expect(fakeSpawn).toHaveBeenCalledTimes(1);
  });
});

describe('pullImages', () => {
  test('pulls every v0-eligible type, skipping stubs', () => {
    const fakeRun = jest.fn().mockReturnValue({ status: 0 });
    const sink = new WritableSink();
    const status = pullImages({ runDocker: fakeRun, stdout: sink });
    expect(status).toBe(0);
    // claude + codex; opencode (v0=false) skipped
    expect(fakeRun).toHaveBeenCalledTimes(2);
    const pulled = fakeRun.mock.calls.map((c) => c[0][1]);
    expect(pulled.some((p) => p.includes('claude'))).toBe(true);
    expect(pulled.some((p) => p.includes('codex'))).toBe(true);
    expect(pulled.some((p) => p.includes('opencode'))).toBe(false);
  });

  test('returns worst status when an image pull fails', () => {
    const fakeRun = jest
      .fn()
      .mockReturnValueOnce({ status: 0 })
      .mockReturnValueOnce({ status: 1 });
    const sink = new WritableSink();
    expect(pullImages({ runDocker: fakeRun, stdout: sink })).toBe(1);
  });
});

describe('update (end-to-end with mocks)', () => {
  const FAKE_LATEST = '99.99.99'; // forces "newer than current"

  function makeDeps({ installType, npmOk = true, eaccesOnce = false } = {}) {
    const stdout = new WritableSink();
    const stderr = new WritableSink();
    const execFileSync = jest.fn().mockReturnValue(`${FAKE_LATEST}\n`);

    let installCalls = 0;
    const spawnSync = jest.fn().mockImplementation(() => {
      installCalls++;
      if (eaccesOnce && installCalls === 1) {
        return { status: 1, stderr: Buffer.from('EACCES') };
      }
      return { status: npmOk ? 0 : 1, stderr: Buffer.from('') };
    });

    const runDocker = jest.fn().mockReturnValue({ status: 0 });

    let scriptPath = '/usr/local/lib/node_modules/yolocage/yc.js';
    if (installType === 'npx') {
      scriptPath = '/root/.npm/_npx/abc/node_modules/yolocage/yc.js';
    } else if (installType === 'unknown') {
      scriptPath = '/home/dev/yolocage/yc.js';
    }

    return {
      deps: { execFileSync, spawnSync, runDocker, stdout, stderr, scriptPath },
      stdout,
      stderr,
      runDocker,
      spawnSync,
    };
  }

  test('reports no-op when current === latest and no force', async () => {
    const { deps, stdout, runDocker } = makeDeps();
    deps.execFileSync.mockReturnValue(`${require('../package.json').version}\n`);

    const code = await update({ deps });
    expect(code).toBe(0);
    expect(stdout.buf).toMatch(/already on latest/);
    expect(runDocker).toHaveBeenCalled(); // pull still runs by default
  });

  test('skips image pull when pull=false', async () => {
    const { deps, runDocker } = makeDeps();
    deps.execFileSync.mockReturnValue(`${require('../package.json').version}\n`);
    await update({ deps, pull: false });
    expect(runDocker).not.toHaveBeenCalled();
  });

  test('check mode returns nonzero if there is a delta', async () => {
    const { deps } = makeDeps();
    const code = await update({ check: true, deps });
    expect(code).toBe(1);
  });

  test('check mode returns zero if up-to-date', async () => {
    const { deps } = makeDeps();
    deps.execFileSync.mockReturnValue(`${require('../package.json').version}\n`);
    const code = await update({ check: true, deps });
    expect(code).toBe(0);
  });

  test('npx install type prints no-op explanation, still pulls images', async () => {
    const { deps, stdout, runDocker, spawnSync } = makeDeps({ installType: 'npx' });
    const code = await update({ deps });
    expect(code).toBe(0);
    expect(stdout.buf).toMatch(/running via npx/);
    expect(spawnSync).not.toHaveBeenCalled();
    expect(runDocker).toHaveBeenCalled();
  });

  test('unknown install type refuses to mutate, still pulls', async () => {
    const { deps, stderr, runDocker, spawnSync } = makeDeps({ installType: 'unknown' });
    const code = await update({ deps });
    expect(code).toBe(1);
    expect(stderr.buf).toMatch(/cannot auto-update/);
    expect(spawnSync).not.toHaveBeenCalled();
    expect(runDocker).toHaveBeenCalled();
  });

  test('npm-global path installs and reports new version', async () => {
    const { deps, stdout, spawnSync } = makeDeps();
    const code = await update({ deps });
    expect(code).toBe(0);
    expect(stdout.buf).toMatch(new RegExp(`updated to ${FAKE_LATEST}`));
    expect(spawnSync.mock.calls[0][1]).toContain(`yolocage@${FAKE_LATEST}`);
  });

  test('npm-global retries with sudo on EACCES', async () => {
    const { deps, spawnSync, stderr } = makeDeps({ eaccesOnce: true });
    const code = await update({ deps });
    expect(code).toBe(0);
    expect(spawnSync).toHaveBeenCalledTimes(2);
    expect(spawnSync.mock.calls[1][0]).toBe('sudo');
    expect(stderr.buf).toMatch(/needs root/);
  });

  test('returns 1 when registry lookup fails', async () => {
    const { deps, stderr } = makeDeps();
    deps.execFileSync.mockImplementation(() => {
      const e = new Error('fail');
      e.stderr = 'ENOTFOUND';
      throw e;
    });
    const code = await update({ deps });
    expect(code).toBe(1);
    expect(stderr.buf).toMatch(/failed to fetch/);
  });
});
