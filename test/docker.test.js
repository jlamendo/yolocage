'use strict';

jest.mock('child_process', () => ({
  spawnSync: jest.fn(),
  execFileSync: jest.fn(),
}));

const { spawnSync } = require('child_process');

function freshDockerModule() {
  jest.resetModules();
  jest.doMock('child_process', () => ({
    spawnSync: spawnSync,
    execFileSync: jest.fn(),
  }));
  return require('../lib/docker');
}

beforeEach(() => {
  spawnSync.mockReset();
});

describe('maybeSudo', () => {
  test('returns false when docker info succeeds directly', () => {
    spawnSync.mockReturnValueOnce({ status: 0 }); // docker info: ok
    const docker = freshDockerModule();
    expect(docker.maybeSudo({})).toBe(false);
    expect(spawnSync).toHaveBeenCalledWith('docker', ['info'], expect.any(Object));
  });

  test('returns true when only sudo docker info works', () => {
    spawnSync
      .mockReturnValueOnce({ status: 1 }) // docker info: fails
      .mockReturnValueOnce({ status: 0 }); // sudo -n docker info: ok
    const docker = freshDockerModule();
    expect(docker.maybeSudo({})).toBe(true);
    expect(spawnSync.mock.calls[1][0]).toBe('sudo');
  });

  test('returns false when neither works (let docker call surface error)', () => {
    spawnSync
      .mockReturnValueOnce({ status: 1 })
      .mockReturnValueOnce({ status: 1 });
    const docker = freshDockerModule();
    expect(docker.maybeSudo({})).toBe(false);
  });

  test('DOCKER_HOST set → never tries sudo', () => {
    const docker = freshDockerModule();
    expect(docker.maybeSudo({ DOCKER_HOST: 'ssh://host' })).toBe(false);
    expect(spawnSync).not.toHaveBeenCalled();
  });

  test('result is cached — subsequent calls do not re-probe', () => {
    spawnSync.mockReturnValueOnce({ status: 0 });
    const docker = freshDockerModule();
    docker.maybeSudo({});
    docker.maybeSudo({});
    docker.maybeSudo({});
    expect(spawnSync).toHaveBeenCalledTimes(1);
  });
});

describe('dockerArgv', () => {
  test('no sudo prefix when probe says direct', () => {
    spawnSync.mockReturnValueOnce({ status: 0 });
    const docker = freshDockerModule();
    const argv = docker.dockerArgv(['ps', '-a'], {});
    expect(argv).toEqual(['docker', 'ps', '-a']);
  });

  test('prepends sudo -n when probe says sudo needed', () => {
    spawnSync
      .mockReturnValueOnce({ status: 1 })
      .mockReturnValueOnce({ status: 0 });
    const docker = freshDockerModule();
    const argv = docker.dockerArgv(['ps', '-a'], {});
    expect(argv).toEqual(['sudo', '-n', 'docker', 'ps', '-a']);
  });
});

describe('buildRunArgs', () => {
  test('translates a basic claude spec', () => {
    spawnSync.mockReturnValueOnce({ status: 0 });
    const docker = freshDockerModule();
    const spec = {
      type: 'claude',
      image: 'ghcr.io/jlamendo/yolocage-claude:latest',
      bindDirs: [
        { host: '/proj', container: '/workspace', mode: 'rw' },
        { host: '/home/me/.claude', container: '/home/agent/.claude', mode: 'rw' },
      ],
      memory: '4g',
      cpus: '2',
      tmux: false,
      ssproxyExtensions: null,
      cmd: ['claude', '--dangerously-skip-permissions'],
      passthrough: [],
    };
    const { argv, cmd } = docker.buildRunArgs(spec, { rm: true, interactive: true });
    expect(argv).toContain('--rm');
    expect(argv).toContain('-it');
    expect(argv).toContain('-v');
    expect(argv).toContain('/proj:/workspace:rw');
    expect(argv).toContain('/home/me/.claude:/home/agent/.claude:rw');
    expect(argv).toContain('--memory');
    expect(argv).toContain('4g');
    expect(argv).toContain('--cpus');
    expect(argv).toContain('2');
    expect(argv).toContain('ghcr.io/jlamendo/yolocage-claude:latest');
    expect(argv[argv.length - 1]).toBe('ghcr.io/jlamendo/yolocage-claude:latest');
    expect(cmd).toEqual(['claude', '--dangerously-skip-permissions']);
  });

  test('YC_TMUX=1 when tmux:true', () => {
    spawnSync.mockReturnValueOnce({ status: 0 });
    const docker = freshDockerModule();
    const { argv } = docker.buildRunArgs(
      {
        image: 'x',
        bindDirs: [],
        tmux: true,
        cmd: ['claude'],
        passthrough: [],
      },
      {}
    );
    expect(argv).toContain('YC_TMUX=1');
  });

  test('ssproxyExtensions mounts file + sets env', () => {
    spawnSync.mockReturnValueOnce({ status: 0 });
    const docker = freshDockerModule();
    const { argv } = docker.buildRunArgs(
      {
        image: 'x',
        bindDirs: [],
        ssproxyExtensions: '/home/me/scrub.json',
        tmux: false,
        cmd: ['claude'],
        passthrough: [],
      },
      {}
    );
    expect(argv).toContain('/home/me/scrub.json:/etc/yolocage/scrub-extensions.json:ro');
    expect(argv).toContain('SSPROXY_EXTENSIONS=/etc/yolocage/scrub-extensions.json');
  });

  test('detach + name + custom volume name', () => {
    spawnSync.mockReturnValueOnce({ status: 0 });
    const docker = freshDockerModule();
    const { argv } = docker.buildRunArgs(
      {
        image: 'x',
        bindDirs: [],
        tmux: false,
        cmd: ['claude'],
        passthrough: [],
      },
      { detach: true, name: 'projectbox', rm: false, interactive: false }
    );
    expect(argv).toContain('-d');
    expect(argv).toContain('--name');
    expect(argv).toContain('projectbox');
    expect(argv).toContain('projectbox-mitmproxy:/home/agent/.mitmproxy');
    expect(argv).not.toContain('--rm');
    expect(argv).not.toContain('-it');
  });

  test('passthrough args appended to cmd', () => {
    spawnSync.mockReturnValueOnce({ status: 0 });
    const docker = freshDockerModule();
    const { cmd } = docker.buildRunArgs(
      {
        image: 'x',
        bindDirs: [],
        tmux: false,
        cmd: ['claude', '--dangerously-skip-permissions'],
        passthrough: ['--resume'],
      },
      {}
    );
    expect(cmd).toEqual(['claude', '--dangerously-skip-permissions', '--resume']);
  });
});
