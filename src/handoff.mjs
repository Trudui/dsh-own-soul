// 接续卡：会话要长得看不见头之前，先写一张交接条。
// 新会话第一轮把它捞出来 —— 等于温启动，不用重读历史。
import { keywords } from './rules.mjs';

export const CARD_LIMIT = 800;
export const WARM_WITHIN_DAYS = 3;

function clip(text, limit) {
  const clean = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return clean.length > limit ? `${clean.slice(0, limit)}…` : clean;
}

/** 从一段流水里挑出「在做什么」：他最近说的话里出现两次以上的名词性词。 */
export function topicsOf(records, limit = 4) {
  const texts = records.map(item => item.user).filter(Boolean).slice(-12);
  if (!texts.length) return [];
  return keywords(texts, 12)
    .filter(item => item.df >= 2 || item.tf >= 2)
    .slice(0, limit)
    .map(item => item.word);
}

/**
 * 造一张接续卡。纯规则，不调模型，绝不出错。
 * @returns {{at:number, date:string, text:string, from:{count:number, sessions:number}}}
 */
export function makeCard({ records = [], date = '', at = Date.now() } = {}) {
  const tail = records.filter(item => item?.user).slice(-12);
  const topics = topicsOf(tail);
  const last = tail[tail.length - 1];
  const firstUser = clip(tail[0]?.user, 80);
  const lastUser = clip(last?.user, 110);
  const lastAnswer = clip(last?.assistant, 110);
  const doingLine = topics.length
    ? `在做什么：${topics.join('、')} 相关的事。`
    : firstUser
      ? `在做什么：从「${firstUser}」这件开始的。`
      : '在做什么：他刚交代完一件事，手头还没收尾。';
  const lines = [
    `# 接续卡 ${date || ''}`.trim(),
    '',
    doingLine,
    lastUser ? `卡在哪：他最后说的是「${lastUser}」。` : '',
    lastAnswer ? `我最后答的是「${lastAnswer}」。` : '',
    '',
    '最后两轮：',
    ...tail.slice(-2).map(item => {
      const pair = [];
      if (item.user) pair.push(`- 他：${clip(item.user, 90)}`);
      if (item.assistant) pair.push(` 我：${clip(item.assistant, 90)}`);
      return pair.join('\n');
    }),
    '',
    '接着往下做就行，不用我重头讲一遍。',
  ].filter((item, index) => item !== '' || index === 1);
  let text = lines.join('\n');
  if (text.length > CARD_LIMIT) text = `${text.slice(0, CARD_LIMIT - 1)}…`;
  return {
    at,
    date: date || '',
    text,
    from: { count: records.length, sessions: new Set(records.map(item => item.sid).filter(Boolean)).size },
  };
}

/** 新会话温启动：只认 3 天内、且不是空的卡。 */
export function isUsable(card, now = Date.now()) {
  if (!card || typeof card.text !== 'string' || !card.text.trim()) return false;
  const age = now - Number(card.at ?? 0);
  return age >= 0 && age <= WARM_WITHIN_DAYS * 24 * 3600 * 1000;
}
