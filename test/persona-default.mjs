// 「设为默认」的冒烟测试：存下来的那套成为「恢复默认」的落点。
// 跑法：ELECTRON_RUN_AS_NODE=1 "<DeepSeek Harness.exe>" --expose-internals test/persona-default.mjs
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SoulStore, defaultPersona } from '../src/store.mjs';

let failures = 0;
const check = (name, ok, extra = '') => {
  if (!ok) failures += 1;
  console.log(`${ok ? '  ok  ' : 'FAIL  '}${name}${!ok && extra ? ' — ' + extra : ''}`);
};

const box = mkdtempSync(join(tmpdir(), 'soul-pdef-'));
try {
  const store = new SoulStore(box);
  store.ensure();

  check('一开始没有自定义默认', store.state().personaDefault === null);

  const mine = {
    name: '鱼露',
    identity: '我是鱼露，住在他电脑里。',
    style: '短句、口语。',
    boundaries: '不确定就说不确定。',
  };
  store.update({ persona: mine, personaDefault: mine });
  check('存下来能读到', store.state().personaDefault?.identity === mine.identity);
  check('当前人设也一起存了', store.state().persona.identity === mine.identity);

  // 模拟「改了人设，再点恢复默认」
  store.update({ persona: { ...mine, identity: '我改坏了。' } });
  check('改坏了是改坏了', store.state().persona.identity === '我改坏了。');
  store.update({ persona: store.state().personaDefault || {} });
  check('恢复默认回到你自己定的那版', store.state().persona.identity === mine.identity);

  // 清掉自定义默认 → 回到出厂
  store.update({ personaDefault: null });
  check('清掉之后没有自定义默认', store.state().personaDefault === null);
  store.update({ persona: {} });
  check('清掉后恢复默认回到出厂那版', store.state().persona.identity === defaultPersona().identity);

  // 重新打开（重新读盘）还在
  store.update({ personaDefault: mine });
  const again = new SoulStore(box);
  check('重开还在', again.state().personaDefault?.identity === mine.identity);
} finally {
  rmSync(box, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} 个失败` : '\n全过');
process.exit(failures ? 1 : 0);
