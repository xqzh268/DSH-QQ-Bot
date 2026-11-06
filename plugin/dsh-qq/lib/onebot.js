/**
 * OneBot v11 协议层：把底层 WS 文本帧翻成"事件 / API 调用"两件事。
 * 不依赖任何 npm 包，只用 lib/ws.js。
 */
import { readFileSync } from 'node:fs';
import { createWebSocketServer } from './ws.js';
import { stickerName } from './imgname.js';
import { describeFaceSeg } from './faces.js';

/** NapCat「反向 WebSocket」要填的地址。0.0.0.0 对客户端没意义，展示成 127.0.0.1。 */
export function buildListenUrl({ host = '127.0.0.1', port = 7800, path = '/onebot', token = '' } = {}) {
  const h = !host || host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
  const p = String(path || '/onebot');
  const pathname = p.startsWith('/') ? p : `/${p}`;
  const base = `ws://${h}:${Number(port) || 7800}${pathname}`;
  const tok = String(token ?? '');
  return tok ? `${base}?access_token=${encodeURIComponent(tok)}` : base;
}

export class OneBot {
  constructor({ host = '127.0.0.1', port, path = '/onebot', token = '', log = console.log }) {
    this.host = host;
    this.port = port;
    this.path = path;
    this.token = token;
    this.log = log;
    this.selfId = '';
    this.server = null;
    this.pending = new Map();
    this.seq = 0;
    this.handlers = new Set();
    /** 我发出去的消息 id（有序集合，用来识别被引用） */
    this.sentIds = new Set();
  }

  get connected() {
    const conn = this.server?.connection?.();
    return Boolean(conn && !conn.closed);
  }

  listenUrl() {
    return buildListenUrl({ host: this.host, port: this.port, path: this.path, token: this.token });
  }

  onEvent(fn) {
    this.handlers.add(fn);
    return () => this.handlers.delete(fn);
  }

  async start() {
    // 热重载时旧实例的端口可能还没释放（dispose 里 close 是异步的），
    // 遇到 EADDRINUSE 等一等再试，而不是直接让通道起不来。
    const attempts = 8;
    for (let i = 1; ; i += 1) {
      try {
        this.server = await createWebSocketServer({
          host: this.host,
          port: this.port,
          path: this.path,
          token: this.token,
        });
        break;
      } catch (err) {
        if (err?.code !== 'EADDRINUSE' || i >= attempts) throw err;
        this.log(`端口 ${this.port} 被占用，${i}/${attempts} 次重试（等旧实例释放）`);
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    this.port = this.server.port;
    this.server.on('connection', () => this.log(`NapCat 已连接（${this.host}:${this.port}${this.path}）`));
    this.server.on('close', () => this.log('NapCat 断开，等待重连'));
    this.server.on('message', (text, conn) => this.#onFrame(text, conn));
    this.log(`等待 NapCat 连接：ws://${this.host}:${this.port}${this.path}`);
    return this;
  }

  #onFrame(text, conn) {
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      this.log('收到非 JSON 帧，已忽略');
      return;
    }

    // API 响应
    if (msg.echo !== undefined && this.pending.has(msg.echo)) {
      const p = this.pending.get(msg.echo);
      this.pending.delete(msg.echo);
      clearTimeout(p.timer);
      if (msg.status === 'ok' || msg.retcode === 0) p.resolve(msg.data);
      else p.reject(new Error(`${msg.wording ?? msg.message ?? 'onebot error'} (retcode=${msg.retcode})`));
      return;
    }

    // 事件
    if (msg.post_type) {
      if (msg.self_id && String(msg.self_id) !== this.selfId) {
        this.selfId = String(msg.self_id);
        this.log(`识别到 bot 账号 ${this.selfId}`);
      }
      for (const fn of this.handlers) {
        try {
          fn(msg);
        } catch (err) {
          this.log('事件处理异常:', err?.message ?? err);
        }
      }
    }
  }

  call(action, params = {}, timeoutMs = 15000) {
    const conn = this.server?.connection?.();
    if (!conn || conn.closed) return Promise.reject(new Error('NapCat 未连接'));
    this.seq += 1;
    const echo = `e${this.seq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(echo);
        reject(new Error(`OneBot API 超时：${action}`));
      }, timeoutMs);
      this.pending.set(echo, { resolve, reject, timer });
      conn.send(JSON.stringify({ action, params, echo }));
    });
  }

  /** chatKey: 'group:123' | 'private:456' */
  async reply(chatKey, text, messageId = null) {
    const [kind, id] = String(chatKey).split(':');
    const message = [];
    if (messageId) message.push({ type: 'reply', data: { id: String(messageId) } });
    message.push({ type: 'text', data: { text } });
    return this.#sendMsg(kind, id, message);
  }

  async send(chatKey, text) {
    const [kind, id] = String(chatKey).split(':');
    const message = [{ type: 'text', data: { text } }];
    return this.#sendMsg(kind, id, message);
  }

  /** 发消息并记下返回的 message_id，用来识别"有人引用了我的话" */
  async #sendMsg(kind, id, message) {
    const data =
      kind === 'group'
        ? await this.call('send_group_msg', { group_id: Number(id), message })
        : await this.call('send_private_msg', { user_id: Number(id), message });
    const mid = data?.message_id;
    if (mid !== undefined && mid !== null) {
      this.sentIds.add(String(mid));
      // 只留最近 500 条，够覆盖"有人回头引用"的时间尺度
      if (this.sentIds.size > 500) this.sentIds.delete(this.sentIds.values().next().value);
    }
    return data;
  }

  /**
   * 取一条已有的消息（用来读"对方引用了什么"）。OneBot v11 的 get_msg：
   * 返回 { time, sender:{user_id,nickname,card?}, message(段数组) }；
   * 消息不存在 / 已撤回 / 太久远取不到时 NapCat 会报错——这里统一返回 null，由上层如实告诉她"取不到"。
   * @returns {Promise<{id:string,userId:string,nickname:string,text:string,at:number,mine:boolean,images:number}|null>}
   */
  async getMessage(messageId) {
    const raw = String(messageId ?? '').trim();
    if (!raw) return null;
    try {
      const data = await this.call('get_msg', { message_id: /^\d+$/.test(raw) ? Number(raw) : raw }, 8000);
      if (!data || typeof data !== 'object') return null;
      const message = data.message;
      const userId = String(data.sender?.user_id ?? data.user_id ?? '');
      return {
        id: raw,
        userId,
        nickname: String(data.sender?.card || data.sender?.nickname || userId),
        text: extractText(message, this.selfId),
        at: Number(data.time ?? 0) * 1000,
        mine: this.isMine(raw) || (Boolean(this.selfId) && userId === this.selfId),
        images: extractImages(message).length,
        imageList: extractImages(message), // 带地址的图片，上层想看就能下载
      };
    } catch {
      return null;
    }
  }

  /** 这条消息 id 是不是我自己发的 */
  isMine(messageId) {
    return messageId !== null && messageId !== undefined && this.sentIds.has(String(messageId));
  }

  /** 发一张本地图片/表情包。用 base64 传，避免路径与 NapCat 工作目录不一致 */
  async sendImage(chatKey, filePath) {
    const buf = readFileSync(filePath);
    const b64 = buf.toString('base64');
    const [kind, id] = String(chatKey).split(':');
    const message = [{ type: 'image', data: { file: `base64://${b64}` } }];
    return this.#sendMsg(kind, id, message);
  }

  /** 发一条由文字段和 QQ 表情段（face）组成的消息；可选引用回复 */
  async sendSegments(chatKey, segments, messageId = null) {
    const [kind, id] = String(chatKey).split(':');
    const message = [];
    if (messageId) message.push({ type: 'reply', data: { id: String(messageId) } });
    message.push(...segments);
    return this.#sendMsg(kind, id, message);
  }

  /** 发一张卡片（NapCat 的 json 消息段，data.data 是卡片 JSON 字符串），比如 B 站小程序视频卡 */
  async sendCard(chatKey, cardJson) {
    const [kind, id] = String(chatKey).split(':');
    const message = [{ type: 'json', data: { data: String(cardJson) } }];
    return this.#sendMsg(kind, id, message);
  }

  async close() {
    await this.server?.close();
  }
}

// ---------- 事件归一化（与独立桥保持一致的语义）----------

/**
 * 抽出图片段。OneBot v11 / NapCat 的图片与表情包都走 image 段，
 * 区别在 sub_type（0 普通图片，1 表情包/商城表情），有的实现还会给 mface 段。
 */
export function extractImages(message) {
  if (!Array.isArray(message)) return [];
  const out = [];
  for (const seg of message) {
    if (!seg || typeof seg !== 'object') continue;
    if (seg.type !== 'image' && seg.type !== 'mface') continue;
    const d = seg.data ?? {};
    // 表情包/图片的地址字段名各实现不同，按优先级取
    const url = d.url || d.file_url || d.origin_url || '';
    out.push({
      url: typeof url === 'string' ? url : '',
      file: String(d.file ?? ''),
      summary: String(d.summary ?? d.emoji_name ?? ''),
      subType: Number(d.sub_type ?? (seg.type === 'mface' ? 1 : 0)),
      isSticker: seg.type === 'mface' || Number(d.sub_type ?? 0) === 1,
    });
  }
  return out;
}

/** 消息里引用（reply 段）的那条消息 id；没有引用返回 null */
export function extractReplyId(message) {
  if (!Array.isArray(message)) return null;
  const seg = message.find((s) => s?.type === 'reply');
  const id = seg?.data?.id;
  return id === undefined || id === null || id === '' ? null : String(id);
}

/** 是否 @ 了别人（不含 @ 她自己、不含 @全体） */
export function mentionsOthers(message, selfId) {
  if (!Array.isArray(message)) return false;
  return message.some((s) => s?.type === 'at' && String(s?.data?.qq) !== 'all' && String(s?.data?.qq) !== String(selfId));
}

const trimUrl = (u) => String(u ?? '').trim().replace(/[?#].*$/, '');
const clip = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

/** 消息里 @ 到的别人的 QQ 号（不含她自己、不含 @全体），去重保序 */
export function mentionIds(message, selfId) {
  if (!Array.isArray(message)) return [];
  const out = [];
  for (const s of message) {
    if (s?.type !== 'at') continue;
    const qq = String(s?.data?.qq ?? '');
    if (/^\d+$/.test(qq) && qq !== String(selfId) && !out.includes(qq)) out.push(qq);
  }
  return out;
}

/**
 * 把 QQ 分享卡片（NapCat 的 json 段，data.data 是 JSON 字符串）转成她看得懂的一行字。
 * 已知两种常见结构：
 *  - 小程序分享（B 站、小红书等）：app=com.tencent.miniapp*，meta.detail_1 = {title: 应用名, desc: 内容标题, qqdocurl: 链接}
 *  - 图文链接分享：meta.news = {title, desc, jumpUrl, tag}
 * 认不出来的结构退回到 prompt 字段或 "[卡片消息]"，绝不抛异常。
 */
export function describeCard(raw) {
  let card;
  try {
    card = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return '[卡片消息]';
  }
  if (!card || typeof card !== 'object') return '[卡片消息]';
  const meta = card.meta ?? {};
  const mini = meta.detail_1;
  const news = meta.news;
  let source = '';
  let title = '';
  let url = '';
  if (mini && typeof mini === 'object') {
    source = mini.title;
    title = mini.desc;
    url = mini.qqdocurl || mini.url;
  } else if (news && typeof news === 'object') {
    source = news.tag;
    title = news.title;
    url = news.jumpUrl;
    if (news.desc && news.desc !== news.title) title = `${title} —— ${clip(news.desc, 80)}`;
  } else {
    const first = Object.values(meta).find((v) => v && typeof v === 'object' && (v.title || v.desc));
    if (first) {
      source = first.tag || first.title;
      title = first.desc || first.title;
      url = first.jumpUrl || first.qqdocurl || first.url;
    }
  }
  if (!title) title = String(card.prompt ?? '').replace(/^\[[^\]]*\]/, '');
  title = clip(title, 140);
  if (!title && !source) return '[卡片消息]';
  const link = trimUrl(url);
  return `[分享${source ? `·${clip(source, 20)}` : ''}${title ? `：${title}` : ''}${link ? ` ${link}` : ''}]`;
}

/**
 * 抽文字。@ 她自己的段去掉（触发信息由 atMe 表达）；
 * @ 别人的段还原成 "@昵称"，否则群友之间"@张三 你看这个"会变成"你看这个"，
 * 她就分不清这句话是对谁说的。
 */
export function extractText(message, selfId = '') {
  if (!message) return '';
  if (typeof message === 'string') {
    return message.replace(/\[CQ:[^\]]+\]/g, '').trim();
  }
  const parts = [];
  for (const seg of message) {
    if (!seg || typeof seg !== 'object') continue;
    if (seg.type === 'at') {
      const qq = String(seg.data?.qq ?? '');
      if (qq && qq !== String(selfId)) parts.push(qq === 'all' ? '@全体成员 ' : `@${seg.data?.name || qq} `);
      continue;
    }
    if (seg.type === 'text') parts.push(seg.data?.text ?? '');
    else if (seg.type === 'face') parts.push(describeFaceSeg(seg));
    else if (seg.type === 'mface' || seg.type === 'image') {
      const isSticker = seg.type === 'mface' || Number(seg.data?.sub_type ?? 0) === 1;
      const name = stickerName(seg.data?.summary ?? seg.data?.emoji_name);
      parts.push(`[${isSticker ? '表情包' : '图片'}${name ? `：${name}` : ''}]`);
    }
    else if (seg.type === 'record') parts.push('[语音]');
    else if (seg.type === 'json') parts.push(describeCard(seg.data?.data));
  }
  return parts.join('').trim();
}

export function mentionsSelf(message, selfId) {
  if (!message || !selfId) return false;
  if (typeof message === 'string') return message.includes(`[CQ:at,qq=${selfId}]`);
  return message.some((seg) => seg?.type === 'at' && String(seg?.data?.qq) === String(selfId));
}

export function normalize(event, selfId) {
  if (!event || typeof event !== 'object') return null;
  if (event.post_type === 'message' && String(event.user_id) === String(selfId)) return null;

  if (event.post_type === 'message') {
    const isGroup = event.message_type === 'group';
    const userId = String(event.user_id);
    const groupId = isGroup ? String(event.group_id) : null;
    return {
      kind: isGroup ? 'group' : 'private',
      at: Date.now(),
      chatKey: isGroup ? `group:${groupId}` : `private:${userId}`,
      groupId,
      userId,
      nickname: event.sender?.card || event.sender?.nickname || userId,
      text: extractText(event.message, selfId),
      images: extractImages(event.message),
      atMe: mentionsSelf(event.message, selfId),
      replyId: extractReplyId(event.message),
      replyToMe: false, // 由上层对照"我发过的消息 id"后填写
      atOthers: mentionsOthers(event.message, selfId),
      atIds: mentionIds(event.message, selfId),
      messageId: event.message_id ?? null,
      timestamp: event.time ? event.time * 1000 : Date.now(),
    };
  }

  if (event.post_type === 'notice' && event.notice_type === 'notify' && event.sub_type === 'poke') {
    const targetId = String(event.target_id ?? '');
    if (selfId && targetId && targetId !== String(selfId)) return null;
    const groupId = event.group_id ? String(event.group_id) : null;
    const userId = String(event.user_id);
    return {
      kind: 'poke',
      at: Date.now(),
      chatKey: groupId ? `group:${groupId}` : `private:${userId}`,
      groupId,
      userId,
      nickname: event.sender?.card || event.sender?.nickname || userId,
      text: '[戳了戳你]',
      atMe: true,
      messageId: null,
      timestamp: Date.now(),
    };
  }

  return null;
}

