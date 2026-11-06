/**
 * 主动发言 + 群消息缓冲。
 *
 * 两种触发：
 *   1) 静默插话 —— 群安静超过 idleMinutes，主动开个话头
 *   2) 闲聊采样 —— 没被 @ 的消息按 sampleRate 抽样，看起来像"能接"的才接
 *
 * 成本控制：闲聊采样不用"第二遍问模型要不要接"，而是本地启发式先筛（疑问句/长度/间隔），
 * 过筛才发一次调用。模型如果判断不该接，回 PASS，我们不发送。
 *
 * 消息缓冲与限流状态落盘在 data/qq-messages.db（node:sqlite，无第三方依赖），
 * 所以重启后仍知道"这个群最近在聊什么""上次主动说话是什么时候"。
 */
import { MessageDB } from './msgdb.js';
import { describeVideo, interestWords } from './bili.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function inQuietHours(ranges, date = new Date()) {
  if (!Array.isArray(ranges) || !ranges.length) return false;
  const minutes = date.getHours() * 60 + date.getMinutes();
  for (const r of ranges) {
    const [a, b] = String(r).split('-');
    if (!a || !b) continue;
    const toMin = (s) => {
      const [h, m] = s.split(':').map(Number);
      return (h || 0) * 60 + (m || 0);
    };
    const start = toMin(a);
    const end = toMin(b);
    if (start <= end ? minutes >= start && minutes < end : minutes >= start || minutes < end) return true;
  }
  return false;
}

/** 整条消息只有图片 / 表情 / 语音占位（可以连着好几个） */
const MEDIA_ONLY = /^(?:\s*\[(?:图片|表情包?|语音|视频|动画表情)(?:[：:][^\]]*)?\])+\s*$/;

/** 像个能接的话吗：疑问、求推荐、感慨、有内容的陈述 */
function looksJoinable(text) {
  const t = String(text ?? '').trim();
  if (t.length < 6) return false;
  if (MEDIA_ONLY.test(t)) return false;
  if (/[?？]/.test(t)) return true;
  if (/(吗|怎么|为什么|咋|能不能|有没有|推荐|求|谁|啥)/.test(t)) return true;
  if (t.length >= 12) return true;
  return false;
}

export class Ambient {
  constructor({ brain, store, log }) {
    this.brain = brain;
    this.store = store;
    this.log = log;
    this.db = new MessageDB(store.dir, log);
    this.buffers = new Map(); // groupId -> [{ nickname, text, at }]（内存兜底）
    this.lastChime = new Map(); // groupId -> ts（内存兜底）
    this.hourHits = new Map(); // groupId -> [ts]
    this.privateHits = new Map(); // userId -> [ts]（内存兜底）
    this.knownUsers = new Set();
    this.timer = null;
    this.stats = { seen: 0, joinable: 0, sampled: 0, pauseTried: 0, pauseHit: 0, lastChimeAt: null };
    // 群聊停顿计时器：一群一个，消息到来时重置
    this.pauseTimers = new Map();
    this.unansweredLogged = new Set(); // 已经提示过"她上一句没人理"的群，免得每轮巡检都打日志
  }

  get cfg() {
    return this.brain.cfg ?? {};
  }

  get settings() {
    const p = this.cfg.proactive ?? {};
    // 人设卡里也写了 proactive.maxPerHour / quietHours；config.json 没配时拿它兜底，
    // 否则人设卡里这两个字段是摆设
    const pp = this.brain.persona?.proactive ?? {};
    const personaQuiet = Array.isArray(pp.quietHours) ? pp.quietHours : typeof pp.quietHours === 'string' && pp.quietHours ? [pp.quietHours] : [];
    return {
      // 总开关：关掉后，三个触发（群静默 / 群采样 / 私聊）都不工作
      enabled: Boolean(p.enabled),
      maxPerHour: p.maxPerHour ?? pp.maxPerHour ?? 2,
      quietHours: p.quietHours ?? personaQuiet,
      // 子触发 1：群里安静太久，主动开话头
      idle: {
        enabled: p.idle?.enabled !== false,
        // 120 分钟在活跃群里几乎永远不满足，默认降到 45
        minutes: p.idle?.minutes ?? p.idleMinutes ?? 45,
        // 群里冷了好几天就别开话头了
        maxSilenceHours: p.idle?.maxSilenceHours ?? 8,
        // 冷场后的暖场只发"有发现"的东西：按群友的爱好联网找一条真实内容（B站/小红书/新闻等）分享；
        // 没找到就不说，不再发"困了/刚醒/吃饭了吗"这种没内容的话。关掉后退回"自己开新话头"
        discover: p.idle?.discover !== false,
        // 她上一句没人理（群里最后一条还是她自己的）就不再暖场，免得自说自话
        skipIfUnanswered: p.idle?.skipIfUnanswered !== false,
        // 每个群每天最多暖场几次
        maxPerDay: p.idle?.maxPerDay ?? 2,
        // 两次"带新东西来"（B 站 / 搜索分享）之间至少隔几小时
        discoverGapHours: Number.isFinite(Number(p.idle?.discoverGapHours)) ? Number(p.idle.discoverGapHours) : 4,
      },
      // 子触发 2：没被 @ 的群消息按采样率接一句
      // 话题停顿后再决定要不要接（默认开启，取代"每条消息掷骰子"）
      pause: {
        enabled: p.pause?.enabled !== false,
        seconds: p.pause?.seconds ?? 90,
        // 停顿接话自己的命中率；没配就沿用 ambient.sampleRate
        sampleRate: p.pause?.sampleRate ?? null,
      },
      ambient: {
        enabled: Boolean(p.ambient?.enabled),
        // 0.05 对小组群太低（24h 只有几十条能接的话），默认提到 0.15
        sampleRate: p.ambient?.sampleRate ?? 0.15,
        minGapMinutes: p.ambient?.minGapMinutes ?? 20,
      },
      // 子触发 3：私聊里主动找她记得的人
      private: {
        enabled: Boolean(p.private?.enabled),
        idleHours: p.private?.idleHours ?? 24,
        maxPerDay: p.private?.maxPerDay ?? 1,
      },
      // 话痨刹车：最近 window 条群消息里她占比超过 maxSelfShare 就不主动开口（0 = 关闭）
      share: {
        maxSelfShare: Number.isFinite(Number(p.maxSelfShare)) ? Number(p.maxSelfShare) : 0.25,
        window: Math.max(10, Number(p.shareWindow) || 30),
      },
      bufferSize: p.bufferSize ?? 30,
    };
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.sweep().catch((err) => this.log('主动巡检异常:', err?.message ?? err));
    }, 5 * 60 * 1000);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const t of this.pauseTimers.values()) clearTimeout(t);
    this.pauseTimers.clear();
    try {
      this.db.close();
    } catch {}
  }

  /** 每条群消息都进缓冲（包括她没回的） */
  note(event) {
    if (event.kind !== 'group' || !event.groupId) return;
    // 用事件本身的时间戳：和引用判断共用同一个基准，避免"触发消息被算成后来的消息"
    const at = Number(event.at) || Date.now();
    const chatKey = `group:${event.groupId}`;

    // 落盘（重启后仍然知道群里聊到哪了）
    this.db.append({
      chatKey,
      groupId: event.groupId,
      userId: event.userId,
      nickname: event.nickname,
      text: event.text,
      at,
    });

    // 群级记忆：积累够了就在后台总结一次（不阻塞、不抛错）
    this.groupMemory?.onMessage?.(chatKey);

    // 停顿计时：这条消息之后如果安静 N 秒，说明话题告一段落，再考虑接一句
    this.#armPause(event);

    // 内存兜底（库不可用时仍能工作）
    const cap = this.settings.bufferSize;
    const list = this.buffers.get(event.groupId) ?? [];
    list.push({ nickname: event.nickname, text: event.text, at });
    while (list.length > cap) list.shift();
    this.buffers.set(event.groupId, list);

    // 让群友也出现在"记忆"里（每人只落盘一次，避免每条消息都写文件）
    const key = String(event.userId);
    if (!this.knownUsers.has(key)) {
      this.knownUsers.add(key);
      try {
        this.store.profile(key, event.nickname);
      } catch {}
    }
  }

  /** 群安静 N 秒后触发一次"要不要接话"的判断 */
  #armPause(event) {
    const s = this.settings;
    if (!s.pause.enabled) return;
    const groupId = String(event.groupId);
    const old = this.pauseTimers.get(groupId);
    if (old) clearTimeout(old);
    const timer = setTimeout(() => {
      this.pauseTimers.delete(groupId);
      this.maybeChimeOnPause(groupId, event.chatKey).catch((err) => this.log('停顿接话异常:', err?.message ?? err));
    }, Math.max(15, Number(s.pause.seconds)) * 1000);
    if (typeof timer?.unref === 'function') timer.unref();
    this.pauseTimers.set(groupId, timer);
  }

  /**
   * 停顿点决策：用"最近这一段对话"作为依据，而不是单条消息。
   * 只要这段里有任何一条看起来能接（问句/够长/话题词），或者干脆聊了好几轮，就值得掷一次。
   */
  async maybeChimeOnPause(groupId, chatKey) {
    const s = this.settings;
    // 停顿接话由 pause.enabled 自己控制，不再受 ambient.enabled 牵连
    // （ambient.enabled 只管"逐条消息掷骰子"那条老路径）
    if (!s.enabled || !s.pause.enabled) return null;
    if (inQuietHours(s.quietHours)) return null;
    const groups = (this.cfg.access?.groups ?? []).map(String);
    if (groups.length && !groups.includes(String(groupId))) return null;

    const recent = this.db.recent(chatKey, 8);
    if (!recent.length) return null;
    // 她自己说的话不算"别人在聊"；纯图片 / 表情 / 语音也不算话题（以前图一发她就看图说话）
    const texts = recent.filter((m) => !m.self).map((m) => String(m.text ?? ''));
    const anyJoinable = texts.some((t) => looksJoinable(t));
    // 聊了好几轮也算"有话题"——别因为最后一句是"哈哈哈"就判死；但得是有文字的几轮
    const enoughTalk = texts.filter((t) => !MEDIA_ONLY.test(t.trim())).length >= 3;
    if (recent.at(-1)?.self) return null; // 群里最后一条还是她自己的：别连着说
    if (!this.shareOk(chatKey)) return null;
    if (!anyJoinable && !enoughTalk) {
      this.stats.pauseTried += 1;
      return null;
    }

    if (!this.#gapOk(groupId, s.ambient.minGapMinutes)) return null;
    this.stats.pauseTried += 1;
    if (Math.random() > (s.pause.sampleRate ?? s.ambient.sampleRate)) return null;
    this.stats.pauseHit += 1;
    if (!this.#hourOk(groupId)) return null;

    const hint = [
      '群里刚聊完一段，现在安静下来了。要开口就只接【最近群里在聊】里这半个小时的内容。',
      '注意：更早的话题已经过去了，不要翻出来；【你刚在群里说过】里的内容说明你已经接过话，别重复。',
      '话题里提到你不确定的东西（游戏、新闻、名词），可以先用 web_search 查一下再说，别猜。',
      '只说一两句短话。别人是两个人在聊、聊的是私事、或是你不熟的游戏细节，就不要插；只有图没有字，也不要描述或点评图。',
      '没把握、或者这个话题你插不上，就只回复大写的 PASS。',
    ].join('\n');
    this.log(`停顿接话：群 ${groupId} 安静 ${s.pause.seconds}s，最近 ${texts.length} 条里可接 ${anyJoinable ? '有' : '无'}，掷骰命中`);
    const out = await this.brain.proactiveSay({ chatKey, groupId, hint });
    if (out) {
      this.setChime(chatKey);
      this.stats.lastChimeAt = Date.now();
    }
    return out;
  }

  /**
   * 给提示词用的"当下这段"对话：
   *   - 只取时间窗口内的消息（默认 30 分钟）
   *   - 遇到太长的中断就截断（之前聊的另一个话题不该被翻出来）
   *   - 排除她自己发的（那些单独给，用来避免重复）
   */
  recent(chatKey) {
    return this.#window(chatKey, false);
  }

  /**
   * 交织时间线：群友的话和她自己的话按真实先后排在一起，
   * 她才看得出"我刚说完 A，然后他们回了 B"。
   *   - self=true 的行是她自己说的
   *   - exclude：触发这次回复的消息（它会在提示词里单独出现，不要重复）
   *     用 { nickname, from, to } 描述，from/to 是合并后的时间范围
   */
  timeline(chatKey, exclude = null) {
    const rows = this.#window(chatKey, true);
    if (!exclude) return rows;
    return rows.filter(
      (r) => !(!r.self && r.nickname === exclude.nickname && r.at >= exclude.from && r.at <= exclude.to),
    );
  }

  #window(chatKey, includeSelf) {
    const windowMin = this.cfg.proactive?.recentWindowMinutes ?? 30;
    const gapMin = this.cfg.proactive?.topicGapMinutes ?? 20;
    const rows = this.db.recent(chatKey, 24).filter((m) => includeSelf || !m.self);
    const now = Date.now();
    const kept = [];
    // 从最新往回走，遇到超过窗口或超过中断阈值就停
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      const m = rows[i];
      const ageMin = (now - Number(m.at ?? 0)) / 60000;
      if (ageMin > windowMin) break;
      const prev = kept.length ? kept[0] : null;
      if (prev && (Number(prev.at) - Number(m.at)) / 60000 > gapMin) break;
      kept.unshift(m);
      if (kept.length >= 12) break;
    }
    if (kept.length) {
      return kept.map((m) => ({ nickname: m.nickname, text: String(m.text).slice(0, 80), at: Number(m.at), self: Boolean(m.self) }));
    }
    // 兜底用内存缓冲，也要守同样的时间窗口：以前这里不看时间，隔了几小时还会把旧消息当"最近在聊"
    const groupId = String(chatKey).split(':')[1];
    const list = (this.buffers.get(groupId) ?? []).filter((m) => (now - Number(m.at ?? 0)) / 60000 <= windowMin);
    return list.slice(-12).map((m) => ({ nickname: m.nickname, text: String(m.text).slice(0, 80), at: Number(m.at) }));
  }

  /** 她在群里说过什么（避免主动开口时把已经接过的话再捡起来） */
  selfSaid(chatKey, limit = 3) {
    return this.db.selfSaid(chatKey, limit);
  }

  /** 记下她自己发出去的一条群消息 */
  rememberSelf(chatKey, text) {
    try {
      this.db.append({
        chatKey,
        groupId: String(chatKey).includes(':') ? String(chatKey).split(':')[1] : null,
        userId: 'self',
        nickname: '我',
        text: String(text ?? '').slice(0, 200),
        at: Date.now(),
        self: true,
      });
    } catch {}
  }

  snapshot() {
    const out = [];
    const seen = new Set();
    for (const [groupId, list] of this.buffers.entries()) {
      seen.add(groupId);
      out.push({
        groupId,
        size: list.length,
        lastAt: list.at(-1)?.at ?? null,
        lastChimeAt: this.getChime(`group:${groupId}`),
        tail: list.slice(-5),
      });
    }
    // 重启后内存是空的，但库里有：把库里的群也列出来
    try {
      const rows = this.db.db.prepare(`SELECT chat_key, count(*) c, max(at) last FROM messages WHERE chat_key LIKE 'group:%' GROUP BY chat_key`).all();
      for (const r of rows) {
        const groupId = String(r.chat_key).split(':')[1];
        if (seen.has(groupId)) continue;
        out.push({
          groupId,
          size: Number(r.c),
          lastAt: Number(r.last),
          lastChimeAt: this.getChime(r.chat_key),
          tail: this.db.recent(r.chat_key, 5),
        });
      }
    } catch {}
    return out;
  }

  /** 主动发言时间：优先库，兜底内存 */
  getChime(chatKey) {
    const fromDb = this.db.getChime(chatKey);
    if (fromDb) return fromDb;
    const groupId = String(chatKey).split(':')[1];
    return this.lastChime.get(groupId) ?? null;
  }

  setChime(chatKey, at = Date.now()) {
    const groupId = String(chatKey).split(':')[1];
    this.lastChime.set(groupId, at);
    this.db.setChime(chatKey, at);
  }

  #hourOk(groupId) {
    const now = Date.now();
    const hits = (this.hourHits.get(groupId) ?? []).filter((t) => now - t < 3600 * 1000);
    if (hits.length >= this.settings.maxPerHour) {
      this.hourHits.set(groupId, hits);
      return false;
    }
    hits.push(now);
    this.hourHits.set(groupId, hits);
    return true;
  }

  #gapOk(groupId, minutes) {
    const last = this.getChime(`group:${groupId}`) ?? 0;
    if (Date.now() - last < minutes * 60 * 1000) return false;
    return true;
  }

  /**
   * 话痨刹车：最近 N 条群消息里她自己占比太高，就先别主动开口了。
   * 真人不会占掉群里 40% 的发言；占比降下来之后才会再接话。
   */
  shareOk(chatKey) {
    const s = this.settings.share;
    if (!(s.maxSelfShare > 0 && s.maxSelfShare < 1)) return true;
    const rows = this.db.recent(chatKey, s.window);
    if (rows.length < 10) return true;
    const mine = rows.filter((m) => m.self).length;
    const ratio = mine / rows.length;
    if (ratio > s.maxSelfShare) {
      this.log(`话痨刹车：最近 ${rows.length} 条里她占了 ${Math.round(ratio * 100)}%（上限 ${Math.round(s.maxSelfShare * 100)}%），这次不主动开口`);
      return false;
    }
    return true;
  }

  #ready(groupId) {
    const s = this.settings;
    if (!s.enabled) return false;
    if (inQuietHours(s.quietHours)) return false;
    const groups = (this.cfg.access?.groups ?? []).map(String);
    if (groups.length && !groups.includes(String(groupId))) return false;
    return true;
  }

  /** 白名单对"主动插话"同样生效：不在名单里的人说十句也触发不了她 */
  #userOk(userId, groupId) {
    const access = this.cfg.access ?? {};
    if (access.proactiveRespectUsers === false) return true; // 显式放行
    // 群成员全开放模式下，白名单群里的任何人说的话都能触发插话
    if ((access.groupMemberScope ?? 'whitelist') === 'group') {
      const groups = (access.groups ?? []).map(String);
      if (!groups.length) return true;
      if (groupId && groups.includes(String(groupId))) return true;
    }
    const users = (access.users ?? []).map(String);
    if (!users.length) return true;
    return users.includes(String(userId));
  }

  /** 没被 @ 的群消息：按采样率决定要不要插一句 */
  async maybeChime(event) {
    const s = this.settings;
    if (!s.enabled || !s.ambient.enabled) return null;
    if (event.kind !== 'group' || event.atMe) return null;
    if (!this.#userOk(event.userId, event.groupId)) return null;
    this.stats.seen += 1;
    this.stats.joinable += looksJoinable(event.text) ? 1 : 0;
    // 默认只走"停顿后决策"，避免同一条消息被两条路径各掷一次骰子
    if (s.pause.enabled) return null;
    if (!looksJoinable(event.text)) return null;
    if (Math.random() > s.ambient.sampleRate) return null;
    this.stats.sampled += 1;
    if (!this.#ready(event.groupId)) return null;
    if (!this.#gapOk(event.groupId, s.ambient.minGapMinutes)) return null;
    if (!this.shareOk(event.chatKey)) return null;
    if (!this.#hourOk(event.groupId)) return null;

    const hint = [
      '群里刚在聊上面的话题，你要是真有话想接就接一句，硬接不如不说。',
      '不想接、没把握、或者话题不适合你，就只回复大写的 PASS。',
    ].join('\n');
    this.log('闲聊采样命中，尝试接话', event.groupId);
    const out = await this.brain.proactiveSay({ chatKey: event.chatKey, groupId: event.groupId, hint });
    if (out) this.setChime(event.chatKey);
    return out;
  }

  /** 定时巡检：群静默 / 私聊久未联系 */
  async sweep() {
    const s = this.settings;
    if (!s.enabled) return;
    if (inQuietHours(s.quietHours)) return;
    if (this.stats.seen > 0) {
      const st = this.stats;
      this.log(
        `主动发言诊断：群消息 ${st.seen} 条，可接 ${st.joinable} 条；停顿决策 ${st.pauseTried} 次、命中 ${st.pauseHit} 次（采样率 ${s.ambient.sampleRate}）`,
      );
      this.stats.seen = 0;
      this.stats.joinable = 0;
      this.stats.sampled = 0;
      this.stats.pauseTried = 0;
      this.stats.pauseHit = 0;
    }
    await this.#sweepGroups(s);
    await this.#sweepPrivate(s);
    await this.#sweepEmail();
  }

  /** 群里安静太久：开个话头（必须总开关 + 静默子开关都开） */
  async #sweepGroups(s) {
    if (!s.idle.enabled) return;
    const groups = (this.cfg.access?.groups ?? []).map(String);
    for (const groupId of groups) {
      const chatKey = `group:${groupId}`;
      if (!this.store.boundSession(chatKey)) continue; // 没聊过的群不主动开口

      // 静默判断优先用库里最后一条消息（重启后仍然有效）
      const lastMsg = this.db.recent(chatKey, 1)[0];
      const buf = this.buffers.get(groupId) ?? [];
      const last = lastMsg?.at ?? buf.at(-1)?.at ?? null;
      if (!last) continue;
      const idleMin = (Date.now() - last) / 60000;
      if (idleMin < s.idle.minutes) continue;
      if (idleMin > s.idle.maxSilenceHours * 60) continue;
      // 她上一句没人理（群里最后一条还是她自己的）：别再自说自话
      if (s.idle.skipIfUnanswered && lastMsg?.self) {
        if (!this.unansweredLogged.has(chatKey)) {
          this.unansweredLogged.add(chatKey);
          this.log(`群 ${groupId} 里最后一条还是她自己的，没人接，暂不暖场`);
        }
        continue;
      }
      this.unansweredLogged.delete(chatKey);
      // 每天暖场次数上限
      const dayKey = `idle:${chatKey}:${new Date().toISOString().slice(0, 10)}`;
      const todayCount = Number(this.db.getKv(dayKey) ?? 0);
      if (s.idle.maxPerDay > 0 && todayCount >= s.idle.maxPerDay) continue;
      if (!this.#gapOk(groupId, 60)) continue;

      // 还在"最近话题"窗口内才让她接旧话题；已经隔了很久（默认静默 45 分钟 > 窗口 30 分钟，几乎总是这种）
      // 之前聊的早就翻篇了，再接就是翻旧账，不能接
      const fresh = this.timeline(chatKey).filter((r) => !r.self);
      let hint;
      let requireTool = false;
      let biliNotes = null;
      let biliCandidates = null;
      if (fresh.length) {
        hint = [
          '群里已经安静挺久了。要开口的话，请**接着上面最近的话题**，或者提一件跟群里某个人有关的具体小事。',
          '不要发"在吗""大家好"这种没内容的招呼；实在没有可接的，就只回复大写的 PASS。',
        ].join('\n');
      } else if (s.idle.discover) {
        // 两次"带新东西来"之间隔开一段时间，一天里别刷屏式分享
        const gapKey = `discover:last:${chatKey}`;
        const lastDiscover = Number(this.db.getKv(gapKey) ?? 0);
        if (Date.now() - lastDiscover < s.idle.discoverGapHours * 3600 * 1000) continue;
        const clues = this.interestClues(chatKey);
        if (!clues.length) {
          this.log(`群 ${groupId} 冷场了，但没有群友爱好线索可以去找新鲜内容，不暖场`);
          continue;
        }
        // 优先走 B 站：系统先按群友爱好搜好真实视频，她只负责挑一个、说两句、发卡片
        let cands = [];
        try {
          cands = (await this.brain.biliDiscover?.(chatKey, this.interestGroups(chatKey))) ?? [];
        } catch (err) {
          this.log('B站找内容失败:', err?.message ?? err);
        }
        if (cands.length) {
          hint = this.biliDiscoverHint(idleMin, clues);
          biliNotes = this.biliCandidateNotes(cands);
          biliCandidates = cands.map((c) => c.bvid);
        } else {
          hint = this.discoverHint(idleMin, clues);
          requireTool = true;
        }
      } else {
        hint = [
          `群里已经 ${Math.round(idleMin)} 分钟没人说话了，之前聊的事早就翻篇了——不要接、不要提之前的话题，那样会显得很尴尬。`,
          '要开口的话，只能开一个有具体内容的新话头（一个具体的问题、一件具体的事），不要发"在吗""困了""刚醒""吃饭了吗"这种没内容的话，也不要编造自己刚做了什么。',
          '没有真想说的就只回复大写的 PASS，沉默比硬聊更好。',
        ].join('\n');
      }
      if (!this.#hourOk(groupId)) continue;
      this.log('群静默触发主动发言', { groupId, idleMin: Math.round(idleMin), mode: biliCandidates ? 'bili' : requireTool ? 'discover' : fresh.length ? 'topic' : 'new' });
      const out = await this.brain.proactiveSay({ chatKey, groupId, hint, requireTool, biliNotes, biliCandidates });
      if (out) {
        this.setChime(chatKey);
        this.db.setKv(dayKey, todayCount + 1);
        if (biliCandidates || requireTool) this.db.setKv(`discover:last:${chatKey}`, Date.now());
      }
      await sleep(500);
    }
  }

  /** 群友的爱好线索：近一周说过话的人的画像（特质 / 事实）+ 这个群的梗，给"找新鲜内容"用 */
  interestClues(chatKey) {
    const clues = [];
    try {
      const selfId = String(this.brain.onebot?.selfId ?? '');
      const people = this.db.participants?.(chatKey, 7 * 24 * 3600 * 1000, 6) ?? [];
      for (const p of people) {
        if (selfId && String(p.userId) === selfId) continue;
        const prof = this.store.profile?.(p.userId, p.nickname);
        const bits = [...(prof?.traits ?? []).slice(0, 3), ...(prof?.facts ?? []).slice(-4)].join('；');
        if (bits) clues.push(`- ${p.nickname}：${bits.slice(0, 110)}`);
      }
      const notes = this.brain.groupMemory?.notesFor?.(chatKey);
      for (const t of [...(notes?.lore ?? []).slice(0, 5), ...(notes?.relations ?? []).slice(0, 4)]) clues.push(`- 群里：${String(t).slice(0, 70)}`);
    } catch (err) {
      this.log('整理群友爱好线索失败:', err?.message ?? err);
    }
    return clues.slice(0, 12);
  }

  /** 群友的爱好词（给 B 站搜索用）：[{ nickname, words:[...] }]，近一周说过话的人，不含她自己 */
  interestGroups(chatKey) {
    const out = [];
    try {
      const selfId = String(this.brain.onebot?.selfId ?? '');
      const people = this.db.participants?.(chatKey, 7 * 24 * 3600 * 1000, 6) ?? [];
      for (const p of people) {
        if (selfId && String(p.userId) === selfId) continue;
        const prof = this.store.profile?.(p.userId, p.nickname);
        // 事实比特质更具体（"在玩影之刃零"比"爱玩游戏"好搜），先排事实，且取最近的
        const words = interestWords([...(prof?.facts ?? []).slice(-4).reverse(), ...(prof?.traits ?? []).slice(0, 3)]);
        if (words.length) out.push({ nickname: p.nickname, words });
      }
    } catch (err) {
      this.log('整理爱好词失败:', err?.message ?? err);
    }
    return out;
  }

  /** B 站候选视频的说明行（放进提示词的"系统帮你查到的内容"） */
  biliCandidateNotes(cands) {
    return [
      '你刚按群友的爱好在 B 站搜到了这几个视频（真实存在）：',
      ...cands.map((c) => `  ${describeVideo(c, { withDesc: false })}——搜「${c.keyword}」得到，和 ${c.who} 的爱好有关`),
      '※ 从里面选一个最适合分享的，在回复里写 [[B站:BV号]]（只能用上面列出的 BV 号）。',
    ];
  }

  /** B 站发现型暖场提示：挑一个、说两句、发卡片 */
  biliDiscoverHint(idleMin, clues) {
    return [
      `群里已经 ${Math.round(idleMin)} 分钟没人说话了，之前聊的事早就翻篇了——不要接、不要提之前的话题，那样会显得很尴尬。`,
      '这次你开口是"随手转一个视频给群友"，不是闲聊。照这个做：',
      '1. 看上面【系统帮你查到的内容】里的候选视频，选一个群里多半会觉得有意思的。面向整个群说，不要点某个人的名字，更不要说"这标题像你""给你的"这类暗指某人的话。',
      '2. 用一两句话说你为什么转它、哪里有意思，像朋友随手转发那样；只能说列表里看得到的信息（标题、UP 主、时长、播放量），没看过的内容别说成你看过。',
      '3. 回复里写上 [[B站:BV号]]，系统会发一张真正的 B 站视频卡片，不要自己贴链接。',
      '4. 没有一个合适的，就只回复大写的 PASS。不要发"在吗""困了""刚睡醒"这种没内容的话，也不要编造你自己刚做了什么。',
      '',
      '【群友爱好线索】（只是线索，别照着念；别把私人的事说出来）',
      ...clues,
    ].join('\n');
  }

  /** 冷场暖场的"带点新东西来"提示：不闲聊，找一条真实存在、和某个群友爱好对得上的内容 */
  discoverHint(idleMin, clues) {
    return [
      `群里已经 ${Math.round(idleMin)} 分钟没人说话了，之前聊的事早就翻篇了——不要接、不要提之前的话题（包括你记忆里"最近在聊"的内容），那样会显得很尴尬。`,
      '这次你开口不是闲聊，是"带点新东西来"。照这个顺序做：',
      '1. 从下面的【群友爱好线索】里挑一个具体的人、一个具体的爱好（游戏、角色、UP 主、话题都行）。',
      '2. 用 web_search 找一条**近期真实存在**的相关内容：B站视频、小红书笔记、新闻、攻略都行，搜索词里可以带上"B站"或"小红书"；需要时再用 web_fetch 读一下。',
      '3. 发出来的话要包含：这是什么（标题或一句话概括）、链接（只能用搜索结果里真实出现过的，绝对不能编）、你觉得它哪里对 TA 有意思；面向整个群说，不要点名，也不要用"像你""给你的"暗指某个人。',
      '4. 小红书的页面经常读不到正文：读不到就只说搜索结果里看得到的标题和摘要，不要编内容。',
      '5. 没搜到靠谱的、或者对不上谁的爱好，就只回复大写的 PASS。宁可不说，也不要发"在吗""困了""刚睡醒""吃饭了吗"这种没内容的话。',
      '不要编造你自己刚做了什么（趴了一会儿、刚醒、刚吃完之类），你没有真实的生活可以汇报。',
      '',
      '【群友爱好线索】（只是线索，别照着念；别把私人的事说出来）',
      ...clues,
    ].join('\n');
  }

  /**
   * 邮件巡查：按间隔让"主人私聊"那个会话去查一次邮箱。
   * 重要邮件才私信过来；没有就 PASS。上次检查时间落库，重启不会立刻重查。
   */
  async #sweepEmail() {
    const mail = this.cfg.mail ?? {};
    if (mail.enabled !== true) return; // 默认关闭，必须显式开
    const everyMin = Math.max(5, Number(mail.watchMinutes ?? 30));
    const owner = String(this.cfg.bot?.ownerId ?? '');
    if (!owner) return;

    const last = Number(this.db.getKv('mail:lastCheck') ?? 0);
    if (Date.now() - last < everyMin * 60000) return;

    const chatKey = `private:${owner}`;
    if (!this.store.boundSession(chatKey)) return; // 还没聊过，不主动查

    let nickname = '我';
    try {
      nickname = this.store.readProfile?.(owner)?.nickname ?? nickname;
    } catch {}

    this.db.setKv('mail:lastCheck', Date.now());
    const hint = [
      `邮件巡查：用 mail_find 看一下最近 ${everyMin} 分钟收到的邮件（未读优先）。`,
      '重要的（工作安排、账单、验证码、需要回复的、认识的真人发来的）用一两句话告诉他是什么事、要不要处理；',
      '广告、通知、订阅、推广一律不提。可以先用 mail_read 看清楚再判断。',
      '没有重要的就只回复大写的 PASS。注意：你只能读邮件，不能发邮件。',
    ].join('\n');
    this.log(`邮件巡查：检查最近 ${everyMin} 分钟的邮件`);
    const out = await this.brain.proactivePrivateSay({ chatKey, userId: owner, nickname, hint });
    if (out) this.log('邮件巡查：已把重要邮件告诉他');
    return out;
  }

  #privateDayOk(userId) {
    // 窗口内的记录从库里取，重启不会把"今天已经找过"清零
    const fromDb = this.db.privateHits(userId, 24 * 3600 * 1000);
    const mem = (this.privateHits.get(userId) ?? []).filter((t) => Date.now() - t < 24 * 3600 * 1000);
    return fromDb.length + mem.length === 0;
  }

  #markPrivate(userId) {
    const list = this.privateHits.get(userId) ?? [];
    list.push(Date.now());
    this.privateHits.set(userId, list);
    this.db.addPrivateHit(userId);
  }

  /** 私聊里主动找久未联系的人（默认关闭） */
  async #sweepPrivate(s) {
    if (!s.private.enabled) return;
    const profiles = this.store.listProfiles() ?? [];
    let sent = 0;
    for (const p of profiles) {
      if (sent >= s.private.maxPerDay) break;
      if ((p.interactions ?? 0) < 1) continue;
      const chatKey = `private:${p.userId}`;
      if (!this.store.boundSession(chatKey)) continue;
      const last = p.lastSeen ? new Date(p.lastSeen).getTime() : 0;
      if (!last) continue;
      if (Date.now() - last < s.private.idleHours * 3600 * 1000) continue;
      if (!this.#privateDayOk(p.userId)) continue;

      const hint = [
        `你想起 ${p.nickname} 了，她/他已经 ${Math.round((Date.now() - last) / 3600000)} 小时没说话了。`,
        '如果要开口，请**基于你记得的这个人**：提起上次聊过的事、问问近况，或者你记得的他的小习惯。',
        '不要说空话套话；没有由头就只回复大写的 PASS。',
      ].join('\n');
      this.log('私聊主动触发', { userId: p.userId, idleHours: Math.round((Date.now() - last) / 3600000) });
      const out = await this.brain.proactivePrivateSay({ chatKey, userId: p.userId, nickname: p.nickname, hint });
      if (out) {
        sent += 1;
        this.#markPrivate(p.userId);
      }
      await sleep(800);
    }
  }
}


