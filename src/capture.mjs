// 从会话事件流里把「真人问 → 助手答」配成对。
// 独立成模块是为了能脱离宿主单测：这一段出过错（流水一条都没记上）。

export function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(block => block && block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n');
}

export function eventsOf(session) {
  if (!session || typeof session !== 'object') return [];
  const list = typeof session.snapshotEvents === 'function' ? session.snapshotEvents() : session.events;
  return Array.isArray(list) ? list : [];
}

export function pairsOf(session) {
  const pairs = [];
  let current = null;
  for (const event of eventsOf(session)) {
    if (!event || typeof event !== 'object') continue;
    if (event.type === 'user/message') {
      if (event.data?.source?.kind !== 'user') continue; // 工具回灌、系统注入的不算
      const text = textOf(event.data?.content).trim();
      if (!text) continue;
      if (current) pairs.push(current);
      current = { useq: event.seq, user: text.slice(0, 4000), assistant: '', time: event.time };
      continue;
    }
    if (event.type === 'assistant/message' && current) {
      const text = (textOf(event.data?.content) || textOf(event.data?.message?.content)).trim();
      if (text) current.assistant = text.slice(0, 4000);
    }
  }
  if (current) pairs.push(current);
  return pairs;
}

export function completedPairs(session, limit = 30) {
  return pairsOf(session)
    .filter(pair => pair.assistant)
    .slice(-limit);
}
