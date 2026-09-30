import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConversationRegistry } from '../src/im/weixin/conversation-registry.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
describe('ConversationRegistry', () => {
  it('maps a user to a stable, privacy-preserving headless session', () => {
    const root = mkdtempSync(join(tmpdir(), 'botwx-registry-'));
    roots.push(root);
    const file = join(root, 'conversations.json');
    const registry = new ConversationRegistry(file);

    const first = registry.sessionIdFor('wx-user-sensitive');
    expect(first).toMatch(/^hl_wx_[A-Za-z0-9_-]{43}$/);
    expect(registry.sessionIdFor('wx-user-sensitive')).toBe(first);

    const rotated = registry.rotate('wx-user-sensitive');
    expect(rotated).not.toBe(first);
    expect(new ConversationRegistry(file).sessionIdFor('wx-user-sensitive')).toBe(rotated);
    expect(readFileSync(file, 'utf8')).not.toContain('wx-user-sensitive');
  });

  it('never aliases two conversation ids', () => {
    const root = mkdtempSync(join(tmpdir(), 'botwx-registry-'));
    roots.push(root);
    const registry = new ConversationRegistry(join(root, 'state.json'));
    expect(registry.sessionIdFor('alice')).not.toBe(registry.sessionIdFor('bob'));
  });

  it('persists a per-conversation model, rotates the session, and migrates v1 state', () => {
    const root = mkdtempSync(join(tmpdir(), 'botwx-registry-'));
    roots.push(root);
    const file = join(root, 'state.json');
    const seed = new ConversationRegistry(file);
    const original = seed.sessionIdFor('alice');

    const selectedSession = seed.selectModel('alice', 'claude-sonnet-5-5');
    expect(selectedSession).not.toBe(original);
    expect(seed.modelFor('alice')).toBe('claude-sonnet-5-5');
    expect(readFileSync(file, 'utf8')).not.toContain('alice');

    const reloaded = new ConversationRegistry(file);
    expect(reloaded.modelFor('alice')).toBe('claude-sonnet-5-5');
    const defaultSession = reloaded.selectModel('alice', undefined);
    expect(defaultSession).not.toBe(selectedSession);
    expect(new ConversationRegistry(file).modelFor('alice')).toBeUndefined();

    writeFileSync(file, JSON.stringify({ schemaVersion: 1, generations: {} }));
    expect(new ConversationRegistry(file).modelFor('alice')).toBeUndefined();
  });
});
