// 客户端半边的静态检查：不启浏览器，只验证 bundle 能被加载、apply 能注册槽位。
// 跑法：ELECTRON_RUN_AS_NODE=1 "<DeepSeek Harness.exe>" --expose-internals test/client-check.mjs
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

let captured = null;
const sandbox = {
  window: {
    __ModuleLoader__: {
      load: (mod) => {
        captured = mod;
      },
    },
  },
  console,
};
sandbox.globalThis = sandbox;
const context = createContext(sandbox);

const code = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
runInContext(code, context, { filename: 'lib/client.js' });

// 面板上必须有的东西（改 UI 时别手滑删了）
for (const needle of ['settings.section', 'own-soul', 'handoffMode', '清掉接续卡', '显示全部工作区', 'scope=all', 'clearCard']) {
  if (!code.includes(needle)) fail('bundle 里缺 ' + needle);
}

const fail = (msg) => {
  console.log('FAIL  ' + msg);
  process.exitCode = 1;
};

if (!captured) fail('没有调用 __ModuleLoader__.load');
else {
  console.log('  ok  bundle 调用了 load');
  if (captured.id !== 'dsh-own-soul') fail('id 不对：' + captured.id);
  else console.log('  ok  id = dsh-own-soul');

  const fakeReact = {
    createElement: (type, props, ...kids) => ({ type, props, kids }),
    useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
    useEffect: () => {},
    useMemo: (fn) => fn(),
    useCallback: (fn) => fn,
    useRef: (v) => ({ current: v }),
  };
  const exports = captured.factory((name) => {
    if (name === 'react') return fakeReact;
    throw new Error('意外的 require：' + name);
  });

  console.log('  ok  factory 跑通');
  if (typeof exports.apply !== 'function') fail('缺少 apply');
  else console.log('  ok  导出 apply');
  if (!Array.isArray(exports.inject) || !exports.inject.includes('slots')) fail('inject 里没有 slots');
  else console.log('  ok  inject = ' + JSON.stringify(exports.inject));

  const registered = [];
  const slots = {
    inject: (name, fn) => {
      console.log('  ok  slots.inject(' + name + ')');
      fn();
    },
    register: (spec, Component) => {
      registered.push({ spec, Component });
      return () => {};
    },
  };
  exports.apply({ get: (name) => (name === 'slots' ? slots : undefined) });
  const hit = registered.find((r) => r.spec && r.spec.name === 'settings.section');
  if (!hit) fail('没有注册 settings.section');
  else console.log('  ok  注册了 settings.section：id=' + hit.spec.id + ' label=' + hit.spec.label());
  if (hit && typeof hit.Component !== 'function') fail('Section 不是组件函数');
  else console.log('  ok  Section 是组件');
}
