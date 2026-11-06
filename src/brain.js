// 大脑：决定要不要说话、说什么、说完记住什么。
import { createLogger } from './log.js';
import { buildPrompt, splitMemo } from './prompt.js';

const log = createLogger('brain');

/** 把长回复切成 QQ 友好的若干条 */
export function splitReply(text, maxChars = 600) {
  const clean = (text ?? '').trim();
  if (!clean) return [];
  if (clean.length <= maxChars) return [clean];
  const out = [];
  let rest = clean;
  while (rest.length > maxChars) {
    const window = rest.slice(0, maxChars);
    const cut = Math.max(
      window.lastIndexOf('\n'),
      window.lastIndexOf('。'),
      window.lastIndexOf('！'),
      window.lastIndexOf('？'),
      window.lastIndexOf('. '),
    );
    const at = cut > maxChars * 0.5 ? cut + 1 : maxChars;
    out.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest) out.push(rest);
  return out.filter(Boolean);
}

export class Brain {
  constructor({ cfg, store, onebot, backend, persona }) {
    this.cfg = cfg;
    this.store = store;
    this.onebot = onebot;
    this.backend = backend;
    this.persona = persona;
  }

  /** 准入判断：谁能驱动她、以什么方式 */
  decide(event) {
    const { access, limits, bot } = this.cfg;
    const isOwner = bot.ownerId && event.userId === String(bot.ownerId);

    if (event.kind === 'private') {
      if (!access.replyPrivate && !isOwner) return { ok: false, why: '私聊已关闭' };
      if (!isOwner && access.users.length && !access.users.map(String).includes(event.userId)) {
        return { ok: false, why: '私聊白名单外' };
      }
      return { ok: true, why: 'private' };
    }

    if (event.kind === 'group') {
      if (access.groups.length && !access.groups.map(String).includes(event.groupId)) {
        return { ok: false, why: '群不在白名单' };
      }
      if (!isOwner && access.users.length && !access.users.map(String).includes(event.userId)) {
        return { ok: false, why: '人不白名单内' };
      }
      // 主人只绕过白名单，不绕过触发条件——否则群里每句话都会被接，太吵
      if (event.atMe) return { ok: true, why: isOwner ? 'owner-at' : 'at' };
      if (access.groupTrigger === 'always') return { ok: true, why: 'always' };
      if (access.groupTrigger === 'smart') {
        const hit = access.keywords?.some((k) => event.text.includes(k));
        if (hit) return { ok: true, why: 'keyword' };
      }
      return { ok: false, why: '没被 @' };
    }

    if (event.kind === 'poke') {
      if (access.groups.length && event.groupId && !access.groups.map(String).includes(event.groupId)) {
        return { ok: false, why: '群不在白名单' };
      }
      return { ok: true, why: 'poke' };
    }

    return { ok: false, why: '未知事件' };
  }

  /** 主动发言只受群白名单约束，不受"被 @"触发条件约束 */
  decideProactive(event) {
    const { access } = this.cfg;
    if (event.kind === 'group' && access.groups.length) {
      if (!access.groups.map(String).includes(event.groupId)) return { ok: false, why: '群不在白名单' };
    }
    return { ok: true, why: 'proactive' };
  }

  rateOk(event) {
    const { limits } = this.cfg;
    if (!this.store.allow(`user:${event.userId}`, 1, (limits.perUserCooldownSec ?? 5) * 1000)) {
      return { ok: false, why: '冷却中' };
    }
    const groupKey = event.groupId ? `group:${event.groupId}` : `dm:${event.userId}`;
    if (!this.store.allow(groupKey, limits.perGroupPerHour ?? 60, 3600 * 1000)) {
      return { ok: false, why: '本小时发言数已达上限' };
    }
    return { ok: true };
  }

  async handle(event, { proactive = false } = {}) {
    const access = proactive ? this.decideProactive(event) : this.decide(event);
    if (!access.ok) {
      log.debug('不回应', access.why, event.chatKey, event.userId);
      return null;
    }
    if (!proactive) {
      const rate = this.rateOk(event);
      if (!rate.ok) {
        log.warn('限流拦下', rate.why, event.chatKey, event.userId);
        return null;
      }
    }

    const profile = this.store.getProfile(event.userId, event.nickname);
    const session = this.store.getSession(event.chatKey);
    const prompt = buildPrompt({ persona: this.persona, profile, event, proactive });

    let result;
    try {
      result = await this.backend.run({
        prompt,
        userText: event.text,
        nickname: profile.nickname,
        personaName: this.persona.name,
        sessionId: session?.sessionId ?? null,
      });
    } catch (err) {
      log.error('后端异常', err.message);
      await this.safeSend(event, '我这会儿有点卡住，稍等再试一次？');
      return null;
    }

    if (result.error) {
      log.error('后端返回错误', result.error);
      await this.safeSend(event, '脑子刚才短路了一下，再说一遍？');
      return null;
    }

    const { clean, memo } = splitMemo(result.text);
    if (!clean) {
      log.warn('模型返回空正文');
      return null;
    }

    // 记忆回写
    if (memo) this.applyMemo(profile.userId, memo, event);
    else this.store.appendEpisode(profile.userId, `和「${profile.nickname}」聊：${event.text.slice(0, 40)}`);

    // 会话映射
    this.store.setSession(event.chatKey, {
      sessionId: result.sessionId ?? session?.sessionId ?? null,
      kind: event.kind,
      groupId: event.groupId,
      userId: event.userId,
      label: event.kind === 'group' ? `QQ群 ${event.groupId}` : `QQ ${event.userId}`,
    });

    const chunks = splitReply(clean, this.cfg.limits.maxReplyChars);
    for (const [i, chunk] of chunks.entries()) {
      await this.safeSend(event, chunk, i === 0 ? event.messageId : null, proactive);
      if (i < chunks.length - 1) await sleep(350); // 别让 QQ 判定为刷屏
    }
    this.store.touchSession(event.chatKey, 'bot');
    return clean;
  }

  applyMemo(userId, memo, event) {
    const p = this.store.getProfile(userId, event.nickname);
    if (Array.isArray(memo.traits)) {
      p.traits = Array.from(new Set([...(p.traits ?? []), ...memo.traits.map(String)])).slice(-12);
    }
    if (Array.isArray(memo.facts)) {
      p.facts = Array.from(new Set([...(p.facts ?? []), ...memo.facts.map(String)])).slice(-20);
    }
    const episode = memo.episode ? String(memo.episode).slice(0, 120) : null;
    if (episode) {
      p.episodes = [...(p.episodes ?? []), { at: new Date().toISOString(), text: episode }].slice(
        -this.cfg.memory.maxEpisodes,
      );
    }
    p.interactions = (p.interactions ?? 0) + 1;
    this.store.saveProfile(p);
    log.info('画像已更新', { userId, traits: p.traits?.length, facts: p.facts?.length });
  }

  async safeSend(event, text, messageId = null, proactive = false) {
    if (!this.onebot.connected) {
      log.error('NapCat 未连接，消息没发出去', text.slice(0, 40));
      return false;
    }
    try {
      if (proactive) await this.onebot.send(event.chatKey, text);
      else await this.onebot.reply(event.chatKey, text, messageId);
      this.store.touchSession(event.chatKey, 'bot');
      return true;
    } catch (err) {
      log.error('发送失败', err.message);
      return false;
    }
  }

  /** 主动发言：在一个群里插一句话 */
  async proactiveSay(groupId, hint) {
    const { proactive } = this.cfg;
    if (!proactive.enabled) return null;
    const chatKey = `group:${groupId}`;
    if (inQuietHours(proactive.quietHours)) {
      log.info('免打扰时段，跳过主动发言');
      return null;
    }
    if (!this.store.allow(`proactive:${chatKey}`, proactive.maxPerHour ?? 2, 3600 * 1000)) {
      log.info('主动发言已达每小时上限', chatKey);
      return null;
    }
    const fakeEvent = {
      kind: 'group',
      chatKey,
      groupId: String(groupId),
      userId: String(this.cfg.bot.ownerId || '0'),
      nickname: '群友',
      text: hint || '（群里已经安静了一会儿，你想说点什么）',
      atMe: false,
      messageId: null,
    };
    const out = await this.handle(fakeEvent, { proactive: true });
    if (out) this.store.markProactive(chatKey);
    return out;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** '23:30-08:00' 形式的免打扰判断 */
export function inQuietHours(ranges, date = new Date()) {
  if (!ranges?.length) return false;
  const minutes = date.getHours() * 60 + date.getMinutes();
  for (const r of ranges) {
    const [a, b] = String(r).split('-');
    const toMin = (s) => {
      const [h, m] = s.split(':').map(Number);
      return h * 60 + m;
    };
    const start = toMin(a);
    const end = toMin(b);
    if (start <= end ? minutes >= start && minutes < end : minutes >= start || minutes < end) return true;
  }
  return false;
}
