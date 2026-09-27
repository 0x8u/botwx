import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { Cron } from 'croner';

const STORE_VERSION = 1;
const DEFAULT_TICK_MS = 15_000;
const MAX_STORED_RESULT_CHARS = 100_000;
const WEIXIN_MESSAGE_CHUNK_CHARS = 3_500;

export type BotwxScheduleStatus = 'running' | 'ok' | 'error' | 'delivery_pending';

export interface BotwxScheduleTask {
  id: string;
  name: string;
  cron: string;
  display: string;
  timeZone: string;
  prompt: string;
  /** SHA-256 of the raw WeChat conversation id; raw ids are never persisted. */
  ownerKey: string;
  /** Dedicated headless session: recurring work does not race interactive chat. */
  sessionId: string;
  enabled: boolean;
  createdAt: string;
  nextRunAt: string;
  lastRunAt?: string;
  lastStatus?: BotwxScheduleStatus;
  lastError?: string;
  pendingDelivery?: {
    text: string;
    createdAt: string;
    outcome: 'ok' | 'error';
    resultError?: string;
    nextChunk?: number;
    error?: string;
  };
}

interface ScheduleState {
  schemaVersion: 1;
  tasks: BotwxScheduleTask[];
}

type ParsedScheduleCommand =
  | { kind: 'list' }
  | { kind: 'create'; cron: string; display: string; prompt: string }
  | { kind: 'remove' | 'pause' | 'resume' | 'run'; id: string };

export interface BotwxSchedulerOptions {
  filePath: string;
  timeZone: string;
  tickMs?: number;
  now?: () => Date;
  log?: (message: string) => void;
}

export type BotwxScheduleExecutor = (task: Readonly<BotwxScheduleTask>) => Promise<string>;
export type BotwxScheduleSender = (message: string) => Promise<void>;

function taskSessionId(id: string): string {
  const digest = createHash('sha256').update(`botwx-schedule:${id}`, 'utf8').digest('base64url');
  return `hl_wxs_${digest.slice(0, 43)}`;
}

function validTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

function nextCronRun(expr: string, timeZone: string, after: Date): string {
  const next = new Cron(expr, { timezone: timeZone }).nextRun(after);
  if (!next) throw new Error(`cron expression has no future run: ${expr}`);
  return next.toISOString();
}

function normalizeHour(period: string | undefined, hour: number): number {
  if (!period) return hour;
  if (['下午', '傍晚', '晚上', '夜里'].includes(period) && hour < 12) return hour + 12;
  if (period === '中午' && hour > 0 && hour < 11) return hour + 12;
  if (['凌晨', '早上', '上午'].includes(period) && hour === 12) return 0;
  return hour;
}

const DAILY_TIME = /(?:每天|每日)\s*(?:(凌晨|早上|上午|中午|下午|傍晚|晚上|夜里)\s*)?(\d{1,2})(?:(?:点|时)(?:(\d{1,2})分?)?|[:：](\d{1,2}))/;

function dailyCreate(text: string): ParsedScheduleCommand | undefined {
  const match = DAILY_TIME.exec(text);
  if (!match) return undefined;
  const hour = normalizeHour(match[1], Number(match[2]));
  const minute = Number(match[3] ?? match[4] ?? 0);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59) {
    throw new Error(`无法识别执行时间：${match[0]}`);
  }

  let prompt = `${text.slice(0, match.index)} ${text.slice(match.index + match[0].length)}`;
  prompt = prompt
    .replace(/^\s*(?:请|麻烦)?\s*帮我\s*(?:写|创建|设置|添加|安排)?\s*(?:一个|一条)?\s*(?:定时|定期)任务[\s,，。:：;；-]*/u, '')
    .replace(/^\s*(?:创建|设置|添加|安排)\s*(?:一个|一条)?\s*(?:定时|定期)任务[\s,，。:：;；-]*/u, '')
    .replace(/^\s*(?:执行|运行|触发)\s*/u, '')
    .replace(/(?:请)?记得(?:这|它)?是(?:一个)?(?:定时|定期)任务[\s,，。;；]*/gu, '')
    .replace(/每次(?:运行|执行)完成后(?:都)?需要通过\s*微信\s*(?:ClawBot)?\s*(?:返回|发送|推送)结果给我[。！!]?/giu, '')
    .replace(/^[\s,，。:：;；-]+|[\s,，]+$/gu, '')
    .trim();
  if (!prompt) throw new Error('定时任务缺少执行内容');
  if (prompt.length > 20_000) throw new Error('定时任务内容过长（最多 20000 字符）');
  const hhmm = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  return { kind: 'create', cron: `${minute} ${hour} * * *`, display: `每天 ${hhmm}`, prompt };
}

/** Deterministic command parser; ambiguous scheduling prose stays in the Agent path. */
export function parseBotwxScheduleCommand(rawText: string): ParsedScheduleCommand | undefined {
  const text = rawText.trim();
  if (!text) return undefined;
  const slash = text.match(/^\/schedule(?:\s+([\s\S]*))?$/i);
  let body = slash ? (slash[1] ?? '').trim() : text;

  if (slash && (!body || /^(?:list|列表|查看)$/i.test(body))) return { kind: 'list' };
  if (!slash && /^(?:列出|查看|显示)(?:我的|微信)?(?:所有)?(?:定时|定期)任务[。！!]?$/u.test(text)) {
    return { kind: 'list' };
  }

  const operation = body.match(/^(?:remove|delete|删除)\s+([0-9a-f]{8})$/i)
    ?? body.match(/^(?:pause|暂停)\s+([0-9a-f]{8})$/i)
    ?? body.match(/^(?:resume|恢复|启用)\s+([0-9a-f]{8})$/i)
    ?? body.match(/^(?:run|执行)\s+([0-9a-f]{8})$/i);
  if (operation) {
    const op = operation[0].split(/\s+/)[0]!.toLowerCase();
    const kind = ['remove', 'delete', '删除'].includes(op)
      ? 'remove'
      : ['pause', '暂停'].includes(op)
        ? 'pause'
        : ['resume', '恢复', '启用'].includes(op)
          ? 'resume'
          : 'run';
    return { kind, id: operation[1]!.toLowerCase() };
  }

  if (slash) {
    body = body.replace(/^add\s+/i, '').trim();
    const cron = body.match(/^([\d*/?,\-]+\s+[\d*/?,\-]+\s+[\d*/?,\-]+\s+[\d*/?,\-]+\s+[\d*/?,\-]+)\s*\|\s*([\s\S]+)$/);
    if (cron) {
      // Cron validates the expression here; no malformed row reaches disk.
      nextCronRun(cron[1]!, 'UTC', new Date());
      return { kind: 'create', cron: cron[1]!, display: cron[1]!, prompt: cron[2]!.trim() };
    }
    return dailyCreate(body);
  }

  const hasScheduleIntent = /(?:帮我|请|麻烦)\s*(?:写|创建|设置|添加|安排).{0,12}(?:定时|定期)任务/su.test(text)
    || /^\s*(?:创建|设置|添加|安排).{0,12}(?:定时|定期)任务/su.test(text)
    || /^\s*(?:请\s*)?(?:每天|每日).+(?:执行|运行|推送|发送|提醒)/su.test(text);
  return hasScheduleIntent ? dailyCreate(text) : undefined;
}

function parseState(raw: unknown): ScheduleState {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { schemaVersion: 1, tasks: [] };
  const record = raw as Record<string, unknown>;
  if (record.schemaVersion !== STORE_VERSION || !Array.isArray(record.tasks)) {
    return { schemaVersion: 1, tasks: [] };
  }
  const tasks = record.tasks.filter((value): value is BotwxScheduleTask => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const task = value as Partial<BotwxScheduleTask>;
    return typeof task.id === 'string' && /^[0-9a-f]{8}$/.test(task.id)
      && typeof task.cron === 'string' && typeof task.prompt === 'string'
      && typeof task.ownerKey === 'string' && /^[A-Za-z0-9_-]{43}$/.test(task.ownerKey)
      && typeof task.sessionId === 'string' && /^hl_[A-Za-z0-9_-]{8,128}$/.test(task.sessionId)
      && typeof task.timeZone === 'string' && validTimeZone(task.timeZone)
      && typeof task.nextRunAt === 'string' && Number.isFinite(Date.parse(task.nextRunAt))
      && typeof task.enabled === 'boolean';
  });
  return { schemaVersion: 1, tasks };
}

function chunks(text: string): string[] {
  const chars = Array.from(text);
  const result: string[] = [];
  for (let index = 0; index < chars.length; index += WEIXIN_MESSAGE_CHUNK_CHARS) {
    result.push(chars.slice(index, index + WEIXIN_MESSAGE_CHUNK_CHARS).join(''));
  }
  return result.length > 0 ? result : ['（任务没有返回文本）'];
}

export class BotwxScheduler {
  private tasks: BotwxScheduleTask[];
  private executor?: BotwxScheduleExecutor;
  private sender?: BotwxScheduleSender;
  private timer?: NodeJS.Timeout;
  private ticking = false;
  private readonly running = new Set<string>();
  private readonly now: () => Date;
  private readonly log: (message: string) => void;

  constructor(private readonly options: BotwxSchedulerOptions) {
    if (!validTimeZone(options.timeZone)) throw new Error(`Invalid Botwx schedule time zone: ${options.timeZone}`);
    this.now = options.now ?? (() => new Date());
    this.log = options.log ?? (() => undefined);
    this.tasks = this.load().tasks;
    let changed = false;
    for (const task of this.tasks) {
      if (task.lastStatus === 'running') {
        task.lastStatus = 'error';
        task.lastError = '任务执行被 Botwx 重启中断';
        changed = true;
      }
    }
    if (changed) this.persist();
  }

  setHandlers(executor: BotwxScheduleExecutor, sender: BotwxScheduleSender): void {
    this.executor = executor;
    this.sender = sender;
  }

  start(): void {
    if (this.timer) return;
    const tickMs = this.options.tickMs ?? DEFAULT_TICK_MS;
    this.timer = setInterval(() => { void this.runDueTasks(); }, tickMs);
    this.timer.unref?.();
    void this.runDueTasks();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  list(ownerKey?: string): BotwxScheduleTask[] {
    return this.tasks.filter(task => !ownerKey || task.ownerKey === ownerKey).map(task => structuredClone(task));
  }

  async handleMessage(input: { ownerKey: string; text: string }): Promise<string | undefined> {
    let command: ParsedScheduleCommand | undefined;
    try {
      command = parseBotwxScheduleCommand(input.text);
    } catch (error) {
      return `❌ ${error instanceof Error ? error.message : String(error)}`;
    }
    if (!command) return undefined;

    if (command.kind === 'list') return this.formatList(input.ownerKey);
    if (command.kind === 'create') return this.create(input.ownerKey, command);
    const task = this.tasks.find(candidate => candidate.id === command.id && candidate.ownerKey === input.ownerKey);
    if (!task) return `❌ 未找到微信定时任务 ${command.id}`;
    if (command.kind === 'remove') {
      this.tasks = this.tasks.filter(candidate => candidate !== task);
      this.persist();
      return `✅ 已删除微信定时任务 ${task.id}`;
    }
    if (command.kind === 'pause') {
      task.enabled = false;
      this.persist();
      return `⏸️ 已暂停微信定时任务 ${task.id}`;
    }
    if (command.kind === 'resume') {
      task.enabled = true;
      task.nextRunAt = nextCronRun(task.cron, task.timeZone, this.now());
      task.lastError = undefined;
      this.persist();
      return `✅ 已恢复微信定时任务 ${task.id}\n下次执行：${this.formatTime(task.nextRunAt, task.timeZone)}`;
    }
    void this.runTask(task, this.now());
    return `▶️ 已触发微信定时任务 ${task.id}；完成后结果会主动发送到微信。`;
  }

  async noteInbound(ownerKey?: string): Promise<void> {
    if (!this.sender) return;
    for (const task of this.tasks.filter(candidate =>
      candidate.pendingDelivery && (!ownerKey || candidate.ownerKey === ownerKey))) {
      await this.deliver(task);
    }
  }

  async runDueTasks(now = this.now()): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      for (const task of this.tasks) {
        if (!task.enabled || this.running.has(task.id) || Date.parse(task.nextRunAt) > now.getTime()) continue;
        await this.runTask(task, now);
      }
    } finally {
      this.ticking = false;
    }
  }

  private create(ownerKey: string, command: Extract<ParsedScheduleCommand, { kind: 'create' }>): string {
    const existing = this.tasks.find(task => task.ownerKey === ownerKey
      && task.enabled && task.cron === command.cron && task.prompt === command.prompt);
    if (existing) {
      return `ℹ️ 相同的微信定时任务已经存在 [${existing.id}]\n下次执行：${this.formatTime(existing.nextRunAt, existing.timeZone)}`;
    }
    const id = randomBytes(4).toString('hex');
    const now = this.now();
    const task: BotwxScheduleTask = {
      id,
      name: command.prompt.length > 28 ? `${command.prompt.slice(0, 28)}…` : command.prompt,
      cron: command.cron,
      display: command.display,
      timeZone: this.options.timeZone,
      prompt: command.prompt,
      ownerKey,
      sessionId: taskSessionId(id),
      enabled: true,
      createdAt: now.toISOString(),
      nextRunAt: nextCronRun(command.cron, this.options.timeZone, now),
    };
    this.tasks.push(task);
    this.persist();
    return [
      `✅ 已创建微信定时任务 [${task.id}]`,
      `规则：${task.display}（${task.timeZone}）`,
      `下次执行：${this.formatTime(task.nextRunAt, task.timeZone)}`,
      '结果将由微信 ClawBot 主动发送；无需安装或调用 botmux MCP。',
    ].join('\n');
  }

  private formatList(ownerKey: string): string {
    const tasks = this.tasks.filter(task => task.ownerKey === ownerKey);
    if (tasks.length === 0) {
      return '暂无微信定时任务。\n示例：/schedule 每天 23:00 生成今日市场复盘';
    }
    return `微信定时任务（${tasks.length}）：\n\n${tasks.map(task => [
      `${task.enabled ? '✅' : '⏸️'} [${task.id}] ${task.display} · ${task.name}`,
      `   下次：${task.enabled ? this.formatTime(task.nextRunAt, task.timeZone) : '已暂停'}`,
      task.lastStatus ? `   上次：${task.lastStatus}${task.lastError ? ` · ${task.lastError}` : ''}` : undefined,
    ].filter(Boolean).join('\n')).join('\n\n')}`;
  }

  private async runTask(task: BotwxScheduleTask, now: Date): Promise<void> {
    if (this.running.has(task.id)) return;
    if (!this.executor) {
      this.log(`[botwx-scheduler] executor is not ready for ${task.id}`);
      return;
    }
    this.running.add(task.id);
    task.lastRunAt = now.toISOString();
    task.nextRunAt = nextCronRun(task.cron, task.timeZone, new Date(now.getTime() + 1_000));
    task.lastStatus = 'running';
    task.lastError = undefined;
    this.persist();
    try {
      const output = await this.executor(structuredClone(task));
      const report = `🕐 定时任务「${task.name}」执行结果\n\n${output || '（Agent 没有返回文本）'}`;
      task.pendingDelivery = {
        text: Array.from(report).slice(0, MAX_STORED_RESULT_CHARS).join(''),
        createdAt: this.now().toISOString(),
        outcome: 'ok',
      };
      task.lastStatus = 'delivery_pending';
      this.persist();
      await this.deliver(task);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      task.pendingDelivery = {
        text: `❌ 定时任务「${task.name}」执行失败\n\n${message}`,
        createdAt: this.now().toISOString(),
        outcome: 'error',
        resultError: message,
      };
      task.lastStatus = 'delivery_pending';
      task.lastError = message;
      this.persist();
      this.log(`[botwx-scheduler] task ${task.id} failed: ${message}`);
      await this.deliver(task);
    } finally {
      this.running.delete(task.id);
    }
  }

  private async deliver(task: BotwxScheduleTask): Promise<void> {
    const pending = task.pendingDelivery;
    if (!pending || !this.sender) return;
    try {
      const parts = chunks(pending.text);
      for (let index = pending.nextChunk ?? 0; index < parts.length; index += 1) {
        await this.sender(parts[index]!);
        // Persist progress so a later chunk failure does not replay every
        // already-delivered part of a long report.
        pending.nextChunk = index + 1;
        this.persist();
      }
      task.pendingDelivery = undefined;
      task.lastStatus = pending.outcome;
      task.lastError = pending.resultError;
      this.persist();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (task.pendingDelivery) task.pendingDelivery.error = message;
      task.lastStatus = 'delivery_pending';
      task.lastError = `微信主动发送暂不可用，结果将在下次收到消息后补发：${message}`;
      this.persist();
      this.log(`[botwx-scheduler] delivery pending for ${task.id}: ${message}`);
    }
  }

  private formatTime(iso: string, timeZone: string): string {
    return new Intl.DateTimeFormat('zh-CN', {
      dateStyle: 'medium',
      timeStyle: 'medium',
      timeZone,
      hour12: false,
    }).format(new Date(iso));
  }

  private load(): ScheduleState {
    if (!existsSync(this.options.filePath)) return { schemaVersion: 1, tasks: [] };
    try {
      return parseState(JSON.parse(readFileSync(this.options.filePath, 'utf8')));
    } catch (error) {
      this.log(`[botwx-scheduler] ignoring unreadable schedule store: ${error instanceof Error ? error.message : String(error)}`);
      return { schemaVersion: 1, tasks: [] };
    }
  }

  private persist(): void {
    const parent = dirname(this.options.filePath);
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    const temporary = `${this.options.filePath}.${process.pid}.${randomUUID()}.tmp`;
    const body = `${JSON.stringify({ schemaVersion: STORE_VERSION, tasks: this.tasks }, null, 2)}\n`;
    try {
      writeFileSync(temporary, body, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      renameSync(temporary, this.options.filePath);
      try { chmodSync(this.options.filePath, 0o600); } catch { /* best effort */ }
    } catch (error) {
      try { if (existsSync(temporary)) unlinkSync(temporary); } catch { /* preserve original */ }
      throw error;
    }
  }
}
