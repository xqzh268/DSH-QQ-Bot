// OneBot v11 事件归一化：把 NapCat 推来的各种事件，变成桥内部统一的形状。
// 参考事件结构：message / notice(notify|poke) / meta_event。

/** 从 message 字段里抽纯文本；同时兼容数组段和 CQ 码字符串两种形态。 */
export function extractText(message) {
  if (!message) return '';
  if (typeof message === 'string') {
    return message
      .replace(/\[CQ:[^\]]+\]/g, '')
      .replace(/&amp;/g, '&')
      .replace(/&#91;/g, '[')
      .replace(/&#93;/g, ']')
      .trim();
  }
  const parts = [];
  for (const seg of message) {
    if (!seg || typeof seg !== 'object') continue;
    if (seg.type === 'text') parts.push(seg.data?.text ?? '');
    else if (seg.type === 'face') parts.push('[表情]');
    else if (seg.type === 'image') parts.push('[图片]');
    else if (seg.type === 'record') parts.push('[语音]');
    else if (seg.type === 'file') parts.push(`[文件:${seg.data?.name ?? seg.data?.file ?? '未知'}]`);
  }
  return parts.join('').trim();
}

/** 是否 @ 了指定的 QQ 号 */
export function mentionsSelf(message, selfId) {
  if (!message || !selfId) return false;
  if (typeof message === 'string') {
    return message.includes(`[CQ:at,qq=${selfId}]`) || message.includes('[CQ:at,qq=all]');
  }
  return message.some(
    (seg) => seg?.type === 'at' && String(seg?.data?.qq) === String(selfId),
  );
}

export function mentionsAll(message) {
  if (!message) return false;
  if (typeof message === 'string') return message.includes('[CQ:at,qq=all]');
  return message.some((seg) => seg?.type === 'at' && String(seg?.data?.qq) === 'all');
}

/**
 * 归一化事件。
 * 返回 null 表示这个事件我们不关心。
 * 形状：{ kind, chatKey, groupId?, userId, nickname, text, atMe, messageId, raw }
 */
export function normalize(event, selfId) {
  if (!event || typeof event !== 'object') return null;

  // 自己发的消息（bot 回环）直接丢
  if (event.post_type === 'message' && String(event.user_id) === String(selfId)) return null;

  if (event.post_type === 'message') {
    const isGroup = event.message_type === 'group';
    const userId = String(event.user_id);
    const groupId = isGroup ? String(event.group_id) : null;
    return {
      kind: isGroup ? 'group' : 'private',
      chatKey: isGroup ? `group:${groupId}` : `private:${userId}`,
      groupId,
      userId,
      nickname: event.sender?.card || event.sender?.nickname || userId,
      text: extractText(event.message),
      atMe: mentionsSelf(event.message, selfId),
      atAll: mentionsAll(event.message),
      messageId: event.message_id ?? null,
      timestamp: event.time ? event.time * 1000 : Date.now(),
      raw: event,
    };
  }

  // 戳一戳：私聊和群里都能收到，是最自然的"求关注"信号
  if (event.post_type === 'notice' && event.notice_type === 'notify' && event.sub_type === 'poke') {
    const groupId = event.group_id ? String(event.group_id) : null;
    const targetId = String(event.target_id ?? '');
    // target 不是自己就忽略
    if (selfId && targetId && targetId !== String(selfId)) return null;
    const userId = String(event.user_id);
    return {
      kind: 'poke',
      chatKey: groupId ? `group:${groupId}` : `private:${userId}`,
      groupId,
      userId,
      nickname: event.sender?.card || event.sender?.nickname || userId,
      text: '[戳了戳你]',
      atMe: true,
      atAll: false,
      messageId: null,
      timestamp: Date.now(),
      raw: event,
    };
  }

  return null;
}
