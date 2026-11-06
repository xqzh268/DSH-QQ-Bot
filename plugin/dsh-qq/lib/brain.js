/**
 * 大脑（插件版）：准入 → 组装提示 → 投递到 DSH 会话 → 等这一轮结束 → 取正文 → 回 QQ。
 *
 * 关键接口（按宿主实测契约）：
 *   agents.create({ sessionId, meta:{cwd, agentPreset}, setup })  -> { agent }
 *   agents.get(id)                                              -> Agent
 *   agent.followup({ id, role:'user', content:[{type:'text',text}], source:{kind:'user'} })
 *   agent.session.snapshotEvents()                              -> 事件数组
 * 事件形状：
 *   user/message      data.content[{type:'text',text}]
 *   assistant/message data.{turn,step,message.content[{type:'text'|'reasoning',text}]}
 *   turn/end          data.reason.kind = 'completed' | 'error' | ...
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildPrompt, buildSystemPrompt, splitMemo, splitReply } from './prompt.js';
import { StickerStore } from './stickers.js';
import { fetchAvatar, asksAboutAvatar } from './avatars.js';
import { needsTiling, tileImage } from './imgtile.js';
import { planBubbles, typingDelay, bubbleGap, polishText, paceFactor } from './humanize.js';
import { BiliClient, buildBiliCard, biliUrl, describeVideo, extractBiliMarkers, pickDiscoverCandidates } from './bili.js';
import { LinkReader } from './links.js';
import { toSegments, stripFaceMarks, extractReactMarkers, reactionId } from './faces.js';
import { cleanReply, varyTics } from './sanitize.js';

/** 私聊里明确喊停：只认整句就是这种话（"等等""先别说""停一下""不是这个意思"） */
export const INTERRUPT_RE = /^(?:等等|等一下|先别(?:说|发|回)?|停(?:一下)?|打住|别说了|不是这个意思)[\s！!。.…？?~～]*$/;

/** "帮我在B站找找/推荐点XX视频"这类明确要找视频的请求；取出要搜的关键词（取不出返回空串） */
export function biliSearchQuery(text) {
  const s = String(text ?? '').replace(/@\S+\s*/g, '').replace(/\[[^\]]*\]/g, ' ').trim();
  const asks =
    /(?:推荐|找|搜|来点|来几个|有没有|给我|整点).{0,14}(?:视频|B站|b站|bilibili|哔哩哔哩|up主|UP主)|(?:B站|b站|bilibili|哔哩哔哩).{0,12}(?:推荐|找|搜|有什么|有没有|看看|上)/i;
  if (!asks.test(s)) return '';
  const q = s
    .replace(/[，。！？,.!?~、：:；;]/g, ' ')
    .replace(/(?:帮我|给我|麻烦|请|能不能|可以|你)?(?:在)?(?:B站|b站|bilibili|哔哩哔哩)(?:上)?/gi, ' ')
    .replace(/帮我|给我|麻烦|请|帮|推荐|找找?|搜搜?|来点|来几个|整点|有没有|有什么|看看|一下|几个|一些|点|个|的|相关|关于|视频|up主|UP主|吗|呢|吧|啊|呀|我|你/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return q.length >= 2 && q.length <= 24 ? q : '';
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** followUps 里表示"她主动开口后、对任何人开放"的占位 userId */
const OPEN_WINDOW = '*';

/** 从回复里摘出 [[表情:关键词]] 标记，返回干净正文与要发的关键词 */
export function extractStickerMarkers(text) {
  const keywords = [];
  const clean = String(text ?? '').replace(/\[\[\s*表情\s*[:：]\s*([^\]]{1,24})\s*\]\]/g, (_m, kw) => {
    keywords.push(String(kw).trim());
    return '';
  });
  return { clean: clean.replace(/\n{3,}/g, '\n\n').trim(), keywords };
}

/**
 * 要不要引用回复。
 * 立刻回 → 不引用（真人不会对着刚说完的话再引用一遍）；
 * 中间插进来别人的话 → 引用，否则看不出在回谁。
 */
export function shouldQuoteReply(event, laterCount = 0) {
  if (!event || event.kind !== 'group') return false;
  if (!event.messageId) return false;
  return Number(laterCount) >= 1;
}

/** 从回复里摘出 [[标签:词1, 词2]] —— 她看过图之后给这张图打的语义标签 */
export function extractTagMarkers(text) {
  const tags = [];
  const clean = String(text ?? '').replace(/\[\[\s*标签\s*[:：]\s*([^\]]{1,80})\s*\]\]/g, (_m, list) => {
    for (const t of String(list).split(/[,，、\s]+/)) {
      const w = t.trim();
      if (w) tags.push(w);
    }
    return '';
  });
  return { clean, tags };
}

/**
 * turn/end 的 reason 有两种形状：字符串 'error'|'aborted'|'stop'，或 {kind:'error'|'aborted'}。
 * 宿主 0.2.x 两种都会出现，漏判一种就会把失败当成功、发出半截空回复。
 */
function classifyReason(reason) {
  if (!reason) return 'unknown';
  if (typeof reason === 'string') return reason;
  return reason.kind ?? 'unknown';
}

export class Brain {
  constructor({ ctx, onebot, store, log }) {
    this.ctx = ctx;
    this.onebot = onebot;
    this.store = store;
    this.log = log;
    this.cfg = store.cfg ?? {};
    this.persona = null;
    this.agents = null;
    /** 本通道创建/接管的会话，用于工具白名单作用域 */
    this.qqAgents = new Set();
    /** 已经把静态人设注册进系统提示词的会话 */
    this.systemPromptAgents = new Set();
    /** 本进程自己创建的会话（走过 setup）；重启前遗留的绑定不在其中 */
    this.createdHere = new Set();
    /** 群里没轮到她回应时别人发的图（chatKey → [{...note, earlier:{nickname,at}, used}]）。QQ 图片链接会过期，所以收到就先下载 */
    this.seenImages = new Map();
    /** 每个会话最近用过的 QQ 表情（[id, 时间]），做冷却用 */
    this.faceHistory = new Map();
    /** 私聊里对方喊停的时间（chatKey → 时间戳） */
    this.interrupts = new Map();
    /** B 站只读客户端 + 链接解析（B 站视频 / 小红书笔记）。只读、不登录 */
    this.bili = new BiliClient({ log });
    this.links = new LinkReader({ bili: this.bili, log, xhs: this.cfg.links?.xhs !== false });
    /** 被动限流：同人冷却 / 每群每小时 */
    this.lastReplyByUser = new Map();
    this.hourHits = new Map();
    /** 表情包库（与消息库共用 data/qq-messages.db） */
    this.stickers = new StickerStore(store.dir, log);
    /** 当前是谁在跟这个会话说话（工具闸用它判断能否访问工作区外） */
    this.speakers = new Map();
    /** 每个会话一条串行队列：chatKey -> 队尾 Promise */
    this.chatQueues = new Map();
    /** 连发合并：`chatKey|userId` -> 等待中的事件 */
    this.debounce = new Map();
    /** 对话延续：chatKey -> { userId, at, count } */
    this.followUps = new Map();
  }

  /**
   * 决定会话用哪个模型：优先插件配置（plugin.model），没配/配不全就跟随宿主默认。
   * 返回 null 表示"没有任何可用选择"，调用方据此不传 agentOptions。
   */
  static resolveModel(configured = {}, hostSelection = null) {
    const pick = (v) => String(v ?? '').trim();
    const provider = pick(configured?.provider) || pick(hostSelection?.provider);
    const model = pick(configured?.model) || pick(hostSelection?.model);
    const effort = pick(configured?.reasoningEffort) || pick(hostSelection?.reasoningEffort);
    if (!provider || !model) return null;
    return { provider, model, ...(effort && effort !== 'off' ? { reasoningEffort: effort } : {}) };
  }

  get ready() {
    return Boolean(this.agents && this.persona);
  }

  /** 只读工具额外允许的目录：表情包库（她需要能看自己收藏的图） */
  extraReadRoots() {
    try {
      return [join(this.store.dir, 'data', 'stickers')];
    } catch {
      return [];
    }
  }

  /** 当前发言人：{ userId, kind, groupId } */
  speakerFor(agentId) {
    return this.speakers.get(String(agentId)) ?? null;
  }

  /** 当前用的模型（设置页展示用） */
  currentModel() {
    const host = this.#hostSelection();
    return {
      host,
      configured: this.cfg.plugin?.model ?? {},
      effective: Brain.resolveModel(this.cfg.plugin?.model ?? {}, host),
    };
  }

  /** 解绑所有 QQ 会话：换模型后需要重建才生效 */
  resetSessions() {
    const all = this.store.bindings?.() ?? {};
    const keys = Object.keys(all);
    for (const key of keys) {
      try {
        this.store.unbind(key);
      } catch {}
      const sid = all[key]?.sessionId;
      if (sid) this.qqAgents.delete(String(sid));
    }
    this.log(`已解绑 ${keys.length} 个会话，下条消息会按新配置重建`);
    return keys.length;
  }

  isQqAgent(agentId) {
    return Boolean(agentId) && this.qqAgents.has(String(agentId));
  }

  init({ agents }) {
    this.agents = agents;
    this.persona = this.store.persona();
    this.log(`角色卡已加载：${this.persona.name}`);
    return this;
  }

  /** 关键词命中：子串匹配、忽略大小写和首尾空格 */
  static keywordHit(text, keywords = []) {
    const body = String(text ?? '').toLowerCase();
    return (keywords ?? []).some((k) => {
      const w = String(k ?? '').trim().toLowerCase();
      return w.length > 0 && body.includes(w);
    });
  }

  // ---------- 准入 ----------
  decide(event) {
    const access = this.cfg.access ?? {};
    const groups = (access.groups ?? []).map(String);
    const users = (access.users ?? []).map(String);
    // groupMemberScope:
    //   'whitelist'（默认）= 群成员也要在 users 名单里
    //   'group'           = 白名单群里的所有成员都能互动，不用逐个填 QQ 号
    //                       （私聊仍然只认 users 名单）
    const openToMembers = (access.groupMemberScope ?? 'whitelist') === 'group';
    const inGroup = event.groupId ? !groups.length || groups.includes(String(event.groupId)) : false;

    if (event.kind === 'private') {
      if (access.replyPrivate === false) return { ok: false, why: '私聊已关闭' };
      if (users.length && !users.includes(event.userId)) return { ok: false, why: '私聊白名单外' };
      return { ok: true };
    }
    if (event.kind === 'group') {
      if (groups.length && !groups.includes(event.groupId)) return { ok: false, why: '群不在白名单' };
      if (!openToMembers && users.length && !users.includes(event.userId)) return { ok: false, why: '人不在白名单' };
      if (event.atMe) return { ok: true };
      const trigger = access.groupTrigger ?? 'at';
      if (trigger === 'always') return { ok: true };
      if (trigger === 'smart' && Brain.keywordHit(event.text, access.keywords)) return { ok: true };
      if (this.#isFollowUp(event)) return { ok: true, followUp: true };
      return { ok: false, why: '没被 @' };
    }
    if (event.kind === 'poke') {
      if (groups.length && event.groupId && !groups.includes(event.groupId)) return { ok: false, why: '群不在白名单' };
      // 戳一戳以前只查群不查人：群里任何人都能戳她、把她叫出来
      if (!openToMembers && users.length && !users.includes(event.userId)) return { ok: false, why: '戳一戳的人不在白名单' };
      return { ok: true };
    }
    return { ok: false, why: '未知事件' };
  }

  // ---------- 会话 ----------
  async ensureAgent(chatKey, event) {
    const bound = this.store.boundSession(chatKey);
    if (bound) {
      const existing = this.agents.get(bound);
      // 绑定的会话可能已经不在宿主的 store 里（重启/被回收），
      // 这时对象还在但一投递就报 "not live"。先探一下，别等它炸。
      // 只沿用"本进程自己创建"的会话：重启后沿用的旧会话没跑过 setup，
      // 既没有人设系统提示词段（于是每条消息都得重发整份人设），工具挂载情况也无从确认。
      const ours = this.createdHere.has(String(bound));
      if (existing && this.#isLive(existing) && ours) {
        this.qqAgents.add(String(bound));
        return existing;
      }
      this.log(
        `绑定 ${chatKey} -> ${bound} ${!ours && existing ? '是重启前遗留的会话（没挂载人设与工具）' : '已失效'}${existing && ours ? '（会话不 live）' : ''}，解绑重建`,
      );
      try {
        this.store.unbind(chatKey);
      } catch {}
      this.qqAgents.delete(String(bound));
    }

    const sessionId = `session-${randomUUID()}`;
    const cwd = this.workspaceDir();
    const presetId = this.cfg.plugin?.agentPreset ?? this.#rosterDefault();
    // 不显式给 provider/model 时，某些宿主版本会直接报 "agent has no provider/model"，
    // 所以能读就带上；读不到就交给宿主默认。
    const agentOptions = this.#defaultModel();
    // 关键：不 mount preset，这个会话一个工具都没有（宿主实测契约）
    const handle = await this.#createWithFallback(chatKey, {
      sessionId,
      meta: { cwd, ...(presetId ? { agentPreset: presetId } : {}) },
      agentOptions,
    });
    const agent = handle?.agent ?? handle;
    if (!agent) throw new Error('agents.create 没有返回 agent');
    this.qqAgents.add(String(sessionId));
    this.createdHere.add(String(sessionId));
    this.store.bind(chatKey, sessionId);
    this.log(`为 ${chatKey} 新建会话 ${sessionId}（cwd=${cwd}, preset=${presetId ?? '默认'}）`);
    await this.attachWorkspace(cwd, sessionId);
    return agent;
  }

  /** 探活：能读到会话事件才算活着 */
  #isLive(agent) {
    try {
      const events = agent?.session?.snapshotEvents?.();
      return Array.isArray(events);
    } catch {
      return false;
    }
  }

  /** 宿主里配置的默认 preset id */
  #rosterDefault() {
    try {
      return this.ctx.get('agentPresets')?.defaultId ?? undefined;
    } catch {
      return undefined;
    }
  }

  /** 宿主里配置的默认模型（拿不到就返回 undefined，交给宿主决定） */
  #hostSelection() {
    try {
      return this.ctx.get('agentDefaultModel')?.currentSelection?.() ?? null;
    } catch {
      return null;
    }
  }

  #defaultModel() {
    const resolved = Brain.resolveModel(this.cfg.plugin?.model ?? {}, this.#hostSelection());
    return resolved ?? undefined;
  }

  /**
   * 创建会话；如果用的是自定义模型且失败（provider/model id 写错），
   * 回退到宿主默认再试一次，别让整条消息因为配置笔误丢掉。
   */
  async #createWithFallback(chatKey, input) {
    // mount=false：不挂 preset，也不注册人设——这个会话没有任何工具（总结用）
    const setup = input.mount === false ? () => {} : (agentCtx, agent) => this.mountPreset(agentCtx, agent, input.sessionId);
    try {
      return await this.agents.create({
        sessionId: input.sessionId,
        meta: input.meta,
        ...(input.agentOptions ? { agentOptions: input.agentOptions } : {}),
        setup,
      });
    } catch (err) {
      const host = this.#hostSelection();
      const hostOptions = host?.provider && host?.model ? { provider: host.provider, model: host.model } : null;
      const usedCustom = Boolean(this.cfg.plugin?.model?.provider || this.cfg.plugin?.model?.model);
      if (!usedCustom || !hostOptions) throw err;
      this.log(`自定义模型不可用（${err?.message ?? err}），回退到宿主默认 ${hostOptions.provider}/${hostOptions.model}`);
      return await this.agents.create({
        sessionId: input.sessionId,
        meta: input.meta,
        agentOptions: hostOptions,
        setup,
      });
    }
  }

  /**
   * 一次性问模型一个问题（群记忆总结用），返回正文或 null。
   * 用独立的无工具会话，不进任何群聊会话的历史；会话用 10 次后换新的，免得历史越攒越长。
   * 调用串行，避免同一个总结会话里两轮交错。
   */
  askOnce(prompt, timeoutMs = 120000) {
    const run = (this.askChain ?? Promise.resolve()).catch(() => {}).then(() => this.#askNow(prompt, timeoutMs));
    this.askChain = run.catch(() => {});
    return run;
  }

  async #askNow(prompt, timeoutMs) {
    try {
      if (!this.summarizer || this.summarizer.uses >= 10) {
        const sessionId = `session-${randomUUID()}`;
        const cwd = this.workspaceDir();
        const handle = await this.#createWithFallback('summary', {
          sessionId,
          meta: { cwd },
          agentOptions: this.#defaultModel(),
          mount: false,
        });
        const agent = handle?.agent ?? handle;
        if (!agent) throw new Error('agents.create 没有返回 agent');
        await this.attachWorkspace(cwd, sessionId);
        this.summarizer = { agent, uses: 0 };
      }
      const { agent } = this.summarizer;
      this.summarizer.uses += 1;
      const before = this.currentTurn(agent);
      agent.followup({ id: randomUUID(), role: 'user', content: [{ type: 'text', text: prompt }], source: { kind: 'user' } });
      const finished = await this.waitForTurnEnd(agent, before, timeoutMs);
      if (!finished) return null;
      const kind = classifyReason(finished.reason);
      if (kind === 'error' || kind === 'aborted') {
        this.summarizer = null; // 出错的会话不再复用
        return null;
      }
      return this.textOfTurn(agent, finished.turn) || null;
    } catch (err) {
      this.summarizer = null;
      this.log('askOnce 失败:', err?.message ?? err);
      return null;
    }
  }

  /** QQ 会话的工作目录：一切都是相对的，文件工具被沙箱钉在这里 */
  workspaceDir() {
    const dir = this.cfg.plugin?.workspaceDir ?? join(this.store.dir, 'qq-sandbox');
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** 挂载 preset（提工具与提示词段落）；失败不能让整条链断 */
  async mountPreset(agentCtx, agent, sessionId = '') {
    try {
      const presets = agentCtx?.get?.('agentPresets') ?? this.ctx.get('agentPresets');
      if (!presets?.mount) {
        this.log('没有 agentPresets.mount，会话将没有工具');
      } else {
        const presetId = agent?.session?.header?.agentPreset ?? this.cfg.plugin?.agentPreset;
        await presets.mount(agentCtx, presetId);
        this.log(`preset 已挂载：${presetId ?? '(默认)'}`);
      }
    } catch (err) {
      this.log('preset mount 失败:', err?.message ?? err);
    }

    // 人设与规则注册进**系统提示词**（挂在 agent 自己的 scope 上，只影响这个会话）。
    // 这样每条消息不用再重复整份人设，历史里也不会累积。
    try {
      const sp = agentCtx?.systemPrompt;
      if (sp?.section) {
        sp.section({ name: 'qq:persona', order: 20, text: buildSystemPrompt(this.persona) });
        // setup 的 agent 参数是可选的（创建期间可能还没有）；Agent.id 就是 SessionId，
        // 拿不到 agent 时用创建时就已知的 sessionId，否则会误判"人设没进系统提示词"，
        // 结果每条消息又把整份人设重复发一遍。
        const id = String(agent?.id ?? agent?.session?.header?.id ?? sessionId ?? '');
        if (id) this.systemPromptAgents.add(id);
        this.log('人设已注册为系统提示词段（不再逐条重复）');
      } else {
        this.log('systemPrompt.section 不可用，回落到逐条发送整份人设');
      }
    } catch (err) {
      this.log('注册系统提示词段失败，回落到逐条发送:', err?.message ?? err);
    }
  }

  /** 把会话挂到工作区，否则 GUI 侧栏里会掉进"未分组" */
  async attachWorkspace(cwd, sessionId) {
    try {
      const registry = this.ctx.get('workspaceRegistry');
      if (!registry) return;
      let workspace = (await registry.resolveByPath?.(cwd)) ?? null;
      if (!workspace && registry.create) workspace = await registry.create(cwd);
      await workspace?.attachSession?.(sessionId);
    } catch (err) {
      this.log('工作区归组失败（不影响对话）:', err?.message ?? err);
    }
  }

  /** 当前事件日志里最大的 turn 号 */
  currentTurn(agent) {
    const events = agent.session?.snapshotEvents?.() ?? [];
    let turn = 0;
    for (const e of events) {
      if (e.type === 'turn/start' || e.type === 'turn/end') turn = Math.max(turn, e.data?.turn ?? 0);
    }
    return turn;
  }

  /**
   * 等这一轮结束；返回 {turn, reason} 或 null（超时）。
   * timeoutMs 是"空闲超时"：会话日志里一直没有新事件超过这么久才算卡死；
   * 只要她还在读图、调工具（不断产生新事件）就继续等，但总时长不超过 maxMs。
   * 以前是硬等 timeoutMs：她读 3 张头像用了 229 秒，回复生成了却因为超过 180 秒被丢掉，没发出去。
   */
  async waitForTurnEnd(agent, afterTurn, timeoutMs = 180000, maxMs = timeoutMs) {
    const started = Date.now();
    let lastCount = -1;
    let lastChange = started;
    while (Date.now() - started < maxMs) {
      const events = agent.session?.snapshotEvents?.() ?? [];
      if (events.length !== lastCount) {
        lastCount = events.length;
        lastChange = Date.now();
      } else if (Date.now() - lastChange >= timeoutMs) {
        return null; // 太久没动静
      }
      for (let i = events.length - 1; i >= 0; i -= 1) {
        const e = events[i];
        if (e.type === 'turn/end' && (e.data?.turn ?? 0) > afterTurn) {
          return { turn: e.data.turn, reason: e.data.reason ?? { kind: 'unknown' } };
        }
      }
      await sleep(400);
    }
    return null;
  }

  /** 取某一轮里助手说出来的正文（跳过思考块） */
  textOfTurn(agent, turn) {
    const events = agent.session?.snapshotEvents?.() ?? [];
    const paragraphs = [];
    for (const e of events) {
      if (e.type !== 'assistant/message') continue;
      if (turn && (e.data?.turn ?? 0) !== turn) continue;
      const blocks = e.data?.message?.content ?? [];
      const text = blocks
        .filter((b) => b?.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text)
        .join('')
        .trim();
      if (text) paragraphs.push(text);
    }
    return paragraphs.join('\n').trim();
  }

  // ---------- 主流程 ----------
  /**
   * 对外入口：同一个会话（chatKey）的消息严格串行处理。
   * 否则同群两个人连续 @ 她时，两次 followup 打进同一个 agent，
   * waitForTurnEnd 会把第一轮的结束当成第二轮的结束，回复错位。
   */
  handle(event, opts = {}) {
    // 私聊里对方明确喊停（"等等""先别说""停"）：记一笔，正在一条条发的气泡会据此停下
    if (!opts.proactive && event?.kind === 'private' && INTERRUPT_RE.test(String(event.text ?? '').trim())) {
      this.interrupts.set(String(event.chatKey), Date.now());
    }
    // 被戳也要先进会话队列再处理（戳回去/回一句都在队列里做，见 #handleNow）。
    // 以前是"先同步等戳回去、再入队"：这几秒里她自己的主动接话先排进去了，
    // 于是戳一戳被甩到好几句话之后才回，回的还是"刚被戳"的口气。
    const wait = Number(this.cfg.humanize?.debounceMs ?? 1800);
    // 这条消息不需要她回应时，图也先存下来：过一会儿有人问"你看这张图"，她才有东西可看
    if (!opts.proactive && event?.groupId && event.kind !== 'poke' && Array.isArray(event.images) && event.images.length && !this.decide(event).ok) {
      this.#rememberImages(event);
    }
    // 主动发言、戳一戳、没打算回应的消息都不需要等；只有"要回应"的消息才合并
    if (opts.proactive || wait <= 0 || !event || event.kind === 'poke' || !this.decide(event).ok) {
      return this.#enqueue(event, opts);
    }
    return this.#debounced(event, opts, wait);
  }

  /** 同一个人在 wait 毫秒内连发的几条，合并成一次输入（真人连发三句，她不该答三次，更不该丢两句） */
  #debounced(event, opts, wait) {
    const key = `${event.chatKey}|${event.userId}`;
    const maxWait = Number(this.cfg.humanize?.debounceMaxMs ?? 6000);
    return new Promise((resolve, reject) => {
      let slot = this.debounce.get(key);
      const now = Date.now();
      if (!slot) {
        slot = { events: [], waiters: [], firstAt: now, timer: null };
        this.debounce.set(key, slot);
      }
      slot.events.push(event);
      slot.waiters.push({ resolve, reject });
      clearTimeout(slot.timer);
      const delay = Math.max(0, Math.min(wait, slot.firstAt + maxWait - now));
      slot.timer = setTimeout(() => {
        this.debounce.delete(key);
        const merged = Brain.mergeEvents(slot.events);
        if (slot.events.length > 1) this.log(`合并 ${key} 连发的 ${slot.events.length} 条消息`);
        this.#enqueue(merged, opts).then(
          (r) => slot.waiters.forEach((w) => w.resolve(r)),
          (e) => slot.waiters.forEach((w) => w.reject(e)),
        );
      }, delay);
    });
  }

  /** 把同一个人连发的多条事件合成一条（文字按行拼接，图片合并，任一条 @ 她就算 @） */
  static mergeEvents(events) {
    if (!Array.isArray(events) || !events.length) return null;
    if (events.length === 1) return events[0];
    const last = events[events.length - 1];
    return {
      ...last, // at / messageId 用最后一条：引用与"之后又来了几条"都以它为基准
      text: events.map((e) => e.text).filter(Boolean).join('\n'),
      images: events.flatMap((e) => e.images ?? []),
      atMe: events.some((e) => e.atMe),
      replyToMe: events.some((e) => e.replyToMe),
      // 连发里引用了别的消息：取最后一个有引用的（和 messageId 取最后一条的约定一致）
      replyId: events.map((e) => e.replyId).filter(Boolean).at(-1) ?? null,
      atIds: [...new Set(events.flatMap((e) => e.atIds ?? []))],
      mergedCount: events.length,
      firstAt: events[0].at, // 合并范围的起点：时间线里要把这一段（都是触发内容）排除掉
    };
  }

  /** 同一个会话的消息严格串行 */
  #enqueue(event, opts) {
    const key = String(event?.chatKey ?? 'unknown');
    const prev = this.chatQueues.get(key) ?? Promise.resolve();
    const run = prev.catch(() => {}).then(() => this.#handleNow(event, opts));
    const tail = run.catch(() => {});
    this.chatQueues.set(key, tail);
    tail.then(() => {
      if (this.chatQueues.get(key) === tail) this.chatQueues.delete(key);
    });
    return run;
  }

  /**
   * 对话延续：她刚回过某人，这个人接着说（没 @）多半还是在跟她说。
   * 连续延续次数有上限，避免两边无限接龙，也避免她一直"抢"别人的话。
   */
  #isFollowUp(event) {
    const sec = Number(this.cfg.access?.followUpSeconds ?? 90);
    if (sec <= 0 || event.kind !== 'group') return false;
    if (event.atOthers) return false; // 明显在跟别人说话
    if (!String(event.text ?? '').trim()) return false;
    const last = this.followUps.get(event.chatKey);
    if (!last || Date.now() - last.at > sec * 1000) return false;
    const max = Number(this.cfg.access?.followUpMax ?? 3);
    // 她自己主动开口之后的窗口：对谁都开放，谁接话都交给模型判断是不是在接她
    if (last.userId === OPEN_WINDOW) return (last.tries ?? 0) < max;
    if (last.userId !== String(event.userId)) return false;
    return last.count < max;
  }

  #noteSpoke(event, wasFollowUp) {
    if (event.kind !== 'group') return;
    const prev = this.followUps.get(event.chatKey);
    const count = wasFollowUp && prev?.userId === String(event.userId) ? prev.count + 1 : 0;
    this.followUps.set(event.chatKey, { userId: String(event.userId), at: Date.now(), count });
  }

  /**
   * 她主动在群里说了一句：打开一个"对任何人开放"的短窗口。
   * 以前主动发言之后不登记任何对象，于是别人接她的话（比如她说"没人给我发红包"，
   * 管理员回"你要钱有啥用"）没 @ 她就不算在跟她说，对话立刻断掉。
   */
  #openWindow(event) {
    if (event.kind !== 'group') return;
    this.followUps.set(event.chatKey, { userId: OPEN_WINDOW, at: Date.now(), count: 0, tries: 0 });
  }

  /**
   * 戳一戳有保鲜期：队列里排了别的话、或戳回去的调用耗了几秒之后，
   * 这一戳可能早就是"好几句话以前"的事了。过期的就当没看见，真人也是这样。
   * 返回原因文字（要丢弃）或 null（还新鲜）。
   */
  #pokeStale(event) {
    const sec = Number(this.cfg.access?.pokeStaleSeconds ?? 90);
    const at = Number(event?.at ?? 0);
    if (!(sec > 0) || !at) return null;
    const age = Date.now() - at;
    if (age > sec * 1000) return `已经是 ${Math.round(age / 1000)} 秒前的事了`;
    const mine = this.ambient?.selfSaid?.(event.chatKey, 1)?.[0];
    if (mine && Number(mine.at) > at) return '这之后她已经在这个会话里说过话了';
    return null;
  }

  async #handleNow(event, { proactive = false, retried = false } = {}) {
    let wasFollowUp = false;
    if (event.kind === 'poke' && !proactive && !retried) {
      const stale = this.#pokeStale(event);
      if (stale) {
        this.log(`戳一戳过期，不回应 ${event.chatKey}/${event.userId}：${stale}`);
        return null;
      }
      // 先按概率直接戳回去（不花模型调用）；没戳成再往下走"回一句"
      if (this.social?.tryPokeBack) {
        const poked = await this.social.tryPokeBack(event);
        if (poked) return poked;
        // 戳回去的调用可能耗了几秒甚至超时，回来再查一次是否已经过期
        const late = this.#pokeStale(event);
        if (late) {
          this.log(`戳一戳过期，不回应 ${event.chatKey}/${event.userId}：${late}`);
          return null;
        }
      }
    }
    // 隐式反馈：上一条表情发出去之后，这条消息就是它的口碑
    if (!proactive && typeof this.stickers?.observeFeedback === 'function') {
      try {
        this.stickers.observeFeedback(event.chatKey, event.text);
      } catch {}
    }
    if (proactive) {
      const groups = (this.cfg.access?.groups ?? []).map(String);
      if (event.groupId && groups.length && !groups.includes(String(event.groupId))) {
        this.log(`主动发言跳过：群 ${event.groupId} 不在白名单`);
        return null;
      }
    } else {
      const access = this.decide(event);
      if (!access.ok) {
        this.log(`不回应 ${event.chatKey}/${event.userId}：${access.why}`);
        return null;
      }
      if (access.followUp) {
        wasFollowUp = true;
        event.followUp = true;
        const win = this.followUps.get(event.chatKey);
        if (win?.userId === OPEN_WINDOW) {
          // 她主动说话后的窗口：记一次尝试（模型回 PASS 时也算，避免群里一直被试探）
          event.followUpOpen = true;
          win.tries = (win.tries ?? 0) + 1;
          this.log(`对话延续：${event.userId} 可能在接她刚才主动说的那句，交给模型判断`);
        } else {
          this.log(`对话延续：${event.userId} 在她刚回完之后接着说，按"跟她说"处理`);
        }
      }
      // 被动回应也要限流：否则 groupTrigger=always 时，活跃群每句话都是
      // 一次完整模型调用（配置里早就有这两个阈值，插件版一直没用上）
      const blocked = this.#rateLimit(event);
      if (blocked) {
        this.log(`限流拦下 ${event.chatKey}/${event.userId}：${blocked}`);
        return null;
      }
    }

    // 群里的主动发言是"她自己想说"，事件里的 userId/昵称只是占位（ownerId/'群友'），
    // 不能拿来读写主人的画像，否则会把主人的昵称和互动次数污染掉。
    const anonymousProactive = proactive && event.kind === 'group';
    const profile = anonymousProactive
      ? { userId: '0', nickname: '群友', traits: [], facts: [], episodes: [], interactions: 0 }
      : this.store.profile(event.userId, event.nickname);

    // 图片/表情包：先入库（按 sha256 去重），拿到本地路径后再拼提示词
    const ownNotes = await this.#ingestImages(event);

    // 对方引用了一条消息：把被引用的内容取出来（右滑引用很久以前的话，她也该知道在说哪句）
    if (!proactive && event.replyId && event.quoted === undefined) {
      event.quoted = await this.#quotedOf(event.replyId);
    }
    // 之前发过、她还没看过的图：被引用消息里的图 + 群里没轮到她回应时别人发的图
    const earlierNotes = [];
    if (!proactive || event.groupId) {
      earlierNotes.push(...(await this.#quotedImages(event.quoted)));
      if (earlierNotes.length < 2) {
        const exclude = [...ownNotes, ...earlierNotes];
        earlierNotes.push(...this.#takeEarlierImages(event.chatKey, exclude, 2 - earlierNotes.length));
      }
    }
    let imageNotes = await this.#tileLongImages([...ownNotes, ...earlierNotes.slice(0, Math.max(0, 3 - ownNotes.length))]);

    // 发言人的头像：平时只给本地路径（想看再 read_image），对方明确提到头像时才随消息附上
    const avatar = anonymousProactive ? null : await this.#avatarFor(event);
    const asked = asksAboutAvatar(event.text);
    const wantAvatar = Boolean(avatar) && asked;
    // 对方要看头像时，把群里相关的人的头像整理成一本"头像册"，让她自己挑着看
    const album = asked ? await this.#avatarAlbum(event, avatar) : null;
    let attachNotes = imageNotes;
    if (wantAvatar) {
      imageNotes = imageNotes.slice(0, 2); // 附图最多 3 张，给头像留一个位置
      attachNotes = [...imageNotes, { path: avatar.path, mediaType: avatar.mediaType, hash: `avatar-${avatar.qq}` }];
    }

    // 链接里的内容 / B 站搜索结果：系统先替她查好，她只管聊（查不到就是没有，不会让她编）
    const known = new Set(event.biliCandidates ?? []); // 她这一轮"有资格"分享的 BV
    let linkNotes = Array.isArray(event.biliNotes) ? [...event.biliNotes] : [];
    if (!proactive) {
      const found = await this.#linkNotesFor(event);
      linkNotes = found.notes;
      for (const bv of found.bvids) known.add(bv);
    }

    let agent;
    try {
      agent = await this.ensureAgent(event.chatKey, event);
    } catch (err) {
      this.log('建会话失败:', err?.message ?? err);
      return null;
    }

    const agentId = String(agent?.id ?? '');
    const staticsInSystem = this.systemPromptAgents.has(agentId);

    // 先试附图，再拼提示词——提示词要如实说明"到底附上了没有"
    const vision = await this.#attachImages(attachNotes);
    const avatarAttached = wantAvatar && vision.blocks.length === attachNotes.filter((n) => !n.tiles && !n.unreadable).slice(0, 3).length;
    const timeline = this.#timelineFor(event, proactive);
    let groupNotes = event.groupId
      ? this.groupMemory?.notesFor?.(
          event.chatKey,
          [event.text, ...(this.recent?.(event.chatKey) ?? []).slice(-6).map((m) => m.text)].filter(Boolean).join('\n'),
        ) ?? null
      : null;
    // 主动开口时群里已经没有"刚刚在聊"的内容：记忆里的"最近在聊"是很久以前的话题，不给她，免得翻旧账
    if (proactive && groupNotes?.topics?.length && !(timeline ?? []).some((r) => !r.self)) {
      groupNotes = { ...groupNotes, topics: [] };
    }
    const prompt = buildPrompt({
      persona: this.persona,
      profile,
      event,
      staticsInSystem,
      proactive,
      recent: this.recent?.(event.chatKey) ?? [],
      selfSaid: this.ambient?.selfSaid?.(event.chatKey) ?? [],
      timeline,
      // 群级记忆只注入该群自己的提示词，私聊和别的群拿不到
      // （群里的戳一戳 kind 是 'poke' 但也在群里，所以按 groupId 判断）
      // 第二个参数让休眠的记忆在被提到时醒来（对方这句话 + 最近几句）
      groupNotes,
      linkNotes,
      imageNotes,
      avatar: avatar ? { path: avatar.path, attached: avatarAttached } : null,
      avatarAlbum: album && album.length > 1 ? album : null,
      visionMode: this.cfg.stickers?.visionMode ?? 'onDemand',
      visionAttached: vision.attached,
    });

    // 戳一戳要按所在会话归类：私聊里主人戳她，和私聊说话是同一种权限；群里戳则按群处理
    const speakerKind = event.kind === 'poke' ? (event.groupId ? 'group' : 'private') : event.kind;
    this.speakers.set(agentId, { userId: event.userId, kind: speakerKind, groupId: event.groupId });
    const before = this.currentTurn(agent);
    const turnStartedAt = Date.now();
    try {
      agent.followup({
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text: prompt }, ...vision.blocks],
        source: { kind: 'user' },
      });
    } catch (err) {
      this.log('投递失败:', err?.message ?? err);
      return null;
    }

    // 空闲 3 分钟没动静才算卡死；干活（读图/调工具）期间最多等 8 分钟
    const finished = await this.waitForTurnEnd(agent, before, 180000, 8 * 60 * 1000);
    if (!finished) {
      this.log('等回复超时（3 分钟没有任何新动静，或这一轮超过 8 分钟）');
      return null;
    }
    const reasonKind = classifyReason(finished.reason);
    if (reasonKind === 'aborted') {
      this.log('这一轮被中止，不发半截回复');
      return null;
    }
    if (reasonKind === 'error') {
      const detail = JSON.stringify(finished.reason).slice(0, 300);
      // 会话被宿主回收（重启/过期）时对象还在但一投递就报 not live：
      // 解绑、重建、重试一次，而不是让用户再问一遍
      if (!retried && /not live|unknown session|no such session/i.test(detail)) {
        this.log('会话已失效，解绑并重建后重试一次:', detail.slice(0, 120));
        try {
          this.store.unbind(event.chatKey);
        } catch {}
        this.qqAgents.delete(String(agentId));
        // 已经在队列里了，直接内部重试，别再排队（否则自己等自己）
        return this.#handleNow(event, { proactive, retried: true });
      }
      this.log('这一轮出错:', detail);
      // 思考强度是适配器自定义值，写太高的档位可能不被当前模型支持
      if (/reasoning|effort|xhigh|thinking/i.test(detail)) {
        const cur = this.cfg.plugin?.model?.reasoningEffort ?? '(跟随默认)';
        this.log(
          `提示：当前的思考强度「${cur}」可能不被这个模型支持。到设置里改成 high 或"跟随默认"，再点一次「重建会话」。`,
        );
      }
      await this.safeSend(event, '刚才脑袋卡了一下，再说一遍？');
      return null;
    }

    const raw = this.textOfTurn(agent, finished.turn);
    const { clean: withMemo, memo } = splitMemo(raw);
    // 她给刚看到的图打的语义标签：[[标签:搞笑, 敷衍]]
    const { clean: noTags, tags } = extractTagMarkers(withMemo);
    // 表情包标记：[[表情:关键词]] 不进聊天正文，换成真实图片发出去
    const { clean: noBili, keywords } = extractStickerMarkers(noTags);
    // B 站标记：[[B站:BV号]] 不进聊天正文，换成真正的小程序视频卡片
    // 表情回应标记：[[贴:笑哭]] 不进聊天正文，变成给对方这句话贴的表情回应（set_msg_emoji_like）
    const { clean: noReact, names: reactNames } = extractReactMarkers(noBili);
    const { clean: preClean, ids: biliIds } = extractBiliMarkers(noReact);
    // 发送前清理：消息数组壳 / 思维链漏出 / [NO_REPLY] / 回声腔 / 穿帮的外壳话术 / 标点（见 sanitize.js）
    let clean = preClean;
    if (this.cfg.cleanup?.enabled !== false && preClean) {
      const swept = cleanReply(preClean, {
        userText: proactive ? '' : event.text,
        hedge: this.cfg.cleanup?.hedge !== false,
        punct: this.cfg.cleanup?.punct !== false,
      });
      if (swept.notes.length) this.log(`回复清理：${swept.notes.join('、')}`);
      clean = swept.text;
    }
    // 口癖降频：开头语气词 / 自我怀疑最近刚说过就换掉
    if (clean && this.cfg.cleanup?.tics !== false && event.groupId) {
      try {
        const prev = (this.ambient?.selfSaid?.(event.chatKey, 4) ?? []).map((x) => x.text);
        const varied = varyTics(clean, prev);
        if (varied !== clean) {
          this.log(`口癖降频：「${clean.slice(0, 12)}」→「${varied.slice(0, 12)}」`);
          clean = varied;
        }
      } catch {}
    }
    const ownForTag = Array.isArray(imageNotes) ? imageNotes.filter((n) => !n.earlier) : [];
    if (tags.length && ownForTag.length && this.stickers?.ok) {
      const target = ownForTag[ownForTag.length - 1];
      if (target?.hash && this.stickers.addTags(target.hash, tags)) {
        this.log(`给表情打标签：${tags.join('、')}`);
      }
    }
    if (!clean && !keywords.length && !biliIds.length && !reactNames.length) {
      this.log('模型没产出正文');
      return null;
    }
    // 主动发言时给了模型一个"不想接就说 PASS"的出口
    if ((proactive || wasFollowUp || event.kind === 'poke') && /^\s*PASS\s*$/i.test(clean)) {
      this.log('模型判断不该接话（PASS），不发送');
      return null;
    }
    // 发现型暖场的硬闸：说"我发现了…"却一次没查，就是凭空编的，宁可不发
    if (proactive && event.requireTool && !this.toolUsedSince(agentId, turnStartedAt, ['web_search', 'web_fetch'])) {
      this.log('发现型暖场：这一轮没有联网查过东西，不发送（避免凭空编"新发现"）');
      return null;
    }
    // B 站发现型暖场的硬闸：系统给了候选视频，她就必须从候选里挑一个分享；没挑（或挑了候选外的）就不发
    if (proactive && event.biliCandidates?.length && !biliIds.some((id) => event.biliCandidates.includes(id))) {
      this.log('B站发现型暖场：没有从候选里选出视频，不发送');
      return null;
    }
    // 记忆落盘：不管模型有没有按格式输出 memo，都要记一次交流——
    // 否则一旦它不配合，"聊过 0 次、0 条记忆"就是必然结果。
    try {
      if (!anonymousProactive) {
        this.store.rememberExchange(event.userId, event.nickname, {
          userText: proactive ? '（主动开口）' : event.text,
          replyText: clean || (reactNames.length ? `（贴了个表情：${reactNames[0]}）` : clean),
          memo,
          maxEpisodes: this.cfg.memory?.maxEpisodes ?? 40,
        });
      }
    } catch (err) {
      this.log('写记忆失败:', err?.message ?? err);
    }

    // 拟人化发送：先等一段"打字时间"，再按概率拆成几个气泡，中间留停顿。
    // 真人不会秒回，也不会把所有话塞进一条。
    // 引用策略：立刻回就不引用；只有中间又插进来别人的话、她的回复离得很远时才引用。
    const laterCount = this.ambient?.db?.countAfter?.(event.chatKey, event.at ?? 0) ?? 0;
    const shouldQuote = shouldQuoteReply(event, laterCount);
    if (event.kind === 'group' && event.atMe) {
      this.log(`引用判断：@ 我之后又来了 ${laterCount} 条 → ${shouldQuote ? '引用回复' : '直接回复'}`);
    }
    // 表情回应：真人看到一句话就顺手点了，不用等"打字"，所以先贴再说话
    if (!proactive && reactNames.length) await this.#reactTo(event, reactNames[0]);
    const human = this.cfg.humanize ?? {};
    // 主动开口（没人叫她）时最多发 proactiveMaxBubbles 条，别一下子刷好几条
    const planCfg = proactive ? { ...human, maxBubbles: Math.min(Number(human.maxBubbles ?? 3), Number(human.proactiveMaxBubbles ?? 2)) } : human;
    const bubbles = planBubbles(clean, planCfg);
    const maxChars = this.cfg.limits?.maxReplyChars ?? 600;
    let first = true;
    let interrupted = false;
    for (const bubble of bubbles) {
      for (const raw of splitReply(bubble, maxChars)) {
        const part = polishText(raw, human);
        if (!part) continue;
        const pace = paceFactor(new Date(), human);
        if (first) {
          const wait = Math.round(typingDelay(part, human) * pace);
          this.log(`拟人延迟 ${wait}ms（${part.length} 字，共 ${bubbles.length} 个气泡，节奏×${pace}）`);
          await sleep(wait);
        } else {
          await sleep(Math.round(bubbleGap(human, Math.random, part) * pace));
        }
        // 私聊里对方喊"等等/停"：后面还没发的气泡不发了（见 handle 里的记录）
        if (interrupted || this.#interruptedSince(event.chatKey, turnStartedAt)) {
          if (!interrupted) this.log('对方喊停，剩下的气泡不发了');
          interrupted = true;
          break;
        }
        await this.#sendBubble(event, part, first && shouldQuote ? event.messageId : null);
        if (event.groupId) this.ambient?.rememberSelf?.(event.chatKey, part);
        first = false;
      }
    }
    if (!proactive) this.#noteSpoke(event, wasFollowUp);
    else this.#openWindow(event);
    // 文字之后发 B 站视频卡片（只认系统查到过的 BV，凭空写的不发）
    for (const bv of biliIds.slice(0, 1)) {
      if (!known.has(bv)) {
        this.log(`她写了 [[B站:${bv}]]，但这个 BV 不在系统查到的范围内，不发`);
        continue;
      }
      await sleep(bubbleGap(human));
      await this.#sendBiliVideo(event, bv);
    }
    // 文字之后补表情包（没有匹配的就静默跳过，不发占位）
    for (const kw of keywords.slice(0, 2)) {
      const picked = this.stickers?.pick(kw, event.chatKey);
      if (!picked) {
        this.log(`想发表情「${kw}」但库里没有匹配`);
        continue;
      }
      await sleep(bubbleGap(human));
      try {
        await this.onebot.sendImage(event.chatKey, picked.path);
        this.ambient?.rememberSelf?.(event.chatKey, '[表情包]');
        this.log(`已发表情包「${kw}」`, picked.hash);
      } catch (err) {
        this.log('发表情包失败:', err?.message ?? err);
      }
    }
    return clean || (biliIds.length ? '[B站视频]' : reactNames.length ? '[表情回应]' : clean);
  }

  /** 记下这个会话用过的 QQ 表情（文字里的脸和表情回应共用冷却，别一边贴一边又发同一个） */
  noteFaceUsed(chatKey, id) {
    const key = String(chatKey);
    const history = this.faceHistory.get(key) ?? [];
    history.push([Number(id), Date.now()]);
    if (history.length > 8) history.splice(0, history.length - 8);
    this.faceHistory.set(key, history);
  }

  /**
   * 给对方这句话贴一个表情回应（set_msg_emoji_like）。名字按 QQ 表情表认，认不出就不贴。
   * 成功返回 true；失败只写日志（有的脸服务器不收为表情回应）。
   */
  async #reactTo(event, name) {
    if (this.cfg.faces?.react === false) return false;
    if (!event?.messageId || (event.kind !== 'group' && event.kind !== 'private')) return false;
    const id = reactionId(name);
    if (id === null) {
      this.log(`想贴表情「${name}」，但表情表里没有这个名字`);
      return false;
    }
    try {
      await this.onebot.call('set_msg_emoji_like', { message_id: event.messageId, emoji_id: id, set: true });
      this.noteFaceUsed(event.chatKey, id);
      this.log(`贴了表情回应「${name}」(${id})`);
      return true;
    } catch (err) {
      this.log(`贴表情回应「${name}」失败:`, err?.message ?? err);
      return false;
    }
  }

  /** 这个会话在 since 之后有没有被对方喊停 */
  #interruptedSince(chatKey, since) {
    return Number(this.interrupts.get(String(chatKey)) ?? 0) > Number(since ?? 0);
  }

  /**
   * 发一个气泡。里面写了 [笑哭] 这样的表情名就换成真正的 QQ 表情段（face）；
   * 带表情的发送失败（表里的 id NapCat 不认等）就去掉表情标记，按纯文字再发一次。
   */
  async #sendBubble(event, text, messageId = null) {
    const cfg = this.cfg.faces ?? {};
    const canFace = cfg.enabled !== false && typeof this.onebot.sendSegments === 'function';
    if (!canFace || !/\[/.test(text)) return this.safeSend(event, text, messageId);
    const key = String(event.chatKey);
    const history = this.faceHistory.get(key) ?? [];
    const plan = toSegments(text, {
      enabled: true,
      max: Number(cfg.maxPerMessage ?? 2),
      cooldownMs: Number(cfg.cooldownMinutes ?? 10) * 60000,
      history,
    });
    this.faceHistory.set(key, history);
    if (plan.stripped || plan.dropped) this.log(`表情处理：表里没有的名字 ${plan.unknown.map((n) => `「${n}」`).join('') || 0}（已去掉）、冷却/超量丢弃 ${plan.dropped} 个`);
    if (!plan.faces) {
      // 没有真表情：按处理后的文字发（可能只是脱了括号或丢了冷却中的脸）
      const plain = plan.segments.map((s) => (s.type === 'text' ? s.data.text : '')).join('').trim();
      return plain ? this.safeSend(event, plain, messageId) : false;
    }
    try {
      await this.onebot.sendSegments(event.chatKey, plan.segments, messageId);
      this.log(`发了 ${plan.faces} 个 QQ 表情`);
      return true;
    } catch (err) {
      this.log('带表情发送失败，改发纯文字:', err?.message ?? err);
      const plain = stripFaceMarks(text);
      return plain ? this.safeSend(event, plain, messageId) : false;
    }
  }

  #biliOn() {
    return this.cfg.bili?.enabled !== false;
  }

  /**
   * 给这条消息查"链接里的内容"和"B站搜索结果"。只在确有必要时才发请求，且整体最多等 15 秒。
   * @returns {Promise<{notes:string[], bvids:string[]}>}
   */
  async #linkNotesFor(event) {
    const out = { notes: [], bvids: [] };
    if (!this.#biliOn() || this.cfg.links?.enabled === false) return out;
    const text = String(event.text ?? '');
    const addressed = event.kind === 'private' || event.atMe;
    const query = addressed ? biliSearchQuery(text) : '';
    const hasLinks = LinkReader.hasLinks(text);
    if (!hasLinks && !query) return out;
    const work = (async () => {
      if (hasLinks) {
        const r = await this.links.notesFor(text);
        out.notes.push(...r.notes);
        for (const v of r.videos) out.bvids.push(v.bvid);
      }
      if (query) {
        const list = (await this.bili.search(query, 8)).filter((v) => v.pic).slice(0, 4);
        if (list.length) {
          out.notes.push(`你在 B 站搜「${query}」得到的结果：`);
          for (const v of list) {
            out.notes.push(`  ${describeVideo(v, { withDesc: false })}`);
            out.bvids.push(v.bvid);
          }
          out.notes.push('※ 想把其中某个视频分享给对方，在回复里写 [[B站:BV号]]（只能用上面列出的 BV 号），系统会发一张 B 站视频卡片；不合适就别发。');
        } else {
          out.notes.push(`你在 B 站搜「${query}」没有搜到可用的结果（可能是没有，也可能是暂时查不了），如实告诉对方，别编视频。`);
        }
      }
    })();
    try {
      await Promise.race([work, sleep(15000)]);
    } catch (err) {
      this.log('查链接内容出错:', err?.message ?? err);
    }
    if (out.notes.length) this.log(`替她查了链接/搜索内容：${out.notes.length} 条`);
    return out;
  }

  #biliShared(chatKey) {
    try {
      const raw = this.ambient?.db?.getKv?.(`bili:shared:${chatKey}`);
      const list = raw ? JSON.parse(raw) : [];
      return Array.isArray(list) ? list.map(String) : [];
    } catch {
      return [];
    }
  }

  #noteBiliShared(chatKey, bvid) {
    try {
      const list = [bvid, ...this.#biliShared(chatKey).filter((x) => x !== bvid)].slice(0, 60);
      this.ambient?.db?.setKv?.(`bili:shared:${chatKey}`, JSON.stringify(list));
    } catch {}
  }

  /**
   * 冷场时给她挑几个"值得分享"的 B 站视频：用群友的爱好词去搜，排掉分享过的、太长的、没人看的。
   * @param {Array<{nickname:string, words:string[]}>} groups 每个群友的爱好词
   * @returns {Promise<object[]>} 候选（带 keyword / who）；没有返回 []
   */
  async biliDiscover(chatKey, groups) {
    if (!this.#biliOn() || this.cfg.bili?.discover === false) return [];
    const jobs = [];
    for (const g of groups ?? []) for (const w of (g.words ?? []).slice(0, 2)) jobs.push({ keyword: w, who: g.nickname });
    if (!jobs.length) return [];
    // 按日期轮转，同一批爱好每天换着搜，不总是同一批结果
    const shift = Math.floor(Date.now() / 86400000) % jobs.length;
    const picked = [...jobs.slice(shift), ...jobs.slice(0, shift)].slice(0, 3);
    const results = [];
    for (const job of picked) {
      const list = await this.bili.search(job.keyword, 10);
      for (const v of list) results.push({ ...v, keyword: job.keyword, who: job.who });
    }
    return pickDiscoverCandidates(results, {
      seen: this.#biliShared(chatKey),
      maxMinutes: this.cfg.bili?.maxMinutes ?? 15,
      minPlay: this.cfg.bili?.minPlay ?? 3000,
      limit: 4,
    });
  }

  /** 发一张 B 站视频卡片；做不出卡片就退回"标题 + 链接"文字。成功返回 true */
  async #sendBiliVideo(event, bvid) {
    const v = await this.bili.view(bvid);
    if (!v) {
      this.log(`B站视频 ${bvid} 查不到，不发卡片`);
      return false;
    }
    if (this.cfg.bili?.card !== false) {
      const card = await buildBiliCard((a, p, t) => this.onebot.call(a, p, t), v);
      if (card) {
        try {
          await this.onebot.sendCard(event.chatKey, card);
          this.ambient?.rememberSelf?.(event.chatKey, `[B站视频卡片：${v.title}]`);
          this.#noteBiliShared(event.chatKey, v.bvid);
          this.log(`已发 B站视频卡片：${v.title}（${v.bvid}）`);
          return true;
        } catch (err) {
          this.log('发 B站卡片失败，改发文字链接:', err?.message ?? err);
        }
      } else {
        this.log('没能生成 B站小程序卡片（NapCat 的 get_mini_app_ark 不可用？），改发文字链接');
      }
    }
    try {
      await this.safeSend(event, `${v.title}\n${biliUrl(v.bvid)}`);
      this.ambient?.rememberSelf?.(event.chatKey, `[B站视频：${v.title}]`);
      this.#noteBiliShared(event.chatKey, v.bvid);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 交织时间线（群友 + 她自己）。被动回应时把触发消息本身排除掉——
   * 它会在【对方这次说的】里单独出现，留在时间线里就重复了。
   * 拿不到（私聊、没有 ambient）返回 null，提示词回落到旧的 recent + selfSaid。
   */
  #timelineFor(event, proactive) {
    if (!event.groupId || typeof this.ambient?.timeline !== 'function') return null;
    try {
      const to = Number(event.at ?? 0);
      // 戳一戳本身不是一条群消息，没有要从时间线里排除的触发内容
      const exclude = proactive || event.kind === 'poke' ? null : { nickname: event.nickname, from: Number(event.firstAt ?? to), to };
      const rows = this.ambient.timeline(event.chatKey, exclude);
      return rows.length ? rows : null;
    } catch {
      return null;
    }
  }

  /** 主动说一句。准入和限流由调用方（Ambient）负责，这里只负责生成与发送。 */
  async proactiveSay({ chatKey, groupId, hint, requireTool = false, biliNotes = null, biliCandidates = null }) {
    const event = {
      kind: 'group',
      chatKey,
      groupId: String(groupId),
      userId: String(this.cfg.bot?.ownerId ?? '0'),
      nickname: '群友',
      text: hint,
      atMe: false,
      messageId: null,
      // 发现型暖场：这一轮必须真的联网查过东西才发，否则当作没有发现、不发（见 #handleNow）
      requireTool: Boolean(requireTool),
      // B 站发现型暖场：系统先搜好的候选（她必须从里面挑一个用 [[B站:BV号]] 分享）
      biliNotes: Array.isArray(biliNotes) ? biliNotes : null,
      biliCandidates: Array.isArray(biliCandidates) && biliCandidates.length ? biliCandidates : null,
    };
    return this.handle(event, { proactive: true });
  }

  /** 私聊主动开口（由 Ambient 决定时机） */
  async proactivePrivateSay({ chatKey, userId, nickname, hint }) {
    const users = (this.cfg.access?.users ?? []).map(String);
    if (users.length && !users.includes(String(userId))) {
      this.log(`私聊主动跳过：${userId} 不在白名单`);
      return null;
    }
    const event = {
      kind: 'private',
      chatKey,
      groupId: null,
      userId: String(userId),
      nickname,
      text: hint,
      atMe: false,
      messageId: null,
    };
    return this.handle(event, { proactive: true });
  }

  /** 取附件服务：宿主里注册名是 attachments（复数），老版本可能是 attachment */
  #attachmentService() {
    for (const name of ['attachments', 'attachment']) {
      try {
        const svc = this.ctx.get(name);
        if (svc && typeof svc.saveImages === 'function') return svc;
      } catch {
        /* 服务未挂载会抛错，继续试下一个 */
      }
    }
    return null;
  }

  /**
   * 视觉模式：always 才把图转成 attachment 块随消息一起发。
   * 返回 { blocks, attached }——attached 决定提示词怎么写，
   * 不能"说附上了但其实没附"（之前就是这么骗到模型的）。
   */
  async #attachImages(imageNotes) {
    const mode = this.cfg.stickers?.visionMode ?? 'onDemand';
    if (mode !== 'always' || !Array.isArray(imageNotes) || !imageNotes.length) {
      return { blocks: [], attached: false };
    }
    const svc = this.#attachmentService();
    if (!svc) {
      this.log('视觉模式 always：找不到 attachments 服务，回落到只给本地路径');
      return { blocks: [], attached: false };
    }
    const blocks = [];
    // 切成段的长图 / 切不了的大图不随消息附（原图会被 read_image 拒收，也会被压糊）：
    // 提示词里给每一段的路径，让她按顺序 read_image
    for (const note of imageNotes.filter((n) => !n.tiles && !n.unreadable).slice(0, 3)) {
      try {
        const buf = readFileSync(note.path);
        const mediaType = note.mediaType ?? 'image/png';
        const refs = await svc.saveImages([{ data: new Uint8Array(buf), mediaType, name: note.hash ?? 'sticker' }]);
        const ref = Array.isArray(refs) ? refs[0] : refs;
        if (ref) blocks.push({ type: 'image', attachment: ref });
        else this.log('附图失败：saveImages 没返回引用');
      } catch (err) {
        this.log('附图失败:', err?.message ?? err);
      }
    }
    if (blocks.length) this.log(`视觉模式 always：随消息附了 ${blocks.length} 张图`);
    else this.log('视觉模式 always：一张都没附上，提示词将回落到给路径');
    return { blocks, attached: blocks.length > 0 };
  }

  /**
   * 头像册：对方在群里要她看头像（"分析我们几个人的头像"）时，
   * 把发言人、被 @ 的人、最近两小时说过话的人的头像都下载好，连同昵称一起交给她，
   * 她用 read_image 自己挑着看。只在群里提供，范围就是这个群里出现过的人。
   * @returns {Promise<Array<{userId:string,nickname:string,path:string}>|null>}
   */
  async #avatarAlbum(event, speakerAvatar) {
    try {
      if (!event.groupId || !this.stickers?.dir) return null;
      if ((this.cfg.stickers?.visionMode ?? 'onDemand') === 'off') return null;
      const people = new Map(); // userId -> nickname（先到先得，发言人 > 被 @ 的 > 最近发言的）
      people.set(String(event.userId), event.nickname || String(event.userId));
      const recent = this.ambient?.db?.participants?.(event.chatKey, 2 * 3600 * 1000, 8) ?? [];
      const byId = new Map(recent.map((p) => [p.userId, p.nickname]));
      for (const id of event.atIds ?? []) if (!people.has(id)) people.set(id, byId.get(id) || `QQ ${id}`);
      for (const p of recent) if (!people.has(p.userId)) people.set(p.userId, p.nickname || `QQ ${p.userId}`);
      const dir = join(this.stickers.dir, 'avatars');
      const ids = [...people.keys()].slice(0, 8);
      const got = await Promise.all(
        ids.map(async (id) => {
          if (speakerAvatar && id === String(event.userId)) return speakerAvatar;
          return fetchAvatar(dir, id); // 内部已吞掉网络错误，失败返回 null
        }),
      );
      const out = [];
      ids.forEach((id, i) => {
        const g = got[i];
        if (g?.path) out.push({ userId: id, nickname: people.get(id), path: g.path });
      });
      return out.length ? out : null;
    } catch (err) {
      this.log('整理头像册失败:', err?.message ?? err);
      return null;
    }
  }

  /** 工具闸每放行/拦截一次 QQ 会话的工具调用就记一笔（用来判断"这一轮到底有没有真的查东西"） */
  noteToolUse(agentId, name) {
    const id = String(agentId ?? '');
    if (!id || !name) return;
    this.toolUses ??= new Map();
    const list = this.toolUses.get(id) ?? [];
    list.push({ name: String(name), at: Date.now() });
    this.toolUses.set(id, list.slice(-60));
  }

  /** 某个会话在 since 之后是否调用过这些工具之一 */
  toolUsedSince(agentId, since, names) {
    const list = this.toolUses?.get(String(agentId ?? '')) ?? [];
    return list.some((t) => t.at >= since && names.includes(t.name));
  }

  /** 把没轮到她回应的群图存起来（后台下载，不阻塞消息处理） */
  #rememberImages(event) {
    if (!this.stickers?.look || (this.cfg.stickers?.visionMode ?? 'onDemand') === 'off') return;
    const chatKey = event.chatKey;
    this.stickers
      .look(event, () => true, 2)
      .then((notes) => {
        if (!notes?.length) return;
        const list = this.seenImages.get(chatKey) ?? [];
        for (const n of notes) {
          if (list.some((x) => x.hash === n.hash)) continue;
          list.push({ ...n, earlier: { nickname: event.nickname, userId: event.userId, at: Number(event.at) || Date.now() }, used: false });
        }
        this.seenImages.set(chatKey, list.slice(-6));
      })
      .catch((err) => this.log('存群图失败:', err?.message ?? err));
  }

  /** 取这个会话里她还没看过的、最近 20 分钟内的图（最多 2 张，最新的优先），取走即标记为已看 */
  #takeEarlierImages(chatKey, exclude = [], max = 2) {
    const list = this.seenImages.get(chatKey);
    if (!list?.length) return [];
    const now = Date.now();
    const skip = new Set(exclude.map((n) => n.hash));
    const fresh = list.filter((n) => now - Number(n.earlier?.at ?? 0) < 20 * 60 * 1000);
    this.seenImages.set(chatKey, fresh);
    const picked = fresh.filter((n) => !n.used && !skip.has(n.hash)).slice(-max);
    for (const n of picked) n.used = true;
    return picked.map(({ used, ...rest }) => rest);
  }

  /** 被引用消息里的图：下载下来给她看（取不到就算了，提示词里仍如实说明） */
  async #quotedImages(quoted) {
    try {
      if (!quoted?.ok || !quoted.imageList?.length || !this.stickers?.look) return [];
      if ((this.cfg.stickers?.visionMode ?? 'onDemand') === 'off') return [];
      const got = await this.stickers.look({ images: quoted.imageList }, () => true, 2);
      return got.map((n) => ({ ...n, earlier: { nickname: quoted.mine ? '你自己' : quoted.nickname, at: quoted.at, quoted: true } }));
    } catch (err) {
      this.log('取被引用的图失败:', err?.message ?? err);
      return [];
    }
  }

  /** 被引用的那条消息：{ok, ...} 。取不到也返回 {ok:false}，让提示词如实说明，而不是装作没引用 */
  async #quotedOf(replyId) {
    const id = String(replyId);
    this.quotedCache ??= new Map();
    const hit = this.quotedCache.get(id);
    if (hit && (hit.ok || Date.now() - hit.cachedAt < 30000)) return hit;
    let out = { ok: false, id, cachedAt: Date.now() };
    try {
      const m = await this.onebot?.getMessage?.(id);
      if (m) out = { ok: true, cachedAt: Date.now(), ...m };
    } catch (err) {
      this.log('取被引用消息失败:', err?.message ?? err);
    }
    this.log(out.ok ? `对方引用了 ${out.nickname} 的一条消息：${String(out.text).slice(0, 40)}` : `对方引用了一条消息（${id}），但取不到内容`);
    this.quotedCache.set(id, out);
    if (this.quotedCache.size > 200) this.quotedCache.delete(this.quotedCache.keys().next().value);
    return out;
  }

  /** 取发言人的头像（本地缓存）；视觉关闭、没有缓存目录、下载失败都返回 null，不影响正常回复 */
  async #avatarFor(event) {
    try {
      if ((this.cfg.stickers?.visionMode ?? 'onDemand') === 'off') return null;
      if (!this.stickers?.dir || !event?.userId) return null;
      return await fetchAvatar(join(this.stickers.dir, 'avatars'), event.userId);
    } catch (err) {
      this.log('取头像失败:', err?.message ?? err);
      return null;
    }
  }

  /**
   * 超长/超大的图（比如 1440×11264 的聊天长截图）read_image 会直接拒收，收下也会被压糊。
   * 先沿长边切成几段（见 imgtile.js），让她按顺序一段一段看。切不了就标成 unreadable，
   * 提示词里如实告诉她"这张图太大看不了"，不让她去试终端、也不让她假装看过。
   */
  async #tileLongImages(notes) {
    if (!Array.isArray(notes) || !notes.length) return notes ?? [];
    const out = [];
    for (const n of notes) {
      if (!needsTiling(n.size)) {
        out.push(n);
        continue;
      }
      let tiled = null;
      try {
        const dir = join(this.stickers?.dir ?? this.workspaceDir(), 'seen', 'tiles');
        tiled = await tileImage(n.path, n.size, dir, String(n.hash ?? 'img').slice(0, 16));
      } catch (err) {
        this.log('长图切片失败:', err?.message ?? err);
      }
      if (tiled) {
        this.log(`长图 ${n.size.width}×${n.size.height} 切成 ${tiled.paths.length} 段${tiled.truncated ? '（太长，只切了前面一部分）' : ''}`);
        out.push({ ...n, tiles: tiled.paths, tileInfo: { vertical: tiled.vertical, truncated: tiled.truncated, along: tiled.along, covered: tiled.covered } });
      } else {
        this.log(`长图 ${n.size.width}×${n.size.height} 切不了（非 Windows / WebP / 解码失败），告诉她看不了`);
        out.push({ ...n, unreadable: true });
      }
    }
    return out;
  }

  /** 图片入库：按配置决定只存表情包还是全部图片 */
  async #ingestImages(event) {
    if (!this.stickers || !Array.isArray(event.images) || !event.images.length) return [];
    const mode = this.cfg.stickers?.autoSave ?? 'stickers';
    const goesToLibrary = (img) => (mode === 'off' ? false : mode === 'all' ? true : Boolean(img.isSticker));
    const visionOff = (this.cfg.stickers?.visionMode ?? 'onDemand') === 'off';
    const out = [];
    // 不进表情包库的图（普通图片、autoSave=off 时的一切）也要让她"看一眼"：
    // 以前这些图根本不下载，她只看到「[图片]」两个字。
    if (!visionOff) {
      try {
        const looked = await this.stickers.look(event, (img) => !goesToLibrary(img), 3);
        out.push(...looked);
      } catch (err) {
        this.log('看图缓存失败:', err?.message ?? err);
      }
    }
    if (mode === 'off' || !this.stickers.ok) return out;
    const contextText = [
      event.text,
      ...(this.recent?.(event.chatKey) ?? []).slice(-3).map((m) => `${m.nickname}：${m.text}`),
    ]
      .filter(Boolean)
      .join(' / ');
    try {
      const saved = await this.stickers.ingest(event, contextText, goesToLibrary);
      for (const s of saved) out.push({ path: s.path, mediaType: s.mediaType, hash: s.hash, isSticker: s.isSticker, animated: s.animated, size: s.size, name: s.name });
      return out.slice(0, 3);
    } catch (err) {
      this.log('图片入库失败:', err?.message ?? err);
      return out.slice(0, 3);
    }
  }

  /** 被动回应的限流：同人冷却 + 每群每小时上限。返回拒绝原因或 null */
  #rateLimit(event) {
    const lim = this.cfg.limits ?? {};
    const now = Date.now();
    const cooldownMs = (lim.perUserCooldownSec ?? 5) * 1000;
    const last = this.lastReplyByUser.get(event.userId) ?? 0;
    if (cooldownMs > 0 && now - last < cooldownMs) {
      return `同一个人 ${Math.ceil((cooldownMs - (now - last)) / 1000)} 秒内刚说过话`;
    }
    const groupKey = event.groupId ? `g:${event.groupId}` : `p:${event.userId}`;
    const cap = lim.perGroupPerHour ?? 60;
    const hits = (this.hourHits.get(groupKey) ?? []).filter((t) => now - t < 3600 * 1000);
    if (hits.length >= cap) {
      this.hourHits.set(groupKey, hits);
      return `本小时已回 ${hits.length} 条，达到上限 ${cap}`;
    }
    this.lastReplyByUser.set(event.userId, now);
    hits.push(now);
    this.hourHits.set(groupKey, hits);
    return null;
  }

  async safeSend(event, text, messageId = null) {
    try {
      if (messageId) await this.onebot.reply(event.chatKey, text, messageId);
      else await this.onebot.send(event.chatKey, text);
      return true;
    } catch (err) {
      this.log('发送失败:', err?.message ?? err);
      return false;
    }
  }
}







