'use strict';

const os = require('os');
const { parseYcrc, expandPathish } = require('../lib/ycrc');

describe('.ycrc parser', () => {
  test('parses simple key=value', () => {
    const out = parseYcrc('type=claude\nmemory=4g\n');
    expect(out.type).toBe('claude');
    expect(out.memory).toBe('4g');
  });

  test('strips # comments to EOL', () => {
    const out = parseYcrc('# header comment\ntype=claude   # trailing\nmemory=2g\n');
    expect(out.type).toBe('claude');
    expect(out.memory).toBe('2g');
  });

  test('ignores blank lines', () => {
    const out = parseYcrc('\n\ntype=claude\n\n\nmemory=2g\n\n');
    expect(out.type).toBe('claude');
    expect(out.memory).toBe('2g');
  });

  test('strips leading + trailing whitespace on keys and values', () => {
    const out = parseYcrc('   type   =   claude   \n');
    expect(out.type).toBe('claude');
  });

  test('expands leading ~ in path values', () => {
    const out = parseYcrc('ssproxy_extensions=~/.yolocage/scrubbers.json\n');
    expect(out.ssproxy_extensions).toBe(`${os.homedir()}/.yolocage/scrubbers.json`);
  });

  test('expands literal $HOME in path values', () => {
    const out = parseYcrc('ssproxy_extensions=$HOME/.yolocage/scrubbers.json\n');
    expect(out.ssproxy_extensions).toBe(`${os.homedir()}/.yolocage/scrubbers.json`);
  });

  test('DOES NOT evaluate $(rm -rf ~) — must remain a literal', () => {
    const out = parseYcrc('memory=$(rm -rf ~)\n');
    // Non-path key: no expansion at all, raw text.
    expect(out.memory).toBe('$(rm -rf ~)');
  });

  test('DOES NOT evaluate $(…) substitution in PATH-shaped key either', () => {
    // ssproxy_extensions is a path key, so it goes through expandPathish.
    // expandPathish only touches `~` and `$HOME` — never `$(…)`.
    const out = parseYcrc('ssproxy_extensions=$(rm -rf ~)\n');
    // No bin/sh ever ran. The dollar-paren sequence is kept verbatim.
    expect(out.ssproxy_extensions).toBe('$(rm -rf ~)');
  });

  test('DOES NOT evaluate `whoami` backticks in PATH-shaped key', () => {
    const out = parseYcrc('ssproxy_extensions=`whoami`/scrubbers.json\n');
    expect(out.ssproxy_extensions).toBe('`whoami`/scrubbers.json');
  });

  test('does not interpret `~bar` (mid-string tilde) as $HOME', () => {
    const out = parseYcrc('ssproxy_extensions=/etc/~bar\n');
    expect(out.ssproxy_extensions).toBe('/etc/~bar');
  });

  test('does not interpret $HOMEISH or $HOME_DIR as $HOME', () => {
    const out = parseYcrc('ssproxy_extensions=/x/$HOMEISH/y\n');
    expect(out.ssproxy_extensions).toBe('/x/$HOMEISH/y');
  });

  test('multi-value key extra_bind_dirs accumulates', () => {
    const out = parseYcrc(
      'extra_bind_dirs=~/.aws:/home/agent/.aws:ro\n' +
        'extra_bind_dirs=~/.kube:/home/agent/.kube:ro\n'
    );
    expect(Array.isArray(out.extra_bind_dirs)).toBe(true);
    expect(out.extra_bind_dirs.length).toBe(2);
    expect(out.extra_bind_dirs[0]).toBe(`${os.homedir()}/.aws:/home/agent/.aws:ro`);
  });

  test('throws on malformed line', () => {
    expect(() => parseYcrc('this line has no equals\n')).toThrow(/malformed/);
  });

  test('throws on empty key', () => {
    expect(() => parseYcrc('=value\n')).toThrow(/empty key/);
  });

  test('expandPathish bare ~ → homedir', () => {
    expect(expandPathish('~')).toBe(os.homedir());
  });
});
