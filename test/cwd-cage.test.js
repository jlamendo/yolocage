'use strict';

// Tests for the per-cwd cage-name derivation + the docker probe helpers
// that drive runShortcut's three-branch attach/start/create logic.

const { getCwdCageName } = require('../yc');

describe('getCwdCageName', () => {
  test('produces a docker-valid name for a typical project dir', () => {
    const name = getCwdCageName('claude', '/home/dev/projects/my-app');
    expect(name).toMatch(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/);
    expect(name).toMatch(/^yc-claude-my-app-[0-9a-f]{8}$/);
  });

  test('embeds the agent type so claude and codex get distinct names', () => {
    const c = getCwdCageName('claude', '/home/dev/x');
    const k = getCwdCageName('codex', '/home/dev/x');
    expect(c).not.toBe(k);
    expect(c).toMatch(/^yc-claude-/);
    expect(k).toMatch(/^yc-codex-/);
  });

  test('disambiguates same-basename different-dirs via the hash suffix', () => {
    const a = getCwdCageName('claude', '/repos/projectA/api');
    const b = getCwdCageName('claude', '/repos/projectB/api');
    expect(a).not.toBe(b);
    // Both end with "-api-<hash>" — basename matches, hash diverges
    expect(a.replace(/-[0-9a-f]{8}$/, '')).toBe('yc-claude-api');
    expect(b.replace(/-[0-9a-f]{8}$/, '')).toBe('yc-claude-api');
  });

  test('returns the same name for the same cwd (deterministic)', () => {
    const a = getCwdCageName('claude', '/some/path');
    const b = getCwdCageName('claude', '/some/path');
    expect(a).toBe(b);
  });

  test('handles non-alphanumeric characters in the basename', () => {
    const name = getCwdCageName('claude', '/dev/super-secret-thing!');
    expect(name).toMatch(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/);
    expect(name).toMatch(/^yc-claude-super-secret-thing-[0-9a-f]{8}$/);
  });

  test('strips leading punctuation from dotted dirs', () => {
    const name = getCwdCageName('claude', '/Users/foo/.dotfile-dir');
    expect(name).toMatch(/^yc-claude-dotfile-dir-[0-9a-f]{8}$/);
    // No leading dot.
    expect(name.split('-')[2]).not.toMatch(/^[._-]/);
  });

  test('falls back to "cage" when the basename squashes to empty', () => {
    const root = getCwdCageName('claude', '/');
    // basename of '/' is '' on POSIX. Should land on the 'cage' fallback.
    expect(root).toMatch(/^yc-claude-cage-[0-9a-f]{8}$/);
  });

  test('truncates very long basenames to 32 chars before hashing', () => {
    const huge = '/x/' + 'a'.repeat(80);
    const name = getCwdCageName('claude', huge);
    // The basename portion (between yc-claude- and -<hash>) is bounded.
    const middle = name.replace(/^yc-claude-/, '').replace(/-[0-9a-f]{8}$/, '');
    expect(middle.length).toBeLessThanOrEqual(32);
    expect(middle.length).toBeGreaterThan(0);
  });
});

describe('cageExists / cageRunning probes', () => {
  // The probes shell out to `docker container inspect`. We mock
  // child_process.spawnSync end-to-end to make the test hermetic.

  beforeEach(() => {
    jest.resetModules();
  });

  function freshDocker(spawnImpl) {
    jest.doMock('child_process', () => ({
      spawnSync: spawnImpl,
      execFileSync: jest.fn(),
    }));
    const docker = require('../lib/docker');
    docker._resetProbeCache();
    return docker;
  }

  test('cageExists returns true when container inspect succeeds', () => {
    const spawn = jest.fn().mockReturnValue({ status: 0 });
    const docker = freshDocker(spawn);
    expect(docker.cageExists('yc-claude-foo-deadbeef')).toBe(true);
    // First call is the sudo probe; second is the actual inspect.
    const last = spawn.mock.calls[spawn.mock.calls.length - 1];
    expect(last[0]).toBe('docker');
    expect(last[1]).toEqual(expect.arrayContaining(['container', 'inspect', 'yc-claude-foo-deadbeef']));
  });

  test('cageExists returns false when container inspect fails', () => {
    // First call: sudo probe (status 0, no sudo needed).
    // Second call: container inspect (status 1, not found).
    const spawn = jest
      .fn()
      .mockReturnValueOnce({ status: 0 })  // docker info: OK
      .mockReturnValueOnce({ status: 1 }); // container inspect: not found
    const docker = freshDocker(spawn);
    expect(docker.cageExists('does-not-exist')).toBe(false);
  });

  test('cageRunning returns true only when state is exactly "true"', () => {
    const spawn = jest
      .fn()
      .mockReturnValueOnce({ status: 0 })            // sudo probe: OK
      .mockReturnValueOnce({ status: 0, stdout: 'true\n' });
    const docker = freshDocker(spawn);
    expect(docker.cageRunning('foo')).toBe(true);
  });

  test('cageRunning returns false for stopped containers', () => {
    const spawn = jest
      .fn()
      .mockReturnValueOnce({ status: 0 })            // sudo probe: OK
      .mockReturnValueOnce({ status: 0, stdout: 'false\n' });
    const docker = freshDocker(spawn);
    expect(docker.cageRunning('foo')).toBe(false);
  });

  test('cageRunning returns false when container does not exist', () => {
    const spawn = jest
      .fn()
      .mockReturnValueOnce({ status: 0 })            // sudo probe: OK
      .mockReturnValueOnce({ status: 1, stdout: '' });
    const docker = freshDocker(spawn);
    expect(docker.cageRunning('does-not-exist')).toBe(false);
  });
});
