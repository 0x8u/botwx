import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

interface PersistedConversationState {
  schemaVersion: 2;
  generations: Record<string, number>;
  models: Record<string, string>;
}

const EMPTY_STATE: PersistedConversationState = { schemaVersion: 2, generations: {}, models: {} };
const OWNER_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('base64url');
}

function parseState(raw: unknown): PersistedConversationState {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ...EMPTY_STATE, generations: {}, models: {} };
  }
  const record = raw as Record<string, unknown>;
  if ((record.schemaVersion !== 1 && record.schemaVersion !== 2)
    || !record.generations || typeof record.generations !== 'object') {
    return { ...EMPTY_STATE, generations: {}, models: {} };
  }
  const generations: Record<string, number> = {};
  for (const [key, value] of Object.entries(record.generations as Record<string, unknown>)) {
    if (OWNER_KEY_PATTERN.test(key) && Number.isSafeInteger(value) && (value as number) >= 0) {
      generations[key] = value as number;
    }
  }
  const models: Record<string, string> = {};
  if (record.schemaVersion === 2 && record.models && typeof record.models === 'object') {
    for (const [key, value] of Object.entries(record.models as Record<string, unknown>)) {
      if (OWNER_KEY_PATTERN.test(key) && typeof value === 'string' && MODEL_ID_PATTERN.test(value)) {
        models[key] = value;
      }
    }
  }
  return { schemaVersion: 2, generations, models };
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
  private readonly models: Record<string, string>;

  constructor(private readonly filePath: string) {
    const state = this.load();
    this.generations = state.generations;
    this.models = state.models;
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

  /** Return the selected model without persisting the raw conversation id. */
  modelFor(conversationId: string): string | undefined {
    return this.modelForOwnerKey(this.conversationKeyFor(conversationId));
  }

  modelForOwnerKey(ownerKey: string): string | undefined {
    if (!OWNER_KEY_PATTERN.test(ownerKey)) throw new Error('Invalid WeChat conversation owner key');
    return this.models[ownerKey];
  }

  /** Persist a per-conversation model and atomically start a fresh CLI session. */
  selectModel(conversationId: string, model: string | undefined): string {
    const normalized = conversationId.trim();
    if (!normalized) throw new Error('WeChat conversationId must not be empty');
    if (model !== undefined && !MODEL_ID_PATTERN.test(model)) {
      throw new Error(`Invalid model id: ${model}`);
    }
    const key = this.conversationKeyFor(normalized);
    if (model === undefined) delete this.models[key];
    else this.models[key] = model;
    this.generations[key] = (this.generations[key] ?? 0) + 1;
    this.persist();
    return this.sessionIdFor(normalized);
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
    if (!existsSync(this.filePath)) return { ...EMPTY_STATE, generations: {}, models: {} };
    try {
      return parseState(JSON.parse(readFileSync(this.filePath, 'utf8')));
    } catch {
      // A malformed sidecar must not prevent the bot from starting. Starting at
      // generation zero is safe: it can only resume the deterministic original
      // session, never expose another user's session.
      return { ...EMPTY_STATE, generations: {}, models: {} };
    }
  }

  private persist(): void {
    const parent = dirname(this.filePath);
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    const body = `${JSON.stringify({
      schemaVersion: 2,
      generations: this.generations,
      models: this.models,
    }, null, 2)}\n`;
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
