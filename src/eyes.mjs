// 眼睛：把本机图片交给免费视觉模型看一眼，只留一段文字回来。
// 这样"看图"就不用装别的插件了 —— own-soul 自己带。
import { existsSync, readFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

export const VISION_MODEL = 'glm-4v-flash';
export const VISION_ENDPOINT = 'https://open.bigmodel.cn/api/paas/v4/chat/completions';
export const MAX_BYTES = 6 * 1024 * 1024;

/** 按文件头判断图片类型，猜不出来就按 jpeg。 */
export function typeOf(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return { mime: 'image/png', ext: 'png' };
  if (buf[0] === 0xff && buf[1] === 0xd8) return { mime: 'image/jpeg', ext: 'jpg' };
  if (buf.subarray(0, 3).toString('latin1') === 'GIF') return { mime: 'image/gif', ext: 'gif' };
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') {
    return { mime: 'image/webp', ext: 'webp' };
  }
  return { mime: 'image/jpeg', ext: 'jpg' };
}

/** 从 HKCU\Environment 里读一个环境变量（setx 写进去的，进程里不一定有）。 */
export function registryValue(name) {
  try {
    const out = execFileSync('reg', ['query', 'HKCU\\Environment', '/v', name], { encoding: 'utf8', timeout: 4000 });
    const match = out.match(new RegExp(`${name}\\s+REG_[A-Z_]+\\s+(.+)$`, 'm'));
    return match ? match[1].trim() : '';
  } catch {
    return '';
  }
}

/** API key 依次找：进程环境 → 注册表 → $DSH_HOME/.credentials.yaml。 */
export function findKey(home) {
  for (const name of ['GLM_API_KEY', 'ZHIPU_API_KEY']) {
    const fromEnv = String(process.env[name] ?? '').trim();
    if (fromEnv) return { key: fromEnv, source: name };
  }
  for (const name of ['GLM_API_KEY', 'ZHIPU_API_KEY']) {
    const value = registryValue(name);
    if (value) return { key: value, source: `注册表 ${name}` };
  }
  try {
    const file = join(home ?? '', '.credentials.yaml');
    if (home && existsSync(file)) {
      const text = readFileSync(file, 'utf8');
      const match = text.match(/ZHIPU_API_KEY[^\n]*?:\s*"?([0-9a-f]{32}\.[A-Za-z0-9]+)/i);
      if (match) return { key: match[1], source: '.credentials.yaml' };
    }
  } catch {}
  return { key: '', source: '' };
}

export function eyesState(home) {
  const found = findKey(home);
  return { ready: Boolean(found.key), source: found.source, model: VISION_MODEL, maxMB: Math.round(MAX_BYTES / 1024 / 1024) };
}

function pickImage(input, home) {
  const raw = String(input ?? '').trim();
  if (!raw) return { error: '没给我图看：传 file 路径或 url' };
  if (/^https?:\/\//i.test(raw)) return { url: raw };
  if (/^data:image\//i.test(raw)) return { dataUrl: raw };
  const path = raw.startsWith('/') && /^\/[a-zA-Z]:\//.test(raw) ? raw.slice(1) : raw;
  if (!existsSync(path)) return { error: `找不到这张图：${path}` };
  const size = statSync(path).size;
  if (size > MAX_BYTES) return { error: `图太大（${Math.round(size / 1024 / 1024)}MB），上限 ${Math.round(MAX_BYTES / 1024 / 1024)}MB` };
  const buf = readFileSync(path);
  const kind = typeOf(buf) ?? { mime: 'image/jpeg', ext: 'jpg' };
  return { dataUrl: `data:${kind.mime};base64,${buf.toString('base64')}`, path, bytes: size, ext: kind.ext };
}

/**
 * 看一眼图。出任何错都返回 {ok:false, error}，绝不抛。
 * @returns {Promise<{ok:boolean, text?:string, model?:string, bytes?:number, path?:string, error?:string}>}
 */
export async function look({ file, url, question, home, model = VISION_MODEL, timeoutMs = 60000 } = {}) {
  const found = findKey(home);
  if (!found.key) return { ok: false, error: '没有可用的视觉 key（GLM_API_KEY / ZHIPU_API_KEY）' };
  const picked = pickImage(file ?? url, home);
  if (picked.error) return { ok: false, error: picked.error };
  const imageUrl = picked.dataUrl ?? picked.url;
  const ask = String(question ?? '').trim() || '用两三句话如实描述这张图：里面有谁、在做什么、有哪些能看清的文字。看不清就说看不清，不要猜。';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(VISION_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${found.key}` },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image_url', image_url: { url: imageUrl } },
              { type: 'text', text: ask },
            ],
          },
        ],
      }),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) return { ok: false, error: `视觉接口 ${res.status}：${text.slice(0, 200)}` };
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      return { ok: false, error: `视觉接口返回的不是 JSON：${text.slice(0, 200)}` };
    }
    const answer = body?.choices?.[0]?.message?.content;
    if (typeof answer !== 'string' || !answer.trim()) return { ok: false, error: '视觉接口没给正文' };
    return { ok: true, text: answer.trim(), model: body.model ?? model, bytes: picked.bytes ?? 0, path: picked.path ?? '', source: found.source };
  } catch (error) {
    return { ok: false, error: `看图失败：${error?.name === 'AbortError' ? '超时' : error?.message ?? error}` };
  } finally {
    clearTimeout(timer);
  }
}
