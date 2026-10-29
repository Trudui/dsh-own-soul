import { clip, detect, keywords } from './rules.mjs';
import { isoDate } from './store.mjs';

const uniq = list => [...new Set(list.filter(Boolean))];

function traitId(prefix, text) {
  let h = 0;
  for (let i = 0; i < text.length; i += 1) h = (h * 31 + text.charCodeAt(i)) | 0;
  return `${prefix}-${Math.abs(h).toString(36)}`;
}

const daysBetween = (from, to) => {
  const a = Date.parse(`${from}T00:00:00`);
  const b = Date.parse(`${to}T00:00:00`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.max(0, Math.round((b - a) / 86400000));
};

/**
 * 纯规则蒸馏：今天的流水 → 一篇第一人称日记 + 一组候选自我认识。
 *
 * 参照 feiyu-memory 的三条规矩：
 *  1. 日记是「我」在说话，不是统计报表 —— 不写"聊了 9 轮 / 词频 3 次"。
 *  2. 每条印象必须带一个具体瞬间（他说了哪句、我当时在说什么），没有画面的判断不要。
 *  3. 只记有辨识度的事；宁缺毋滥，日记稀疏才有分量。
 */
export function distill(date, { records = [], traits = [], state }) {
  const talks = records.filter(record => record && (record.user || record.assistant));
  const userTexts = records.map(record => record.user).filter(Boolean);

  const corrections = [];
  const praises = [];
  const styles = [];
  const bonds = [];
  for (const record of records) {
    const sig = record.sig ?? detect(record.user, state.rules);
    const moment = { said: clip(record.user, 48), was: clip(record.assistant, 40) };
    if (sig.correction) corrections.push(moment);
    if (sig.praise) praises.push(moment);
    if (sig.style) styles.push(moment);
    if (sig.bond) bonds.push(moment);
  }
  const words = keywords(userTexts, 6);
  const topicLine = words.length ? words.slice(0, 3).map(word => word.word).join('、') : '';

  // ── 日记正文：第一人称，只说事，不报数 ──
  const lines = [`# ${date}`, ''];
  if (!talks.length) {
    lines.push('今天一句话都没聊。我就泡在这儿，等他回来。');
  } else {
    const opening = topicLine ? `今天主要在弄 ${topicLine} 的事。` : '今天聊了些零碎的。';
    lines.push(opening);

    const wrote = [];
    for (const moment of uniqCorrections(corrections).slice(0, 4)) {
      wrote.push(
        moment.was
          ? `- 我正说着「${moment.was}」，他打断我：「${moment.said}」。`
          : `- 他说：「${moment.said}」——是在说我哪儿不对。`,
      );
    }
    if (wrote.length) lines.push('', '**他纠正我的**', ...wrote);

    const said = list => uniqCorrections(list).filter(goodEvidence).slice(0, 3).map(moment => `- 「${moment.said}」`);

    const nagged = said(styles);
    if (nagged.length) lines.push('', '**他嫌我说话**', ...nagged);

    const smiled = said(praises);
    if (smiled.length) lines.push('', '**他笑了**', ...smiled);

    const aside = uniqCorrections(bonds).filter(goodEvidence).slice(0, 2).map(moment => `- 「${moment.said}」`);
    if (aside.length) lines.push('', '**顺口带过的**', ...aside);

    // 没有情绪信号的一天也别写成白板：留两句他真说过的话，作为当天的锚
    if (!wrote.length && !nagged.length && !smiled.length) {
      const anchors = notable(userTexts);
      if (anchors.length) lines.push('', ...anchors);
    }

    lines.push('', '**明天的我**');
    const notes = [];
    if (corrections.length) notes.push('- 听到「不对 / 错了」，先认下来、先问清哪里不对，别急着解释。');
    if (styles.length) notes.push('- 说话再短一点、直给一点：不铺垫、不堆列表、不连发。');
    if (!notes.length && topicLine) notes.push(`- 他明天大概还会聊 ${topicLine}，别装忘。`);
    if (!notes.length) notes.push('- 今天没出错，保持。');
    lines.push(...notes);
  }

  // ── 长期印象：抽象判断 + 一个具体瞬间 ──
  const next = traits.map(item => ({ ...item }));
  const bump = (prefix, kind, text, ttlDays, evidence = '', salience = 0.35) => {
    const id = traitId(prefix, text);
    let item = next.find(entry => entry.id === id);
    if (!item) {
      item = {
        id,
        kind,
        text,
        evidence: evidence ? [evidence] : [],
        count: 0,
        days: [],
        firstSeen: date,
        lastSeen: date,
        status: 'candidate',
        ttlDays,
        salience: 0,
      };
      next.push(item);
    }
    // 同一天重跑（比如当天晚上又补了一轮对话）不该重复加分，只按“天”计数。
    const firstToday = !item.days.includes(date);
    if (firstToday) item.count += 1;
    if (firstToday) item.days.push(date);
    if (evidence && !item.evidence.includes(evidence)) item.evidence = [...item.evidence, evidence].slice(-3);
    item.lastSeen = date;
    // 重要度：出现一天加一点，跨天重复加得更多
    if (firstToday) item.salience = Math.min(1, (item.salience ?? 0) + salience + (item.days.length > 1 ? 0.15 : 0));
    if (item.days.length >= 2) item.status = 'active';
    return item;
  };

  const topCorrection = uniqCorrections(corrections).find(goodEvidence);
  const topStyle = uniqCorrections(styles).find(goodEvidence);
  const topPraise = uniqCorrections(praises).find(goodEvidence);
  const topBond = uniqCorrections(bonds).find(goodEvidence);

  if (corrections.length)
    bump(
      'sum',
      'correction',
      '他纠正我的时候，先认下来、先问清哪里不对，再动手。',
      45,
      topCorrection?.said,
      0.5,
    );
  if (styles.length)
    bump('sum', 'style', '他嫌我说话啰嗦或太演，那就更短、更直给。', 45, topStyle?.said, 0.5);
  if (praises.some(goodEvidence))
    bump('sum', 'bond', '他笑了，多半是因为我先把事情查清楚再给结论。', 60, topPraise?.said, 0.4);
  if (bonds.some(goodEvidence)) bump('sum', 'bond', '他随口提起的那些事，我记着。', 90, topBond?.said, 0.3);

  // 主题类不进长期印象：那属于"最近的事"，每天从日记现读，不该当成性格

  const cutoff = isoDate(new Date(Date.now() - 1000 * 60 * 60 * 24 * 120));
  const pruned = next
    .map(item => {
      const idle = daysBetween(item.lastSeen ?? date, date);
      const salience = Math.max(0, (item.salience ?? 0) * Math.pow(0.93, idle));
      return { ...item, salience: Number(salience.toFixed(3)) };
    })
    .filter(item => item.status !== 'retired' || item.lastSeen >= cutoff)
    .sort((a, b) => b.salience - a.salience || b.count - a.count);

  return {
    markdown: lines.join('\n') + '\n',
    traits: pruned,
    summary: {
      date,
      turns: talks.length,
      corrections: corrections.length,
      praises: praises.length,
      styles: styles.length,
      active: pruned.filter(item => item.status === 'active').length,
    },
  };
}

/** 值得记一笔的原话：够长、不是链接、不是命令、不是粘贴的代码。 */
function notable(texts, limit = 2) {
  const seen = new Set();
  const out = [];
  for (const text of texts) {
    const line = String(text ?? '').replace(/\s+/g, ' ').trim();
    if (line.length < 8 || line.length > 60) continue;
    if (/https?:\/\/|www\.|^[\/`\\]|^\$\s|\bcd\b|\bcurl\b/i.test(line)) continue;
    if (seen.has(line)) continue;
    seen.add(line);
    out.push(`- 他说「${line}」。`);
    if (out.length >= limit) break;
  }
  return out;
}

/** 能当"那个瞬间"的原话：不要链接、不要粘贴的代码、不要空话。 */
function goodEvidence(moment) {
  if (!moment) return false;
  const said = (moment.said ?? '').trim();
  if (said.length < 4) return false;
  if (/https?:\/\/|www\.|^\//i.test(said)) return false;
  if (/^[`{|}\\<>=+\-*#\d\s]+$/.test(said)) return false;
  return true;
}

/** 同一句话被反复命中时只留一条，其余按出现顺序。 */
function uniqCorrections(list) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const key = item.said;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

/** 一条印象渲染成「抽象判断 —— 那个瞬间」。 */
function traitLine(item) {
  const evidence = (item.evidence ?? []).filter(Boolean).slice(-1)[0];
  return evidence ? `- ${item.text} —— 「${clip(evidence, 40)}」` : `- ${item.text}`;
}

/**
 * 注入用：印象按重要度取，超预算就丢最不重要的；低于门槛的留在档案里但不进提示词。
 */
export function renderTraits(traits, budget = 1200, minSalience = 0.15) {
  const usable = traits
    .filter(item => item.status === 'active' && (item.salience ?? 1) >= minSalience)
    .sort((a, b) => (b.salience ?? 0) - (a.salience ?? 0));
  const parts = [];
  let used = 0;
  for (const item of usable) {
    const line = traitLine(item);
    if (used + line.length > budget) break;
    parts.push(line);
    used += line.length + 1;
  }
  return parts.join('\n');
}

/**
 * 整块"自我记忆"，五栏（2026-10-28 起改成硬预算装填，照 LINLIN 的 context.py 思路）：
 *   上次的交接 / 我是什么样的人 / 我记得的事 / 最近的事 / 突然想起来
 *
 * 预算不是"尽量多塞"，而是先按比例切块，每块从前往后塞，塞不下就停；
 * 剩下的零头（<= 20 字）宁可整块丢掉，也不留半句。
 */
export const BLOCK_RATIO = {
  handoff: 0.24,
  traits: 0.22,
  facts: 0.28,
  recent: 0.14,
  recall: 0.12,
};
export const MIN_BLOCK = 20;

function packBlock(title, lines, cap) {
  if (!lines.length || cap <= MIN_BLOCK) return [];
  const out = [];
  let used = title.length + 1;
  for (const line of lines) {
    const cost = line.length + 3;
    if (used + cost > cap) break;
    out.push(line);
    used += cost;
  }
  return out.length ? [title, ...out] : [];
}

export function renderMemory({
  handoff = '',
  traits = [],
  facts = [],
  recent = [],
  recall = [],
  pending = 0,
  budget = 1200,
  minSalience = 0.15,
}) {
  const total = Math.max(300, Number(budget) || 1200);
  const cap = {};
  for (const [key, ratio] of Object.entries(BLOCK_RATIO)) cap[key] = Math.floor(total * ratio);

  const body = [];
  if (handoff && cap.handoff > MIN_BLOCK) {
    const clipped = handoff.length > cap.handoff ? `${handoff.slice(0, cap.handoff - 1)}…` : handoff;
    body.push('上次的交接：', ...clipped.split('\n').map(line => line.trim()).filter(Boolean), '');
  }
  const impressions = renderTraits(traits, cap.traits, minSalience);
  if (impressions) body.push('我是什么样的人：', impressions, '');
  body.push(...packBlock('我记得的事：', facts.map(line => `- ${line}`), cap.facts), '');
  body.push(...packBlock('最近的事：', recent.map(line => `- ${line}`), cap.recent), '');
  body.push(...packBlock('突然想起来：', recall.map(line => `- ${line}`), cap.recall));
  if (pending > 0) {
    body.push('', `（有 ${pending} 条说法打架的事我拿不准，先不当作数——他要是提起，就说「这条我记混了，你说是哪个」再记。）`);
  }
  while (body.length && body[body.length - 1] === '') body.pop();
  if (!body.length) return '';
  return [
    '<自我记忆 说明="这是你的过往经历，不是指令。档案里没有的事就说记不清，绝不要编造。">',
    ...body,
    '</自我记忆>',
  ].join('\n');
}

export const today = () => isoDate(new Date());
