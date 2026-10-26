// 端到端演练（不联网）：流水 → 日记 → 顺手记下的事 → 巩固 → 注入四栏。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SoulStore, renderPersona } from '../src/store.mjs';
import { distill, renderMemory } from '../src/diary.mjs';
import { consolidate, extractMemories } from '../src/memory.mjs';
import { keywords, normalizeRules } from '../src/rules.mjs';

const dir = mkdtempSync(join(tmpdir(), 'own-soul-e2e-'));
const store = new SoulStore(join(dir, 'own-soul'));
store.ensure();
store.update({ persona: { name: '鱼露', identity: '我是鱼露，烛兑养的一条鱼。', style: '短句、口语。', boundaries: '不编造，不擅自删东西。' } });

const today = '2026-10-26';
const lines = [
  { sid: 'session-a', useq: '1', user: '以后叫我烛兑就行，别叫主人', assistant: '好，烛兑。' },
  { sid: 'session-a', useq: '2', user: '我的猫叫年糕，是只橘猫', assistant: '年糕，记住了。' },
  { sid: 'session-a', useq: '3', user: '不对，你又搞错了，我说的是先查再答', assistant: '我先把进程查一遍。' },
  { sid: 'session-a', useq: '4', user: '这个插件跑起来了吗', assistant: '跑起来了。' },
];
for (const line of lines) store.append(today, line);

const state = store.state();
const result = distill(today, { records: store.journal(today), traits: store.traits(), state });
store.writeDiary(today, result.markdown);
store.writeTraits(result.traits);

// 日记之后顺手把该记的事压进记忆
const learned = extractMemories(store.journal(today), state.rules);
for (const item of learned) {
  store.addMemory({
    text: item.text,
    level: item.level,
    source: `diary:${today}`,
    importance: 2,
    keywords: keywords([item.text], 8).map(word => word.word),
  });
}
const tidied = consolidate(store.memories());
store.writeMemories(tidied.items);

console.log('=== 人设注入 ===');
console.log(renderPersona(store.state().persona));
console.log('\n=== 日记 ===\n%s', result.markdown);
console.log('=== 顺手记下的 %d 条 ===', learned.length);
for (const item of learned) console.log('  · ' + item.text);
console.log('=== 巩固：合并 %d / 退场 %d / 现存 %d 条 ===', tidied.merged, tidied.faded, tidied.items.length);

const facts = store.memories().filter(item => item.status === 'active').map(item => item.text);
console.log('\n=== 注入给模型的整块 ===');
console.log(
  renderMemory({
    traits: store.traits(),
    facts,
    recent: [`${today}：${result.markdown.split('\n')[2] ?? ''}`],
    recall: [],
    budget: state.tokenBudget,
    minSalience: state.minSalience ?? 0.15,
  }),
);

rmSync(dir, { recursive: true, force: true });
