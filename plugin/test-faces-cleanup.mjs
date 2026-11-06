// QQ 表情（face 段）、回复清理、喊停打断 的验证（离线）。
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { COMMON_FACES, describeFaceSeg, extractReactMarkers, faceGuide, faceId, reactionId, faceName, loadFaces, stripFaceMarks, toSegments } from './dsh-qq/lib/faces.js';
import { asksIdentity, cleanReply, stripThoughts, unwrapShell } from './dsh-qq/lib/sanitize.js';
import { splitBubbles } from './dsh-qq/lib/humanize.js';
import { extractText } from './dsh-qq/lib/onebot.js';
import { pickReaction, EMOJI } from './dsh-qq/lib/social.js';
import { Brain, INTERRUPT_RE } from './dsh-qq/lib/brain.js';
import { ProjectStore } from './dsh-qq/lib/persona.js';
import { buildSystemPrompt } from './dsh-qq/lib/prompt.js';

let failed = 0;
const ok = (m) => console.log(`  ✓ ${m}`);
const no = (m, d = '') => {
  failed += 1;
  console.log(`  ✗ ${m}${d ? `\n      ${d}` : ''}`);
};
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 表情表 ----------
{
  const t = loadFaces();
  t.count > 250 ? ok(`表情表载入：${t.count} 个名字（来自 NapCat 的 sysface）`) : no('表情表太小/没载入', String(t.count));
  faceId('微笑') === 14 && faceId('笑哭') === 182 && faceId('doge') === 179
    ? ok('同名多 id 时优先不隐藏的（微笑=14，而不是隐藏的 452）') : no('id 不对', [faceId('微笑'), faceId('笑哭'), faceId('doge')].join());
  faceId('狗头') === 179 && faceId('ok') === faceId('OK') && faceId('扶额') === faceId('捂脸') ? ok('别名（狗头→doge、ok→OK、扶额→捂脸）') : no('别名不对');
  faceId('思考') === faceId('托腮') && faceId('疑惑') === faceId('疑问') && faceId('谢谢') !== null ? ok('她常编的名字（思考/疑惑/谢谢…）映射到最接近的脸') : no('编造名字的别名不对');
  { const r = toSegments('诶 是我用错词了吗[思考]', { history: [] }); r.faces === 1 && r.segments.at(-1).type === 'face' ? ok('截图里的 [思考] 现在会变成真表情，而不是字面的"思考"') : no('[思考] 没变成表情', JSON.stringify(r)); }
  faceId('不存在的脸') === null && faceId('') === null ? ok('认不出的名字返回 null') : no('认不出的没返回 null');
  faceName(182) === '笑哭' && faceName(99999) === '' ? ok('id → 名字') : no('id→名字不对');
  const missing = COMMON_FACES.filter((n) => faceId(n) === null);
  missing.length === 0 ? ok(`提示词里的 ${COMMON_FACES.length} 个常用表情名全都在表里`) : no('常用清单里有表里没有的', missing.join());
  const g = faceGuide();
  /\[笑哭\]/.test(g) && /最多一两个/.test(g) && /\[\[表情:关键词\]\]/.test(g) ? ok('提示词说明了写法、克制使用、与表情包的区别') : no('提示词说明不完整');
  g.length < 600 ? ok(`表情说明只占 ${g.length} 字`) : no('表情说明太长', String(g.length));
  /【QQ 表情】/.test(buildSystemPrompt({ name: '小鱼', identity: 'x', speech: {} })) ? ok('系统提示词里带上了表情说明') : no('系统提示词没带表情说明');

  describeFaceSeg({ type: 'face', data: { id: '182' } }) === '[表情:笑哭]'
    && describeFaceSeg({ type: 'face', data: { id: '99999', raw: { faceText: '/新表情' } } }) === '[表情:新表情]'
    && describeFaceSeg({ type: 'face', data: { id: '99999' } }) === '[表情]'
    ? ok('收到的表情：按 id 翻成名字，表里没有就用 raw.faceText，再不行才是 [表情]') : no('收表情翻译不对');
  extractText([{ type: 'text', data: { text: '哈哈' } }, { type: 'face', data: { id: '182' } }], '1') === '哈哈[表情:笑哭]'
    ? ok('消息文字里能看到对方发的是哪个表情') : no('extractText 没带表情名');
}

// ---------- 表情回应与表情表联动 ----------
{
  reactionId('赞') === '76' && reactionId('斜眼笑') === '178' && reactionId('爱心') === '66' ? ok('回应用的 id 来自同一张表（赞=76、斜眼笑=178、爱心=66，与原来手写的一致）') : no('回应 id 与原手写值不一致', [reactionId('赞'), reactionId('斜眼笑'), reactionId('爱心')].join());
  reactionId('假脸名') === null && reactionId('狗头') === '179' ? ok('认不出的名字不贴；别名也认（狗头→doge）') : no('回应名字解析不对');
  const m = extractReactMarkers('好的[[贴:赞]] 嗯 [[回应：笑哭]] [[贴:赞]]');
  eq(m.names, ['赞', '笑哭']) && !/\[\[/.test(m.clean) && /好的/.test(m.clean) ? ok('[[贴:名字]] 标记被摘掉、去重，不进聊天正文') : no('贴表情标记提取不对', JSON.stringify(m));
  eq(extractReactMarkers('[[表情:无语]] 行').names, []) ? ok('不误吃 [[表情:关键词]]（表情包标记）') : no('误吃了表情包标记');
  /\[\[贴:/.test(faceGuide()) && faceGuide().length < 700 ? ok('提示词说明了 [[贴:名字]] 的用法，总长仍很短') : no('贴表情说明缺失或太长', String(faceGuide().length));

  // 规则式回应：原有三类不变，新增类别的 id 由表解析
  pickReaction('笑死我了哈哈') === EMOJI.smirk && pickReaction('太可爱了吧') === EMOJI.heart && pickReaction('这个太强了') === EMOJI.like && pickReaction('今天中午吃什么') === null
    ? ok('原有的三类规则式回应不变') : no('原规则被改坏了');
  pickReaction('今天好累想哭') === reactionId('拥抱') && pickReaction('谢谢你呀') === reactionId('比心') && pickReaction('这也太离谱了') === reactionId('吃瓜')
    ? ok('新增：难过→拥抱、道谢→比心、离谱→吃瓜（id 从表里查）') : no('新增类别不对', [pickReaction('今天好累想哭'), pickReaction('谢谢你呀'), pickReaction('这也太离谱了')].join());
}

// ---------- toSegments ----------
{
  const r = toSegments('太好笑了[笑哭] 然后[捂脸]', { history: [] });
  eq(r.segments.map((s) => s.type), ['text', 'face', 'text', 'face']) && r.segments[1].data.id === '182' && r.faces === 2
    ? ok('[笑哭] 变成真正的 face 段，文字与表情保持原来的顺序') : no('转换不对', JSON.stringify(r));
  toSegments('[笑哭][捂脸][吃瓜]', { history: [], max: 2 }).faces === 2 ? ok('一条消息最多 2 个表情') : no('没限量');
  const h = [];
  toSegments('好[笑哭]', { history: h });
  const again = toSegments('又来[笑哭]', { history: h });
  again.faces === 0 && again.dropped === 1 && again.segments.map((s) => s.data.text).join('') === '又来' ? ok('同一张脸刚用过：冷却，丢掉（不留名字）') : no('冷却没生效', JSON.stringify(again));
  toSegments('好[笑哭]', { history: h, now: Date.now() + 11 * 60000 }).faces === 1 ? ok('冷却过期后又能用') : no('冷却没过期');
  const unk = toSegments('看[图片]和[1]还有[假脸名]', { history: [] });
  unk.faces === 0 && unk.segments[0].data.text === '看和[1]还有' && unk.stripped === 2 && unk.unknown.join() === '图片,假脸名' ? ok('表里没有的 [名字] 整个去掉（不留字面的"思考"），[1] 这种序号原样保留') : no('未知名处理不对', JSON.stringify(unk));
  toSegments('[[表情:无语]] 你好', { history: [] }).faces === 0 ? ok('[[表情:关键词]] 双括号标记不被当成小黄脸') : no('双括号被误转');
  toSegments('哈哈[表情:笑哭]', { history: [] }).faces === 1 && toSegments('哈哈[表情：笑哭]', { history: [] }).faces === 1 ? ok('她照着收到的格式写 [表情:笑哭] 也认') : no('[表情:x] 没认');
  toSegments('[笑哭]', { enabled: false, history: [] }).segments[0].data.text === '[笑哭]' ? ok('关闭时原样不动') : no('关闭仍转换');
  const only = toSegments('[笑哭]', { history: [] });
  only.segments.length === 1 && only.segments[0].type === 'face' ? ok('只有表情的消息 = 单个 face 段') : no('纯表情消息不对', JSON.stringify(only));
  stripFaceMarks('好[笑哭]啊[假脸名]') === '好啊' ? ok('发送失败的退路：表情标记全部删掉') : no('stripFaceMarks 不对', stripFaceMarks('好[笑哭]啊[假脸名]'));
}

// ---------- 分气泡不拆表情 ----------
{
  const parts = splitBubbles('哈哈！[笑哭]\n你看这个[捂脸]');
  parts.length === 2 && parts[0] === '哈哈！[笑哭]' ? ok('"哈哈！"后面单独的表情并进上一条，不单发一个小黄脸') : no('表情被拆成单独气泡', JSON.stringify(parts));
}

// ---------- 回复清理 ----------
{
  cleanReply("['第一句。', '第二句。']").text === '第一句。\n第二句。' ? ok('拆掉消息数组外壳（单引号数组）') : no('数组壳没拆', cleanReply("['第一句。', '第二句。']").text);
  cleanReply('[{"type":"text","text":"你好呀"},{"type":"text","text":"在吗"}]').text === '你好呀\n在吗' ? ok('拆掉 [{type:text}] 外壳') : no('对象壳没拆');
  unwrapShell("['苹果', '香蕉']") === "['苹果', '香蕉']" && unwrapShell('[1,2,3]') === '[1,2,3]' ? ok('用户要的数据列表不当外壳拆') : no('误拆了数据列表');

  stripThoughts('<thought>他想要啥</thought>好的呀') === '好的呀' && stripThoughts('好的<think>没写完') === '好的' ? ok('摘掉思维链（含没闭合的）') : no('思维链没摘干净');

  cleanReply('[NO_REPLY]').text === '' ? ok('整条是 [NO_REPLY] → 不发') : no('NO_REPLY 没吞');
  cleanReply('[NO_REPLY]\n好的').text === '好的' ? ok('单独成行的 [NO_REPLY] 去掉，正文留下') : no('单独暗号没去掉');
  cleanReply('这个标记 [NO_REPLY] 是静默暗号啊').text.includes('[NO_REPLY]') ? ok('正常解释暗号的话不被吞') : no('误吞了解释');

  cleanReply('我隐约听见你说想吃饭 那就去吃吧').text === '那就去吃吧' || /^那就去吃吧/.test(cleanReply('我隐约听见你说想吃饭 那就去吃吧').text)
    ? ok('擦掉"隐约听见…"回声腔') : no('回声腔没擦', cleanReply('我隐约听见你说想吃饭 那就去吃吧').text);
  cleanReply('没听清，你再说一遍').text === '没听清，你再说一遍' ? ok('"没听清"这种诚实说明保留') : no('误擦了诚实说明');

  const leak = cleanReply('好啊。作为一个AI语言模型，我没办法吃饭。那你吃什么呀');
  leak.text === '好啊。那你吃什么呀' ? ok('穿帮的"作为 AI 语言模型…"整句丢掉') : no('外壳话术没擦', leak.text);
  cleanReply('我根据我的人设要这样说。今天挺开心').text === '今天挺开心' ? ok('"根据我的人设/系统提示…"整句丢掉') : no('人设穿帮句没擦');
  cleanReply('我用了 web_search 查了一下。结果是明天下雨').text === '结果是明天下雨' ? ok('工具过程旁白（web_search）整句丢掉') : no('工具旁白没擦', cleanReply('我用了 web_search 查了一下。结果是明天下雨').text);
  cleanReply('我用了 web_search 查了一下。结果是明天下雨', { userText: '你怎么查的' }).text.includes('web_search') ? ok('对方问"你怎么查的"时，工具说明放行') : no('问工具时仍被擦');
  asksIdentity('你是不是AI啊') && asksIdentity('你是机器人吗') && asksIdentity('真人吗') && !asksIdentity('今天吃了吗') ? ok('能认出认真问身份的话') : no('身份提问识别不对');
  cleanReply('嗯，我是AI。不过聊天挺开心', { userText: '你是不是AI' }).text.includes('我是AI') ? ok('对方认真问身份时，不抹掉她的回答') : no('身份回答被擦了');
  cleanReply('看这个 https://x.com/a 作为AI语言模型的使用说明').text.includes('https://x.com/a') ? ok('含链接的句子整句保留（宁可少擦）') : no('带链接句被误删');
  cleanReply('```\n作为AI语言模型 print(1)\n```').text.includes('作为AI语言模型') ? ok('代码块里原样保留') : no('代码块被改');
  cleanReply('我是AI（笑）。好吧').text === '好吧' ? ok('丢句后不留孤零零的括号') : no('括号残骸', cleanReply('我是AI（笑）。好吧').text);

  cleanReply('我「真的」不知道、也不想说').text === '我“真的”不知道，也不想说' ? ok('「」→“”，顿号当逗号用的改成逗号') : no('标点没规范', cleanReply('我「真的」不知道、也不想说').text);
  cleanReply('苹果、香蕉、橘子').text === '苹果、香蕉、橘子' ? ok('并列词的顿号不动') : no('误改了并列顿号');
  const gone = cleanReply('作为AI语言模型');
  gone.text === '' && gone.notes.length ? ok('整条被擦光就不发（不发"……"）') : no('擦光后仍有内容', JSON.stringify(gone));
  cleanReply('……').text === '……' ? ok('她本来就想发的"……"不动') : no('原有的省略号被吞');
  cleanReply('今天天气不错', { hedge: false, punct: false }).notes.length === 0 ? ok('普通话原样通过，没有任何改动记录') : no('普通话被改');
}

// ---------- 大脑：face 段 / 清理 / 喊停（假 agent、假 NapCat） ----------
{
  INTERRUPT_RE.test('等等') && INTERRUPT_RE.test('先别说！') && !INTERRUPT_RE.test('等等我去拿个东西') ? ok('喊停只认整句是"等等/停/先别说"') : no('喊停正则不对');

  const dir = mkdtempSync(join(tmpdir(), 'qqface-'));
  try {
    writeFileSync(join(dir, 'config.json'), JSON.stringify({
      bot: { ownerId: '1' },
      access: { users: [], groups: ['1'], groupTrigger: 'at', groupMemberScope: 'group', followUpSeconds: 0, followUpMax: 0 },
      persona: { active: 'persona/p.json' },
      limits: { perUserCooldownSec: 0, perGroupPerHour: 100, maxReplyChars: 600 },
      memory: { maxEpisodes: 40 },
      proactive: { enabled: false },
      stickers: { autoSave: 'off', visionMode: 'off' },
      humanize: { enabled: true, splitProbability: 1, minSplitChars: 1, debounceMs: 5, debounceMaxMs: 20, minTypingMs: 1, maxTypingMs: 1, perCharMs: 1, gapMinMs: 150, gapMaxMs: 150, stripPeriod: false },
    }));
    mkdirSync(join(dir, 'persona'));
    writeFileSync(join(dir, 'persona', 'p.json'), JSON.stringify({ name: '小鱼', identity: '群友', speech: {} }));
    const store = new ProjectStore(dir);

    let reply = () => '好';
    const events = [];
    let turn = 0;
    const agent = {
      id: 'agent-1',
      session: { snapshotEvents: () => events },
      followup(msg) {
        turn += 1;
        const t = turn;
        const text = msg.content[0].text;
        events.push({ type: 'turn/start', data: { turn: t } });
        setTimeout(() => {
          events.push({ type: 'assistant/message', data: { turn: t, message: { content: [{ type: 'text', text: reply(text) }] } } });
          events.push({ type: 'turn/end', data: { turn: t, reason: 'stop' } });
        }, 10);
      },
    };
    const agents = { get: () => agent, create: async () => ({ agent }) };
    const sent = []; // 每条：{ kind:'text'|'segs', v }
    let failSegs = false;
    const onebot = {
      selfId: '999',
      send: async (k, t) => sent.push({ kind: 'text', v: t }),
      reply: async (k, t) => sent.push({ kind: 'text', v: t }),
      sendImage: async () => {},
      sendSegments: async (k, segs) => {
        if (failSegs) throw new Error('不支持的ID');
        sent.push({ kind: 'segs', v: segs });
      },
    };
    const brain = new Brain({ ctx: { get: () => undefined }, onebot, store, log: () => {} }).init({ agents });
    const ev = (text, extra = {}) => ({
      kind: 'group', groupId: '1', chatKey: 'group:1', userId: '11', nickname: '甲', text, atMe: true, messageId: `m${Math.random()}`, at: Date.now(), images: [], ...extra,
    });

    // 1) 回复里的 [笑哭] → 真正的 face 段
    reply = () => '哈哈哈[笑哭]';
    await brain.handle(ev('讲个笑话'));
    const s1 = sent.at(-1);
    s1?.kind === 'segs' && eq(s1.v.map((x) => x.type), ['text', 'face']) && s1.v[1].data.id === '182' && s1.v[0].data.text === '哈哈哈'
      ? ok('她写的 [笑哭] 真的以 face 段发了出去（不是文字）') : no('没发成 face 段', JSON.stringify(sent));

    // 2) 同一张脸冷却：紧接着再用 [笑哭]，这张脸不再发（文字照发）
    sent.length = 0;
    reply = () => '又来了[笑哭]';
    await brain.handle(ev('再来一个'));
    sent.length === 1 && sent[0].kind === 'text' && sent[0].v === '又来了' ? ok('冷却：刚用过的脸不连着发，文字照常发') : no('冷却没生效', JSON.stringify(sent));

    // 3) 不认识的名字：去括号当文字发
    sent.length = 0;
    reply = () => '好的[假脸名]';
    await brain.handle(ev('嗯'));
    sent.length === 1 && sent[0].kind === 'text' && sent[0].v === '好的' ? ok('不认识的 [名字] 既不带方括号、也不留字面文字') : no('裸方括号漏出去了', JSON.stringify(sent));

    // 4) 带表情发送失败（NapCat 不认这个 id）：退回纯文字
    sent.length = 0;
    failSegs = true;
    reply = () => '哈哈[捂脸]';
    await brain.handle(ev('哎'));
    failSegs = false;
    sent.length === 1 && sent[0].kind === 'text' && sent[0].v === '哈哈' ? ok('face 段发送失败时退回纯文字（不至于什么都没发）') : no('失败没有退路', JSON.stringify(sent));

    // 5) 回复清理接进了发送流程
    sent.length = 0;
    reply = () => '好啊。作为一个AI语言模型，我没办法吃饭。那你吃什么呀';
    await brain.handle(ev('吃饭了吗'));
    sent.map((x) => x.v).join('|').includes('AI') ? no('外壳话术漏出去了', JSON.stringify(sent)) : ok('发出去的回复里没有"作为 AI 语言模型"');
    sent.length = 0;
    reply = () => '[NO_REPLY]';
    await brain.handle(ev('随便'));
    sent.length === 0 ? ok('[NO_REPLY] 不发任何东西') : no('NO_REPLY 被发出去了', JSON.stringify(sent));
    sent.length = 0;
    reply = () => "['第一句', '第二句。']";
    await brain.handle(ev('说两句'));
    !sent.some((x) => typeof x.v === 'string' && x.v.includes("'")) && sent.length >= 1 ? ok('消息数组外壳不会原样发出去') : no('外壳漏出去了', JSON.stringify(sent));
    // 配置关闭
    brain.cfg.cleanup = { enabled: false };
    sent.length = 0;
    reply = () => '[NO_REPLY]';
    await brain.handle(ev('随便2'));
    brain.cfg.cleanup = {};
    sent.length === 1 ? ok('cleanup.enabled=false 时不清理') : no('关闭后仍清理', JSON.stringify(sent));

    // 5b) 表情回应：[[贴:赞]] → 对触发消息调用 set_msg_emoji_like；可以不说话，也可以配文字
    const calls = [];
    onebot.call = async (action, params) => (calls.push({ action, params }), {});
    sent.length = 0;
    reply = () => '[[贴:赞]]';
    const reactEv = ev('我考过了', { messageId: 'm-react-1' });
    const out1 = await brain.handle(reactEv);
    calls.length === 1 && calls[0].action === 'set_msg_emoji_like' && calls[0].params.message_id === 'm-react-1' && calls[0].params.emoji_id === '76' && calls[0].params.set === true && sent.length === 0 && out1
      ? ok('只回 [[贴:赞]]：给对方那句话贴表情回应，不发任何消息') : no('贴表情回应不对', JSON.stringify({ calls, sent }));
    const hist = brain.faceHistory.get('group:1') ?? [];
    hist.some((h) => h[0] === 76) ? ok('贴过的脸记进冷却记录（和文字里的脸共用）') : no('没记冷却', JSON.stringify(hist));
    sent.length = 0;
    calls.length = 0;
    reply = () => '恭喜呀[赞]';
    await brain.handle(ev('我又考过了', { messageId: 'm-react-2' }));
    sent.length === 1 && sent[0].kind === 'text' && sent[0].v === '恭喜呀' ? ok('刚贴过的脸，文字里就不再重复发同一个') : no('冷却没跨过两条路径', JSON.stringify(sent));
    sent.length = 0;
    calls.length = 0;
    reply = () => '哈哈 [[贴:笑哭]]';
    await brain.handle(ev('讲个笑话2', { messageId: 'm-react-3' }));
    calls.length === 1 && calls[0].params.emoji_id === '182' && sent.length === 1 && sent[0].v === '哈哈' ? ok('文字 + 表情回应可以一起用') : no('文字加回应不对', JSON.stringify({ calls, sent }));
    calls.length = 0;
    reply = () => '[[贴:假脸名]]';
    sent.length = 0;
    await brain.handle(ev('随便3', { messageId: 'm-react-4' }));
    calls.length === 0 && sent.length === 0 ? ok('不认识的脸名：不贴、也不乱发') : no('未知名字也贴了', JSON.stringify({ calls, sent }));
    onebot.call = async () => { throw new Error('emoji not allowed'); };
    reply = () => '行[[贴:赞]]';
    sent.length = 0;
    await brain.handle(ev('随便4', { messageId: 'm-react-5' }));
    sent.length === 1 && sent[0].v === '行' ? ok('回应被服务器拒绝时，只写日志，文字照发') : no('回应失败影响了发言', JSON.stringify(sent));
    brain.cfg.faces = { react: false };
    calls.length = 0;
    onebot.call = async (a, p) => (calls.push(p), {});
    reply = () => '嗯[[贴:赞]]';
    await brain.handle(ev('随便5', { messageId: 'm-react-6' }));
    brain.cfg.faces = {};
    calls.length === 0 ? ok('faces.react=false 时不贴') : no('关了还在贴');

    // 6) 私聊喊停：还没发完的气泡不再发
    sent.length = 0;
    reply = (t) => (/【对方这次说的】\n等等/.test(t) ? '好的' : '第一段话\n\n第二段话\n\n第三段话');
    const pev = (text) => ({ kind: 'private', chatKey: 'private:5', groupId: null, userId: '5', nickname: '乙', text, atMe: false, messageId: `p${Math.random()}`, at: Date.now(), images: [] });
    const first = brain.handle(pev('讲讲'));
    for (let i = 0; i < 100 && !sent.some((x) => x.v === '第一段话'); i += 1) await sleep(20); // 等第一个气泡发出
    await sleep(40); // 第二个气泡之前（气泡间隔 150ms）
    const stop = brain.handle(pev('等等'));
    await Promise.all([first, stop]);
    const texts = sent.map((x) => x.v);
    texts.includes('第一段话') && !texts.includes('第二段话') && !texts.includes('第三段话') && texts.includes('好的')
      ? ok('私聊里喊"等等"：后面的气泡停发，喊停的那句照常回复') : no('喊停没生效', JSON.stringify(texts));
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

await sleep(10);
if (failed) {
  console.log(`\n✗ ${failed} 项失败`);
  process.exit(1);
}
console.log('\n✓ QQ 表情 / 回复清理 / 喊停验证通过');
