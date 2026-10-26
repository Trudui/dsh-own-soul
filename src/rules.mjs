// 纯规则打分：不打模型、不花钱。所有判断都来自用户自己说的话。
export const DEFAULT_RULES = Object.freeze({
  correction: '不对|错了|不是这样|不是这个|搞错|理解错|谁让你|我说过|又说|又忘了|怎么又|重新|算了|别这样|不要这样|你听我说|说反了',
  praise: '不错|可以啊|好耶|笑死|厉害|牛啊|挺好|挺好的|对的对的|这就对|舒服了|谢谢|喜欢这个|干得好',
  style: '太长|太啰嗦|别废话|说重点|闭嘴|别发|吵|太慢|简洁点|简单点|别演|不要疯|废话',
  bond: '记得|第一次|以后|一直|陪我|想你|可爱|宝|乖',
  // 值得单独记一条的信号：他说"以后""每次""别再""我叫""我喜欢"的时候
  memory: '记住|记一下|记着|以后|每次|别再|不要再|我叫|我的名字|我喜欢|我不喜欢|我最|我住|我在用|我的猫|我的狗|我养|说好|约定|习惯',
});

const cache = new Map();
function rx(source) {
  if (!source) return null;
  let hit = cache.get(source);
  if (!hit) {
    hit = new RegExp(source);
    cache.set(source, hit);
  }
  return hit;
}

/** 用户这一句话里命中了哪些信号。 */
export function detect(text, rules = DEFAULT_RULES) {
  const s = typeof text === 'string' ? text : '';
  if (!s) return { correction: false, praise: false, style: false, bond: false, quotes: [] };
  const correction = rx(rules.correction)?.test(s) ?? false;
  const praise = rx(rules.praise)?.test(s) ?? false;
  const style = rx(rules.style)?.test(s) ?? false;
  const bond = rx(rules.bond)?.test(s) ?? false;
  return { correction, praise, style, bond, quotes: [] };
}

const STOP = new Set(['这个', '那个', '就是', '不是', '可以', '什么', '怎么', '一个', '我们', '你们', '他们', '现在', '然后', '因为', '所以', '还是', '已经', '没有', '这里', '那里', '自己', '一下', '觉得', '应该', '但是', '如果', '时候', '东西', '问题', '嗯嗯', '好的', '这样', '那样', '这么', '那么', '一种', '一次', '有点', '一点']);
// 含这些字的 gram 基本都是跨词碎片（"你看""不到""的你""个插"），直接丢掉。
const STOP_CHARS = new Set('的了是在我你他她它和与就都很也把被这那有个不没要会能还又再才只对说做去来上下中大小多少吗呢吧啊哦嘛啦么什怎让给从到然后如果因为所以但是而且或者一个'.split(''));
const PUNCT = /[\s，。！？、,.!?~…:：;；"'“”‘’()（）\[\]【】<>《》/\\|@#$%^&*+=_-]/;

const CJK = /[\u4e00-\u9fa5]+/g;
const ASCII = /[A-Za-z][A-Za-z0-9_.-]{2,}/g;

/**
 * 从他说的话里抽"今天在聊什么"。
 * 规则版：ASCII 词（bilibili / dsh / plugin）+ 中文 2~4 字窗口，按「出现在几条消息里」排序，
 * 丢掉跨词碎片和只出现一次的长短语。
 */
export function keywords(texts, limit = 8) {
  const stat = new Map(); // word -> { tf, df }
  for (const raw of texts) {
    // 链接和域名不算话题：先整段抹掉再抽词
    const text = String(raw ?? '')
      .replace(/https?:\/\/\S+/gi, ' ')
      .replace(/\b(?:www\.)?[\w-]+\.(?:com|cn|net|org|io|dev|ai|me|app)\b/gi, ' ');
    const seenHere = new Set();
    for (const word of text.match(ASCII) ?? []) {
      const key = word.toLowerCase().replace(/[.-]+$/, '');
      if (key.length < 3) continue;
      const hit = stat.get(key) ?? { tf: 0, df: 0 };
      hit.tf += 1;
      if (!seenHere.has(key)) {
        seenHere.add(key);
        hit.df += 1;
      }
      stat.set(key, hit);
    }
    for (const run of text.match(CJK) ?? []) {
      for (const size of [4, 3, 2]) {
        if (run.length < size) continue;
        for (let i = 0; i + size <= run.length; i += 1) {
          const gram = run.slice(i, i + size);
          if (STOP.has(gram)) continue;
          if ([...gram].some(char => STOP_CHARS.has(char))) continue;
          const hit = stat.get(gram) ?? { tf: 0, df: 0 };
          hit.tf += 1;
          if (!seenHere.has(gram)) {
            seenHere.add(gram);
            hit.df += 1;
          }
          stat.set(gram, hit);
        }
      }
    }
  }
  const ranked = [...stat.entries()]
    .filter(([, hit]) => hit.df >= 2 || hit.tf >= 3)
    .sort((a, b) => b[1].df * 2 + b[1].tf - (a[1].df * 2 + a[1].tf) || b[0].length - a[0].length);
  const picked = [];
  for (const [word, hit] of ranked) {
    if (picked.some(item => item.word.includes(word) || word.includes(item.word))) continue;
    picked.push({ word, count: hit.tf, days: hit.df });
    if (picked.length >= limit) break;
  }
  return picked;
}

/** 截断到 n 个字符，保留原话。 */
export function clip(text, n = 40) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n) + '…' : s;
}

export function normalizeRules(input) {
  const rules = { ...DEFAULT_RULES };
  if (input && typeof input === 'object') {
    for (const key of Object.keys(DEFAULT_RULES)) {
      const value = input[key];
      if (typeof value === 'string' && value.trim() && value.length <= 2000) rules[key] = value.trim();
    }
  }
  return rules;
}
