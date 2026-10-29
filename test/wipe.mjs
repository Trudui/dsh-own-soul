// 一键清空记忆的冒烟测试：记忆全没、人设和设置留着。
// 跑法：ELECTRON_RUN_AS_NODE=1 "<DeepSeek Harness.exe>" --expose-internals test/wipe.mjs
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SoulStore } from '../src/store.mjs';

let failures = 0;
const check = (name, ok, extra = '') => {
  if (!ok) failures += 1;
  console.log(`${ok ? '  ok  ' : 'FAIL  '}${name}${!ok && extra ? ' — ' + extra : ''}`);
};

const box = mkdtempSync(join(tmpdir(), 'soul-wipe-'));
try {
  const store = new SoulStore(box);
  store.ensure();
  store.update({ persona: { name: '鱼露', identity: '我是鱼露。' }, tokenBudget: 1500 });
  store.addMemory({ text: '他的猫叫年糕', level: 'fact' });
  store.append('2026-10-30', { sid: 's1', useq: '1', user: '在吗', assistant: '在' });
  store.writeDiary('2026-10-30', '# 2026-10-30\n今天挺安静。');
  store.writeTraits([
    { id: 't1', kind: 'style', text: '先查再答', status: 'active', count: 2, days: ['2026-10-30'], salience: 1 },
  ]);
  store.writeHandoff({ at: Date.now(), date: '2026-10-30', text: '在做什么：测试', from: { count: 1, sessions: 1 } });

  check(
    '清空前确实有东西',
    store.memories().length === 1 && store.journalDates().length === 1 && store.diaryDates().length === 1,
  );

  const removed = store.wipeMemory();
  check('清空返回统计', removed.files >= 2 && removed.journal === 1 && removed.diary === 1, JSON.stringify(removed));
  check('记忆条目清空', store.memories().length === 0);
  check('流水清空', store.journalDates().length === 0);
  check('日记清空', store.diaryDates().length === 0);
  check('印象清空', store.traits().length === 0);
  check('接续卡清空', !store.handoff());
  check(
    '人设和设置还在',
    store.state().persona.identity === '我是鱼露。' && store.state().tokenBudget === 1500,
  );
  check('清空以后还能接着记', store.addMemory({ text: '重新开始', level: 'fact' }).created === true);
  store.append('2026-10-31', { sid: 's1', useq: '2', user: '又来了', assistant: '嗯' });
  check('清空以后流水还能写', store.journalDates().length === 1);
} finally {
  rmSync(box, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} 个失败` : '\n全过');
process.exit(failures ? 1 : 0);
