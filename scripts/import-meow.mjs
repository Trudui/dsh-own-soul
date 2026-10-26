// 把 meow-memory 的 SQLite 记忆搬进 own-soul 的 memory.json。
// 用法：ELECTRON_RUN_AS_NODE=1 "<DSH exe>" --expose-internals scripts/import-meow.mjs <memory.db> [storeDir] [--dry]
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { SoulStore } from '../src/store.mjs';
import { mergeEntries, newEntry } from '../src/memory.mjs';

const LEVELS = ['soul', 'user', 'fact', 'lesson', 'rules', 'project', 'topic'];

const args = process.argv.slice(2);
const dbPath = args.find(arg => arg.endsWith('.db'));
const dry = args.includes('--dry');
const storeArg = args.find(arg => !arg.startsWith('--') && !arg.endsWith('.db'));

if (!dbPath || !existsSync(dbPath)) {
  console.error('用法：scripts/import-meow.mjs <memory.db> [storeDir] [--dry]');
  process.exit(2);
}

const raw = (value) => {
  if (typeof value !== 'string' || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return value.split(/[,，、\s]+/).filter(Boolean);
  }
};

const db = new DatabaseSync(dbPath);
const incoming = [];
const counts = {};

for (const level of LEVELS) {
  let rows = [];
  try {
    rows = db.prepare(`select * from "${level}"`).all();
  } catch {
    continue;
  }
  counts[level] = rows.length;
  for (const row of rows) {
    const text = String(row.content ?? '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    incoming.push(
      newEntry({
        text,
        level,
        project: typeof row.project === 'string' && row.project !== '全局' ? row.project : '',
        keywords: raw(row.keywords),
        importance: row.importance ?? 2,
        status: row.status === 'archived' ? 'archived' : row.status === 'stale' ? 'stale' : 'active',
        source: row.source_session ? `meow:${String(row.source_session).slice(0, 24)}` : 'meow',
        createdAt: Number.isFinite(row.created_at) ? row.created_at : Date.now(),
        updatedAt: Number.isFinite(row.updated_at) ? row.updated_at : Date.now(),
        hit: row.hit_count ?? 0,
      }),
    );
  }
}

console.log('读到：', JSON.stringify(counts), '共', incoming.length, '条');

if (!storeArg) {
  console.log('（没给 storeDir，只做统计）');
  process.exit(0);
}

const store = new SoulStore(storeArg);
store.ensure();
const existing = store.memories();
const result = mergeEntries(existing, incoming);
console.log(`合并结果：新增 ${result.added}，重复 ${result.merged}，总计 ${result.items.length}`);
if (dry) {
  console.log('--dry：没有写盘');
  process.exit(0);
}
store.writeMemories(result.items);
console.log('已写入', store.memoryFile);
