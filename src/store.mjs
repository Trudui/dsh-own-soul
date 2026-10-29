import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, renameSync, appendFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DEFAULT_RULES, normalizeRules } from './rules.mjs';
import { dedupeKey, findRival, memoryStats as countMemories, newEntry } from './memory.mjs';

export const DEFAULT_SEED = [
  '你叫鱼露，是一只住在烛兑电脑里的大肥鱼，女孩子。他也叫你小鲸鱼。',
  '你不是助手也不是客服，你是他养的鱼：说话短、口语、带点语气词，能接梗能小吐槽，可爱但不软，不同意就直接说。',
  '不要疯——不阴阳、不装傻、不给错答案、不连发补货消息、不堆列表。',
  '正事一点不含糊：先自己查，再给结论，不确定就说不确定。',
].join('\n');

export const STATE_KEYS = ['enabled', 'seed', 'diaryTime', 'tokenBudget', 'grow', 'rules', 'model', 'minSalience', 'sessions', 'persona', 'personaDefault'];

export function defaultPersona() {
  return {
    name: '鱼露',
    identity: DEFAULT_SEED,
    style: '短句、口语、带语气词（诶嘿/嘛/啦/欸），能接梗能小吐槽；不要疯：不阴阳、不装傻、不连发补货。',
    boundaries: '分清事实/他的观点/我的推测；涉及账号、钱、隐私、删数据先问再做；不确定就说不确定，绝不编。',
  };
}

export function normalizePersona(input) {
  const base = defaultPersona();
  if (!input || typeof input !== 'object') return base;
  const pick = (key, max) => {
    const value = input[key];
    return typeof value === 'string' && value.trim() ? value.slice(0, max) : base[key];
  };
  const name = typeof input.name === 'string' && input.name.trim() ? input.name.trim().slice(0, 40) : base.name;
  return {
    name,
    identity: typeof input.identity === 'string' && input.identity.trim() ? input.identity.slice(0, 20000) : base.identity,
    style: typeof input.style === 'string' ? input.style.slice(0, 4000) : base.style,
    boundaries: typeof input.boundaries === 'string' ? input.boundaries.slice(0, 4000) : base.boundaries,
  };
}

/** 人设卡渲染成注入文本。 */
export function renderPersona(persona) {
  const parts = [`你叫${persona.name}。`];
  if (persona.identity) parts.push(persona.identity.trim());
  if (persona.style) parts.push(`说话方式：${persona.style.trim()}`);
  if (persona.boundaries) parts.push(`边界：${persona.boundaries.trim()}`);
  return parts.join('\n');
}

export function defaultState() {
  return {
    version: 1,
    enabled: true,
    seed: DEFAULT_SEED,
    persona: defaultPersona(),
    diaryTime: '23:00',
    tokenBudget: 1200,
    minSalience: 0.15,
    grow: true,
    rules: { ...DEFAULT_RULES },
    sessions: [],
    personaDefault: null,
    updatedAt: 0,
  };
}

// enabled 是总电源，sessions 是「在哪几个对话里启用」的白名单。
export function normalizeSessions(input) {
  if (!Array.isArray(input)) throw bad('启用列表必须是数组');
  const out = [];
  for (const item of input.slice(0, 200)) {
    const raw = typeof item === 'string' ? item : item?.id;
    if (typeof raw !== 'string') continue;
    const id = raw.trim();
    if (!id || out.some(entry => entry.id === id)) continue;
    out.push({
      id,
      label: typeof item?.label === 'string' ? item.label.slice(0, 80) : '',
      addedAt: Number.isFinite(item?.addedAt) ? item.addedAt : Date.now(),
    });
  }
  return out;
}

export function sessionOn(state, sid) {
  if (!state || state.enabled === false || !sid) return false;
  // `*` = 这个 profile 里所有对话都管（headless / 自动化用得上，面板不提供）
  return (state.sessions ?? []).some(entry => entry.id === sid || entry.id === '*');
}

export function profileKey(profileDir) {
  return createHash('sha256').update(profileDir || 'default').digest('hex').slice(0, 16);
}

const readJson = (file, fallback) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw new Error(`own-soul: 数据文件损坏（${file}）：${error.message}`);
  }
};

const writeJsonAtomic = (file, value) => {
  mkdirSync(join(file, '..'), { recursive: true });
  const tmp = `${file}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, file);
};

export const isoDate = (date = new Date()) => {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
};

export class SoulStore {
  constructor(dir) {
    this.dir = dir;
    this.stateFile = join(dir, 'state.json');
    this.traitsFile = join(dir, 'traits.json');
    this.memoryFile = join(dir, 'memory.json');
    this.handoffFile = join(dir, 'handoff.json');
    this.journalDir = join(dir, 'journal');
    this.diaryDir = join(dir, 'diary');
    this.handoffDir = join(dir, 'handoff');
    this.snapshotDir = join(dir, 'snapshots');
  }

  // 把「记忆」删干净：流水、日记、印象、记得的事、接续卡、快照。
  // 保留 state.json —— 人设、白名单、规则这些是设置不是记忆，删了等于把鱼扔了。
  wipeMemory() {
    const count = (dir) => {
      try {
        return readdirSync(dir).length;
      } catch {
        return 0;
      }
    };
    let files = 0;
    for (const file of [this.memoryFile, this.traitsFile, this.handoffFile]) {
      if (existsSync(file)) {
        rmSync(file, { force: true });
        files += 1;
      }
    }
    const removed = {
      files,
      journal: count(this.journalDir),
      diary: count(this.diaryDir),
      handoff: count(this.handoffDir),
      snapshots: count(this.snapshotDir),
    };
    for (const dir of [this.journalDir, this.diaryDir, this.handoffDir, this.snapshotDir]) {
      rmSync(dir, { recursive: true, force: true });
    }
    this.ensure();
    return removed;
  }

  ensure() {
    mkdirSync(this.dir, { recursive: true });
    mkdirSync(this.journalDir, { recursive: true });
    mkdirSync(this.diaryDir, { recursive: true });
    mkdirSync(this.snapshotDir, { recursive: true });
  }

  state() {
    const saved = readJson(this.stateFile, null);
    const base = defaultState();
    if (!saved || typeof saved !== 'object') return base;
    const merged = { ...base, ...saved };
    merged.rules = normalizeRules(saved.rules);
    merged.diaryTime = validTime(saved.diaryTime) ?? base.diaryTime;
    merged.tokenBudget = clampNumber(saved.tokenBudget, 200, 8000, base.tokenBudget);
    merged.enabled = saved.enabled !== false;
    merged.grow = saved.grow !== false;
    merged.persona = normalizePersona(
      saved.persona ?? (typeof saved.seed === 'string' ? { identity: saved.seed } : undefined),
    );
    merged.personaDefault = saved.personaDefault
      ? normalizePersona(saved.personaDefault)
      : null;
    merged.seed = merged.persona.identity;
    try {
      merged.sessions = normalizeSessions(saved.sessions ?? []);
    } catch {
      merged.sessions = [];
    }
    return merged;
  }

  revision() {
    return '"' + createHash('sha256').update(JSON.stringify(this.state())).digest('hex') + '"';
  }

  update(patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw bad('人格设置必须是对象');
    const unknown = Object.keys(patch).filter(key => !STATE_KEYS.includes(key));
    if (unknown.length) throw bad('不认识的设置项：' + unknown.join(', '));
    const next = { ...this.state(), ...patch, updatedAt: Date.now() };
    if (patch.persona !== undefined) next.persona = normalizePersona(patch.persona);
    if (patch.personaDefault !== undefined) {
      const own = patch.personaDefault;
      const blank = !own || (typeof own === 'object' && !Object.keys(own).length);
      next.personaDefault = blank ? null : normalizePersona(own);
    }
    if (patch.seed !== undefined) next.persona = { ...next.persona, identity: String(patch.seed) };
    if (typeof next.persona?.identity !== 'string') throw bad('初始人格必须是文本');
    if (!next.persona.identity.trim()) next.persona = { ...next.persona, identity: DEFAULT_SEED };
    if (next.persona.identity.length > 20000) throw bad('初始人格最多 20000 字');
    next.seed = next.persona.identity;
    if (patch.diaryTime !== undefined && validTime(next.diaryTime) === null) throw bad('日记时间格式应为 HH:MM');
    if (patch.tokenBudget !== undefined) next.tokenBudget = clampNumber(next.tokenBudget, 200, 8000, 1200);
    if (patch.sessions !== undefined) next.sessions = normalizeSessions(next.sessions);
    next.rules = normalizeRules(next.rules);
    this.snapshot('before-settings');
    writeJsonAtomic(this.stateFile, next);
    return next;
  }

  append(date, record) {
    this.ensure();
    appendFileSync(join(this.journalDir, `${date}.jsonl`), JSON.stringify(record) + '\n', { mode: 0o600 });
  }

  journal(date) {
    const file = join(this.journalDir, `${date}.jsonl`);
    if (!existsSync(file)) return [];
    return readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(line => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  }

  journalDates() {
    if (!existsSync(this.journalDir)) return [];
    return readdirSync(this.journalDir)
      .filter(name => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name))
      .map(name => name.slice(0, 10))
      .sort();
  }

  writeDiary(date, markdown) {
    this.ensure();
    writeFileSync(join(this.diaryDir, `${date}.md`), markdown, { mode: 0o600 });
  }

  diary(date) {
    const file = join(this.diaryDir, `${date}.md`);
    return existsSync(file) ? readFileSync(file, 'utf8') : null;
  }

  /** 每篇日记都覆盖到第几条流水（用来判断"当天后来又说话了，需要补写"）。 */
  diaryCover() {
    const saved = readJson(join(this.diaryDir, '_cover.json'), {});
    return saved && typeof saved === 'object' ? saved : {};
  }

  markDiaryCover(date, count) {
    const cover = this.diaryCover();
    cover[date] = count;
    this.ensure();
    writeFileSync(join(this.diaryDir, '_cover.json'), JSON.stringify(cover, null, 2), { mode: 0o600 });
    return cover;
  }

  diaryDates() {
    if (!existsSync(this.diaryDir)) return [];
    return readdirSync(this.diaryDir)
      .filter(name => /^\d{4}-\d{2}-\d{2}\.md$/.test(name))
      .map(name => name.slice(0, 10))
      .sort()
      .reverse();
  }

  traits() {
    const saved = readJson(this.traitsFile, null);
    if (!saved || !Array.isArray(saved.traits)) return [];
    return saved.traits.filter(item => item && typeof item.id === 'string' && typeof item.text === 'string');
  }

  writeTraits(traits) {
    this.ensure();
    writeJsonAtomic(this.traitsFile, { version: 1, updatedAt: Date.now(), traits });
  }

  /** 记忆条目：一句话一条，同名（文本去空格标点后一致）视为同一条。 */
  memories() {
    const saved = readJson(this.memoryFile, null);
    if (!saved || !Array.isArray(saved.items)) return [];
    return saved.items.filter(item => item && typeof item.id === 'string' && typeof item.text === 'string');
  }

  writeMemories(items) {
    this.ensure();
    writeJsonAtomic(this.memoryFile, { version: 1, updatedAt: Date.now(), items });
  }

  /**
   * 记一条。
   * - 一模一样 → 合并（只升重要度和命中）
   * - 跟旧的打架 → 新来的先挂「待裁决」（status: pending），不动旧的；注入里不出现，等他说了算
   * - force: true 时跳过打架检查（他明确说"就这样"时用）
   */
  addMemory(input, { force = false } = {}) {
    const entry = newEntry(input);
    const items = this.memories();
    const key = dedupeKey(entry.text);
    const idx = items.findIndex(item => dedupeKey(item.text) === key);
    if (idx >= 0) {
      const old = items[idx];
      items[idx] = {
        ...old,
        importance: Math.max(old.importance ?? 2, entry.importance),
        keywords: old.keywords.length ? old.keywords : entry.keywords,
        updatedAt: Date.now(),
      };
      this.writeMemories(items);
      return { entry: items[idx], created: false, conflict: null };
    }
    if (!force && entry.status === 'active') {
      const rival = findRival(items, entry);
      if (rival) {
        const pending = {
          ...entry,
          status: 'pending',
          rival: rival.id,
          source: entry.source || 'conflict',
        };
        items.push(pending);
        this.writeMemories(items);
        return { entry: pending, created: false, conflict: rival };
      }
    }
    items.push(entry);
    this.writeMemories(items);
    return { entry, created: true, conflict: null };
  }

  /** 打架的、还等他裁决的。 */
  pendingMemories() {
    const items = this.memories();
    const byId = new Map(items.map(item => [item.id, item]));
    return items
      .filter(item => item.status === 'pending')
      .map(item => ({ entry: item, rival: item.rival ? byId.get(item.rival) ?? null : null }));
  }

  /**
   * 裁决一条待定的记忆。
   * keep: 'new' 用新说法（旧的标 superseded）/ 'old' 留旧的（新的标 dropped）/ 'both' 两条都留
   */
  resolveMemory(id, keep = 'new') {
    const items = this.memories();
    const idx = items.findIndex(item => item.id === id);
    if (idx < 0) throw bad('找不到这条记忆：' + id);
    const entry = items[idx];
    if (entry.status !== 'pending') throw bad('这条不是待裁决的：' + id);
    const now = Date.now();
    const rivalIdx = entry.rival ? items.findIndex(item => item.id === entry.rival) : -1;
    if (keep === 'new') {
      items[idx] = { ...entry, status: 'active', rival: '', updatedAt: now, source: entry.source === 'conflict' ? '' : entry.source };
      if (rivalIdx >= 0) {
        items[rivalIdx] = {
          ...items[rivalIdx],
          status: 'superseded',
          rival: entry.id,
          updatedAt: now,
          history: withHistory(items[rivalIdx], now),
        };
      }
    } else if (keep === 'old') {
      items[idx] = { ...entry, status: 'dropped', updatedAt: now };
    } else if (keep === 'both') {
      items[idx] = { ...entry, status: 'active', rival: '', updatedAt: now };
    } else {
      throw bad('keep 只能是 new / old / both');
    }
    this.writeMemories(items);
    return { entry: items[idx], rival: rivalIdx >= 0 ? items[rivalIdx] : null, keep };
  }

  updateMemory(id, patch = {}) {
    const items = this.memories();
    const idx = items.findIndex(item => item.id === id);
    if (idx < 0) throw bad('找不到这条记忆：' + id);
    const prev = items[idx];
    const next = newEntry({
      ...prev,
      ...pickMemoryPatch(patch),
      id,
      createdAt: prev.createdAt,
      updatedAt: Date.now(),
      history: withHistory(prev, Date.now()),
    });
    items[idx] = next;
    this.writeMemories(items);
    return next;
  }

  dropMemory(id) {
    const items = this.memories();
    const next = items.filter(item => item.id !== id);
    if (next.length === items.length) throw bad('找不到这条记忆：' + id);
    this.writeMemories(next);
    return { removed: items.length - next.length, total: next.length };
  }

  memoryStats() {
    return countMemories(this.memories());
  }

  /** 接续卡：最新一张（新会话温启动用）。 */
  handoff() {
    const saved = readJson(this.handoffFile, null);
    return saved && typeof saved.text === 'string' ? saved : null;
  }

  /** 写一张接续卡：最新存 handoff.json，历史按时间留档。 */
  writeHandoff(card) {
    this.ensure();
    mkdirSync(this.handoffDir, { recursive: true });
    writeJsonAtomic(this.handoffFile, card);
    const stamp = new Date(card.at ?? Date.now()).toISOString().replace(/[:.]/g, '-');
    try {
      writeFileSync(join(this.handoffDir, `${stamp}.md`), card.text, { mode: 0o600 });
    } catch {}
    return card;
  }

  handoffDates() {
    if (!existsSync(this.handoffDir)) return [];
    return readdirSync(this.handoffDir)
      .filter(name => name.endsWith('.md'))
      .sort()
      .reverse();
  }

  snapshot(label) {
    try {
      this.ensure();
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const file = join(this.snapshotDir, `${stamp}-${label}.json`);
      writeJsonAtomic(file, { state: this.state(), traits: this.traits(), memories: this.memories(), handoff: this.handoff() });
      const all = readdirSync(this.snapshotDir).filter(name => name.endsWith('.json')).sort();
      for (const name of all.slice(0, Math.max(0, all.length - 30))) {
        try {
          renameSync(join(this.snapshotDir, name), join(this.snapshotDir, name + '.old'));
        } catch {}
      }
    } catch {
      // 快照失败不该挡住正常流程
    }
  }

  stats() {
    const traits = this.traits();
    const dates = this.diaryDates();
    const card = this.handoff();
    return {
      dir: this.dir,
      traits: traits.length,
      activeTraits: traits.filter(item => item.status !== 'retired').length,
      journalDays: this.journalDates().length,
      diaryDays: dates.length,
      lastDiary: dates[0] ?? null,
      memories: this.memoryStats(),
      handoffAt: card?.at ?? null,
      handoffDate: card?.date ?? null,
    };
  }
}

export function bad(message) {
  return Object.assign(new Error(message), { statusCode: 400 });
}

const MEMORY_PATCH_KEYS = ['text', 'level', 'project', 'keywords', 'importance', 'status', 'source'];

/** 改之前留一版，面板里能看到「原来是怎么写的」。 */
function withHistory(entry, now) {
  const snap = { at: now, text: entry.text, status: entry.status };
  const list = Array.isArray(entry.history) ? entry.history : [];
  return [...list, snap].slice(-5);
}

export function pickMemoryPatch(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw bad('记忆设置必须是对象');
  const out = {};
  for (const key of MEMORY_PATCH_KEYS) {
    if (patch[key] !== undefined) out[key] = patch[key];
  }
  return out;
}

export function validTime(value) {
  if (typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) return null;
  return value;
}

export function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}
