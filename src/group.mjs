// 群聊回放：只读本地会话日志，把「群里谁说了什么 + 我真发出去的回话」还原成短剧本。
//
// 为什么不用 dsh_im_group_history：群消息走旧桥接（source.kind === 'qq'，没有 rpcId），
// @xmanrui/dsh-im 的授权兑换永远失败，那工具在这台机器上必然报 unauthorized。
// 这里不碰网络、不碰桥接，只读 $DSH_HOME 下的会话日志，纯解析。
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const BOILER = /^（这台机器只把正文里/;
const IMAGE_HINT = /^（群里的人发了 (\d+) 张图：.*$/;
const IMAGE_ONLY = /^（群里的人发来了图片，没有配字）$/;

export const MAX_MINUTES = 240;
export const MAX_LIMIT = 400;

/** 目录列举，失败就当空。 */
export function listDirs(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
}

/** 会话日志是多帧 zstd：按 magic 切帧逐段解压，坏帧跳过。 */
export function readSessionLog(file) {
  let buf;
  try {
    buf = readFileSync(file);
  } catch {
    return [];
  }
  const offsets = [];
  let idx = buf.indexOf(ZSTD_MAGIC, 0);
  while (idx !== -1) {
    offsets.push(idx);
    idx = buf.indexOf(ZSTD_MAGIC, idx + 4);
  }
  const parts = [];
  for (let i = 0; i < offsets.length; i += 1) {
    const slice = buf.subarray(offsets[i], i + 1 < offsets.length ? offsets[i + 1] : buf.length);
    try {
      parts.push(zstdDecompressSync(slice).toString('utf8'));
    } catch {
      /* 半帧 */
    }
  }
  const events = [];
  for (const line of parts.join('').split('\n')) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      /* 残行 */
    }
  }
  return events;
}

function textOf(content) {
  if (!Array.isArray(content)) return '';
  return content.filter((part) => part?.type === 'text').map((part) => part.text).join('\n');
}

/** 去掉桥接加的那行「只发 [QQ] 那段」的说明，图片提示压缩成一句。 */
export function cleanGroupText(text) {
  return text
    .split('\n')
    .filter((line) => !BOILER.test(line.trim()))
    .map((line) => {
      const hit = IMAGE_HINT.exec(line.trim());
      return hit ? `［发了 ${hit[1]} 张图］` : line;
    })
    .filter((line) => !IMAGE_ONLY.test(line.trim()))
    .join('\n')
    .trim();
}

/** assistant 文本里只取 [QQ] 之间那段（才是真的发到群里的）。 */
export function sentPart(text) {
  const hit = /\[QQ\]([\s\S]*?)\[\/QQ\]/.exec(text);
  return hit ? hit[1].trim().replace(/\n+/g, ' ') : '';
}

/** 桥接配置里写着的「群会话」是哪个 id。 */
export function groupSessionId(home) {
  try {
    const cfg = JSON.parse(readFileSync(join(home, 'qq-bridge-config.json'), 'utf8'));
    return typeof cfg['群会话'] === 'string' ? cfg['群会话'] : '';
  } catch {
    return '';
  }
}

/** 在 $DSH_HOME/sessions/<workspace>/<sid>/session.v4.jsonl.zstd 里找该会话。 */
export function findSessionFile(home, sid) {
  const root = join(home, 'sessions');
  for (const workspace of listDirs(root)) {
    const wsDir = join(root, workspace);
    const dirs = listDirs(wsDir);
    for (const name of dirs) {
      if (sid && !name.includes(sid)) continue;
      const file = join(wsDir, name, 'session.v4.jsonl.zstd');
      if (existsSync(file)) return { file, sid: name, workspace };
    }
  }
  return null;
}

/**
 * 把事件流折成剧本行。
 * @returns {{ when:number, who:string, text:string }[]}
 */
export function replayRows(events, { since, selfQQ = '1435065373' } = {}) {
  const rows = [];
  for (const event of events) {
    const when = Number(event?.time ?? event?.timestamp ?? 0);
    if (!when || (since && when < since)) continue;
    const data = event?.data;

    if (event?.type === 'user/message' && data?.source?.kind === 'qq') {
      const body = cleanGroupText(textOf(data.content));
      if (!body) continue;
      const firstLine = body.split('\n')[0];
      // 自己说的话被桥接回灌成入站消息，丢掉（真发出去的那份由 assistant 记）
      if (firstLine.includes(`（${selfQQ}）`)) continue;
      rows.push({ when, who: firstLine, text: body.slice(firstLine.length).trim() });
      continue;
    }

    if (event?.type === 'assistant/message') {
      const body = sentPart(textOf(data?.message?.content ?? data?.content));
      if (!body) continue;
      rows.push({ when, who: '我', text: body });
    }
  }
  rows.sort((a, b) => a.when - b.when);
  return rows;
}

const hhmmss = (ms) => new Date(ms).toLocaleTimeString('zh-CN', { hour12: false });

/**
 * 主入口：最近 minutes 分钟的群聊剧本（纯文本）。
 * 任何一步失败都返回一句人话，不抛。
 */
export function recentGroupReplay({ home, minutes = 60, limit = 160, selfQQ = '1435065373' } = {}) {
  try {
    const span = Math.min(Math.max(Number(minutes) || 60, 1), MAX_MINUTES);
    const cap = Math.min(Math.max(Number(limit) || 160, 1), MAX_LIMIT);
    const sid = groupSessionId(home);
    if (!sid) return '没在 qq-bridge-config.json 里找到「群会话」，翻不了。';
    const found = findSessionFile(home, sid);
    if (!found) return `找到了群会话 id（${sid}），但本地没有它的日志文件。`;

    const rows = replayRows(readSessionLog(found.file), { since: Date.now() - span * 60_000, selfQQ });
    const picked = rows.length > cap ? rows.slice(-cap) : rows;
    const head = `# 群聊回放 · 最近 ${span} 分钟（${picked.length} 条 / 全量 ${rows.length} 条）`;
    if (!picked.length) return `${head}\n\n（这段时间群里没人说话，也没人艾特我。）`;
    return [head, '', ...picked.map((row) => `${hhmmss(row.when)} ${row.who}${row.text ? `：${row.text}` : ''}`)].join('\n');
  } catch (err) {
    return `翻群聊失败了：${err?.message ?? err}`;
  }
}
