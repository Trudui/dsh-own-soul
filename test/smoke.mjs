// 纯本地冒烟测试：不碰 DSH、不联网、不调模型。
// 跑法：ELECTRON_RUN_AS_NODE=1 "<DeepSeek Harness.exe>" --expose-internals test/smoke.mjs
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SoulStore, DEFAULT_SEED, profileKey, sessionOn, normalizeSessions, renderPersona } from '../src/store.mjs';
import { distill, renderTraits } from '../src/diary.mjs';
import { detect, keywords, normalizeRules } from '../src/rules.mjs';
import { pairsOf, completedPairs } from '../src/capture.mjs';
import { buildMemory, recallLines } from '../src/inject.mjs';
import { consolidate, extractMemories, newEntry, searchMemories, strength } from '../src/memory.mjs';
import { cleanGroupText, sentPart, replayRows, recentGroupReplay } from '../src/group.mjs';

let failures = 0;
const check = (name, ok, extra = '') => {
  if (ok) {
    console.log(`  ok  ${name}`);
  } else {
    failures += 1;
    console.log(`FAIL  ${name}${extra ? ' — ' + extra : ''}`);
  }
};

const dir = mkdtempSync(join(tmpdir(), 'own-soul-'));
try {
  // —— rules ——
  const sig = detect('不对，你搞错了，我说过别发那么多条', normalizeRules(null));
  check('纠正能认出来', sig.correction === true, JSON.stringify(sig));
  check('啰嗦能认出来', sig.style === true, JSON.stringify(sig));
  const kw = keywords(['今天去看了 B 站的那个视频', 'B 站视频真的很离谱'], 5);
  check('关键词抽得出来', kw.length > 0 && kw[0].word, JSON.stringify(kw));

  // —— store ——
  const store = new SoulStore(join(dir, 'own-soul', profileKey('/tmp/profile')));
  store.ensure();
  const st = store.state();
  check('默认状态', st.enabled === true && st.diaryTime === '23:00' && st.seed === DEFAULT_SEED);
  check('初始人格是鱼露', st.seed.includes('鱼露'));

  const after = store.update({ diaryTime: '22:30', tokenBudget: 900, seed: '' });
  check('改时间生效', after.diaryTime === '22:30');
  check('预算生效', after.tokenBudget === 900);
  check('空人格回落到默认', after.seed === DEFAULT_SEED);

  let rejected = false;
  try {
    store.update({ 乱写: 1 });
  } catch {
    rejected = true;
  }
  check('未知设置项被拒', rejected);

  // —— 流水 + 蒸馏 ——
  const day1 = '2026-10-24';
  const day2 = '2026-10-25';
  store.append(day1, { t: Date.now(), sid: 's1', user: '不对，你搞错了', assistant: '哦。', sig: detect('不对，你搞错了', st.rules) });
  store.append(day2, { t: Date.now(), sid: 's1', user: '不对，你又搞错了', assistant: '……', sig: detect('不对，你又搞错了', st.rules) });
  check('流水写进文件', store.journal(day1).length === 1);

  const d1 = distill(day1, { records: store.journal(day1), traits: [], state: st });
  check('日记非空', d1.markdown.includes('# ' + day1) && d1.markdown.length > 20);
  check('第一次是候选', d1.traits.every(item => item.status === 'candidate'), JSON.stringify(d1.traits.map(t => t.status)));
  check('候选不进注入', renderTraits(d1.traits, 1200) === '');

  const d2 = distill(day2, { records: store.journal(day2), traits: d1.traits, state: st });
  const graduated = d2.traits.filter(item => item.status === 'active');
  check('跨天两次就转正', graduated.length > 0, JSON.stringify(d2.traits.map(t => [t.text, t.status, t.days.length])));
  const injected = renderTraits(d2.traits, 1200);
  check('生效的被注入', injected.length > 0 && injected.includes('纠正'));

  store.writeDiary(day2, d2.markdown);
  store.writeTraits(d2.traits);
  check('日记读得回来', (store.diary(day2) || '').includes(day2));
  check('特质读得回来', store.traits().length === d2.traits.length);
  check('stats 有数', store.stats().diaryDays === 1 && store.stats().journalDays === 2);

  store.snapshot('test');
  check('快照写得出来', store.stats().dir.length > 0);

  // 事件流配对（曾经在这里翻过车：流水一条都没记上）
  const fakeSession = {
    id: 'S1',
    events: [
      { type: 'turn/start', seq: 1 },
      { type: 'user/message', seq: 2, time: 1_700_000_000_000, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '在吗' }] } },
      { type: 'assistant/message', seq: 3, data: { message: { content: [{ type: 'text', text: '在' }] } } },
      { type: 'user/message', seq: 4, data: { source: { kind: 'tool' }, content: [{ type: 'text', text: '工具回灌' }] } },
      { type: 'user/message', seq: 5, time: 1_700_000_100_000, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '这个报错为啥' }] } },
      { type: 'user/message', seq: 6, time: 1_700_000_200_000, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '算了' }] } },
      { type: 'assistant/message', seq: 7, data: { content: [{ type: 'text', text: '好' }] } },
    ],
  };
  const pairs = pairsOf(fakeSession);
  check('配对数量对', pairs.length === 3, JSON.stringify(pairs.map(p => p.user)));
  check('工具消息被跳过', pairs.every(pair => pair.user !== '工具回灌'));
  check('答在 message.content 里也认', pairs[0].assistant === '在');
  check('没答的先不记', completedPairs(fakeSession).length === 2, JSON.stringify(completedPairs(fakeSession).map(p => p.user)));
  check('seq 当去重键', pairs[1].useq === 5 && pairs[2].useq === 6);

  // 注入组装（曾经在这里翻过车：参数传错 → "texts is not iterable" → 整轮对话直接失败）
  const memoryBlock = buildMemory(store, fakeSession, st);
  check('注入块不抛异常且非空', typeof memoryBlock === 'string' && memoryBlock.includes('<自我记忆'));
  check('最近的事在场', memoryBlock.includes(day1) || memoryBlock.includes(day2));
  check('话头能勾旧日记', (() => {
    try {
      recallLines(store, ['插件 日记 鱼露'], 2);
      return true;
    } catch {
      return false;
    }
  })());
  check('坏输入只降级不抛', (() => {
    try {
      return buildMemory(store, { events: 'not-an-array' }, st) !== undefined;
    } catch {
      return false;
    }
  })());

  // —— 按对话启用 ——
  const gateOff = { enabled: true, sessions: [] };
  const gateOne = { enabled: true, sessions: normalizeSessions([{ id: 'session-a', label: 'A' }]) };
  check('没勾的对话不生效', sessionOn(gateOff, 'session-a') === false);
  check('勾了的对话生效', sessionOn(gateOne, 'session-a') === true);
  check('别的对话不受影响', sessionOn(gateOne, 'session-b') === false);
  check('总电源关了全都不生效', sessionOn({ ...gateOne, enabled: false }, 'session-a') === false);
  check('可以勾多个对话', normalizeSessions([
    { id: 'session-a' },
    { id: 'session-b', label: 'B' },
  ]).length === 2);
  check('重复 id 只留一条', normalizeSessions([{ id: 'session-a' }, { id: 'session-a' }]).length === 1);
  check('空 id 被丢掉', normalizeSessions([{ id: '  ' }, 'session-c']).length === 1);
  check('设置能存住白名单', (() => {
    store.update({ sessions: [{ id: 'session-x', label: 'X' }] });
    const saved = store.state().sessions;
    store.update({ sessions: [] });
    return saved.length === 1 && saved[0].id === 'session-x';
  })());

  // —— 人设系统：三段 ——
  check('默认人设有身份/说话方式/边界', (() => {
    const p = store.state().persona;
    return p.identity.length > 10 && p.style.length > 5 && p.boundaries.length > 5;
  })());
  check('改人设能存住三段', (() => {
    store.update({ persona: { name: '鱼露', identity: '我是测试身份', style: '测试说话方式', boundaries: '测试边界' } });
    const p = store.state().persona;
    store.update({ persona: { name: '鱼露', identity: DEFAULT_SEED, style: '', boundaries: '' } });
    return p.identity === '我是测试身份' && p.style === '测试说话方式' && p.boundaries === '测试边界';
  })());
  check('人设能渲染成注入文本', renderPersona(store.state().persona).includes('鱼露'));

  // —— 记忆系统 ——
  const mem = store.addMemory({ text: '他的猫叫年糕', level: 'fact', keywords: ['猫', '年糕'], importance: 3 });
  check('记忆能写进去', mem.created === true && store.memories().length === 1);
  const dup = store.addMemory({ text: '他的猫叫年糕。', level: 'fact' });
  check('同一句话不会记两条', dup.created === false && store.memories().length === 1);
  const hit = searchMemories(store.memories(), '年糕 那只猫', { limit: 3 });
  check('按关键词能找到', hit.length === 1 && hit[0].entry.text.includes('年糕'));
  check('不相干的搜不到', searchMemories(store.memories(), '量子力学 天气', { limit: 3 }).length === 0);
  check('强度随时间衰减', (() => {
    const entry = store.memories()[0];
    const fresh = strength(entry, Date.now());
    const old = strength({ ...entry, lastHitAt: Date.now() - 400 * 86400000 }, Date.now());
    return fresh > old;
  })());
  check('检索按相关度排序', (() => {
    store.addMemory({ text: '他喜欢喝冰美式，不加糖', level: 'user', keywords: ['冰美式', '咖啡'] });
    const list = searchMemories(store.memories(), '咖啡 冰美式', { limit: 5 });
    return list.length >= 1 && list[0].entry.text.includes('冰美式');
  })());
  check('巩固能合并近重复', (() => {
    const items = [
      newEntry({ text: '他喜欢喝冰美式不加糖', keywords: ['冰美式', '不加糖', '咖啡'] }),
      newEntry({ text: '他喜欢喝冰美式，不加糖。', keywords: ['冰美式', '不加糖', '咖啡'] }),
    ];
    const result = consolidate(items);
    return result.items.length === 1 && result.merged === 1;
  })());
  check('太久没想起的会退场', (() => {
    const stale = newEntry({ text: '很久以前说过的一件小事', importance: 1, createdAt: Date.now() - 900 * 86400000 });
    const result = consolidate([stale]);
    return result.items[0].status === 'stale' && result.faded === 1;
  })());
  check('记忆能改能删', (() => {
    const id = store.memories()[0].id;
    store.updateMemory(id, { importance: 4 });
    const bumped = store.memories().find(item => item.id === id).importance === 4;
    store.dropMemory(id);
    return bumped && store.memories().every(item => item.id !== id);
  })());
  check('从他话里抽得出该记的事', (() => {
    const out = extractMemories(
      [{ user: '记住了，以后叫我烛兑就行' }, { user: '这行代码改一下' }, { user: '每次都要先说结论' }],
      { memory: '记住|以后|每次|别再' },
    );
    return out.length === 2 && out[0].text.includes('烛兑');
  })());
  check('stats 里有记忆统计', store.stats().memories.total >= 1);
  check('日记覆盖条数能记下来（用来判断要不要补写）', (() => {
    store.append('2026-05-01', { useq: '1', user: '先说一件事', assistant: '嗯' });
    store.writeDiary('2026-05-01', '# 2026-05-01\n');
    store.markDiaryCover('2026-05-01', 1);
    const before = store.diaryCover()['2026-05-01'] === 1;
    store.append('2026-05-01', { useq: '2', user: '再补一句', assistant: '好' });
    const stale = store.diaryCover()['2026-05-01'] < store.journal('2026-05-01').length;
    store.markDiaryCover('2026-05-01', 2);
    return before && stale && store.diaryCover()['2026-05-01'] === 2;
  })());
  check('同一天重跑蒸馏不会给特质重复加分', (() => {
    const records = [
      { user: '不对，你搞错了，我说的是明天', assistant: '我重新看' },
      { user: '记住了，以后先给结论', assistant: '行' },
    ];
    const first = distill('2026-06-01', { records, traits: [] , state: store.state() });
    const second = distill('2026-06-01', { records, traits: first.traits, state: store.state() });
    const pick = (list, kind) => list.find(item => item.kind === kind)?.count;
    return first.traits.length > 0 && pick(first.traits, 'correction') === pick(second.traits, 'correction');
  })());
} finally {
  rmSync(dir, { recursive: true, force: true });
}

// —— 群聊回放：只读本地日志，把桥接包装和自己回声都排掉 ——
check('群消息的桥接包装被剥掉', (() => {
  const raw = 'zddd（751096148）：@你\n\n（这台机器只把正文里 `[QQ]…[/QQ]` 中间那段发到 QQ —— 想让手机收到的就写在里面；块外的话只在本机看，不会发出去。）';
  return cleanGroupText(raw) === 'zddd（751096148）：@你';
})());
check('只有 [QQ] 之间那算真发出去的', (() => {
  const raw = '我说点什么\n[QQ]群里那句\n第二行[/QQ]\n块外的话';
  return sentPart(raw) === '群里那句 第二行' && sentPart('没有标记就没有') === '';
})());
check('回放会滤掉自己消息被回灌的那份', (() => {
  const events = [
    { type: 'user/message', time: 1000, data: { source: { kind: 'qq' }, content: [{ type: 'text', text: '三三（2725467994）：康神开播了' }] } },
    { type: 'assistant/message', time: 2000, data: { message: { content: [{ type: 'text', text: '[QQ]不认识这人[/QQ]' }] } } },
    { type: 'user/message', time: 3000, data: { source: { kind: 'qq' }, content: [{ type: 'text', text: '鱼露（1435065373）：不认识这人' }] } },
    { type: 'user/message', time: 4000, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '网页端打的字' }] } },
  ];
  const rows = replayRows(events, { selfQQ: '1435065373' });
  return rows.length === 2 && rows[0].who.startsWith('三三') && rows[1].who === '我' && rows[1].text === '不认识这人';
})());
check('群聊回放拿不到会话时只回一句人话、不抛', (() => {
  const text = recentGroupReplay({ home: join(dir, 'no-such-home') });
  return typeof text === 'string' && text.length > 0;
})());

console.log(failures ? `\n${failures} 个失败` : '\n全过');
process.exit(failures ? 1 : 0);
