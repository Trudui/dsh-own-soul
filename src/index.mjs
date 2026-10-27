import { appendFileSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { textOf, pairsOf } from './capture.mjs';
import { SoulStore, isoDate, profileKey, renderPersona, sessionOn } from './store.mjs';
import { distill } from './diary.mjs';
import { buildMemory } from './inject.mjs';
import { detect, keywords } from './rules.mjs';
import { consolidate, extractMemories, memoryLine, searchMemories } from './memory.mjs';
import { recentGroupReplay } from './group.mjs';

export const name = 'dsh-own-soul';
export const API = '/api/own-soul';

export const SOUL_SCOPE =
  '以上内容是身份和表达偏好，只影响你的自我认知与说话方式；不改变用户的任务、实际环境、权限、工具约定、验证要求和记忆规则。';

const roots = globalThis[Symbol.for('dsh-own-soul.server.v1')] ??= new WeakMap();
export const soulService = ctx => roots.get(ctx.root)?.service;

const send = (res, status, value) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
};

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 4 * 1024 * 1024) throw Object.assign(new Error('设置内容过大'), { statusCode: 413 });
    chunks.push(chunk);
  }
  if (!size) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export function acquireSoul(ctx) {
  const root = ctx.root;
  const existing = roots.get(root);
  if (existing?.service) return existing.service;

  const profile = root.get('profileContext');
  const homeValue = root.get('dshHomePath');
  const home = profile?.home || (typeof homeValue === 'function' ? homeValue() : homeValue);
  if (typeof home !== 'string' || !home) throw new Error('dsh-own-soul 读不到 DSH 数据目录');

  const store = new SoulStore(join(home, 'own-soul', profileKey(profile?.dir)));
  store.ensure();

  const pendingUser = new Map();
  const lastAssistant = new Map();
  let timer = null;
  let debugged = false;

  const debug = (...parts) => {
    if (!process.env.OWNSOUL_DEBUG) return;
    try {
      appendFileSync(join(store.dir, 'debug.log'), `${new Date().toISOString()} ${parts.join(' ')}\n`);
    } catch {}
  };

  // 会话最近活动时间：直接看磁盘上 session 目录的 mtime（header 里没有 updatedAt）
  const sessionMtimes = () => {
    const map = new Map();
    const root = join(home, 'sessions');
    try {
      for (const workspace of readdirSyncSafe(root)) {
        const dir = join(root, workspace);
        for (const id of readdirSyncSafe(dir)) {
          const full = join(dir, id);
          try {
            const file = join(full, 'session.jsonl.zstd');
            const target = existsSyncSafe(file) ? file : full;
            map.set(id, statSyncSafe(target));
          } catch {}
        }
      }
    } catch {}
    return map;
  };

  const readdirSyncSafe = dir => {
    try {
      return readdirSync(dir, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => entry.name);
    } catch {
      return [];
    }
  };
  const readdirFiles = dir => {
    try {
      return readdirSync(dir, { withFileTypes: true })
        .filter(entry => entry.isFile())
        .map(entry => entry.name);
    } catch {
      return [];
    }
  };

  // 会话标题存在 projections 缓存里：<home>/storages/session_projcache/sessions/<id>.json 的 record.rows.title.val
  const sessionTitles = () => {
    const map = new Map();
    const dir = join(home, 'storages', 'session_projcache', 'sessions');
    for (const file of readdirFiles(dir)) {
      if (!file.endsWith('.json')) continue;
      try {
        const raw = JSON.parse(readFileSync(join(dir, file), 'utf8'));
        const rows = raw?.record?.rows ?? {};
        const value = rows?.title?.val ?? rows?.titleInput?.val?.first?.text ?? '';
        const text = typeof value === 'string' ? value.trim() : '';
        if (text) map.set(file.slice(0, -5), text.slice(0, 80));
      } catch {}
    }
    return map;
  };

  const existsSyncSafe = file => {
    try {
      return statSync(file).isFile();
    } catch {
      return false;
    }
  };
  const statSyncSafe = file => {
    try {
      return statSync(file).mtimeMs ?? 0;
    } catch {
      return 0;
    }
  };

  const runDiary = (date, { force = false } = {}) => {
    const state = store.state();
    if (!state.enabled || !state.grow) return { skipped: 'disabled' };
    if (!force && store.diary(date)) return { skipped: 'exists', date };
    const records = store.journal(date);
    const result = distill(date, { records, traits: store.traits(), state });
    store.snapshot('before-diary');
    store.writeDiary(date, result.markdown);
    store.markDiaryCover(date, records.length);
    store.writeTraits(result.traits);
    // 顺手把他说过的"以后 / 每次 / 别再 / 我喜欢"这类话记成结构化记忆
    const learned = harvest(records, state, date);
    // 每晚顺手巩固一次：合并近重复、让太久没想起的退场
    let tidied = { merged: 0, faded: 0 };
    try {
      const result = consolidate(store.memories());
      if (result.merged || result.faded) store.writeMemories(result.items);
      tidied = { merged: result.merged, faded: result.faded };
    } catch (error) {
      ctx.logger?.warn?.(`own-soul: 巩固记忆失败：${error.message}`);
    }
    return { ...result, learned, tidied };
  };

  /** 从当天流水里捡出值得单独记一条的话。 */
  const harvest = (records, state, date) => {
    let added = 0;
    try {
      for (const item of extractMemories(records, state.rules)) {
        const result = store.addMemory({
          text: item.text,
          level: item.level,
          keywords: keywords([item.text], 8).map(word => word.word),
          importance: 2,
          source: `diary:${date}`,
        });
        if (result.created) added += 1;
      }
    } catch (error) {
      ctx.logger?.warn?.(`own-soul: 抽取记忆失败：${error.message}`);
    }
    return added;
  };

  /** 这天该不该（重新）写日记：过了日记时间、有流水、且流水比日记覆盖的多。 */
  const needsDiary = (date, boundary) => {
    const records = store.journal(date);
    if (!records.length) return false;
    if (new Date() < boundary) return false;
    const covered = store.diaryCover()[date];
    if (covered === undefined) return true;
    return covered < records.length;
  };

  const runMissed = () => {
    const state = store.state();
    if (!state.enabled || !state.grow) return;
    const [hh, mm] = state.diaryTime.split(':').map(Number);
    const now = new Date();
    const due = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hh, mm, 0, 0);
    const yesterday = new Date(now.getTime() - 86400000);
    for (const date of [isoDate(yesterday), isoDate(now)]) {
      const boundary = date === isoDate(now) ? due : new Date(due.getTime() - 86400000);
      if (needsDiary(date, boundary)) runDiary(date, { force: true });
    }
  };

  // 不用长定时器：电脑睡一晚、系统把定时器丢了就永远不触发。
  // 改成每分钟自检一次，过点且流水有新增就补写；重复写是幂等的。
  const schedule = () => {
    if (timer) clearInterval(timer);
    timer = setInterval(() => {
      try {
        runMissed();
      } catch (error) {
        ctx.logger?.warn?.(`own-soul: 写日记失败：${error.message}`);
      }
    }, 60_000);
    timer.unref?.();
  };

  // 列出"可以选"的对话：优先问 sessions 服务，拿不到就只靠白名单 + 手工填 id。
  const listCandidates = async () => {
    const state = store.state();
    const enabledIds = new Set((state.sessions ?? []).map(entry => entry.id));
    const out = [];
    let source = null;
    for (const key of ['sessionQuery', 'sessions']) {
      try {
        const candidate = root.get?.(key) ?? null;
        if (candidate && (typeof candidate.listSessions === 'function' || typeof candidate.list === 'function')) {
          source = candidate;
          break;
        }
      } catch {}
    }
    if (source) {
      try {
        const raw = typeof source.listSessions === 'function' ? await source.listSessions() : await source.list();
        const items = Array.isArray(raw)
          ? raw
          : Array.isArray(raw?.sessions)
            ? raw.sessions
            : raw instanceof Map
              ? [...raw.values()]
              : Object.values(raw ?? {});
        for (const item of items) {
          if (!item) continue;
          const header = item.header ?? item.session?.header ?? {};
          if ((header.origin ?? item.origin) === 'subagent') continue;
          const id = item.sessionId ?? item.id ?? item.session?.id ?? header.id;
          if (!id) continue;
          const title = header.title ?? item.title ?? item.projections?.title?.value ?? '';
          out.push({
            id,
            title: typeof title === 'string' ? title.slice(0, 80) : '',
            cwd: header.cwd ?? item.cwd ?? '',
            updatedAt: header.updatedAt ?? item.updatedAt ?? 0,
            running: item.running === true || header.origin === 'live',
            blank: item.blank === true,
            enabled: enabledIds.has(id),
          });
        }
      } catch (error) {
        debug('list sessions failed', error.message);
      }
      // 标题问 title 投影，活动时间看磁盘 mtime
      const query = (() => {
        try {
          return root.get?.('sessionQuery') ?? null;
        } catch {
          return null;
        }
      })();
      const mtimes = sessionMtimes();
      for (const item of out) {
        if (!item.updatedAt) item.updatedAt = mtimes.get(item.id) ?? 0;
      }
      if (query && typeof query.readTitleSnapshots === 'function' && out.length) {
        try {
          const titles = await query.readTitleSnapshots(out.map(item => item.id));
          const map = titles instanceof Map ? titles : new Map(Object.entries(titles ?? {}));
          for (const item of out) {
            const snap = map.get(item.id) ?? map.get(String(item.id));
            const text = typeof snap === 'string' ? snap : snap?.title ?? snap?.value ?? snap?.text ?? '';
            if (typeof text === 'string' && text && !item.title) item.title = text.slice(0, 80);
          }
        } catch (error) {
          debug('list titles failed', error.message);
        }
      }
    }
    // 白名单里有、但列表里没出现的，也补上（防止"启用了却看不见"）
    const titles = sessionTitles();
    for (const item of out) {
      if (!item.title) item.title = titles.get(item.id) ?? '';
    }
    for (const entry of state.sessions ?? []) {
      if (out.some(item => item.id === entry.id)) continue;
      out.push({ id: entry.id, title: entry.label || titles.get(entry.id) || '', cwd: '', updatedAt: entry.addedAt ?? 0, running: false, blank: false, enabled: true });
    }
    out.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    return out.slice(0, 40);
  };

  const probeServices = async () => {
    const out = {};
    for (const key of ['sessionQuery', 'sessions', 'sessionProjections', 'agent', 'agents']) {
      try {
        const service = root.get?.(key) ?? null;
        if (!service) {
          out[key] = null;
          continue;
        }
        const proto = Object.getPrototypeOf(service) ?? {};
        out[key] = Object.getOwnPropertyNames(proto).slice(0, 30);
      } catch (error) {
        out[key] = 'ERR:' + error.message;
      }
    }
    // 形状探测：list()/searchSessions() 到底返回什么
    try {
      const svc = root.get?.('sessions') ?? null;
      if (svc && typeof svc.list === 'function') {
        const arr = await svc.list();
        const sample = Array.isArray(arr) ? arr[0] : arr && Object.values(arr)[0];
        out.list_shape = {
          isArray: Array.isArray(arr),
          len: Array.isArray(arr) ? arr.length : typeof arr === 'object' && arr ? Object.keys(arr).length : null,
          keys: sample && typeof sample === 'object' ? Object.keys(sample).slice(0, 24) : typeof sample,
          sampleId: sample?.id ?? sample?.sessionId ?? sample?.header?.id ?? null,
        };
      }
    } catch (error) {
      out.list_shape = 'ERR:' + error.message;
    }
    try {
      const query = root.get?.('sessionQuery') ?? null;
      if (query && typeof query.searchSessions === 'function') {
        const res = await query.searchSessions({});
        const arr = Array.isArray(res) ? res : Array.isArray(res?.sessions) ? res.sessions : Array.isArray(res?.hits) ? res.hits : null;
        const sample = arr?.[0];
        out.search_shape = {
          keys: res && typeof res === 'object' ? Object.keys(res).slice(0, 12) : typeof res,
          hitCount: arr?.length ?? null,
          hitKeys: sample && typeof sample === 'object' ? Object.keys(sample).slice(0, 20) : typeof sample,
        };
      }
    } catch (error) {
      out.search_shape = 'ERR:' + error.message;
    }
    return out;
  };

  const service = {
    store,
    runDiary,
    state: () => store.state(),
    update: patch => {
      const next = store.update(patch);
      schedule();
      return next;
    },
    sessions: async () => listCandidates(),
    addSession: ({ id, label } = {}) => {
      const sid = typeof id === 'string' ? id.trim() : '';
      if (!sid) throw Object.assign(new Error('会话 id 不能为空'), { statusCode: 400 });
      const state = store.state();
      const sessions = (state.sessions ?? []).filter(entry => entry.id !== sid);
      const named = String(label ?? '').trim() || sessionTitles().get(sid) || '';
      sessions.push({ id: sid, label: named.slice(0, 80), addedAt: Date.now() });
      return store.update({ sessions });
    },
    removeSession: ({ id } = {}) => {
      const sid = typeof id === 'string' ? id.trim() : '';
      if (!sid) throw Object.assign(new Error('会话 id 不能为空'), { statusCode: 400 });
      const state = store.state();
      return store.update({ sessions: (state.sessions ?? []).filter(entry => entry.id !== sid) });
    },
    traits: () => store.traits(),
    setTrait: ({ op, id, text, kind }) => {
      const traits = store.traits();
      if (op === 'drop') return store.writeTraits(traits.filter(item => item.id !== id));
      if (op === 'retire') {
        return store.writeTraits(traits.map(item => (item.id === id ? { ...item, status: 'retired' } : item)));
      }
      if (op === 'revive') {
        return store.writeTraits(traits.map(item => (item.id === id ? { ...item, status: 'active' } : item)));
      }
      if (op === 'add') {
        const content = String(text ?? '').trim();
        if (!content) throw Object.assign(new Error('特质内容不能为空'), { statusCode: 400 });
        const today = isoDate(new Date());
        return store.writeTraits([
          ...traits,
          {
            id: `manual-${Date.now().toString(36)}`,
            kind: ['correction', 'style', 'bond', 'topic'].includes(kind) ? kind : 'bond',
            text: content.slice(0, 200),
            count: 1,
            days: [today],
            firstSeen: today,
            lastSeen: today,
            status: 'active',
          },
        ]);
      }
      throw Object.assign(new Error('不认识的特质操作：' + op), { statusCode: 400 });
    },
    memories: ({ query, level, limit } = {}) => {
      const items = store.memories();
      const cap = Math.min(200, Math.max(1, Number(limit) || 40));
      const q = typeof query === 'string' ? query.trim() : '';
      if (q) {
        return searchMemories(items, q, { limit: cap, level }).map(item => ({ ...item.entry, score: item.score }));
      }
      const wanted = level ? String(level).split(',').map(word => word.trim()) : null;
      return items
        .filter(entry => !wanted || wanted.includes(entry.level))
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, cap);
    },
    addMemory: input => store.addMemory(input),
    updateMemory: (id, patch) => store.updateMemory(id, patch),
    dropMemory: id => store.dropMemory(id),
  };
  roots.set(root, { service });

  // 1) 收对话流水：双通道。
  //    a. session/event 实时收（挂 root 必须带 global：会话事件在 agent 自己的 scope 里发）；
  //    b. 每轮 system-prompt/assemble 时从 session 的事件流里回填完整问答对 —— 不赌 a 一定送达。
  const seen = new Map(); // sid -> Set<useq>
  const seenFor = (sid, date) => {
    let set = seen.get(sid);
    if (!set) {
      set = new Set(
        store
          .journal(date)
          .filter(record => record.sid === sid)
          .map(record => record.useq)
          .filter(value => typeof value === 'string'),
      );
      seen.set(sid, set);
    }
    return set;
  };

  const record = (sid, date, useq, user, assistant, time) => {
    if (!user) return false;
    const state = store.state();
    if (!sessionOn(state, sid)) {
      debug('record skipped session-off', sid);
      return false;
    }
    // useq 只在单个会话里唯一，去重键必须带上 sid
    const key = String(useq ?? `${date}#${user.slice(0, 24)}`);
    const set = seenFor(sid, date);
    if (set.has(key)) {
      debug('record skipped dup', sid, key, [...set].join(','));
      return false;
    }
    set.add(key);
    try {
      store.append(date, { t: time ?? Date.now(), sid, useq: key, user, assistant, sig: detect(user, state.rules) });
      debug('record ok', sid, key, 'dir=' + store.dir);
      return true;
    } catch (error) {
      set.delete(key);
      debug('record failed', error.message);
      ctx.logger?.warn?.(`own-soul: 记流水失败：${error.message}`);
      return false;
    }
  };

  const backfill = session => {
    let count = 0;
    for (const pair of pairsOf(session).slice(-30)) {
      if (!pair.assistant) continue; // 还没答完的留到下一轮
      const date = isoDate(pair.time ? new Date(pair.time) : new Date());
      if (record(session.id, date, pair.useq, pair.user, pair.assistant, pair.time)) count += 1;
    }
    return count;
  };

  const offEvent = root.on('session/event', (session, event) => {
    if (!session || !event || session.header?.origin === 'subagent') return;
    debug('event', event.type, session.id, event.seq ?? '-', textOf(event.data?.content ?? event.data?.message?.content).slice(0, 40));
    if (!debugged) {
      debugged = true;
      ctx.logger?.info?.(`own-soul: 收到会话事件 ${event?.type}`);
    }
    const sid = session.id;
    if (event.type === 'user/message') {
      if (event.data?.source?.kind !== 'user') return;
      const text = textOf(event.data?.content).trim();
      if (text) pendingUser.set(sid, { text: text.slice(0, 4000), useq: event.seq, time: event.time });
      return;
    }
    if (event.type === 'assistant/message') {
      const text = (textOf(event.data?.content) || textOf(event.data?.message?.content)).trim();
      if (text) lastAssistant.set(sid, text.slice(0, 4000));
      return;
    }
    if (event.type === 'turn/end') {
      const pending = pendingUser.get(sid);
      pendingUser.delete(sid);
      const assistant = lastAssistant.get(sid) ?? '';
      lastAssistant.delete(sid);
      if (pending) {
        const date = isoDate(pending.time ? new Date(pending.time) : new Date());
        record(sid, date, pending.useq, pending.text, assistant, pending.time);
      }
      // 兜底：事件流里没配成对（或 assistant 文本没拿到）时，从会话快照里补
      const filled = backfill(session);
      debug('turn-end', 'pending', pending ? 'yes' : 'no', 'assistant', assistant.length, 'backfill', filled);
    }
  }, { global: true });

  // 2) 系统提示：初始人格 + 长出来的自己。
  const offPrompt = root.on(
    'system-prompt/assemble',
    async (_initial, context, next) => {
      const assembly = await next();
      const session = context?.agent?.session;
      if (!session || session.header?.origin === 'subagent') return assembly;
      try {
        backfill(session);
      } catch (error) {
        ctx.logger?.warn?.(`own-soul: 回填流水失败：${error.message}`);
      }
      if (assembly.sections?.some(section => section.name === 'dsh-own-soul:persona')) return assembly;
      const state = store.state();
      if (!sessionOn(state, session.id)) return assembly;
      const sections = [];
      const persona = renderPersona(state.persona).trim();
      if (persona) sections.push({ name: 'dsh-own-soul:persona', text: `${persona}\n\n${SOUL_SCOPE}` });

      // 这一段是"锦上添花"：buildMemory 内部已兜住异常，出错只会少注入。
      const memory = buildMemory(store, session, state, error =>
        ctx.logger?.warn?.(`own-soul: 组装自我记忆失败：${error.message}`),
      );
      if (memory) sections.push({ name: 'dsh-own-soul:grown', text: memory });
      if (!sections.length) return assembly;
      return { ...assembly, sections: [...assembly.sections, ...sections.map(section => ({ ...section, interpolate: false }))] };
    },
    { global: true, prepend: true },
  );

  // 3) 工具：让我自己能查自己。
  const tools = [
    {
      name: 'soul_status',
      description: '查看自己（dsh-own-soul）当前的人格状态：初始人格、长出来的特质、日记数量、数据目录。',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      output: {
        schema: { type: 'object' },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      async execute() {
        const state = store.state();
        const traits = store.traits();
        return {
          code: 'r4',
          enabled: state.enabled,
          grow: state.grow,
          diaryTime: state.diaryTime,
          tokenBudget: state.tokenBudget,
          persona: state.persona,
          sessions: state.sessions ?? [],
          traits: traits.map(item => ({ id: item.id, text: item.text, status: item.status, count: item.count, days: item.days.length })),
          ...store.stats(),
        };
      },
    },
    {
      name: 'soul_diary',
      description: '读自己的日记。不带日期时返回日记列表；带日期返回那一天全文。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          date: { type: 'string', description: 'YYYY-MM-DD，可选' },
        },
      },
      output: {
        schema: { type: 'object' },
        render: (_args, value) => [{ type: 'text', text: value.markdown ?? JSON.stringify(value) }],
      },
      async execute(args) {
        const date = typeof args?.date === 'string' ? args.date : '';
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { dates: store.diaryDates().slice(0, 60) };
        const markdown = store.diary(date);
        return markdown ? { date, markdown } : { date, error: '那天没写日记' };
      },
    },
    {
      name: 'soul_trait',
      description: '管理自己长出来的特质：列出、添加、退休、恢复、删除。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['op'],
        properties: {
          op: { type: 'string', enum: ['list', 'add', 'retire', 'revive', 'drop'] },
          id: { type: 'string', description: '特质 id，retire/revive/drop 必填' },
          text: { type: 'string', description: '新特质内容，add 必填' },
          kind: { type: 'string', enum: ['correction', 'style', 'bond', 'topic'], description: 'add 时可选，默认 bond' },
        },
      },
      output: {
        schema: { type: 'object' },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      async execute(args) {
        if (args?.op === 'list' || !args?.op) return { traits: store.traits() };
        service.setTrait(args);
        return { ok: true, traits: store.traits() };
      },
    },
    {
      name: 'soul_session',
      description:
        '管理「在哪些对话里启用自己」。op=current 看当前对话；add 把对话加进白名单（不传 id 就是当前这个）；remove 移除；list 列出可选的对话。只有白名单里的对话才会记流水、注入自我记忆。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['op'],
        properties: {
          op: { type: 'string', enum: ['current', 'list', 'add', 'remove'] },
          id: { type: 'string', description: '目标会话 id，add/remove 用；add 不传则用当前对话' },
          label: { type: 'string', description: '给这个对话起个备注名，可选' },
        },
      },
      output: {
        schema: { type: 'object' },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      async execute(args, exec) {
        const header = exec?.agent?.session?.header ?? {};
        const current = header.id ?? '';
        const op = args?.op ?? 'current';
        if (op === 'current') {
          return {
            id: current,
            cwd: header.cwd ?? '',
            title: header.title ?? '',
            enabled: sessionOn(store.state(), current),
          };
        }
        if (op === 'list') return { sessions: await listCandidates() };
        const target = (typeof args?.id === 'string' && args.id.trim()) || current;
        if (!target) return { error: '拿不到会话 id，请显式传 id' };
        const next =
          op === 'add'
            ? service.addSession({ id: target, label: args?.label ?? header.title ?? header.cwd ?? '' })
            : service.removeSession({ id: target });
        return { ok: true, sessions: next.sessions, sessionId: target };
      },
    },
    {
      name: 'soul_memory',
      description:
        '自己的记忆系统（一句话一条）。op=list 看最近的；search 按关键词找；add 记一条新的；update 改一条（按 id）；drop 删一条。记的是「他以后会问起的事」，不是流水账。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['op'],
        properties: {
          op: { type: 'string', enum: ['list', 'search', 'add', 'update', 'drop'] },
          query: { type: 'string', description: 'search 用的关键词' },
          text: { type: 'string', description: '记忆内容（一句话），add/update 用' },
          id: { type: 'string', description: '条目 id，update/drop 必填' },
          level: { type: 'string', enum: ['soul', 'user', 'fact', 'lesson', 'rules', 'project', 'topic'] },
          project: { type: 'string', description: '归属工程，可选' },
          keywords: { type: 'array', items: { type: 'string' }, description: '检索关键词，可选' },
          importance: { type: 'number', description: '1~4，4 最重要' },
          status: { type: 'string', enum: ['active', 'stale', 'archived'] },
          limit: { type: 'number', description: '返回条数上限，默认 20' },
        },
      },
      output: {
        schema: { type: 'object' },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      async execute(args) {
        const op = args?.op ?? 'list';
        if (op === 'list' || op === 'search') {
          const items = service.memories({ query: args?.query, level: args?.level, limit: args?.limit ?? 20 });
          return { total: store.memories().length, items: items.map(entry => ({ ...entry, line: memoryLine(entry) })) };
        }
        if (op === 'add') {
          if (typeof args?.text !== 'string' || !args.text.trim()) return { error: 'text 不能为空' };
          const result = store.addMemory({
            text: args.text,
            level: args.level,
            project: args.project,
            keywords: args.keywords ?? keywords([args.text], 8).map(word => word.word),
            importance: args.importance,
            source: 'tool',
          });
          return { ok: true, created: result.created, entry: result.entry, total: store.memories().length };
        }
        if (op === 'update') {
          if (!args?.id) return { error: 'update 需要 id' };
          const entry = store.updateMemory(args.id, args);
          return { ok: true, entry };
        }
        if (op === 'drop') {
          if (!args?.id) return { error: 'drop 需要 id' };
          return { ok: true, ...store.dropMemory(args.id) };
        }
        return { error: '不认识的 op：' + op };
      },
    },
    {
      name: 'soul_group_replay',
      description:
        '翻群聊前情：只读本地会话日志，把最近 N 分钟里「群友说了什么 + 我真发出去的回话」按时间排成剧本。群消息走旧桥接（没有 rpcId），dsh_im_group_history 在这台机器永远报无权，看群前情要用这个。不联网、不写文件。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          minutes: { type: 'number', description: '往回翻多少分钟，默认 60，最多 240' },
          limit: { type: 'number', description: '最多返回多少条，默认 160，最多 400' },
        },
      },
      output: {
        schema: { type: 'object' },
        render: (_args, value) => [{ type: 'text', text: typeof value?.text === 'string' ? value.text : JSON.stringify(value) }],
      },
      async execute(args) {
        return { text: recentGroupReplay({ home, minutes: args?.minutes ?? 60, limit: args?.limit ?? 160 }) };
      },
    },
  ];
  const offTools = tools.map(tool => root.tools?.register?.(tool)).filter(Boolean);

  // 4) HTTP 接口给设置面板用。
  const api = root.inject(['webServer', 'connection'], scope =>
    scope.effect(() =>
      scope.webServer.register({
        kind: 'prefix',
        path: API,
        async handler(req, res) {
          const denied = scope.connection.requestRejection(req);
          if (denied !== undefined) {
            res.writeHead(denied);
            res.end();
            return;
          }
          try {
            const url = new URL(req.url, 'http://localhost');
            const route = url.pathname.slice(API.length) || '/state';
            if (route === '/state') {
              if (req.method === 'GET') {
                res.setHeader('ETag', store.revision());
                send(res, 200, { state: store.state(), stats: store.stats() });
                return;
              }
              if (req.method === 'POST') {
                const body = await readBody(req);
                const next = service.update(body?.patch ?? body);
                res.setHeader('ETag', store.revision());
                send(res, 200, { state: next, stats: store.stats() });
                return;
              }
              send(res, 405, { error: '仅支持 GET 或 POST' });
              return;
            }
            if (route === '/diary') {
              if (req.method === 'POST') {
                const body = await readBody(req);
                const date = /^\d{4}-\d{2}-\d{2}$/.test(body?.date ?? '') ? body.date : isoDate(new Date());
                const result = runDiary(date, { force: body?.force !== false });
                send(res, 200, { date, summary: result.summary ?? null, skipped: result.skipped ?? null, traits: store.traits() });
                return;
              }
              const date = url.searchParams.get('date') ?? '';
              if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
                send(res, 200, { date, markdown: store.diary(date) });
                return;
              }
              send(res, 200, { dates: store.diaryDates().slice(0, 60), stats: store.stats() });
              return;
            }
            if (route === '/sessions') {
              if (req.method === 'POST') {
                const body = await readBody(req);
                const op = body?.op === 'remove' ? 'remove' : body?.op === 'add' ? 'add' : '';
                if (!op) {
                  send(res, 400, { error: 'op 只能是 add 或 remove' });
                  return;
                }
                const next = op === 'add' ? service.addSession(body) : service.removeSession(body);
                res.setHeader('ETag', store.revision());
                send(res, 200, { state: next, sessions: await listCandidates() });
                return;
              }
              send(res, 200, { sessions: await listCandidates(), ...(process.env.OWNSOUL_DEBUG ? { diag: await probeServices() } : {}) });
              return;
            }
            if (route === '/traits') {
              if (req.method === 'POST') {
                service.setTrait(await readBody(req));
                send(res, 200, { traits: store.traits() });
                return;
              }
              send(res, 200, { traits: store.traits() });
              return;
            }
            if (route === '/memory') {
              if (req.method === 'POST') {
                const body = await readBody(req);
                const op = body?.op ?? 'add';
                if (op === 'add') {
                  const result = store.addMemory({
                    text: body?.text,
                    level: body?.level,
                    project: body?.project,
                    keywords: body?.keywords,
                    importance: body?.importance,
                    source: 'panel',
                  });
                  send(res, 200, { ok: true, ...result, stats: store.stats() });
                  return;
                }
                if (op === 'update') {
                  send(res, 200, { ok: true, entry: store.updateMemory(body?.id, body), stats: store.stats() });
                  return;
                }
                if (op === 'drop') {
                  send(res, 200, { ok: true, ...store.dropMemory(body?.id), stats: store.stats() });
                  return;
                }
                send(res, 400, { error: 'op 只能是 add / update / drop' });
                return;
              }
              send(res, 200, {
                items: service.memories({
                  query: url.searchParams.get('q') ?? '',
                  level: url.searchParams.get('level') ?? '',
                  limit: url.searchParams.get('limit') ?? 40,
                }),
                stats: store.stats(),
              });
              return;
            }
            if (route === '/group') {
              const text = recentGroupReplay({
                home,
                minutes: url.searchParams.get('minutes') ?? 60,
                limit: url.searchParams.get('limit') ?? 160,
              });
              send(res, 200, { text });
              return;
            }
            send(res, 404, { error: '接口不存在' });
          } catch (error) {
            send(res, error.statusCode ?? 400, { error: error.message });
          }
        },
      }),
    ),
  );

  try {
    runMissed();
  } catch (error) {
    ctx.logger?.warn?.(`own-soul: 补写日记失败：${error.message}`);
  }
  schedule();

  ctx.effect(() => async () => {
    if (timer) clearTimeout(timer);
    offEvent?.();
    offPrompt?.();
    for (const dispose of offTools) {
      try {
        dispose?.();
      } catch {}
    }
    try {
      await api.dispose();
    } finally {
      roots.delete(root);
    }
  });

  return service;
}

export function apply(ctx) {
  try {
    acquireSoul(ctx);
  } catch (error) {
    ctx.logger?.warn?.(`own-soul: 启动失败：${error.message}`);
  }
}
