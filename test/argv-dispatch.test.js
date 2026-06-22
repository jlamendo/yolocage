'use strict';

const { classifyArgv } = require('../yc');

describe('classifyArgv', () => {
  test('bare yc → shortcut, claude', () => {
    const c = classifyArgv([]);
    expect(c.mode).toBe('shortcut');
    expect(c.type).toBe('claude');
    expect(c.passthrough).toEqual([]);
  });

  test('yc claude → shortcut, claude', () => {
    const c = classifyArgv(['claude']);
    expect(c.mode).toBe('shortcut');
    expect(c.type).toBe('claude');
  });

  test('yc codex → shortcut, codex', () => {
    const c = classifyArgv(['codex']);
    expect(c.mode).toBe('shortcut');
    expect(c.type).toBe('codex');
  });

  test('yc claude -- --resume → shortcut, passthrough', () => {
    const c = classifyArgv(['claude', '--', '--resume']);
    expect(c.mode).toBe('shortcut');
    expect(c.type).toBe('claude');
    expect(c.passthrough).toEqual(['--resume']);
  });

  test('yc claude -- -p foo bar → multi-token passthrough', () => {
    const c = classifyArgv(['claude', '--', '-p', 'foo', 'bar']);
    expect(c.passthrough).toEqual(['-p', 'foo', 'bar']);
  });

  test('yc claude --resume (no --) → still treated as passthrough (all dash-prefixed)', () => {
    const c = classifyArgv(['claude', '--resume']);
    expect(c.mode).toBe('shortcut');
    expect(c.passthrough).toEqual(['--resume']);
  });

  test('yc claude positional (no --) → error', () => {
    expect(() => classifyArgv(['claude', 'somefile.txt'])).toThrow(/unexpected positional/);
  });

  test('yc create … → subcommand form', () => {
    const c = classifyArgv(['create', 'foo', '--type=claude']);
    expect(c.mode).toBe('subcommand');
    expect(c.argv).toEqual(['create', 'foo', '--type=claude']);
  });

  test('yc list → subcommand form', () => {
    const c = classifyArgv(['list']);
    expect(c.mode).toBe('subcommand');
  });

  test('yc rm foo → subcommand', () => {
    const c = classifyArgv(['rm', 'foo']);
    expect(c.mode).toBe('subcommand');
  });

  test('yc --help → subcommand (commander prints help)', () => {
    const c = classifyArgv(['--help']);
    expect(c.mode).toBe('subcommand');
  });

  test('yc -h → subcommand', () => {
    const c = classifyArgv(['-h']);
    expect(c.mode).toBe('subcommand');
  });

  test('yc --version → subcommand', () => {
    const c = classifyArgv(['--version']);
    expect(c.mode).toBe('subcommand');
  });

  test('unknown first token → subcommand (commander will error)', () => {
    const c = classifyArgv(['totally-bogus']);
    expect(c.mode).toBe('subcommand');
  });

  test('unknown shortcut token falls through to subcommand mode', () => {
    // Anything that isn't in TYPE_DEFAULTS (opencode was removed in
    // 0.1.1) is treated as a generic subcommand. The fallback path
    // then surfaces the canonical 'unknown subcommand' help text.
    const c = classifyArgv(['opencode']);
    expect(c.mode).toBe('subcommand');
  });
});
