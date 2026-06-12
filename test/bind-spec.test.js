'use strict';

const os = require('os');
const { parseBindSpec, dedupeBindList, formatBindSpec } = require('../lib/bind-spec');

describe('parseBindSpec', () => {
  test('host:container', () => {
    const b = parseBindSpec('/host:/container');
    expect(b.host).toBe('/host');
    expect(b.container).toBe('/container');
    expect(b.mode).toBe('rw');
  });

  test('host:container:ro', () => {
    const b = parseBindSpec('/host:/container:ro');
    expect(b.host).toBe('/host');
    expect(b.container).toBe('/container');
    expect(b.mode).toBe('ro');
  });

  test('host:container:rw', () => {
    const b = parseBindSpec('/host:/container:rw');
    expect(b.mode).toBe('rw');
  });

  test('expands ~ on host side', () => {
    const b = parseBindSpec('~/.aws:/home/agent/.aws:ro');
    expect(b.host).toBe(`${os.homedir()}/.aws`);
    expect(b.container).toBe('/home/agent/.aws');
    expect(b.mode).toBe('ro');
  });

  test('expands $HOME on host side', () => {
    const b = parseBindSpec('$HOME/.kube:/home/agent/.kube:ro');
    expect(b.host).toBe(`${os.homedir()}/.kube`);
  });

  test('rejects single-token spec', () => {
    expect(() => parseBindSpec('/just-one-path')).toThrow(/at least host:container/);
  });

  test('rejects empty', () => {
    expect(() => parseBindSpec('')).toThrow();
  });

  test('rejects relative container path', () => {
    expect(() => parseBindSpec('/host:rel/path')).toThrow(/container path must be absolute/);
  });

  test('host with colon — last token is mode', () => {
    // 4 tokens: "Volumes", "/something with colons", "/container", "ro"
    // We only support absolute host paths so this is a hypothetical Mac volume.
    const b = parseBindSpec('/Volumes/My:Disk:/container:ro');
    expect(b.host).toBe('/Volumes/My:Disk');
    expect(b.container).toBe('/container');
    expect(b.mode).toBe('ro');
  });

  test('host with colon — no mode keyword, last token is container', () => {
    const b = parseBindSpec('/Volumes/My:Disk:/container');
    expect(b.host).toBe('/Volumes/My:Disk');
    expect(b.container).toBe('/container');
    expect(b.mode).toBe('rw');
  });

  test('non-mode third token is treated as container, not mode', () => {
    const b = parseBindSpec('/a:/b:/c');
    // Last token '/c' is not 'ro'/'rw', so container='/c', host='/a:/b'
    expect(b.host).toBe('/a:/b');
    expect(b.container).toBe('/c');
    expect(b.mode).toBe('rw');
  });
});

describe('dedupeBindList', () => {
  test('drops duplicate host:container pairs (last mode wins)', () => {
    const list = [
      { host: '/a', container: '/x', mode: 'ro' },
      { host: '/b', container: '/y', mode: 'rw' },
      { host: '/a', container: '/x', mode: 'rw' },
    ];
    const out = dedupeBindList(list);
    expect(out.length).toBe(2);
    const a = out.find((b) => b.host === '/a');
    expect(a.mode).toBe('rw'); // later wins
  });

  test('preserves order', () => {
    const list = [
      { host: '/a', container: '/x', mode: 'rw' },
      { host: '/b', container: '/y', mode: 'rw' },
      { host: '/c', container: '/z', mode: 'rw' },
    ];
    const out = dedupeBindList(list);
    expect(out.map((b) => b.host)).toEqual(['/a', '/b', '/c']);
  });
});

describe('formatBindSpec', () => {
  test('round-trips', () => {
    const b = parseBindSpec('/host:/container:ro');
    expect(formatBindSpec(b)).toBe('/host:/container:ro');
  });
});
