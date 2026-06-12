'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { resolveCascade, mergeLayer, parseBool } = require('../lib/config');

function writeTmp(name, content) {
  const p = path.join(os.tmpdir(), `yc-test-${process.pid}-${Date.now()}-${name}`);
  fs.writeFileSync(p, content, 'utf8');
  return p;
}

describe('mergeLayer', () => {
  test('REPLACE keys overwrite', () => {
    const acc = { type: 'claude', memory: '2g' };
    mergeLayer(acc, { memory: '4g' });
    expect(acc.memory).toBe('4g');
    expect(acc.type).toBe('claude');
  });

  test('APPEND keys union', () => {
    const acc = { extra_bind_dirs: ['/a:/x'] };
    mergeLayer(acc, { extra_bind_dirs: ['/b:/y'] });
    expect(acc.extra_bind_dirs).toEqual(['/a:/x', '/b:/y']);
  });
});

describe('parseBool', () => {
  test('true variants', () => {
    expect(parseBool('true')).toBe(true);
    expect(parseBool('1')).toBe(true);
    expect(parseBool('yes')).toBe(true);
    expect(parseBool('on')).toBe(true);
    expect(parseBool(true)).toBe(true);
  });
  test('false / unset', () => {
    expect(parseBool('false')).toBe(false);
    expect(parseBool('')).toBe(false);
    expect(parseBool(undefined)).toBe(false);
    expect(parseBool(null)).toBe(false);
    expect(parseBool('off')).toBe(false);
  });
});

describe('resolveCascade', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-cascade-'));

  afterAll(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (_) {}
  });

  test('type defaults apply when no .ycrc, no CLI', () => {
    const spec = resolveCascade({
      type: 'claude',
      homeYcrcPath: path.join(tmpDir, 'nope-home.ycrc'),
      projectYcrcPath: path.join(tmpDir, 'nope-project.ycrc'),
      cliLayer: { type: 'claude' },
    });
    expect(spec.type).toBe('claude');
    expect(spec.image).toBe('yolocage/claude:dev');
    expect(spec.configDirHost).toBe(path.join(os.homedir(), '.claude'));
    expect(spec.configDirContainer).toBe('/home/agent/.claude');
    expect(spec.bindDirs.length).toBe(2); // workspace + configDir
  });

  test('home .ycrc image overrides type default', () => {
    const home = writeTmp('home.ycrc', 'image=yolocage/claude:1.4.2\n');
    const spec = resolveCascade({
      type: 'claude',
      homeYcrcPath: home,
      projectYcrcPath: path.join(tmpDir, 'nope.ycrc'),
      cliLayer: { type: 'claude' },
    });
    expect(spec.image).toBe('yolocage/claude:1.4.2');
  });

  test('project .ycrc overrides ~/.ycrc', () => {
    const home = writeTmp('cas-home.ycrc', 'image=yolocage/claude:1.4.2\nmemory=4g\n');
    const project = writeTmp('cas-project.ycrc', 'image=yolocage/claude:2.0.0\n');
    const spec = resolveCascade({
      type: 'claude',
      homeYcrcPath: home,
      projectYcrcPath: project,
      cliLayer: { type: 'claude' },
    });
    expect(spec.image).toBe('yolocage/claude:2.0.0');
    expect(spec.memory).toBe('4g'); // inherited from home
  });

  test('CLI overrides everything', () => {
    const home = writeTmp('cli-home.ycrc', 'image=yolocage/claude:1.4.2\n');
    const project = writeTmp('cli-project.ycrc', 'image=yolocage/claude:2.0.0\n');
    const spec = resolveCascade({
      type: 'claude',
      homeYcrcPath: home,
      projectYcrcPath: project,
      cliLayer: { type: 'claude', image: 'yolocage/claude:cli' },
    });
    expect(spec.image).toBe('yolocage/claude:cli');
  });

  test('bind_dirs REPLACES — type defaults are dropped', () => {
    const home = writeTmp('br-home.ycrc', 'bind_dirs=/tmp/here:/workspace\n');
    const spec = resolveCascade({
      type: 'claude',
      homeYcrcPath: home,
      projectYcrcPath: path.join(tmpDir, 'nope.ycrc'),
      cliLayer: { type: 'claude' },
    });
    // Only one bind (the one we set); no /workspace + ~/.claude defaults.
    expect(spec.bindDirs.length).toBe(1);
    expect(spec.bindDirs[0].host).toBe('/tmp/here');
    expect(spec.bindDirs[0].container).toBe('/workspace');
  });

  test('extra_bind_dirs APPENDS across layers + dedupes', () => {
    const home = writeTmp(
      'ex-home.ycrc',
      'extra_bind_dirs=~/.aws:/home/agent/.aws:ro\n'
    );
    const project = writeTmp(
      'ex-project.ycrc',
      'extra_bind_dirs=~/.kube:/home/agent/.kube:ro\n' +
        'extra_bind_dirs=~/.aws:/home/agent/.aws:ro\n' // duplicate
    );
    const spec = resolveCascade({
      type: 'claude',
      homeYcrcPath: home,
      projectYcrcPath: project,
      cliLayer: { type: 'claude' },
    });
    // 2 type-defaults + 2 unique extras = 4. (the aws dup is dedupe'd)
    const extraHosts = spec.bindDirs.map((b) => b.host);
    expect(extraHosts).toContain(`${os.homedir()}/.aws`);
    expect(extraHosts).toContain(`${os.homedir()}/.kube`);
    // Dedupe check: .aws appears exactly once.
    expect(extraHosts.filter((h) => h === `${os.homedir()}/.aws`).length).toBe(1);
  });

  test('codex type defaults apply', () => {
    const spec = resolveCascade({
      type: 'codex',
      homeYcrcPath: path.join(tmpDir, 'nope.ycrc'),
      projectYcrcPath: path.join(tmpDir, 'nope2.ycrc'),
      cliLayer: { type: 'codex' },
    });
    expect(spec.type).toBe('codex');
    expect(spec.image).toBe('yolocage/codex:dev');
    expect(spec.configDirContainer).toBe('/home/agent/.codex');
  });

  test('opencode errors with v2 message', () => {
    expect(() =>
      resolveCascade({
        type: 'opencode',
        homeYcrcPath: path.join(tmpDir, 'nope.ycrc'),
        projectYcrcPath: path.join(tmpDir, 'nope2.ycrc'),
        cliLayer: { type: 'opencode' },
      })
    ).toThrow(/v2/);
  });
});
