// 引用策略 + 主动发言触发链路自测
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { shouldQuoteReply } from './dsh-qq/lib/brain.js';
import { MessageDB } from './dsh-qq/lib/msgdb.js';
import { Ambient } from './dsh-qq/lib/ambient.js';

let bad = 0;
const ok = (m) => console.log(`  ✓ ${m}`);
const no = (m, d = '') => {
  console.log(`  ✗ ${m}${d ? ` —— ${d}` : ''}`);
  bad += 1;
};
const safeRm = (dir) => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {}
};

// ---------- 引用策略 ----------
const evt = (over = {}) => ({ kind: 'group', messageId: 'm1', atMe: true, at: 1000, ...over });
shouldQuoteReply(evt(), 0) === false ? ok('立刻回复不引用') : no('立刻回复却引用了');
shouldQuoteReply(evt(), 1) === true ? ok('隔了别人消息才引用') : no('隔了消息却不引用');
shouldQuoteReply(evt({ kind: 'private' }), 5) === false ? ok('私聊永不引用') : no('私聊引用了');
shouldQuoteReply(evt({ messageId: null }), 5) === false ? ok('没有消息 id 不引用') : no('无 id 却引用');

// ---------- countAfter ----------
{
  const dir = mkdtempSync(join(tmpdir(), 'qqquote-'));
  const db = new MessageDB(dir, () => {});
  const key = 'group:1';
  db.append({ chatKey: key, groupId: '1', userId: 'a', nickname: 'A', text: '第一条', at: 100 });
  db.append({ chatKey: key, groupId: '1', userId: 'b', nickname: 'B', text: '第二条', at: 200 });
  db.append({ chatKey: key, groupId: '1', userId: 'c', nickname: 'C', text: '第三条', at: 300 });
  db.countAfter(key, 100) === 2 ? ok('触发消息之后有 2 条') : no('countAfter 错误', String(db.countAfter(key, 100)));
  db.countAfter(key, 300) === 0 ? ok('最新一条之后没有消息') : no('最新一条之后被算成有');
  db.countAfter('group:2', 100) === 0 ? ok('别的群互不影响') : no('串群了');
  db.close();
  safeRm(dir);
}

// ---------- 主动发言链路 ----------
{
  const dir = mkdtempSync(join(tmpdir(), 'qqchime-'));
  try {
    const logs = [];
    const store = {
      dir,
      profile: () => ({}),
      boundSession: () => 'session-x',
      listProfiles: () => [],
    };
    const brain = {
      cfg: {
        access: { users: ['136638211'], groups: ['1'], groupMemberScope: 'group' },
        proactive: {
          enabled: true,
          maxPerHour: 5,
          quietHours: [],
          pause: { enabled: false },
          ambient: { enabled: true, sampleRate: 1, minGapMinutes: 0 },
          idle: { enabled: true, minutes: 1 },
          private: { enabled: false },
        },
      },
      proactiveSay: async () => '接一句',
      proactivePrivateSay: async () => null,
    };
    const ambient = new Ambient({ brain, store, log: (...a) => logs.push(a.join(' ')) });
    const event = { kind: 'group', groupId: '1', chatKey: 'group:1', userId: '999', nickname: '群友', text: '这个报错到底怎么弄啊', atMe: false, at: Date.now() };
    const out = await ambient.maybeChime(event);
    out === '接一句' ? ok('采样命中后真的发出去了') : no('主动发言没触发', String(out));
    ambient.stats.sampled >= 1 ? ok('采样计数正常') : no('采样计数没记录', JSON.stringify(ambient.stats));

    // 同一条消息再来一次：minGap=0，但每小时上限会拦（这里 maxPerHour=5，仍应通过）
    const atMe = await ambient.maybeChime({ ...event, atMe: true });
    atMe === null ? ok('被 @ 时不走主动插话') : no('被 @ 也触发了主动插话');

    const short = await ambient.maybeChime({ ...event, text: '嗯' });
    short === null ? ok('太短的话不接') : no('太短也接了');
    ambient.stop();
  } finally {
    safeRm(dir);
  }
}

// ---------- 静默暖场：话题早已结束时，不能让她接旧话题 ----------
{
  const mk = (extraProactive = {}, profileOf = () => ({}), brainExtra = {}) => {
    const dir = mkdtempSync(join(tmpdir(), 'qqcold-'));
    const hints = [];
    const reqs = [];
    const extras = [];
    const brain = {
      cfg: {
        access: { users: [], groups: ['1'], groupMemberScope: 'group' },
        proactive: { enabled: true, maxPerHour: 9, quietHours: [], pause: { enabled: false }, ambient: { enabled: true, sampleRate: 1, minGapMinutes: 0 }, idle: { enabled: true, minutes: 45 }, private: { enabled: false }, ...extraProactive },
      },
      proactiveSay: async ({ hint, requireTool, biliNotes, biliCandidates }) => (hints.push(hint), reqs.push(requireTool), extras.push({ biliNotes, biliCandidates }), 'x'),
      ...brainExtra,
      proactivePrivateSay: async () => null,
    };
    const ambient = new Ambient({ brain, store: { dir, profile: profileOf, boundSession: () => 's', listProfiles: () => [] }, log: () => {} });
    return { ambient, hints, reqs, extras, dir };
  };
  const clueProfile = (id) => (id === '1001' ? { traits: ['爱玩动作游戏'], facts: ['在玩影之刃零'] } : {});
  const { ambient, hints, reqs, dir } = mk({}, clueProfile);
  try {
    const chatKey = 'group:1';
    // 一小时前还在聊：已出"最近话题"窗口（默认 30 分钟）
    ambient.db.append({ chatKey, groupId: '1', userId: '1001', nickname: 'A', text: '我妹妹上班了', at: Date.now() - 60 * 60000 });
    ambient.db.append({ chatKey, groupId: '1', userId: '1002', nickname: 'B', text: '她好厉害', at: Date.now() - 58 * 60000 });
    await ambient.sweep();
    hints.length === 1 && /早就翻篇了/.test(hints[0]) && !/接着上面最近的话题/.test(hints[0]) && /分钟没人说话/.test(hints[0])
      ? ok('隔了很久的暖场：提示"早就翻篇了"，不再让她接上面的话题')
      : no('暖场提示还在让她接旧话题', hints[0]);
    reqs[0] === true && /web_search/.test(hints[0]) && /在玩影之刃零/.test(hints[0]) && /B站/.test(hints[0]) && /小红书/.test(hints[0])
      ? ok('冷场暖场改成"发现型"：带群友爱好线索、让她联网找B站/小红书内容，并要求这一轮真的查过')
      : no('发现型暖场提示不对', hints[0]);
    !/困了、天气|此刻的小状态/.test(hints[0]) && /没内容的话/.test(hints[0]) && /不要编造你自己刚做了什么/.test(hints[0])
      ? ok('不再建议"困了/饭点"这类时间流水账，并明确禁止编造自己的经历')
      : no('提示里仍有时间流水账建议', hints[0]);
    await ambient.sweep();
    hints.length === 1 ? ok('刚暖过、间隔不够时不会连着再来') : no('连续暖场了', String(hints.length));

    // 内存缓冲兜底以前不看时间：几个小时前的消息会被当成"最近在聊"
    ambient.note({ kind: 'group', groupId: '1', chatKey: 'group:2', userId: 'u3', nickname: 'C', text: '三小时前的话', atMe: false, at: Date.now() - 3 * 3600000 });
    ambient.timeline('group:2').length === 0 ? ok('过期的内存缓冲不再被当成"最近在聊"') : no('过期缓冲仍进了时间线', JSON.stringify(ambient.timeline('group:2')));
  } finally {
    ambient.stop();
    safeRm(dir);
  }

  // 没有任何爱好线索：不暖场（不硬聊）；关掉发现模式则用"有内容的新话头"；她上一句没人理不再暖场；每日上限
  {
    const none = mk();
    try {
      none.ambient.db.append({ chatKey: 'group:1', groupId: '1', userId: '1001', nickname: 'A', text: '随便聊', at: Date.now() - 60 * 60000 });
      await none.ambient.sweep();
      none.hints.length === 0 ? ok('没有群友爱好线索时不暖场') : no('没线索也暖场了', none.hints[0]);
    } finally {
      none.ambient.stop();
      safeRm(none.dir);
    }
    const off = mk({ idle: { enabled: true, minutes: 45, discover: false } });
    try {
      off.ambient.db.append({ chatKey: 'group:1', groupId: '1', userId: '1001', nickname: 'A', text: '随便聊', at: Date.now() - 60 * 60000 });
      await off.ambient.sweep();
      off.hints.length === 1 && off.reqs[0] === false && !/web_search/.test(off.hints[0]) && /没内容的话/.test(off.hints[0]) ? ok('关闭发现模式：只开有具体内容的新话头，同样禁止流水账') : no('关闭发现模式的提示不对', off.hints[0]);
    } finally {
      off.ambient.stop();
      safeRm(off.dir);
    }
    const un = mk({}, clueProfile);
    try {
      un.ambient.db.append({ chatKey: 'group:1', groupId: '1', userId: '1001', nickname: 'A', text: '我妹妹上班了', at: Date.now() - 120 * 60000 });
      un.ambient.db.append({ chatKey: 'group:1', groupId: '1', userId: '9', nickname: '她', text: '嗯 加油', at: Date.now() - 60 * 60000, self: true });
      await un.ambient.sweep();
      un.hints.length === 0 ? ok('她上一句没人理（最后一条是她自己的）时不再暖场') : no('没人理还在暖场', un.hints[0]);
    } finally {
      un.ambient.stop();
      safeRm(un.dir);
    }
    const cap = mk({ idle: { enabled: true, minutes: 45, maxPerDay: 1 } }, clueProfile);
    try {
      cap.ambient.db.append({ chatKey: 'group:1', groupId: '1', userId: '1001', nickname: 'A', text: '随便聊', at: Date.now() - 60 * 60000 });
      await cap.ambient.sweep();
      cap.ambient.db.setChime('group:1', Date.now() - 3 * 3600 * 1000); // 让间隔限制过去，只剩每日上限
      await cap.ambient.sweep();
      cap.hints.length === 1 ? ok('每个群每天暖场次数有上限') : no('每日上限没生效', String(cap.hints.length));
    } finally {
      cap.ambient.stop();
      safeRm(cap.dir);
    }
  }

  // B 站候选：有候选就走"挑一个转发"；没候选才退回联网搜索
  {
    const cands = [{ bvid: 'BV1GJ411x7h7', title: '好视频', author: 'UP', duration: 200, play: 90000, keyword: '影之刃', who: 'A' }];
    const withBili = mk({}, clueProfile, { biliDiscover: async () => cands });
    try {
      withBili.ambient.db.append({ chatKey: 'group:1', groupId: '1', userId: '1001', nickname: 'A', text: '随便聊', at: Date.now() - 60 * 60000 });
      await withBili.ambient.sweep();
      const e = withBili.extras[0];
      withBili.reqs[0] === false && e?.biliCandidates?.join() === 'BV1GJ411x7h7' && e.biliNotes.some((x) => /BV1GJ411x7h7/.test(x) && /和 A 的爱好有关/.test(x)) && /\[\[B站:BV号\]\]/.test(withBili.hints[0]) && !/web_search/.test(withBili.hints[0])
        ? ok('冷场暖场有 B 站候选时：只让她从候选里挑一个转发（带卡片标记），不再要求联网搜索')
        : no('B 站暖场提示不对', JSON.stringify({ e, h: withBili.hints[0]?.slice(0, 200) }));
    } finally {
      withBili.ambient.stop();
      safeRm(withBili.dir);
    }
    const empty = mk({}, clueProfile, { biliDiscover: async () => [] });
    try {
      empty.ambient.db.append({ chatKey: 'group:1', groupId: '1', userId: '1001', nickname: 'A', text: '随便聊', at: Date.now() - 60 * 60000 });
      await empty.ambient.sweep();
      empty.reqs[0] === true && /web_search/.test(empty.hints[0]) ? ok('B 站没搜到候选时，退回联网搜索的发现模式') : no('没候选没有退回', empty.hints[0]);
      const groups = empty.ambient.interestGroups('group:1');
      groups.length === 1 && groups[0].nickname === 'A' && groups[0].words.includes('影之刃零') ? ok('从画像里整理出每个群友的爱好词（事实优先）') : no('爱好词不对', JSON.stringify(groups));
    } finally {
      empty.ambient.stop();
      safeRm(empty.dir);
    }
  }

  // 还在窗口内（窗口调大）时，仍然让她接最近的话题
  const warm = mk({ recentWindowMinutes: 180 });
  try {
    warm.ambient.db.append({ chatKey: 'group:1', groupId: '1', userId: '1001', nickname: 'A', text: '我妹妹上班了', at: Date.now() - 60 * 60000 });
    await warm.ambient.sweep();
    warm.hints.length === 1 && /接着上面最近的话题/.test(warm.hints[0]) ? ok('话题还新鲜时，仍然让她接最近的话题') : no('新鲜话题的提示不对', warm.hints[0]);
  } finally {
    warm.ambient.stop();
    safeRm(warm.dir);
  }
}

// ---------- 停顿后决策（取代逐条采样） ----------
{
  const dir = mkdtempSync(join(tmpdir(), 'qqpause-'));
  try {
    const store = { dir, profile: () => ({}), boundSession: () => 's', listProfiles: () => [] };
    const brain = {
      cfg: {
        access: { users: [], groups: ['1'], groupMemberScope: 'group' },
        proactive: {
          enabled: true,
          maxPerHour: 9,
          quietHours: [],
          pause: { enabled: true, seconds: 60 },
          ambient: { enabled: true, sampleRate: 1, minGapMinutes: 20 },
          idle: { enabled: false },
          private: { enabled: false },
        },
      },
      proactiveSay: async () => '补一句',
      proactivePrivateSay: async () => null,
    };
    const ambient = new Ambient({ brain, store, log: () => {} });
    const chatKey = 'group:1';

    // 只有一条短消息、也没聊几轮 → 不接
    ambient.db.append({ chatKey, groupId: '1', userId: 'u1', nickname: 'A', text: '嗯', at: Date.now() });
    const none = await ambient.maybeChimeOnPause('1', chatKey);
    none === null ? ok('只有一句"嗯"时不接') : no('单句也被接了');

    // 一段真实对话（多条）→ 该掷骰就接
    ambient.db.append({ chatKey, groupId: '1', userId: 'u1', nickname: 'A', text: '这个报错怎么修', at: Date.now() });
    ambient.db.append({ chatKey, groupId: '1', userId: 'u2', nickname: 'B', text: '先看日志', at: Date.now() });
    ambient.db.append({ chatKey, groupId: '1', userId: 'u1', nickname: 'A', text: '日志里说超时', at: Date.now() });
    const hit = await ambient.maybeChimeOnPause('1', chatKey);
    hit === '补一句' ? ok('聊过几轮后停顿 → 接一句') : no('停顿后没接', String(hit));

    // 刚接过一次，间隔不足 → 不再接
    const again = await ambient.maybeChimeOnPause('1', chatKey);
    again === null ? ok('间隔不足时不再接') : no('间隔没生效');

    // 安静时段不接
    brain.cfg.proactive.quietHours = ['00:00-23:59'];
    const quiet = await ambient.maybeChimeOnPause('1', chatKey);
    quiet === null ? ok('免打扰时段不接') : no('免打扰时段仍接了');

    ambient.stop();
  } finally {
    safeRm(dir);
  }
}

console.log('');
if (bad) {
  console.log(`✗ ${bad} 项失败`);
  process.exit(1);
}
console.log('✓ 引用与主动发言验证通过');
