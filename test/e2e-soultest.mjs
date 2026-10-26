// 端到端演练：把隔离实例今天的流水蒸馏两遍（模拟"跨天重复"），看日记和特质怎么长。
import { copyFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { SoulStore } from '../src/store.mjs';
import { distill, renderTraits, renderMemory } from '../src/diary.mjs';

const root = process.argv[2] ?? 'D:/DSH-Home/own-soul/a89fe1822ede1dba';
const store = new SoulStore(root);
store.ensure();
const state = store.state();

const run = date => {
  const records = store.journal(date);
  const result = distill(date, { records, traits: store.traits(), state });
  store.writeDiary(date, result.markdown);
  store.writeTraits(result.traits);
  return result;
};

const today = store.journalDates().at(-1);
console.log('=== 今天（%s）的流水 %d 条 ===', today, store.journal(today).length);
const first = run(today);
console.log('\n--- 日记 ---\n%s', first.markdown);
console.log('--- 特质（第 1 天，全是候选）---');
for (const item of first.traits) console.log(`  [${item.status}] ${item.text}  证据=${item.evidence?.at(-1) ?? '-'} salience=${item.salience}`);

// 第二天又碰上同样的事 → 转正
const tomorrow = '2026-10-27';
copyFileSync(join(root, 'journal', `${today}.jsonl`), join(root, 'journal', `${tomorrow}.jsonl`));
const second = run(tomorrow);
console.log('\n--- 第 2 天日记 ---\n%s', second.markdown);
console.log('--- 转正的特质 ---');
for (const item of second.traits) console.log(`  [${item.status}] ${item.text} (${item.days.length} 天)`);
console.log('\n--- 注入给模型的整块 ---');
console.log(renderMemory({ traits: store.traits(), recent: [`${tomorrow}：${second.markdown.split('\n')[2] ?? ''}`], recall: [], budget: state.tokenBudget, minSalience: state.minSalience ?? 0.15 }));
if (existsSync(join(root, 'traits.json'))) console.log('\n（traits.json 已落盘）');
