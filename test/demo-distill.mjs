import { mkdirSync, copyFileSync, writeFileSync, rmSync } from 'node:fs';
import { SoulStore, isoDate } from '../src/store.mjs';
import { distill, renderTraits } from '../src/diary.mjs';

const root = 'D:/BigFatFish/_shots/demo-soul';
rmSync(root, { recursive: true, force: true });
for (const dir of ['journal', 'diary', 'snapshots']) mkdirSync(`${root}/${dir}`, { recursive: true });
copyFileSync('D:/DSH-Home/own-soul/a3b54e923db26531/journal/2026-10-26.jsonl', `${root}/journal/2026-10-26.jsonl`);

const store = new SoulStore(root);
store.ensure();
const state = store.state();
const day1 = '2026-10-26';
const day2 = '2026-10-27';

const run = date => {
  const records = store.journal(date);
  const result = distill(date, { records, traits: store.traits(), state });
  store.writeDiary(date, result.markdown);
  store.writeTraits(result.traits);
  return result;
};

const first = run(day1);
console.log('=== 第 1 天日记 ===');
console.log(first.markdown);

// 模拟"第二天又聊了同样的东西"：把同一天的流水复制到 10-27，验证跨天才转正
copyFileSync(`${root}/journal/${day1}.jsonl`, `${root}/journal/${day2}.jsonl`);
const second = run(day2);
console.log('=== 第 2 天日记 ===');
console.log(second.markdown);
console.log('=== 转正后的特质（注入系统的部分）===');
console.log(renderTraits(store.traits(), state.tokenBudget));
writeFileSync(`${root}/rendered.txt`, renderTraits(store.traits(), state.tokenBudget));
