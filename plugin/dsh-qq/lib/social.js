/**
 * 轻量社交动作：不走模型、几乎零成本，但最像"群里有这么个人"。
 *   - 复读：同一句话被不同的人连续说了几遍，按概率跟一句
 *   - 表情回应：对笑、夸、可爱之类的话点个表情（set_msg_emoji_like），而不是硬回一句
 *   - 戳回去：被戳后按概率直接戳回去（group_poke / friend_poke）
 *
 * NapCat 接口（已对照其源码核实）：
 *   set_msg_emoji_like { message_id, emoji_id, set }   emoji_id 取 QQ 表情 id 字符串
 *   group_poke  { group_id, user_id }
 *   friend_poke { user_id }
 * 表情 id：76 赞 / 178 斜眼笑 / 66 爱心；其余（拥抱/比心/吃瓜/月亮）按名字查 QQ 表情表
 * 她自己想贴表情时，用回复里的 [[贴:名字]]（见 brain.js 的 #reactTo），和这里共用同一张表和冷却记录
 *
 * 每个动作都有总开关、概率、冷却；全部失败只写日志，不影响主流程。
 */
import { inQuietHours } from './ambient.js';
import { reactionId } from './faces.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const between = (lo, hi, rnd = Math.random) => Math.round(lo + rnd() * Math.max(0, hi - lo));

export const EMOJI = { like: '76', smirk: '178', heart: '66' };
/** 其余回应：名字取自 QQ 表情表（faces.js），id 由表解析，不在这里手写数字 */
const react = (name) => reactionId(name);

/** 归一化复读文本：去首尾空白、统一全半角标点和大小写，忽略末尾语气标点 */
export function normRepeatText(text) {
  return String(text ?? '')
    .trim()
    .toLowerCase()
    .replace(/[！!。.，,？?~～…\s]+$/gu, '')
    .replace(/\s+/g, ' ');
}

/**
 * 要不要复读。rows 是最近的消息（时间正序，包含刚到的这一条）。
 * 条件：末尾连续 minRepeats 条都是同一句、来自不同的人，且她最近没说过这句。
 * 返回要复读的原文，或 null。
 */
export function repeatCandidate(rows, { minUsers = 3, maxLen = 20 } = {}) {
  if (!Array.isArray(rows) || rows.length < minUsers) return null;
  const last = rows[rows.length - 1];
  if (!last || last.self) return null;
  const key = normRepeatText(last.text);
  if (!key || key.length > maxLen) return null;
  // 占位符、纯链接、像命令的都不复读
  if (/^\[[^\]]+\]$/.test(key) || /https?:\/\//.test(key) || /^[/#!]/.test(key)) return null;

  const speakers = new Set();
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const r = rows[i];
    if (r.self) break; // 她已经插过话，这一串到此为止
    if (normRepeatText(r.text) !== key) break;
    speakers.add(r.nickname);
  }
  if (speakers.size < minUsers) return null;
  // 最近她自己说过同一句 → 不再说
  if (rows.some((r) => r.self && normRepeatText(r.text) === key)) return null;
  return String(last.text).trim();
}

/** 挑一个表情回应；没有合适的返回 null */
export function pickReaction(text) {
  const t = String(text ?? '');
  if (!t.trim()) return null;
  if (/(哈哈|笑死|xswl|绷不住|乐死|笑不活|😂|🤣|[草艹]{1,}\s*$)/i.test(t)) return EMOJI.smirk;
  if (/(可爱|萌|爱你|喜欢你|抱抱|好暖|贴贴)/.test(t)) return EMOJI.heart;
  if (/(牛逼|牛批|太强|厉害|绝了|好耶|nb\b|666|给力|学到了|太棒)/i.test(t)) return EMOJI.like;
  if (/(难过|好累|累死|心累|想哭|哭了|破防|失眠|好烦|不开心|难受|emo)/i.test(t)) return react('拥抱');
  if (/(谢谢|感谢|多谢|辛苦了)/.test(t)) return react('比心');
  if (/(离谱|八卦|卧槽|我靠|真的假的|什么鬼|不是吧)/.test(t)) return react('吃瓜');
  if (/^\s*晚安/.test(t)) return react('月亮');
  return null;
}

export class Social {
  constructor({ brain, ambient, onebot, log }) {
    this.brain = brain;
    this.ambient = ambient;
    this.onebot = onebot;
    this.log = log;
    this.repeating = new Set(); // 正在等待复读发出的群
    this.lastRepeat = new Map(); // chatKey -> ts
    this.lastReact = new Map(); // chatKey -> ts
    this.pokes = new Map(); // `${chatKey}|${userId}` -> [ts]
  }

  get cfg() {
    const s = this.brain.cfg?.social ?? {};
    return {
      repeat: {
        enabled: s.repeat?.enabled !== false,
        probability: s.repeat?.probability ?? 0.5,
        minUsers: s.repeat?.minUsers ?? 3,
        maxLen: s.repeat?.maxLen ?? 20,
        cooldownSec: s.repeat?.cooldownSec ?? 180,
      },
      react: {
        enabled: s.react?.enabled !== false,
        probability: s.react?.probability ?? 0.12,
        cooldownSec: s.react?.cooldownSec ?? 180,
      },
      pokeBack: {
        enabled: s.pokeBack?.enabled !== false,
        probability: s.pokeBack?.probability ?? 0.4,
        cooldownSec: s.pokeBack?.cooldownSec ?? 60,
        maxPer10Min: s.pokeBack?.maxPer10Min ?? 3,
      },
    };
  }

  /** 共同前提：群在白名单内、不在免打扰时段 */
  #groupOk(event) {
    if (event.kind !== 'group' || !event.groupId) return false;
    const groups = (this.brain.cfg?.access?.groups ?? []).map(String);
    if (groups.length && !groups.includes(String(event.groupId))) return false;
    if (inQuietHours(this.brain.cfg?.proactive?.quietHours ?? [])) return false;
    return true;
  }

  /** 复读。成功发出返回 true */
  async maybeRepeat(event, rnd = Math.random) {
    const c = this.cfg.repeat;
    if (!c.enabled || !this.#groupOk(event) || event.atMe) return false;
    if (this.repeating.has(event.chatKey)) return false;
    if (Date.now() - (this.lastRepeat.get(event.chatKey) ?? 0) < c.cooldownSec * 1000) return false;
    const rows = this.ambient?.db?.recent?.(event.chatKey, 8) ?? [];
    const text = repeatCandidate(rows, { minUsers: c.minUsers, maxLen: c.maxLen });
    if (!text) return false;
    if (rnd() > c.probability) return false;

    this.repeating.add(event.chatKey);
    try {
      await sleep(between(1200, 3500, rnd));
      await this.onebot.send(event.chatKey, text);
      this.ambient?.rememberSelf?.(event.chatKey, text);
      this.lastRepeat.set(event.chatKey, Date.now());
      this.log(`复读：${text}`);
      return true;
    } catch (err) {
      this.log('复读失败:', err?.message ?? err);
      return false;
    } finally {
      this.repeating.delete(event.chatKey);
    }
  }

  /** 表情回应。成功返回 true */
  async maybeReact(event, rnd = Math.random) {
    const c = this.cfg.react;
    if (!c.enabled || !this.#groupOk(event) || event.atMe || !event.messageId) return false;
    if (Date.now() - (this.lastReact.get(event.chatKey) ?? 0) < c.cooldownSec * 1000) return false;
    const emoji = pickReaction(event.text);
    if (!emoji) return false;
    if (rnd() > c.probability) return false;

    this.lastReact.set(event.chatKey, Date.now());
    try {
      await sleep(between(1000, 4000, rnd));
      await this.onebot.call('set_msg_emoji_like', { message_id: event.messageId, emoji_id: emoji, set: true });
      this.brain.noteFaceUsed?.(event.chatKey, emoji);
      this.log(`表情回应 ${emoji}：${String(event.text).slice(0, 20)}`);
      return true;
    } catch (err) {
      this.log('表情回应失败:', err?.message ?? err);
      return false;
    }
  }

  /**
   * 被戳后戳回去。返回 'poked' 表示已经处理（不再走模型），null 表示没戳（调用方走原流程）。
   * 准入沿用 brain.decide（白名单），并限制频率防止互戳成战争。
   */
  async tryPokeBack(event, rnd = Math.random) {
    const c = this.cfg.pokeBack;
    if (!c.enabled || event.kind !== 'poke') return null;
    if (!this.brain.decide(event).ok) return null;
    if (rnd() > c.probability) return null;

    const key = `${event.chatKey}|${event.userId}`;
    const now = Date.now();
    const hits = (this.pokes.get(key) ?? []).filter((t) => now - t < 10 * 60 * 1000);
    if (hits.length >= c.maxPer10Min) return null;
    if (hits.length && now - hits[hits.length - 1] < c.cooldownSec * 1000) return null;

    try {
      await sleep(between(800, 2500, rnd));
      if (event.groupId) await this.onebot.call('group_poke', { group_id: Number(event.groupId), user_id: Number(event.userId) });
      else await this.onebot.call('friend_poke', { user_id: Number(event.userId) });
      hits.push(now);
      this.pokes.set(key, hits);
      this.log(`戳回去：${event.nickname}`);
      return 'poked';
    } catch (err) {
      // 接口不可用就回落到原来的"让模型回一句"
      this.log('戳回去失败，改走模型:', err?.message ?? err);
      return null;
    }
  }
}
