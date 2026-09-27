import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

interface PersistedConversationState {
  schemaVersion: 1;
  generations: Record<string, number>;
}

const EMPTY_STATE: PersistedConversationState = { schemaVersion: 1, generations: {} };

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('base64url');
}

function parseState(raw: unknown): PersistedConversationState {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ...EMPTY_STATE, generations: {} };
  const record = raw as Record<string, unknown>;
  if (record.schemaVersion !== 1 || !record.generations || typeof record.generations !== 'object') {
    return { ...EMPTY_STATE, generations: {} };
  }
  const generations: Record<string, number> = {};
  for (const [key, value] of Object.entries(record.generations as Record<string, unknown>)) {
    if (/^[A-Za-z0-9_-]{43}$/.test(key) && Number.isSafeInteger(value) && (value as number) >= 0) {
      generations[key] = value as number;
    }
  }
  return { schemaVersion: 1, generations };
}

/**
 * Maps opaque WeChat conversation ids to stable Botmux headless ids.
 *
 * Raw WeChat identifiers never reach disk: only their SHA-256 digest and a
 * reset generation are persisted. `/clear` advances the generation, which
 * starts a new model session without deleting audit/history from the old one.
 */
export class ConversationRegistry {
  private readonly generations: Record<string, number>;

  constructor(private readonly filePath: string) {
    this.generations = this.load().generations;
  }

  sessionIdFor(conversationId: string): string {
    const normalized = conversationId.trim();
    if (!normalized) throw new Error('WeChat conversationId must not be empty');
    const key = this.conversationKeyFor(normalized);
    const generation = this.generations[key] ?? 0;
    // Botmux headless ids must match /^hl_[A-Za-z0-9_-]{8,128}$/.
    return `hl_wx_${sha256(`${key}:${generation}`).slice(0, 43)}`;
  }

  /** Stable privacy-preserving owner key for connector-owned sidecars. */
  conversationKeyFor(conversationId: string): string {
    const normalized = conversationId.trim();
    if (!normalized) throw new Error('WeChat conversationId must not be empty');
    return sha256(normalized);
  }

  rotate(conversationId: string): string {
    const normalized = conversationId.trim();
    if (!normalized) throw new Error('WeChat conversationId must not be empty');
    const key = sha256(normalized);
    this.generations[key] = (this.generations[key] ?? 0) + 1;
    this.persist();
    return this.sessionIdFor(normalized);
  }

  private load(): PersistedConversationState {
    if (!existsSync(this.filePath)) return { ...EMPTY_STATE, generations: {} };
    try {
      return parseState(JSON.parse(readFileSync(this.filePath, 'utf8')));
    } catch {
      // A malformed sidecar must not prevent the bot from starting. Starting at
      // generation zero is safe: it can only resume the deterministic original
      // session, never expose another user's session.
      return { ...EMPTY_STATE, generations: {} };
    }
  }

  private persist(): void {
    const parent = dirname(this.filePath);
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    const body = `${JSON.stringify({ schemaVersion: 1, generations: this.generations }, null, 2)}\n`;
    try {
      writeFileSync(temporary, body, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      renameSync(temporary, this.filePath);
      try { chmodSync(this.filePath, 0o600); } catch { /* best effort on non-POSIX filesystems */ }
    } catch (error) {
      try {
        if (existsSync(temporary)) unlinkSync(temporary);
      } catch { /* preserve the original error */ }
      throw error;
    }
  }
}
