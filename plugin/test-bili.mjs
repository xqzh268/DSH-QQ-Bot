// B 站搜索 / 链接解析 / 视频卡片分享 的验证（全部离线，用假 fetch 与假 NapCat）。
// 联网实测见 plugin/live-bili.mjs。
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BiliClient, buildBiliCard, describeVideo, extractBiliMarkers, findBiliRefs, interestWords, pickDiscoverCandidates, wbiKeyFrom, wbiSign, fmtCount, fmtDuration,
} from './dsh-qq/lib/bili.js';
import { LinkReader, parseMeta } from './dsh-qq/lib/links.js';
import { Brain, biliSearchQuery } from './dsh-qq/lib/brain.js';
import { ProjectStore } from './dsh-qq/lib/persona.js';
import { buildPrompt, buildSystemPrompt } from './dsh-qq/lib/prompt.js';

let failed = 0;
const ok = (m) => console.log(`  ✓ ${m}`);
const no = (m, d = '') => {
  failed += 1;
  console.log(`  ✗ ${m}${d ? `\n      ${d}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 纯函数 ----------
{
  // B 站公开文档里的 WBI 示例（img_key/sub_key → mixin key；固定 wts 下的签名）
  const imgUrl = 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png';
  const subUrl = 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png';
  const key = wbiKeyFrom(imgUrl, subUrl);
  key === 'ea1db124af3c7062474693fa704f4ff8' ? ok('WBI 混合 key 与官方示例一致') : no('WBI key 不对', String(key));
  const signed = wbiSign({ foo: '114', bar: '514', zab: 1919810 }, key, 1702204169);
  signed.w_rid === '8f6f2b5b3d485fe1886cec6a0be8c5d4' ? ok('WBI 签名与官方示例一致') : no('WBI 签名不对', signed.w_rid);
  wbiKeyFrom('x', 'y') === null ? ok('取不到 key 文件名时返回 null') : no('坏输入没返回 null');
  wbiSign({ k: "a!b'c(d)e*f" }, key, 1).k === 'abcdef' ? ok('参数值里的 !\'()* 会被去掉') : no('特殊字符没处理');

  const refs = findBiliRefs('看 https://www.bilibili.com/video/BV1GJ411x7h7/?p=1 还有 https://b23.tv/AbC123x 和 https://www.bilibili.com/video/av170001');
  refs.bvids[0] === 'BV1GJ411x7h7' && refs.shorts[0] === 'https://b23.tv/AbC123x' && refs.avs[0] === '170001'
    ? ok('能认出 BV 号 / 短链 / av 号') : no('链接识别不对', JSON.stringify(refs));
  findBiliRefs('今天吃了 BV 的鸡腿，BV0000000000').bvids.length === 0 ? ok('不是真 BV 号的文字不误判') : no('误判了 BV');

  const m = extractBiliMarkers('这个挺有意思 [[B站:BV1GJ411x7h7]]\n哈哈 [[b站：BV17zsd6nE1Y]] [[B站:瞎写的]]');
  m.ids.join() === 'BV1GJ411x7h7,BV17zsd6nE1Y' && !/\[\[/.test(m.clean) && /有意思/.test(m.clean)
    ? ok('[[B站:BV号]] 标记被摘掉，写不出 BV 的标记被丢弃') : no('标记提取不对', JSON.stringify(m));

  interestWords(['喜欢影之刃', '在玩影之刃零', '爱玩动作游戏', '好', '喜欢影之刃']).join('|') === '影之刃|影之刃零|动作游戏'
    ? ok('爱好词：去掉"喜欢/在玩/爱玩"前缀、去重、去掉过短的') : no('爱好词提取不对', interestWords(['喜欢影之刃', '在玩影之刃零', '爱玩动作游戏', '好']).join('|'));

  const vids = [
    { bvid: 'BV1aaaaaaaaa', pic: 'p', duration: 300, play: 50000, keyword: 'A' },
    { bvid: 'BV1bbbbbbbbb', pic: 'p', duration: 4 * 3600, play: 9e6, keyword: 'A' }, // 太长
    { bvid: 'BV1ccccccccc', pic: 'p', duration: 200, play: 100, keyword: 'A' }, // 没人看
    { bvid: 'BV1ddddddddd', pic: '', duration: 200, play: 90000, keyword: 'A' }, // 无封面
    { bvid: 'BV1eeeeeeeee', pic: 'p', duration: 200, play: 70000, keyword: 'A' },
    { bvid: 'BV1fffffffff', pic: 'p', duration: 200, play: 60000, keyword: 'A' }, // 同关键词第 3 条
    { bvid: 'BV1ggggggggg', pic: 'p', duration: 100, play: 8000, keyword: 'B' },
  ];
  const picked = pickDiscoverCandidates(vids, { seen: ['BV1eeeeeeeee'] });
  picked.map((v) => v.bvid).join() === 'BV1fffffffff,BV1aaaaaaaaa,BV1ggggggggg'
    ? ok('候选筛选：排掉分享过的/太长/没人看/无封面，同一关键词最多 2 条，按播放量排序') : no('候选筛选不对', picked.map((v) => v.bvid).join());

  fmtCount(427e4) === '427万' && fmtCount(9999) === '9999' && fmtDuration(3661) === '1:01:01' && fmtDuration(75) === '1:15'
    ? ok('播放量 / 时长格式化') : no('格式化不对');
  /《标题》.*UP主 某人.*（BV1aaaaaaaaa）/.test(describeVideo({ title: '标题', author: '某人', bvid: 'BV1aaaaaaaaa', duration: 60, play: 1 }))
    ? ok('视频说明行包含标题/UP主/BV 号') : no('说明行不对');

  biliSearchQuery('@小鱼 你在B站帮我找找影之刃零的视频') === '影之刃零'
    && biliSearchQuery('推荐几个做饭的B站视频吧') === '做饭'
    && biliSearchQuery('今天天气真好') === ''
    && biliSearchQuery('B站视频') === ''
    ? ok('"帮我找视频"类请求能取出搜索词，闲聊不触发') : no('搜索词提取不对', [biliSearchQuery('@小鱼 你在B站帮我找找影之刃零的视频'), biliSearchQuery('推荐几个做饭的B站视频吧')].join(' | '));

  const meta = parseMeta('<html><head><title>备用标题</title><meta property="og:title" content="周末探店 - 小红书"><meta name="description" content="这家店&amp;好吃"></head></html>');
  meta.title === '周末探店' && meta.desc === '这家店&好吃' ? ok('小红书页面 og:title / description 解析（去掉"- 小红书"后缀、还原实体）') : no('meta 解析不对', JSON.stringify(meta));
}

// ---------- BiliClient（假 fetch） ----------
{
  const calls = [];
  const imgUrl = 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png';
  const subUrl = 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png';
  const json = (body, status = 200) => ({ ok: status === 200, status, json: async () => body, headers: { get: () => null }, text: async () => '' });
  const fetchImpl = async (url, opts) => {
    calls.push({ url: String(url), cookie: opts?.headers?.Cookie ?? '' });
    const u = new URL(url);
    if (u.pathname === '/x/frontend/finger/spi') return json({ code: 0, data: { b_3: 'AAAA-1111', b_4: 'BBBB-2222' } });
    if (u.pathname === '/x/web-interface/nav') return json({ code: -101, data: { wbi_img: { img_url: imgUrl, sub_url: subUrl } } });
    if (u.pathname === '/x/web-interface/wbi/search/type') {
      return json({ code: 0, data: { result: [{ bvid: 'BV1GJ411x7h7', title: '<em class="keyword">影之刃</em>解说', author: 'UP', pic: '//i0.hdslb.com/a.jpg', duration: '12:34', play: 12345, description: 'd', typename: '单机游戏', pubdate: 1700000000 }, { title: '没有 bvid' }] } });
    }
    if (u.pathname === '/x/web-interface/view') {
      const bv = u.searchParams.get('bvid');
      if (bv === 'BV1GJ411x7h7') return json({ code: 0, data: { bvid: bv, title: '标题', desc: '简介', owner: { name: 'UP', mid: 1 }, pic: 'http://i0.hdslb.com/a.jpg', duration: 90, stat: { view: 5, like: 2 }, pages: [{}] } });
      return json({ code: -404, message: '啥都木有' });
    }
    return json({ code: 404 }, 404);
  };
  const c = new BiliClient({ fetchImpl, minGapMs: 0 });
  const list = await c.search('影之刃', 5);
  list.length === 1 && list[0].title === '影之刃解说' && list[0].duration === 754 && list[0].pic === 'https://i0.hdslb.com/a.jpg'
    ? ok('搜索：去 <em> 标签、时长转秒、封面补 https、丢掉没有 bvid 的') : no('搜索结果不对', JSON.stringify(list));
  const searchCall = calls.find((x) => x.url.includes('/wbi/search/type'));
  /w_rid=[0-9a-f]{32}/.test(searchCall?.url ?? '') && /wts=\d+/.test(searchCall.url) && /buvid3=AAAA-1111/.test(searchCall.cookie)
    ? ok('搜索请求带 WBI 签名与游客 buvid3 Cookie') : no('搜索请求缺签名或 Cookie', JSON.stringify(searchCall));
  const before = calls.length;
  await c.search('影之刃', 5);
  calls.length === before ? ok('同一关键词有缓存，不重复请求') : no('没走缓存');
  const v = await c.view('BV1GJ411x7h7');
  v?.title === '标题' && v.pic === 'https://i0.hdslb.com/a.jpg' && v.play === 5 ? ok('取视频信息') : no('view 不对', JSON.stringify(v));
  (await c.view('BV1aaaaaaaaa')) === null ? ok('查不到的视频返回 null（不会编）') : no('不存在的视频返回了东西');
  (await c.view('随便写')) === null ? ok('不是 BV/av 的输入返回 null') : no('坏输入没返回 null');

  // 风控：412 后一段时间不再请求
  let hits = 0;
  const blocked = new BiliClient({ fetchImpl: async () => (hits++, { ok: false, status: 412, json: async () => ({}), headers: { get: () => null } }), minGapMs: 0 });
  await blocked.view('BV1GJ411x7h7');
  const h1 = hits;
  await blocked.view('BV1aaaaaaaaa');
  await blocked.search('x');
  hits === h1 ? ok('被风控（412）后冷却，不再继续打 B 站') : no('风控后仍在请求', `${h1} → ${hits}`);

  // 网络抛错也不能把异常抛出来
  const broken = new BiliClient({ fetchImpl: async () => { throw new Error('boom'); }, minGapMs: 0 });
  const r = await broken.search('x');
  Array.isArray(r) && r.length === 0 && (await broken.view('BV1GJ411x7h7')) === null ? ok('网络出错：返回空而不是抛异常') : no('网络出错没兜住');
}

// ---------- 卡片 ----------
{
  const arkOk = { app: 'com.tencent.miniapp_01', view: 'view_x', ver: '1', prompt: '[QQ小程序]哔哩哔哩', meta: { detail_1: { appid: '1109937557', title: '哔哩哔哩', desc: '标题' } }, config: {} };
  let seen = null;
  const call = async (action, params) => ((seen = { action, params }), { data: arkOk });
  const video = { bvid: 'BV1GJ411x7h7', title: '标题', author: 'UP', pic: 'https://i0.hdslb.com/a.jpg' };
  const card = await buildBiliCard(call, video);
  seen?.action === 'get_mini_app_ark' && seen.params.type === 'bili' && seen.params.picUrl === video.pic
    && seen.params.jumpUrl === 'pages/video/video?bvid=BV1GJ411x7h7' && seen.params.webUrl === 'https://www.bilibili.com/video/BV1GJ411x7h7'
    ? ok('向 NapCat 要 B 站小程序卡片：参数（type=bili/封面/jumpUrl/webUrl）正确') : no('get_mini_app_ark 参数不对', JSON.stringify(seen));
  JSON.parse(card).app === 'com.tencent.miniapp_01' ? ok('返回可直接放进 json 消息段的卡片字符串') : no('卡片内容不对', card);
  JSON.parse(await buildBiliCard(async () => arkOk, video)).app === 'com.tencent.miniapp_01' ? ok('回包少包一层 data 时也认') : no('少包一层没认出来');
  (await buildBiliCard(async () => { throw new Error('x'); }, video)) === null
    && (await buildBiliCard(async () => ({ data: { foo: 1 } }), video)) === null
    && (await buildBiliCard(call, { ...video, pic: '' })) === null
    ? ok('NapCat 报错 / 回包不像卡片 / 没封面：返回 null，由上层退回文字') : no('异常情况没返回 null');
}

// ---------- 提示词 ----------
{
  const persona = { name: '小鱼', identity: '群友', speech: {} };
  const event = { kind: 'group', groupId: '1', chatKey: 'group:1', userId: '9', nickname: '甲', text: '看这个', atMe: true };
  const withNotes = buildPrompt({ persona, profile: {}, event, staticsInSystem: true, linkNotes: ['B站视频：《标题》（BV1GJ411x7h7）'] });
  /【系统帮你查到的内容】/.test(withNotes) && /BV1GJ411x7h7/.test(withNotes) ? ok('链接内容进了提示词，并声明是系统真实查到的') : no('提示词没带链接内容');
  !/【系统帮你查到的内容】/.test(buildPrompt({ persona, profile: {}, event, staticsInSystem: true })) ? ok('没有链接内容时不多占提示词') : no('空链接内容也出现了');
  /\[\[B站:BV号\]\]/.test(buildSystemPrompt(persona)) && /绝对不能凭记忆/.test(buildSystemPrompt(persona)) ? ok('系统提示词写明了分享 B 站视频的标记和"不许编 BV 号"') : no('系统提示词缺 B 站说明');
}

// ---------- 大脑：链接解析 + 发卡片（假 agent / 假 NapCat） ----------
{
  const dir = mkdtempSync(join(tmpdir(), 'qqbili-'));
  try {
    writeFileSync(join(dir, 'config.json'), JSON.stringify({
      bot: { ownerId: '1' },
      access: { users: [], groups: ['1'], groupTrigger: 'at', groupMemberScope: 'group', followUpSeconds: 0, followUpMax: 0 },
      persona: { active: 'persona/p.json' },
      limits: { perUserCooldownSec: 0, perGroupPerHour: 100, maxReplyChars: 600 },
      memory: { maxEpisodes: 40 },
      proactive: { enabled: false },
      stickers: { autoSave: 'off', visionMode: 'off' },
      humanize: { enabled: false, debounceMs: 10, debounceMaxMs: 50, minTypingMs: 1, maxTypingMs: 1, perCharMs: 1 },
    }));
    mkdirSync(join(dir, 'persona'));
    writeFileSync(join(dir, 'persona', 'p.json'), JSON.stringify({ name: '小鱼', identity: '群友', speech: {} }));
    const store = new ProjectStore(dir);

    let reply = () => '好看';
    const prompts = [];
    const events = [];
    let turn = 0;
    const agent = {
      id: 'agent-1',
      session: { snapshotEvents: () => events },
      followup(msg) {
        const text = msg.content[0].text;
        prompts.push(text);
        turn += 1;
        const t = turn;
        events.push({ type: 'turn/start', data: { turn: t } });
        setTimeout(() => {
          events.push({ type: 'assistant/message', data: { turn: t, message: { content: [{ type: 'text', text: reply(text) }] } } });
          events.push({ type: 'turn/end', data: { turn: t, reason: 'stop' } });
        }, 20);
      },
    };
    const agents = { get: () => agent, create: async () => ({ agent }) };
    const sent = [];
    const cards = [];
    const arkCalls = [];
    const onebot = {
      selfId: '999',
      send: async (k, t) => sent.push(t),
      reply: async (k, t) => sent.push(t),
      sendImage: async () => {},
      sendCard: async (k, c) => cards.push(c),
      call: async (action, params) => (arkCalls.push({ action, params }), { data: { app: 'com.tencent.miniapp_01', meta: { detail_1: { title: '哔哩哔哩' } } } }),
    };
    const brain = new Brain({ ctx: { get: () => undefined }, onebot, store, log: () => {} }).init({ agents });
    const VID = { bvid: 'BV1GJ411x7h7', title: '好视频', author: 'UP', pic: 'https://i0.hdslb.com/a.jpg', duration: 200, play: 90000, like: 10, desc: '简介' };
    const kv = new Map();
    brain.ambient = { db: { getKv: (k) => kv.get(k) ?? null, setKv: (k, v) => kv.set(k, String(v)) }, rememberSelf() {} };
    const searched = [];
    brain.bili = {
      videosIn: async (text) => (/BV1GJ411x7h7/.test(text) ? [VID] : []),
      view: async (id) => (id === VID.bvid ? VID : null),
      search: async (q) => (searched.push(q), q === '没结果' ? [] : [VID]),
    };
    brain.links = new LinkReader({ bili: brain.bili, xhs: false });

    const ev = (text, extra = {}) => ({
      kind: 'group', groupId: '1', chatKey: 'group:1', userId: '11', nickname: '甲',
      text, atMe: true, messageId: `m${Math.random()}`, at: Date.now(), images: [], ...extra,
    });

    // 1) 群友发 B 站卡片/链接：提示词里有系统查到的视频信息
    await brain.handle(ev('[分享·哔哩哔哩：好视频 https://www.bilibili.com/video/BV1GJ411x7h7] 你看过吗'));
    /【系统帮你查到的内容】/.test(prompts.at(-1)) && /《好视频》/.test(prompts.at(-1)) && /UP主 UP/.test(prompts.at(-1))
      ? ok('群友发了 B 站链接：她看到的是系统查到的标题/UP主/播放量，而不只是一个链接') : no('提示词里没有视频信息', prompts.at(-1)?.slice(0, 600));

    // 2) 没有链接的普通闲聊：不发任何 B 站请求，提示词里没有这一段
    const before = prompts.length;
    await brain.handle(ev('今天好热啊'));
    !/【系统帮你查到的内容】/.test(prompts.at(-1)) && prompts.length === before + 1 ? ok('普通聊天不带这一段') : no('闲聊带了查询结果');

    // 3) 对她说"帮我找视频"：先搜，把结果给她，她用标记分享 → 真的发卡片
    reply = () => '这个不错 [[B站:BV1GJ411x7h7]]';
    sent.length = 0;
    cards.length = 0;
    await brain.handle(ev('@小鱼 帮我在B站找找影之刃零的视频'));
    searched.at(-1) === '影之刃零' && /你在 B 站搜「影之刃零」得到的结果/.test(prompts.at(-1)) && /\[\[B站:BV号\]\]/.test(prompts.at(-1))
      ? ok('"帮我找视频"：按关键词搜，结果和分享方法写进提示词') : no('没有搜或没写进提示词', `${searched.join()} | ${prompts.at(-1)?.slice(0, 500)}`);
    sent.length === 1 && sent[0] === '这个不错' && !/\[\[/.test(sent[0]) ? ok('标记不进聊天正文') : no('正文不对', JSON.stringify(sent));
    cards.length === 1 && JSON.parse(cards[0]).app === 'com.tencent.miniapp_01' && arkCalls.at(-1)?.params.bvid === undefined && arkCalls.at(-1)?.params.picUrl === VID.pic
      ? ok('文字之后发出一张 B 站小程序视频卡片（不是链接）') : no('没发出卡片', JSON.stringify({ cards, arkCalls }));

    // 4) 凭空写的 BV 号：不在系统查到的范围内，不发
    reply = () => '看这个 [[B站:BV1zzzzzzzzz]]';
    sent.length = 0;
    cards.length = 0;
    await brain.handle(ev('随便聊聊'));
    cards.length === 0 && sent.length === 1 ? ok('她自己编的 BV 号不会发出卡片') : no('编造的 BV 也发了', JSON.stringify({ cards, sent }));

    // 5) 搜不到：如实告诉她"没搜到"，不给候选
    reply = () => '没找到呢';
    await brain.handle(ev('帮我在B站找找没结果的视频'));
    /没有搜到可用的结果/.test(prompts.at(-1)) ? ok('搜不到时明确告诉她没有，别编视频') : no('没搜到没说明', prompts.at(-1)?.slice(0, 400));

    // 6) NapCat 做不出卡片：退回"标题 + 链接"文字
    reply = () => '推荐 [[B站:BV1GJ411x7h7]]';
    onebot.call = async () => { throw new Error('action not found'); };
    sent.length = 0;
    cards.length = 0;
    await brain.handle(ev('帮我在B站找找影之刃的视频'));
    cards.length === 0 && sent.some((t) => /好视频\nhttps:\/\/www\.bilibili\.com\/video\/BV1GJ411x7h7/.test(t))
      ? ok('生成不了卡片时退回"标题 + 链接"文字，不至于什么都不发') : no('卡片失败没有退路', JSON.stringify({ sent, cards }));

    // 7) 配置关掉：不查、不发
    brain.cfg.bili = { enabled: false };
    searched.length = 0;
    const p0 = prompts.length;
    await brain.handle(ev('帮我在B站找找影之刃的视频'));
    searched.length === 0 && !/【系统帮你查到的内容】/.test(prompts[p0]) ? ok('bili.enabled=false：不搜不查') : no('关了还在查');
    brain.cfg.bili = {};

    // 8) 发现型暖场：候选 → 她必须从候选里挑；没挑就不发；挑了就发卡片，并记录已分享避免重复
    onebot.call = async () => ({ data: { app: 'com.tencent.miniapp_01', meta: { detail_1: {} } } });
    reply = () => 'PASS';
    sent.length = 0;
    cards.length = 0;
    const cand = { ...VID, keyword: '影之刃', who: '甲' };
    const noPick = await brain.proactiveSay({ chatKey: 'group:1', groupId: '1', hint: 'H', biliNotes: ['候选'], biliCandidates: [VID.bvid] });
    !noPick && !sent.length && !cards.length ? ok('发现型暖场：她 PASS 就不发') : no('PASS 还发了', JSON.stringify({ sent, cards }));
    reply = () => '甲你不是在玩影之刃嘛 看这个';
    const noMarker = await brain.proactiveSay({ chatKey: 'group:1', groupId: '1', hint: 'H', biliNotes: ['候选'], biliCandidates: [VID.bvid] });
    !noMarker && !sent.length ? ok('发现型暖场：只说话没挑视频（可能是编的）也不发') : no('没挑视频也发了', JSON.stringify(sent));
    reply = () => '甲你不是在玩影之刃嘛 看这个 [[B站:BV1GJ411x7h7]]';
    await brain.proactiveSay({ chatKey: 'group:1', groupId: '1', hint: 'H', biliNotes: ['候选'], biliCandidates: [VID.bvid] });
    sent.length === 1 && cards.length === 1 ? ok('发现型暖场：从候选里挑一个，文字 + 视频卡片') : no('暖场没发出卡片', JSON.stringify({ sent, cards }));
    JSON.parse(kv.get('bili:shared:group:1') ?? '[]')[0] === VID.bvid ? ok('已分享的视频记下来，下次不重复') : no('没记录已分享', JSON.stringify([...kv]));

    // 9) biliDiscover：按爱好词搜、排掉已分享的
    const found = await brain.biliDiscover('group:1', [{ nickname: '甲', words: ['影之刃'] }]);
    found.length === 0 ? ok('已经分享过的视频不会再被当候选') : no('重复候选', JSON.stringify(found.map((v) => v.bvid)));
    kv.clear();
    const found2 = await brain.biliDiscover('group:1', [{ nickname: '甲', words: ['影之刃'] }]);
    found2.length === 1 && found2[0].who === '甲' && found2[0].keyword === '影之刃' ? ok('按群友爱好词找到候选，并标注是谁的爱好') : no('候选不对', JSON.stringify(found2));
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

await sleep(10);
if (failed) {
  console.log(`\n✗ ${failed} 项失败`);
  process.exit(1);
}
console.log('\n✓ B站搜索 / 链接解析 / 视频卡片验证通过');
