import { keywords } from './rules.mjs';
import { BLOCK_RATIO, renderMemory } from './diary.mjs';
import { memoryLine, renderFacts, searchMemories } from './memory.mjs';
import { isUsable } from './handoff.mjs';
import { pairsOf } from './capture.mjs';

/** 取一行能读懂的摘要：跳过标题/粗体/标签行。 */
export function oneLine(text, limit = 70) {
  const line =
    String(text ?? '')
      .split('\n')
      .map(item => item.trim())
      .find(item => item && !item.startsWith('#') && !item.startsWith('**') && !item.startsWith('<')) ?? '';
  return line.length > limit ? `${line.slice(0, limit)}…` : line;
}

/** 最近几篇日记的"当天锚"，永远在场，不走相似度。 */
export function recentLines(store, limit = 3) {
  return store
    .diaryDates()
    .slice(0, limit)
    .map(date => [date, oneLine(store.diary(date) ?? '')])
    .filter(([, line]) => Boolean(line))
    .map(([date, line]) => `${date}：${line}`);
}

/** 今天这几个话头，去翻更早的日记，命中了才翻出来。 */
export function recallLines(store, texts, limit = 2) {
  const words = keywords(texts, 8).map(item => item.word);
  if (!words.length) return [];
  const dates = store.diaryDates();
  const fresh = new Set(dates.slice(0, 3));
  const scored = [];
  for (const date of dates) {
    if (fresh.has(date)) continue;
    const text = store.diary(date) ?? '';
    if (!text) continue;
    const hits = words.filter(word => text.includes(word)).length;
    if (hits) scored.push({ date, hits, line: oneLine(text) });
  }
  return scored
    .sort((a, b) => b.hits - a.hits || (a.date < b.date ? 1 : -1))
    .slice(0, limit)
    .map(item => `${item.date}：${item.line}`);
}

/**
 * 组装注入用的整块"自我记忆"。
 * 出任何错都只返回空串 —— 这段是锦上添花，绝不能让整轮对话失败。
 */
export const WARM_PAIRS = 2;
export const WARM_RATIO = 1.7;
export const WARM_MAX = 2000;

export function isWarmSession(session) {
  try {
    return pairsOf(session).length <= WARM_PAIRS;
  } catch {
    return false;
  }
}

export function buildMemory(store, session, state, onError) {
  try {
    const texts = textsOf(session);
    const items = store.memories();
    const base = Number(state.tokenBudget) || 1200;
    // 新会话头两轮：把预算放大一点，好让它"醒过来"时先认清自己是谁、之前在干嘛。
    // 聊开之后立刻回落到正常预算，不然每轮都付这笔钱。
    const warm = isWarmSession(session);
    const budget = warm ? Math.min(WARM_MAX, Math.round(base * WARM_RATIO)) : base;
    const factCap = Math.floor(budget * BLOCK_RATIO.facts);
    const hot = pickFacts(items, texts, Math.max(2, Math.round(factCap / 95)));
    const pending = items.filter(entry => entry.status === 'pending').length;
    const recalled = pickRecall(items, texts, hot);
    return renderMemory({
      handoff: warmStart(store, session),
      traits: store.traits(),
      facts: hot.map(entry => memoryLine(entry, 90)),
      recent: recentLines(store, warm ? 4 : 3),
      recall: [...recallLines(store, texts, warm ? 3 : 2), ...recalled.map(entry => memoryLine(entry, 70))],
      pending,
      budget,
      minSalience: state.minSalience ?? 0.15,
    });
  } catch (error) {
    onError?.(error);
    return '';
  }
}

/**
 * 温启动：只有"这个会话几乎还没聊"（<=2 个问答对）时，才把 3 天内的接续卡拿出来。
 * 聊开了就不再提，免得每轮都把旧交接顶在头上。
 */
export function warmStart(store, session) {
  try {
    // 关了接续卡就不注入；手动模式下只要是写好的卡仍然用（写了就是为了用）
    if (store.state().handoffMode === 'off') return '';
    const pairs = pairsOf(session);
    if (pairs.length > 2) return '';
    const card = store.handoff();
    return isUsable(card) ? card.text : '';
  } catch {
    return '';
  }
}

/** 记得的事：先放这几句话命中的，再用最重要的补满。 */
function pickFacts(items, texts, limit = 6) {
  const query = texts.join(' ');
  const hits = query ? searchMemories(items, query, { limit, minScore: 0.2 }) : [];
  const picked = hits.map(item => item.entry);
  const seen = new Set(picked.map(entry => entry.id));
  if (picked.length >= limit) return picked.slice(0, limit);
  for (const entry of items) {
    if (seen.has(entry.id) || entry.status !== 'active') continue;
    picked.push(entry);
    seen.add(entry.id);
    if (picked.length >= limit) break;
  }
  return picked;
}

/** 突然想起来：更早的、没进"记得的事"的条目。 */
function pickRecall(items, texts, already) {
  const query = texts.join(' ');
  if (!query) return [];
  const used = new Set(already.map(entry => entry.id));
  return searchMemories(items, query, { limit: 6, minScore: 0.15 })
    .map(item => item.entry)
    .filter(entry => !used.has(entry.id))
    .slice(0, 2);
}

export { renderFacts };

/** 从会话里取最近的几句"他说的话"。 */
export function textsOf(session, limit = 8) {
  const events = session?.snapshotEvents?.() ?? session?.events ?? [];
  const out = [];
  for (const event of events) {
    if (event?.type !== 'user/message') continue;
    const data = event.data ?? {};
    if (data.source?.kind !== 'user') continue;
    const blocks = Array.isArray(data.content) ? data.content : [];
    const text = blocks
      .map(block => (typeof block === 'string' ? block : block?.text ?? ''))
      .join(' ')
      .trim();
    if (text) out.push(text);
  }
  return out.slice(-limit);
}
