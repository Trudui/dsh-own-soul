// 记忆系统：一句话一条，带关键词、来源、时间。
// 纯规则检索，不打模型、不花钱；打分逻辑照 LINLIN 的双轴记忆（时间 + 强度）简化而来。
import { clip } from './rules.mjs';

export const LEVELS = ['soul', 'user', 'fact', 'lesson', 'rules', 'project', 'topic'];

export const LEVEL_LABEL = {
  soul: '我',
  user: '他',
  fact: '事',
  lesson: '教训',
  rules: '规矩',
  project: '工程',
  topic: '话题',
};

/** 一条记忆的形状。 */
export function newEntry(input = {}) {
  const text = String(input.text ?? '').replace(/\s+/g, ' ').trim();
  if (!text) throw Object.assign(new Error('记忆内容不能为空'), { statusCode: 400 });
  if (text.length > 2000) throw Object.assign(new Error('一条记忆最多 2000 字'), { statusCode: 400 });
  const level = LEVELS.includes(input.level) ? input.level : 'fact';
  const now = Date.now();
  return {
    id: String(input.id ?? '').trim() || entryId(text),
    text,
    level,
    project: typeof input.project === 'string' ? input.project.slice(0, 40) : '',
    keywords: normalizeKeywords(input.keywords),
    importance: clamp(input.importance, 1, 4, 2),
    status: ['active', 'stale', 'archived'].includes(input.status) ? input.status : 'active',
    source: typeof input.source === 'string' ? input.source.slice(0, 60) : '',
    createdAt: Number.isFinite(input.createdAt) ? input.createdAt : now,
    updatedAt: Number.isFinite(input.updatedAt) ? input.updatedAt : now,
    hit: Number.isFinite(input.hit) ? input.hit : 0,
    lastHitAt: Number.isFinite(input.lastHitAt) ? input.lastHitAt : 0,
  };
}

export function normalizeKeywords(input) {
  const list = Array.isArray(input) ? input : typeof input === 'string' ? input.split(/[,，、\s]+/) : [];
  const out = [];
  for (const raw of list) {
    const word = String(raw ?? '').trim().toLowerCase();
    if (!word || word.length > 24) continue;
    if (out.includes(word)) continue;
    out.push(word);
    if (out.length >= 13) break;
  }
  return out;
}

/** 同一句话 → 同一个 id，天然去重。 */
export function entryId(text) {
  const normalized = dedupeKey(text);
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < normalized.length; i += 1) {
    const code = normalized.charCodeAt(i);
    h1 = (h1 ^ code) * 0x01000193;
    h2 = (h2 * 31 + code) | 0;
  }
  const a = (h1 >>> 0).toString(36);
  const b = Math.abs(h2).toString(36);
  return `m-${a}${b}`.slice(0, 24);
}

export function dedupeKey(text) {
  return String(text ?? '')
    .replace(/\s+/g, '')
    .replace(/[，。！？、,.!?~…:：;；"'“”‘’()（）\[\]【】<>《》]/g, '')
    .toLowerCase();
}

function clamp(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** 把一句话切成检索用的词：ASCII 词 + 中文 2/3 字窗口。 */
export function termsOf(text) {
  const s = String(text ?? '')
    .replace(/https?:\/\/\S+/gi, ' ')
    .toLowerCase();
  const out = new Set();
  for (const word of s.match(/[a-z][a-z0-9_.-]{2,}/g) ?? []) out.add(word.replace(/[.-]+$/, ''));
  for (const run of s.match(/[\u4e00-\u9fa5]+/g) ?? []) {
    for (const size of [3, 2]) {
      for (let i = 0; i + size <= run.length; i += 1) out.add(run.slice(i, i + size));
    }
  }
  return [...out].filter(word => word.length >= 2).slice(0, 400);
}

const DAY = 86400000;

// 参数照 LINLIN 的双轴记忆调的：事实活得久、流水活得短。
export const TAU_DAYS = { fact: 365, lesson: 365, rules: 365, soul: 365, user: 365, project: 180, topic: 90 };
export const FORGET_BELOW = 0.25; // 低于这个：进「记不太清」区，不再主动注入
export const CLEAR_ABOVE = 0.55; // 高于这个：记得清楚
export const MIN_SALIENCE = 0.1;
export const MERGE_SIM = 0.82;

/**
 * 强度（双轴）：时间衰减 + 被想起的次数。
 * S = 0.7 * exp(-Δt/τ) + 0.3 * min(1, ln(1+hit)/ln16)
 * Δt 量到「上一次被想起」，没被想起过就从创建时间算。
 */
export function strength(entry, now = Date.now()) {
  const tau = TAU_DAYS[entry.level] ?? 180;
  const last = entry.lastHitAt || entry.createdAt || now;
  const ageDays = Math.max(0, (now - last) / DAY);
  const decay = Math.exp(-ageDays / tau);
  const use = Math.min(1, Math.log(1 + (entry.hit ?? 0)) / Math.log(16));
  return Number((0.7 * decay + 0.3 * use).toFixed(4));
}

/** 三档：清楚 / 模糊 / 快忘了。 */
export function clarity(entry, now = Date.now()) {
  const s = strength(entry, now);
  if (s >= CLEAR_ABOVE) return 'clear';
  if (s >= FORGET_BELOW) return 'fuzzy';
  return 'faint';
}

/**
 * 一条记忆对一句问话的相关度。
 * 关键词命中（强度） × 记忆强度 × 时间新鲜度。
 */
export function scoreEntry(entry, terms, { now = Date.now() } = {}) {
  if (!entry || entry.status === 'archived') return 0;
  const keywords = entry.keywords.length ? entry.keywords : termsOf(entry.text);
  const haystack = `${entry.text} ${entry.keywords.join(' ')}`.toLowerCase();
  let hits = 0;
  for (const term of terms) {
    if (term.length < 2) continue;
    if (keywords.some(word => word === term)) hits += 3;
    else if (haystack.includes(term)) hits += 1;
  }
  if (!hits) return 0;
  const relevance = Math.min(1, hits / 6);
  const importance = 0.6 + (entry.importance ?? 2) * 0.2;
  const memory = 0.35 + 0.65 * strength(entry, now);
  return Number((relevance * importance * memory).toFixed(4));
}

/** 按一句话检索：命中关键词的排前面，同等分数新的优先。 */
export function searchMemories(items, query, { limit = 8, level, project, minScore = 0.12, now = Date.now() } = {}) {
  const terms = termsOf(query);
  if (!terms.length) return [];
  const wanted = level ? String(level).split(',').map(word => word.trim()).filter(Boolean) : null;
  const out = [];
  for (const entry of items) {
    if (entry.status === 'archived') continue;
    if (wanted && !wanted.includes(entry.level)) continue;
    if (project && entry.project && entry.project !== project) continue;
    const score = scoreEntry(entry, terms, { now });
    if (score < minScore) continue;
    out.push({ entry, score });
  }
  return out.sort((a, b) => b.score - a.score || b.entry.createdAt - a.entry.createdAt).slice(0, limit);
}

/** 把检索结果渲染成注入行。 */
export function memoryLine(entry, limit = 90) {
  const body = clip(entry.text, limit);
  return LEVEL_LABEL[entry.level] ? `${body}` : body;
}

/** 注入用：按重要度 + 时间取一批「我记得的事」。快忘了的不主动提，除非很重要。 */
export function renderFacts(items, { budget = 600, limit = 8, now = Date.now() } = {}) {
  const usable = items
    .filter(entry => entry.status === 'active')
    .filter(entry => clarity(entry, now) !== 'faint' || (entry.importance ?? 2) >= 4)
    .sort((a, b) => (b.importance ?? 2) - (a.importance ?? 2) || strength(b, now) - strength(a, now));
  const lines = [];
  let used = 0;
  for (const entry of usable) {
    const line = `- ${memoryLine(entry)}`;
    if (used + line.length > budget) break;
    lines.push(line);
    used += line.length + 1;
    if (lines.length >= limit) break;
  }
  return lines.join('\n');
}

/** 两条记忆像不像：关键词 Jaccard + 文本包含。纯规则，不需要向量。 */
export function textSim(a, b) {
  const ka = new Set(a.keywords.length ? a.keywords : termsOf(a.text));
  const kb = new Set(b.keywords.length ? b.keywords : termsOf(b.text));
  if (!ka.size || !kb.size) return 0;
  let inter = 0;
  for (const word of ka) if (kb.has(word)) inter += 1;
  const jaccard = inter / (ka.size + kb.size - inter);
  const shrink = (s, n = 24) => String(s ?? '').replace(/\s+/g, '').slice(0, n);
  const contained = shrink(a.text) === shrink(b.text) ? 1 : 0;
  return Number(Math.max(jaccard, contained).toFixed(3));
}

/**
 * 巩固：合并近重复 + 让太久没想起的条目退场（只标 faint，不删）。
 * 照 LINLIN 的巩固四件事，砍掉依赖向量的部分。
 */
export function consolidate(items, { now = Date.now(), threshold = MERGE_SIM } = {}) {
  const kept = [];
  let merged = 0;
  for (const entry of items) {
    const twin = kept.find(other => other.status === 'active' && entry.status === 'active' && textSim(other, entry) >= threshold);
    if (twin) {
      twin.hit = (twin.hit ?? 0) + (entry.hit ?? 0) + 1;
      twin.lastHitAt = Math.max(twin.lastHitAt ?? 0, entry.lastHitAt ?? 0, entry.createdAt ?? 0);
      twin.importance = Math.max(twin.importance ?? 2, entry.importance ?? 2);
      twin.keywords = normalizeKeywords([...(twin.keywords ?? []), ...(entry.keywords ?? [])]);
      twin.updatedAt = now;
      merged += 1;
      continue;
    }
    kept.push(entry);
  }
  let faded = 0;
  const next = kept.map(entry => {
    const s = strength(entry, now);
    if (entry.status === 'active' && s < MIN_SALIENCE) {
      faded += 1;
      return { ...entry, status: 'stale', updatedAt: now };
    }
    return entry;
  });
  return { items: next, merged, faded };
}

/** 容量估计：每条大概多少字节，一 年/十年会长到多大。 */
export function capacityStats(items) {
  let bytes = 0;
  for (const entry of items) bytes += Buffer.byteLength(JSON.stringify(entry), 'utf8') + 1;
  const per = items.length ? Math.round(bytes / items.length) : 0;
  return {
    total: items.length,
    bytes,
    avgBytes: per,
    yearBytes: per * 120 * 365,
  };
}

/** 合并：同文本只留一条，保留更早的 createdAt、更大的 hit。 */
export function mergeEntries(existing, incoming) {
  const map = new Map();
  for (const entry of existing) map.set(dedupeKey(entry.text), entry);
  const added = [];
  const merged = [];
  for (const raw of incoming) {
    const entry = newEntry(raw);
    const key = dedupeKey(entry.text);
    const old = map.get(key);
    if (old) {
      merged.push({ ...old, importance: Math.max(old.importance ?? 2, entry.importance ?? 2), updatedAt: Date.now() });
      continue;
    }
    map.set(key, entry);
    added.push(entry);
  }
  return { items: [...existing, ...added], added: added.length, merged: merged.length, duplicates: merged };
}

/**
 * 他说的话里，哪些值得单独记一条。
 * 只认明确信号（以后 / 每次 / 别再 / 记住 / 我叫 / 我喜欢…），不做无脑摘要。
 */
export function extractMemories(records, rules = {}) {
  const signal = rxOf(rules.memory);
  if (!signal) return [];
  const out = [];
  const seen = new Set();
  for (const record of records) {
    const text = String(record?.user ?? '').replace(/\s+/g, ' ').trim();
    if (text.length < 6 || text.length > 300) continue;
    if (/https?:\/\/|www\./i.test(text)) continue;
    if (!signal.test(text)) continue;
    const key = dedupeKey(text);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ text, level: 'fact', keyword: '' });
  }
  return out.slice(-6);
}

const rxCache = new Map();
function rxOf(source) {
  if (typeof source !== 'string' || !source) return null;
  let hit = rxCache.get(source);
  if (!hit) {
    try {
      hit = new RegExp(source);
    } catch {
      return null;
    }
    rxCache.set(source, hit);
  }
  return hit;
}

export function memoryStats(items, now = Date.now()) {
  const byLevel = {};
  const byClarity = { clear: 0, fuzzy: 0, faint: 0 };
  let active = 0;
  for (const entry of items) {
    byLevel[entry.level] = (byLevel[entry.level] ?? 0) + 1;
    if (entry.status === 'active') {
      active += 1;
      byClarity[clarity(entry, now)] += 1;
    }
  }
  return { total: items.length, active, byLevel, byClarity, ...capacityStats(items) };
}
