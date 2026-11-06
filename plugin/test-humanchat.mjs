// 拟人互动改造自测：提示词修正 / 会话串行 / 连发合并 / 对话延续 / @ 与引用还原 / 主动发言不污染画像
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Brain } from './dsh-qq/lib/brain.js';
import { ProjectStore } from './dsh-qq/lib/persona.js';
import { buildPrompt, buildSystemPrompt, timeContext, splitMemo } from './dsh-qq/lib/prompt.js';
import { normalize, extractText, OneBot } from './dsh-qq/lib/onebot.js';

let bad = 0;
const ok = (m) => console.log(`  ✓ ${m}`);
const no = (m, d = '') => {
  console.log(`  ✗ ${m}${d ? ` —— ${d}` : ''}`);
  bad += 1;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const safeRm = (dir) => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {}
};

// ---------- 提示词：图片说明的三元表达式 ----------
{
  const persona = { name: '小鱼', identity: 'x', speech: {} };
  const profile = { userId: '1', nickname: 'A', traits: [], facts: [], episodes: [], interactions: 0 };
  const event = { kind: 'group', groupId: '1', text: '看', atMe: true };
  const base = { persona, profile, event, staticsInSystem: true };
  const notAttached = buildPrompt({ ...base, imageNotes: [{ path: 'C:\\s\\a.jpg', isSticker: true }], visionAttached: false });
  notAttached.includes('本地文件：C:\\s\\a.jpg') && notAttached.includes('- 表情包')
    ? ok('没附图时如实给本地路径，并保留"表情包"前缀')
    : no('没附图却没给路径', notAttached.split('\n').filter((l) => l.includes('表情包')).join('|'));
  !notAttached.includes('已随消息附上') ? ok('没附图时不再谎称已附上') : no('没附图却说已附上');
  const attached = buildPrompt({ ...base, imageNotes: [{ path: 'C:\\s\\a.jpg' }], visionAttached: true });
  attached.includes('已随消息附上') && !attached.includes('本地文件') ? ok('附了图才说已附上') : no('附图说明不对');
  buildPrompt({ ...base, event: { ...event, atMe: false, followUp: true } }).includes('接着你的话')
    ? ok('对话延续的场景说明写进了提示词')
    : no('提示词缺对话延续说明');
}

// ---------- 时间感 ----------
{
  const d = (h, m = 0) => new Date(2026, 10, 2, h, m); // 2026-11-02 是周一
  const night = timeContext(d(2, 10));
  night.includes('周一') && night.includes('02:10') && night.includes('困') ? ok('凌晨：带星期、时刻，提示犯困') : no('凌晨时间感不对', night);
  timeContext(d(12, 20)).includes('午饭') ? ok('中午：提示饭点') : no('中午没提饭点');
  timeContext(d(15, 0)).endsWith('（下午）。') ? ok('下午：只报时间，不硬加状态') : no('下午多了状态', timeContext(d(15, 0)));
  const p = buildPrompt({
    persona: { name: '小鱼', identity: 'x', speech: {} },
    profile: { userId: '1', nickname: 'A', traits: [], facts: [], episodes: [], interactions: 0 },
    event: { kind: 'group', groupId: '1', text: 'hi', atMe: true },
    staticsInSystem: true,
    now: d(2, 10),
  });
  p.includes('现在是周一 02:10') ? ok('时间进了每轮提示词') : no('提示词里没有时间');
}

// ---------- 归一化：@ 别人 / 引用 ----------
{
  const msg = [
    { type: 'reply', data: { id: '777' } },
    { type: 'at', data: { qq: '10000' } },
    { type: 'at', data: { qq: '42', name: '张三' } },
    { type: 'text', data: { text: '你看这个' } },
  ];
  extractText(msg, '10000') === '@张三 你看这个' ? ok('@ 别人还原成 @昵称，@ 自己去掉') : no('@ 还原错误', extractText(msg, '10000'));
  const ev = normalize({ post_type: 'message', message_type: 'group', group_id: 1, user_id: 5, message: msg, message_id: 9 }, '10000');
  ev?.replyId === '777' ? ok('解析出被引用的消息 id') : no('没解析引用', String(ev?.replyId));
  ev?.atMe && ev?.atOthers ? ok('atMe 与 atOthers 同时识别') : no('at 识别错误', JSON.stringify([ev?.atMe, ev?.atOthers]));
  const plain = normalize({ post_type: 'message', message_type: 'group', group_id: 1, user_id: 5, message: [{ type: 'text', data: { text: 'hi' } }] }, '10000');
  plain.atOthers === false && plain.replyId === null ? ok('普通消息没有误判') : no('普通消息被误判');
}

// ---------- 我发过的消息 id ----------
{
  const ob = new OneBot({ port: 0, log: () => {} });
  ob.call = async () => ({ message_id: 123 });
  await ob.send('group:1', 'hi');
  ob.isMine(123) && ob.isMine('123') && !ob.isMine(124) ? ok('发出去的消息 id 被记录，用于识别被引用') : no('isMine 不对');
}

// ---------- 合并 ----------
{
  const a = { chatKey: 'group:1', userId: '9', text: '在吗', atMe: true, at: 1, messageId: 'a', images: [] };
  const b = { ...a, text: '帮我看个东西', atMe: false, at: 2, messageId: 'b', images: [{ url: 'u' }] };
  const m = Brain.mergeEvents([a, b]);
  m.text === '在吗\n帮我看个东西' && m.atMe && m.messageId === 'b' && m.at === 2 && m.images.length === 1 && m.mergedCount === 2
    ? ok('mergeEvents：文字拼接、任一条 @ 即 @、基准取最后一条')
    : no('mergeEvents 不对', JSON.stringify(m));
  Brain.mergeEvents([a]) === a ? ok('单条不变') : no('单条被改了');
}

// ---------- 端到端：串行 / 合并 / 延续 / 不污染画像 ----------
{
  const dir = mkdtempSync(join(tmpdir(), 'qqhuman-'));
  try {
    writeFileSync(
      join(dir, 'config.json'),
      JSON.stringify({
        bot: { ownerId: '136638211' },
        access: { users: [], groups: ['1'], groupTrigger: 'at', groupMemberScope: 'group', followUpSeconds: 60, followUpMax: 2 },
        persona: { active: 'persona/p.json' },
        limits: { perUserCooldownSec: 0, perGroupPerHour: 100, maxReplyChars: 600 },
        memory: { maxEpisodes: 40 },
        proactive: { enabled: false },
        stickers: { autoSave: 'off', visionMode: 'off' },
        humanize: { enabled: false, debounceMs: 250, debounceMaxMs: 1000, minTypingMs: 1, maxTypingMs: 1, perCharMs: 1 },
      }),
    );
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(dir, 'persona'));
    writeFileSync(join(dir, 'persona', 'p.json'), JSON.stringify({ name: '小鱼', identity: '群友', speech: {} }));

    const store = new ProjectStore(dir);
    const prompts = [];
    let active = 0;
    let maxActive = 0;
    const makeAgent = () => {
      const events = [];
      let turn = 0;
      return {
        id: 'agent-1',
        session: { snapshotEvents: () => events },
        followup(msg) {
          const text = msg.content[0].text;
          prompts.push(text);
          const said = /【(?:对方这次说的|你现在想做的事)】\n([\s\S]*?)\n\n请直接给出/.exec(text)?.[1] ?? '?';
          turn += 1;
          const t = turn;
          events.push({ type: 'turn/start', data: { turn: t } });
          active += 1;
          maxActive = Math.max(maxActive, active);
          setTimeout(() => {
            active -= 1;
            events.push({ type: 'assistant/message', data: { turn: t, message: { content: [{ type: 'text', text: `回:${said.replace(/\n/g, '/')}` }] } } });
            events.push({ type: 'turn/end', data: { turn: t, reason: 'stop' } });
          }, 80);
        },
      };
    };
    const agent = makeAgent();
    const agents = { get: () => agent, create: async () => ({ agent }) };
    const sent = [];
    const onebot = {
      send: async (k, t) => sent.push(t),
      reply: async (k, t) => sent.push(t),
      sendImage: async () => {},
    };
    const brain = new Brain({ ctx: { get: () => undefined }, onebot, store, log: () => {} }).init({ agents });

    const ev = (userId, text, extra = {}) => ({
      kind: 'group', groupId: '1', chatKey: 'group:1', userId, nickname: `u${userId}`,
      text, atMe: true, messageId: `m${Math.random()}`, at: Date.now(), images: [], ...extra,
    });

    // 1) 两个人几乎同时 @ 她：必须一个接一个处理，回复不能错位
    // 回归：宿主 setup(agentCtx, agent?) 的 agent 可能是 undefined，
    // 人设注册进系统提示词后必须仍然被记下，否则每条消息会把整份人设重复发一遍
    {
      let registered = null;
      const sctx = { get: () => undefined, systemPrompt: { section: (s) => (registered = s) } };
      await brain.mountPreset(sctx, undefined, 'session-no-agent');
      registered?.name === 'qq:persona' && brain.systemPromptAgents.has('session-no-agent')
        ? ok('setup 拿不到 agent 时，仍记下"人设已在系统提示词里"（不会逐条重复整份人设）')
        : no('人设注册后没有记录会话 id', JSON.stringify([registered?.name, [...brain.systemPromptAgents]]));
    }

    await Promise.all([brain.handle(ev('11', '甲的问题')), brain.handle(ev('22', '乙的问题'))]);
    maxActive === 1 ? ok('同一会话里同时只跑一轮（串行）') : no('同会话并发了', String(maxActive));
    sent.length === 2 && sent.includes('回:甲的问题') && sent.includes('回:乙的问题')
      ? ok('两个人各自拿到自己的回复，没有错位')
      : no('回复错位或缺失', JSON.stringify(sent));

    // 2) 同一个人连发三条：合并成一次输入、一次回复
    sent.length = 0;
    prompts.length = 0;
    await Promise.all([
      brain.handle(ev('33', '在吗')),
      sleep(60).then(() => brain.handle(ev('33', '我有个问题'))),
      sleep(120).then(() => brain.handle(ev('33', '帮我看看'))),
    ]);
    prompts.length === 1 ? ok('连发三条只投递一次') : no('连发没合并', String(prompts.length));
    sent.length === 1 && sent[0] === '回:在吗/我有个问题/帮我看看' ? ok('三条内容都在这一次输入里，没有丢') : no('合并内容不对', JSON.stringify(sent));

    // 3) 对话延续：她刚回完 33，33 不 @ 接着说 → 回；别人不 @ → 不回
    sent.length = 0;
    await brain.handle(ev('33', '那再说一句', { atMe: false }));
    sent.length === 1 ? ok('刚聊过的人不 @ 接着说，她会接') : no('对话延续没生效', JSON.stringify(sent));
    sent.length = 0;
    await brain.handle(ev('44', '路人随口一句', { atMe: false }));
    sent.length === 0 ? ok('别的人不 @ 仍然不插嘴') : no('路人被回应了');
    sent.length = 0;
    await brain.handle(ev('33', '@别人 你看', { atMe: false, atOthers: true }));
    sent.length === 0 ? ok('明显在跟别人说话时不抢') : no('抢了别人的话');
    // followUpMax=2：已经延续 1 次，再 1 次后封顶
    await brain.handle(ev('33', '第二次延续', { atMe: false }));
    sent.length = 0;
    await brain.handle(ev('33', '第三次延续', { atMe: false }));
    sent.length === 0 ? ok('连续延续到上限后不再接，避免无限接龙') : no('延续没有上限');
    sent.length = 0;
    await brain.handle(ev('33', '重新 @ 一下'));
    sent.length === 1 ? ok('重新 @ 之后恢复') : no('@ 后没恢复');

    // 4) 主动发言不污染主人画像
    const before = store.listProfiles().find((p) => p.userId === '136638211');
    await brain.proactiveSay({ chatKey: 'group:1', groupId: '1', hint: '随便接一句' });
    const after = store.listProfiles().find((p) => p.userId === '136638211');
    !before && !after ? ok('群里主动发言没有给主人建档/记次数') : no('主动发言污染了主人画像', JSON.stringify(after));

    // 4b) 她主动说一句之后，别人不 @ 接她的话，她要能接住（截图里的场景）
    sent.length = 0;
    prompts.length = 0;
    await brain.handle(ev('77', '你要钱有啥用', { atMe: false }));
    sent.length === 1 ? ok('她主动说话后，有人不 @ 接话，她会接住') : no('主动发言后接话被无视', JSON.stringify(sent));
    /主动说了一句/.test(prompts[prompts.length - 1] ?? '') ? ok('提示里告诉她「这可能是在接你刚才主动说的话」') : no('提示没说明来由', (prompts[prompts.length - 1] ?? '').slice(0, 120));
    sent.length = 0;
    await brain.handle(ev('88', '我也想问', { atMe: false }));
    sent.length === 0 ? ok('她接了 77 之后，窗口转成和 77 的对话，路人 88 仍不被抢话') : no('窗口没收窄到对话对象', JSON.stringify(sent));
    sent.length = 0;
    await brain.handle(ev('77', '就是问问', { atMe: false }));
    sent.length === 1 ? ok('77 继续说，她继续接') : no('接话之后没能继续聊', JSON.stringify(sent));

    // 窗口对任何人开放也有上限：followUpMax=2 次尝试之后不再试探
    await brain.proactiveSay({ chatKey: 'group:1', groupId: '1', hint: '随便接一句' });
    sent.length = 0;
    await brain.handle(ev('91', '@别人 看这个', { atMe: false, atOthers: true }));
    sent.length === 0 ? ok('明显在跟别人说话时，窗口也不抢') : no('主动窗口抢了别人的话');
    // 让模型判断为 PASS 的情形也算一次尝试：窗口用完后不再触发
    const realFollowup = agent.followup;
    agent.followup = function (msg) {
      const t = msg.content[0].text.replace(/(【对方这次说的】\n)[\s\S]*?(\n\n请直接给出)/, '$1PASS$2');
      return realFollowup.call(this, { ...msg, content: [{ type: 'text', text: t }] });
    };
    await brain.handle(ev('92', '无关的话1', { atMe: false }));
    await brain.handle(ev('93', '无关的话2', { atMe: false }));
    agent.followup = realFollowup;
    const promptsBefore = prompts.length;
    await brain.handle(ev('94', '无关的话3', { atMe: false }));
    prompts.length === promptsBefore ? ok('窗口的试探次数用完后，不再为无关的话调模型') : no('窗口无限敞开', String(prompts.length - promptsBefore));

    // 4c) 头像：发言人的头像下载到缓存目录，提示词给出路径（离线：桩掉 fetch）
    {
      const realFetch = globalThis.fetch;
      const oldStickers = brain.stickers;
      const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]), Buffer.from('JFIF'), Buffer.alloc(32)]);
      let asked = '';
      globalThis.fetch = async (url) => {
        asked = String(url);
        return new Response(JPG, { status: 200, headers: { 'content-type': 'image/jpeg' } });
      };
      brain.stickers = { dir: join(dir, 'stk'), ok: false };
      // 视觉关闭（测试默认）时不取头像
      prompts.length = 0;
      sent.length = 0;
      await brain.handle(ev('2468013', '先不看'));
      asked === '' && !/【对方的头像】/.test(prompts[prompts.length - 1] ?? '') ? ok('视觉关闭时不下载、不提头像') : no('视觉关闭仍取了头像', asked);
      brain.cfg.stickers.visionMode = 'onDemand';
      prompts.length = 0;
      sent.length = 0;
      await brain.handle(ev('2468013', '在吗'));
      brain.cfg.stickers.visionMode = 'off';
      globalThis.fetch = realFetch;
      brain.stickers = oldStickers;
      const p = prompts[prompts.length - 1] ?? '';
      /q1\.qlogo\.cn\/g\?b=qq&nk=2468013/.test(asked) ? ok('按发言人的 QQ 号请求头像') : no('头像地址不对', asked);
      /【对方的头像】/.test(p) && /avatars[\\/]2468013\.jpg/.test(p) ? ok('提示词里有头像路径，她可以 read_image 查看') : no('提示词没有头像', p.slice(-400));
      sent.length === 1 ? ok('取头像不影响正常回复') : no('取头像后没回复', JSON.stringify(sent));
    }

    // 4d) 头像册：对方说"分析我们几个人的头像"，她拿到群里相关的人的头像文件
    {
      const realFetch = globalThis.fetch;
      const oldStickers = brain.stickers;
      const oldAmbient = brain.ambient;
      const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]), Buffer.from('JFIF'), Buffer.alloc(32)]);
      const asked = [];
      globalThis.fetch = async (url) => {
        asked.push(String(url));
        return new Response(JPG, { status: 200, headers: { 'content-type': 'image/jpeg' } });
      };
      brain.stickers = { dir: join(dir, 'stk2'), ok: false };
      brain.ambient = { db: { participants: () => [{ userId: '3333333', nickname: '乙', at: 1 }, { userId: '4444444', nickname: '丙', at: 1 }, { userId: '5555555', nickname: '丁', at: 1 }] } };
      brain.cfg.stickers.visionMode = 'onDemand';
      prompts.length = 0;
      await brain.handle(ev('2468013', '帮我分析一下我们几个人的头像', { atIds: ['9999999'] }));
      const p = prompts[prompts.length - 1] ?? '';
      const names = ['u2468013', '乙', '丙', '丁', 'QQ 9999999'];
      names.every((n) => p.includes(n)) && /【群友头像册】/.test(p) ? ok('头像册里有发言人、被 @ 的人和最近发言的人') : no('头像册缺人', p.slice(p.indexOf('【群友头像册】'), p.indexOf('【群友头像册】') + 400));
      ['2468013', '3333333', '4444444', '5555555', '9999999'].every((id) => new RegExp(`avatars[\\\\/]${id}\\.jpg`).test(p)) ? ok('每个人的头像路径都在提示词里') : no('头像路径不全');
      asked.length === 5 ? ok('每人只下载一次（发言人的头像不重复取）') : no('下载次数不对', String(asked.length));

      // 不提头像时不整理头像册
      asked.length = 0;
      prompts.length = 0;
      await brain.handle(ev('2468013', '今天吃啥'));
      !/【群友头像册】/.test(prompts[prompts.length - 1] ?? '') ? ok('没提头像就不出头像册') : no('无关话题也出了头像册');

      brain.cfg.stickers.visionMode = 'off';
      globalThis.fetch = realFetch;
      brain.stickers = oldStickers;
      brain.ambient = oldAmbient;
    }

    // 4e) 重启后遗留的绑定会话（不是本进程创建的、没跑过 setup）必须重建，
    //     否则它没有人设系统提示词段，每条消息都得重发整份人设
    {
      let created = 0;
      const realCreate = agents.create;
      agents.create = async (o) => {
        created += 1;
        // 像真实宿主一样：创建时跑 setup，agent 参数拿不到
        await o.setup?.({ get: () => undefined, systemPrompt: { section: () => {} } }, undefined);
        return realCreate(o);
      };
      store.bind('group:1', 'session-left-over-from-last-run');
      await brain.handle(ev('55', '重启后的第一句'));
      created === 1 ? ok('重启遗留的旧会话被重建（会跑 setup、挂人设段）') : no('遗留会话没重建', String(created));
      const sid = store.boundSession('group:1');
      sid !== 'session-left-over-from-last-run' && brain.systemPromptAgents.has(sid) && brain.createdHere.has(sid)
        ? ok('新会话被记为"本进程创建 + 人设已在系统提示词里"')
        : no('新会话没被记录', JSON.stringify([sid, [...brain.systemPromptAgents]]));
      await brain.handle(ev('55', '第二句'));
      created === 1 ? ok('同一进程里第二条消息沿用该会话，不会反复重建') : no('反复重建', String(created));
      agents.create = realCreate;
    }

    // 4f) 等回复：空闲超时 + 总上限。干活（不断有新事件）时不能被硬超时丢掉回复
    {
      const mk = (feed) => {
        const events = [];
        const t0 = Date.now();
        return { session: { snapshotEvents: () => { feed(events, Date.now() - t0); return events; } } };
      };
      // 每 100ms 一个 tool 事件，持续 900ms 后结束；空闲超时只有 300ms，但一直在干活
      const busy = mk((ev2, ms) => {
        const n = Math.floor(ms / 100);
        while (ev2.length < Math.min(n, 9)) ev2.push({ type: 'tool/call', data: {} });
        if (ms >= 900 && !ev2.some((e) => e.type === 'turn/end')) ev2.push({ type: 'turn/end', data: { turn: 1, reason: { kind: 'stop' } } });
      });
      const r1 = await brain.waitForTurnEnd(busy, 0, 300, 3000);
      r1?.turn === 1 ? ok('一直在干活（读图/调工具）时，超过空闲超时也继续等，回复不被丢') : no('干活中被超时丢掉', JSON.stringify(r1));

      const idle = mk(() => {});
      const t1 = Date.now();
      const r2 = await brain.waitForTurnEnd(idle, 0, 300, 3000);
      r2 === null && Date.now() - t1 < 1200 ? ok('完全没动静则按空闲超时放弃，不会等到总上限') : no('卡死没及时放弃', String(Date.now() - t1));

      const endless = mk((ev2, ms) => { while (ev2.length < Math.floor(ms / 50)) ev2.push({ type: 'tool/call', data: {} }); });
      const t2 = Date.now();
      const r3 = await brain.waitForTurnEnd(endless, 0, 300, 700);
      r3 === null && Date.now() - t2 < 1500 ? ok('一直在动但永远不结束：到总上限就放弃') : no('总上限没生效', String(Date.now() - t2));
    }

    // 4g) 她末尾的记忆块 JSON 写坏了，也不能漏进发出去的正文
    {
      const bad = '看完啦\n\n你的头像是只白猫\n\n<<MEMO>>{"facts":["x"],"episode":"他让我分析头像，我照着说了"]}<</MEMO>>';
      const { clean, memo } = splitMemo(bad);
      !/MEMO|episode/.test(clean) && clean.includes('看完啦') && clean.includes('白猫')
        ? ok('记忆块 JSON 写坏时，只是丢掉这条记忆，正文原样保留、记忆块不外漏')
        : no('坏记忆块漏进正文', JSON.stringify({ clean, memo }));
    }

    // 4h) 引用：被引用消息的内容要进提示词；取不到就如实说取不到
    {
      const oldGet = onebot.getMessage;
      const old = Date.now() - 12 * 86400000;
      onebot.getMessage = async (id) =>
        id === 'q-ok'
          ? { id, userId: '30003', nickname: '李同学', text: '周五的面试我过了', at: old, mine: false, images: 0 }
          : id === 'q-mine'
            ? { id, userId: '10000', nickname: '小鱼', text: '那你先垫两口', at: Date.now() - 5 * 60000, mine: true, images: 0 }
            : null;
      prompts.length = 0;
      await brain.handle(ev('66', '那后来呢', { replyId: 'q-ok', atMe: true }));
      const p1 = prompts[prompts.length - 1] ?? '';
      /【对方引用的消息】/.test(p1) && p1.includes('李同学') && p1.includes('周五的面试我过了') && /12 天前/.test(p1) && p1.includes('别当成刚发生的事')
        ? ok('引用了很久以前的消息：内容、发送者、几天前都在提示词里')
        : no('引用内容没进提示词', p1.slice(p1.indexOf('【对方引用的消息】'), p1.indexOf('【对方引用的消息】') + 300));
      prompts.length = 0;
      await brain.handle(ev('67', '嗯嗯', { replyId: 'q-mine', atMe: true }));
      const p2 = prompts[prompts.length - 1] ?? '';
      /发送者：你自己/.test(p2) && p2.includes('那你先垫两口') && !p2.includes('别当成刚发生的事') ? ok('引用的是她自己的话：标明是"你自己"，近期的不提醒"以前的"') : no('引用自己的话', p2.slice(p2.indexOf('【对方引用的消息】'), p2.indexOf('【对方引用的消息】') + 200));
      prompts.length = 0;
      await brain.handle(ev('68', '这个呢', { replyId: 'q-gone', atMe: true }));
      const p3 = prompts[prompts.length - 1] ?? '';
      /内容取不到/.test(p3) && /不要假装知道/.test(p3) ? ok('被引用消息取不到时，如实告诉她并禁止假装知道') : no('取不到的提示不对', p3.slice(p3.indexOf('【对方引用的消息】'), p3.indexOf('【对方引用的消息】') + 200));
      prompts.length = 0;
      await brain.handle(ev('69', '没引用的普通话'));
      !/【对方引用的消息】/.test(prompts[prompts.length - 1] ?? '') ? ok('没引用时不出现这一段') : no('没引用却有这一段');
      onebot.getMessage = oldGet;
    }

    // 4i) 长图：超过 read_image 单边上限的图，要么切成段给她按顺序看，要么如实说看不了
    {
      const { spawnSync } = await import('node:child_process');
      const oldStickers = brain.stickers;
      brain.cfg.stickers.visionMode = 'onDemand';
      const stk = join(dir, 'stk3');
      mkdirSync(stk, { recursive: true });
      const stubLook = (note) => ({ dir: stk, ok: false, look: async () => [note] });

      // 切不了：文件不存在，任何平台都走"看不了"
      brain.stickers = stubLook({ path: join(stk, 'missing.png'), mediaType: 'image/png', hash: 'missing', size: { width: 1440, height: 11264 }, transient: true });
      prompts.length = 0;
      await brain.handle(ev('71', '你看这个长图', { images: [{ url: 'http://x/a.png' }] }));
      const pu = prompts[prompts.length - 1] ?? '';
      /太大我看不了/.test(pu) && /不要假装看过/.test(pu) && !pu.includes('missing.png') ? ok('切不了的超大图：提示词让她如实说看不了') : no('切不了时的提示不对', pu.slice(pu.indexOf('【对方这次发的图】'), pu.indexOf('【对方这次发的图】') + 300));

      // 真实切图（Windows）：现生成一张 1200×10000 的长图
      if (process.platform === 'win32') {
        const src = join(stk, 'long.png');
        const gen = spawnSync('powershell.exe', ['-NoProfile', '-Command', `Add-Type -AssemblyName System.Drawing; $b = New-Object System.Drawing.Bitmap 1200, 10000; $g = [System.Drawing.Graphics]::FromImage($b); $g.Clear([System.Drawing.Color]::White); $b.Save('${src.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png)`], { encoding: 'utf8' });
        if (gen.status === 0) {
          brain.stickers = stubLook({ path: src, mediaType: 'image/png', hash: 'longimg0123456789', size: { width: 1200, height: 10000 }, transient: true });
          prompts.length = 0;
          await brain.handle(ev('72', '帮我看看这张长图', { images: [{ url: 'http://x/b.png' }] }));
          const pt = prompts[prompts.length - 1] ?? '';
          const segs = [...pt.matchAll(/第 (\d+) 段：(.+\.jpg)/g)].map((m) => m[2]);
          segs.length >= 3 && segs.every((p) => /seen[\\/]tiles[\\/]longimg012345678[\d]*-\d\.jpg$/.test(p)) && /1200×10000/.test(pt) && !pt.includes('long.png')
            ? ok(`长图被切成 ${segs.length} 段放进提示词（路径在可读目录 seen/tiles 下），不再给原图`)
            : no('长图没切段', pt.slice(pt.indexOf('【对方这次发的图】'), pt.indexOf('【对方这次发的图】') + 500));
        } else no('生成测试长图失败', gen.stderr?.slice(0, 150));
      }

      // 普通小图不受影响
      brain.stickers = stubLook({ path: join(stk, 'small.png'), mediaType: 'image/png', hash: 'small', size: { width: 800, height: 600 }, transient: true });
      prompts.length = 0;
      await brain.handle(ev('73', '这张呢', { images: [{ url: 'http://x/c.png' }] }));
      const ps = prompts[prompts.length - 1] ?? '';
      ps.includes('small.png') && !/超长图|太大我看不了/.test(ps) ? ok('普通尺寸的图不切、照旧给路径') : no('普通图被误处理', ps.slice(ps.indexOf('【对方这次发的图】'), ps.indexOf('【对方这次发的图】') + 200));

      // 4j) 群里没 @ 她时别人发的图，之后有人问"你看这张图"，她要能看到；引用消息里的图也一样
      const lookOf = async (e) => (e.images ?? []).map((i) => ({ hash: i.url.slice(-6), path: join(stk, `${i.url.slice(-6)}.png`), mediaType: 'image/png', size: { width: 800, height: 600 }, transient: true }));
      brain.stickers = { dir: stk, ok: false, look: async (e) => lookOf(e) };
      prompts.length = 0;
      const decided = await brain.handle(ev('81', '', { atMe: false, images: [{ url: 'http://x/group-pic-1' }] }));
      await new Promise((r) => setTimeout(r, 50));
      const waiting = brain.seenImages.get('group:1') ?? [];
      waiting.length === 1 && decided == null ? ok('没轮到她回应的群图被先存下来') : no('群图没存', JSON.stringify([waiting.length, decided]));
      await brain.handle(ev('82', '你看见刚才那张图了吗'));
      const pe = prompts[prompts.length - 1] ?? '';
      /【之前发的图】/.test(pe) && /u81/.test(pe) && pe.includes('-pic-1.png') ? ok('之后被问到时，提示词带上了之前那张群图（标明是谁发的）') : no('提示词没带之前的群图', pe.slice(pe.indexOf('【之前发的图】'), pe.indexOf('【之前发的图】') + 250));
      prompts.length = 0;
      await brain.handle(ev('83', '那张图呢'));
      !/【之前发的图】/.test(prompts[prompts.length - 1] ?? '') ? ok('同一张之前的图只给一次，不会反复附') : no('之前的图被重复给了');

      // 被引用消息里的图
      prompts.length = 0;
      brain.onebot.getMessage = async () => ({ ok: true, id: 'q1', userId: '90', nickname: '老王', text: '', at: Date.now() - 86400000, mine: false, images: 1, imageList: [{ url: 'http://x/quoted-pic' }] });
      await brain.handle(ev('84', '这张图什么意思', { replyId: 'q1' }));
      const pq = prompts[prompts.length - 1] ?? '';
      /被引用的消息里（老王发的）/.test(pq) && pq.includes('ed-pic.png') ? ok('被引用消息里的图也下载并交给她') : no('被引用的图没给', pq.slice(pq.indexOf('【之前发的图】'), pq.indexOf('【之前发的图】') + 250));

      // 4k) 群里已经冷场很久时的主动开口：记忆里"最近在聊"是旧话题，不能给她；被动回应照常带
      const oldGm = brain.groupMemory;
      brain.groupMemory = { notesFor: () => ({ lore: ['「某梗」x'], relations: [], topics: ['妹妹上班的事'] }) };
      prompts.length = 0;
      await brain.proactiveSay({ chatKey: 'group:1', groupId: '1', hint: '冷场了' });
      const pc = prompts[prompts.length - 1] ?? '';
      !pc.includes('妹妹上班的事') && pc.includes('「某梗」x') ? ok('冷场后主动开口：不带旧的"最近在聊"，其他群记忆保留') : no('冷场暖场仍带着旧话题', pc.slice(pc.indexOf('【你对这个群'), pc.indexOf('【你对这个群') + 200));
      prompts.length = 0;
      await brain.handle(ev('85', '随便说句话'));
      (prompts[prompts.length - 1] ?? '').includes('妹妹上班的事') ? ok('被 @ 回应时照常带"最近在聊"') : no('被动回应也被去掉了话题');
      brain.groupMemory = oldGm;

      // 4l) 群里每一轮都写明"这一轮是谁在跟她说话"，同群多人时才不会把 A 的事安到 B 头上
      prompts.length = 0;
      await brain.handle(ev('86', '你好呀', { nickname: '领事', userId: '555' }));
      const pn = prompts[prompts.length - 1] ?? '';
      /这一轮跟你说话的人是「领事」（QQ 555）/.test(pn) ? ok('群里每一轮都写明说话的人是谁') : no('提示词没写明说话的人', pn.slice(0, 200));
      const pp = buildPrompt({ persona: { name: '小鱼', identity: 'x', speech: {} }, profile: { userId: '9', nickname: 'P', traits: [], facts: [], episodes: [], interactions: 0 }, event: { kind: 'private', text: 'hi', nickname: 'P', userId: '9' }, staticsInSystem: true });
      !/这一轮跟你说话的人是/.test(pp) ? ok('私聊不加这句') : no('私聊也加了说话人句');
      /每件事、每张图、每段经历都有自己的主人/.test(buildSystemPrompt({ name: '小鱼', identity: 'x', speech: {} })) ? ok('系统提示词里有"事归各人"的规则') : no('系统提示词缺规则');

      brain.cfg.stickers.visionMode = 'off';
      brain.stickers = oldStickers;
    }

    // 5) 戳一戳：群里的戳要按「在群里」处理，不能当私聊；过期的戳不回
    const poke = (userId, extra = {}) => ({
      kind: 'poke', groupId: '1', chatKey: 'group:1', userId, nickname: `u${userId}`,
      text: '[戳了戳你]', atMe: true, messageId: null, at: Date.now(), ...extra,
    });
    sent.length = 0;
    prompts.length = 0;
    await brain.handle(poke('55'));
    const pokePrompt = prompts[prompts.length - 1] ?? '';
    /你正在一个 QQ 群（群号 1）/.test(pokePrompt) && !/在私聊/.test(pokePrompt)
      ? ok('群里被戳：场景是「在群里」，不再误判成私聊')
      : no('群里的戳被当成私聊', pokePrompt.slice(0, 120));
    sent.length === 1 ? ok('刚被戳会正常回一句') : no('刚被戳没回', JSON.stringify(sent));
    !/秒前的事了/.test(pokePrompt) ? ok('刚被戳时提示里不会说"几秒前"') : no('新鲜的戳被说成过期');

    sent.length = 0;
    prompts.length = 0;
    await brain.handle(poke('55', { at: Date.now() - 200_000 }));
    prompts.length === 0 && sent.length === 0 ? ok('3 分钟前的戳（排队太久）直接当没看见') : no('过期的戳还被回了', JSON.stringify({ prompts: prompts.length, sent }));

    await brain.handle(poke('55', { at: Date.now() - 30_000 }));
    /30 秒前的事了/.test(prompts[prompts.length - 1] ?? '') ? ok('半分钟前的戳：提示里如实告诉她这是 30 秒前的事') : no('没说明戳是多久以前的', (prompts[prompts.length - 1] ?? '').slice(0, 160));

    // 她在这一戳之后已经说过话 → 不再回头回这一戳
    sent.length = 0;
    prompts.length = 0;
    brain.ambient = { selfSaid: () => [{ text: '刚说的', at: Date.now() }] };
    await brain.handle(poke('55', { at: Date.now() - 5_000 }));
    brain.ambient = undefined;
    prompts.length === 0 && sent.length === 0 ? ok('她在这一戳之后已经说过话，就不再回头回这一戳') : no('说过话之后还回了旧戳', JSON.stringify(sent));

    // 戳回去慢（调用耗时）不能让戳一戳插到后来的消息后面
    sent.length = 0;
    brain.social = { tryPokeBack: async () => { await sleep(400); return null; } };
    const p1 = brain.handle(poke('66'));
    const p2 = brain.handle(ev('11', '后来的话'));
    await Promise.all([p1, p2]);
    brain.social = undefined;
    sent[0] === '回:[戳了戳你]' && sent[1] === '回:后来的话'
      ? ok('戳一戳按到达顺序处理，不会被后来的话插队')
      : no('戳一戳被插队', JSON.stringify(sent));
  } finally {
    safeRm(dir);
  }
}

console.log('');
if (bad) {
  console.log(`✗ ${bad} 项失败`);
  process.exit(1);
}
console.log('✓ 拟人互动验证通过');
