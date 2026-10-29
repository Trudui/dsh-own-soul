// 接续卡：模式开关、清理、注入闸门。
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SoulStore } from '../src/store.mjs';
import { makeCard } from '../src/handoff.mjs';
import { warmStart } from '../src/inject.mjs';

let failed = 0;
const ok = (name, cond, extra = '') => {
  if (cond) console.log('  ok  ' + name);
  else {
    console.log('  FAIL  ' + name + (extra ? ' — ' + extra : ''));
    failed += 1;
  }
};

const box = mkdtempSync(join(tmpdir(), 'own-soul-hoff-'));
const store = new SoulStore(box);
store.ensure();

// 1) 默认是自动
ok('默认接续卡模式是 auto', store.state().handoffMode === 'auto', store.state().handoffMode);

// 2) 三种模式都能存
for (const mode of ['manual', 'off', 'auto']) {
  store.update({ handoffMode: mode });
  ok('能存成 ' + mode, store.state().handoffMode === mode);
}

// 3) 乱写要报错
let threw = '';
try {
  store.update({ handoffMode: 'sometimes' });
} catch (error) {
  threw = error.message;
}
ok('非法模式会报错', threw.includes('auto / manual / off'), threw);

// 4) 空会话 + 没有卡：不注入
const emptySession = { id: 's-empty', events: [] };
ok('没有卡就不注入', warmStart(store, emptySession) === '');

// 5) 写一张卡，auto 下空会话能拿到
const card = makeCard({
  records: [{ user: '接着做接续卡', assistant: '好，先写按钮再写闸门' }],
  date: '2026-10-30',
  at: Date.now(),
});
store.update({ handoffMode: 'auto' });
store.writeHandoff(card);
const warm = warmStart(store, emptySession);
ok('auto 下新会话能温启动', typeof warm === 'string' && warm.includes('接续卡'), JSON.stringify(warm).slice(0, 60));

// 6) manual 也照用（写了就是为了用）
store.update({ handoffMode: 'manual' });
ok('manual 下写好的卡仍然注入', warmStart(store, emptySession) !== '');

// 7) off 不注入
store.update({ handoffMode: 'off' });
ok('off 下不注入', warmStart(store, emptySession) === '');

// 8) 清掉：卡 + 留档都没了
const before = store.handoff();
ok('清之前卡还在', !!(before && before.text));
const removed = store.clearHandoff();
ok('clearHandoff 报了卡 1 张', removed.card === 1, JSON.stringify(removed));
ok('clearHandoff 报了留档份数', typeof removed.archive === 'number' && removed.archive >= 1, JSON.stringify(removed));
ok('清完 handoff.json 没了', !existsSync(join(box, 'handoff.json')));
ok('清完 handoff/ 目录没了', !existsSync(join(box, 'handoff')));
ok('清完读不到卡', !store.handoff());
ok('清完不注入', warmStart(store, emptySession) === '');
ok('清完还能再写', (() => {
  store.writeHandoff(card);
  return !!store.handoff();
})());

// 9) 清卡不动别的东西
store.addMemory({ text: '接续卡清掉不影响记忆', level: 'fact' });
store.writeHandoff(card);
store.clearHandoff();
ok('清卡不动记忆', store.memories().some(item => /接续卡清掉不影响记忆/.test(item.text)));
ok('清卡不动人设', store.state().persona.name === '鱼露');

rmSync(box, { recursive: true, force: true });
console.log(failed ? `\n${failed} 项没过` : '\n全过');
process.exitCode = failed ? 1 : 0;
