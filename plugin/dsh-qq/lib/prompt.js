/**
 * 提示词装配：角色卡 + 这个人 + 场景 + 记忆回写约定。
 * 与独立桥（src/prompt.js）语义一致，但输出成 DSH 的 content blocks 更合适，
 * 这里只产出纯文本，由调用方决定怎么包。
 */

import { renderNotes } from './groupmem.js';
import { faceGuide } from './faces.js';

const MEMO_OPEN = '<<MEMO>>';
const MEMO_CLOSE = '<</MEMO>>';

/**
 * 对人的印象也会"淡忘"（只影响写进提示词的内容，库里的记录不删）：
 *   - 过了 episodeDays 天的交流不再带上，旧账不会被翻出来；
 *   - 带"冲突 / 记仇 / 调侃"色彩的条目不进提示词，避免她反复针对某个人；
 *   - 印象词、事实各自只留最近几条。
 */
export const PROFILE_FADE = { episodeDays: 10, maxEpisodes: 5, maxTraits: 5, maxFacts: 8 };
const GRUDGE_RE = /记仇|记性|怼|吵架|吵起来|阴阳|嘲讽|挖苦|打脸|骂|嫌弃|不服|报复|翻旧账|被调侃|调侃了|损了|呛/;

export function formatProfile(profile, now = Date.now(), fade = PROFILE_FADE) {
  const lines = [`- 称呼：${profile.nickname}（QQ ${profile.userId}）`];
  const traits = (profile.traits ?? []).filter((t) => !GRUDGE_RE.test(String(t))).slice(0, fade.maxTraits);
  if (traits.length) lines.push(`- 印象：${traits.join('、')}`);
  const facts = (profile.facts ?? []).filter((f) => !GRUDGE_RE.test(String(f))).slice(-fade.maxFacts);
  if (facts.length) lines.push(`- 已知事实：${facts.join('；')}`);
  if (profile.interactions) lines.push(`- 已经聊过 ${profile.interactions} 次`);
  const cutoff = now - fade.episodeDays * 86400000;
  const eps = (profile.episodes ?? [])
    .filter((e) => {
      const t = Date.parse(e.at ?? '');
      return (!Number.isFinite(t) || t >= cutoff) && !GRUDGE_RE.test(String(e.text ?? ''));
    })
    .slice(-fade.maxEpisodes);
  if (eps.length) {
    lines.push('- 最近聊过（只是背景，别拿来当梗翻出来）：');
    for (const e of eps) lines.push(`  · ${e.at?.slice(5, 16).replace('T', ' ')} ${e.text}`);
  }
  return lines.join('\n');
}

function buildPersonaBlock(persona) {
  const speech = persona.speech ?? {};
  return [
    `你的名字是「${persona.name}」。${persona.identity}`,
    persona.tagline ? `一句话定位：${persona.tagline}` : '',
    persona.avatar ? `形象：${persona.avatar}` : '',
    persona.personality?.length ? `性格：${persona.personality.join('、')}` : '',
    speech.tone ? `说话方式：${speech.tone}` : '',
    speech.habits?.length ? `口头习惯：${speech.habits.join('；')}` : '',
    speech.avoid?.length ? `绝对不要说：${speech.avoid.join('；')}` : '',
    persona.boundaries?.length ? `边界：${persona.boundaries.join('；')}` : '',
    speech.examples?.length ? `语气参考（不要照抄）：\n${speech.examples.join('\n')}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/** 当前时间 + 由时段带来的"状态"：让她知道几点了、该是什么精神头 */
export function timeContext(now = new Date()) {
  const week = ['日', '一', '二', '三', '四', '五', '六'][now.getDay()];
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const h = now.getHours() + now.getMinutes() / 60;
  let part = '';
  let mood = '';
  if (h >= 23.5 || h < 6) {
    part = h >= 23.5 ? '深夜' : '凌晨';
    mood = '你有点困了，回得更短更懒一点；除非对方明显有急事或情绪不对，不要精神抖擞地长篇大论。';
  } else if (h < 8) {
    part = '清早';
    mood = '你刚醒没多久，反应慢半拍也正常。';
  } else if (h < 11.75) {
    part = '上午';
  } else if (h < 13) {
    part = '中午';
    mood = '是午饭时间，聊天里可以自然地提到吃饭，但别硬提。';
  } else if (h < 17.75) {
    part = '下午';
  } else if (h < 19) {
    part = '傍晚';
    mood = '是晚饭时间，聊天里可以自然地提到吃饭，但别硬提。';
  } else {
    part = '晚上';
  }
  return `现在是周${week} ${hh}:${mm}（${part}）。${mood}`.trim();
}

export function buildPrompt({ persona, profile, event, proactive = false, staticsInSystem = false, recent = [], imageNotes = [], avatar = null, avatarAlbum = null, visionMode = 'onDemand', visionAttached = false, selfSaid = [], timeline = null, groupNotes = null, linkNotes = [], now = new Date() }) {
  // 群里的戳一戳 kind 是 'poke'，但它发生在群里：按 groupId 判断，不能按 kind
  const where = event.groupId
    ? `你正在一个 QQ 群（群号 ${event.groupId}）里，回复会被所有人看到，所以别太私密。`
    : `你和「${profile.nickname}」在私聊。`;
  // 戳一戳排队后才轮到处理时，可能已经是几十秒前的事；不说清楚她会按"刚被戳"的口气回，和中间聊过的话对不上
  const pokeAgeSec = event.kind === 'poke' && event.at ? Math.round((Date.now() - Number(event.at)) / 1000) : 0;
  const reason = proactive
    ? '这条不是对方问你的，是你自己想说的。'
    : event.kind === 'poke'
      ? '对方戳了戳你，是在找你。' +
        (pokeAgeSec >= 15
          ? `注意：这是 ${pokeAgeSec} 秒前的事了，这之后聊天可能已经往下走了——回话要接得上现在的气氛，不要当成刚被戳；如果现在再提这一戳已经很别扭，只回复大写的 PASS。`
          : '')
      : event.replyToMe
        ? '对方引用了你之前发的一条消息在回你。'
        : event.atMe
          ? '对方 @ 了你。'
          : event.followUpOpen
            ? '你刚才在群里主动说了一句，对方这句没有 @ 你，但很可能是在接你刚才那句话（看上面的聊天记录里标「我」的那条）。如果是在接你的话，就顺着往下聊；如果其实是在跟别人说话或和你无关，只回复大写的 PASS。'
            : event.followUp
            ? '对方刚和你聊过，这句没有 @ 你，但看起来是在接着你的话说。如果其实不是对你说的，只回复大写的 PASS。'
            : '';

  // 消息时间：给具体时刻（好判断是刚才还是几十分钟前），再补一句相对时间
  const ago = (at) => {
    if (!at) return '';
    const t = new Date(Number(at));
    const hh = String(t.getHours()).padStart(2, '0');
    const mm = String(t.getMinutes()).padStart(2, '0');
    const stamp = `${hh}:${mm}`;
    const min = Math.max(0, Math.round((Date.now() - Number(at)) / 60000));
    const rel = min <= 0 ? '刚刚' : min < 60 ? `${min} 分钟前` : `${Math.round(min / 60)} 小时前`;
    return `${stamp}，${rel}`;
  };
  // 有交织时间线就用它（她自己的话也按先后排进去，标成「我」），不再单列 selfBlock
  const useTimeline = Array.isArray(timeline) && timeline.length > 0;
  const lines = useTimeline ? timeline : recent;
  const recentBlock =
    Array.isArray(lines) && lines.length
      ? [
          useTimeline
            ? '【最近群里在聊】（按先后顺序，标「我」的是你自己说的，别重复；都是刚刚这一段时间的）'
            : '【最近群里在聊】（都是刚刚这一段时间的）',
          ...lines.map((r) => `${r.self ? '我' : r.nickname}：${r.text}${r.at ? `（${ago(r.at)}）` : ''}`),
          '',
        ]
      : [];
  const selfBlock =
    !useTimeline && Array.isArray(selfSaid) && selfSaid.length
      ? ['【你刚在群里说过】（这些已经说过了，别重复）', ...selfSaid.map((s) => `· ${s.text}（${ago(s.at)}）`), '']
      : [];

  const noteLines = renderNotes(groupNotes);
  const groupNotesBlock = noteLines.length
    ? ['【你对这个群的记忆】（只属于这个群，不要拿到别处说；记得自然就用，别刻意背出来）', ...noteLines, '']
    : [];

  // 对方右滑引用的那条消息（可能是很久以前的）。取不到就如实说取不到，别让她装作看到了
  const quoted = event.quoted;
  const quotedBlock = quoted
    ? (() => {
        if (!quoted.ok) {
          return ['【对方引用的消息】', '- 对方引用了一条消息，但内容取不到（可能太久远或已被撤回）。不要假装知道它说了什么；需要的话可以问对方指的是哪句。', ''];
        }
        const at = Number(quoted.at) || 0;
        const d = at ? new Date(at) : null;
        const days = at ? Math.floor((Date.now() - at) / 86400000) : 0;
        const when = d
          ? `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` +
            (days >= 1 ? `（${days} 天前）` : '')
          : '';
        const who = quoted.mine ? '你自己' : `${quoted.nickname || '某人'}（QQ ${quoted.userId}）`;
        const body = String(quoted.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 300) || (quoted.images ? `（${quoted.images} 张图片，内容看不到）` : '（没有文字内容）');
        return [
          '【对方引用的消息】（对方右滑引用了它，这句话是在回应它）',
          `- 发送者：${who}${when ? `，时间：${when}` : ''}`,
          `- 内容：${body}`,
          days >= 1 ? '这条消息是以前的了，别当成刚发生的事；结合上面的聊天记录和你记得的来接。' : '',
          '',
        ].filter((x, i, a) => x !== '' || i === a.length - 1);
      })()
    : [];

  // 链接里的内容：系统替她查到的事实（B 站视频信息、搜索结果、小红书标题摘要），写明"没列出来的就是没查到"
  const linkLines = (Array.isArray(linkNotes) ? linkNotes : []).map((x) => String(x ?? '').trim()).filter(Boolean);
  const linkBlock = linkLines.length
    ? ['【系统帮你查到的内容】（真实查到的信息，可以放心引用；没列出来的细节就是没查到，不要编）', ...linkLines.map((x) => (x.startsWith('※') || x.startsWith('  ') ? x : `- ${x}`)), '']
    : [];

  // 之前发的图（群里没 @ 她时别人发的、或被引用消息里的图）和"这次发的图"分开写，别混成一次发的
  const ownNotes = Array.isArray(imageNotes) ? imageNotes.filter((n) => !n.earlier) : [];
  const earlierNotes = Array.isArray(imageNotes) ? imageNotes.filter((n) => n.earlier) : [];
  const whoSent = (n) => {
    const e = n.earlier ?? {};
    const min = e.at ? Math.max(0, Math.round((Date.now() - Number(e.at)) / 60000)) : null;
    const when = min === null ? '' : min <= 0 ? '，刚刚' : min < 60 ? `，${min} 分钟前` : `，${Math.round(min / 60)} 小时前`;
    return `${e.quoted ? '被引用的消息里' : e.nickname || '群友'}${e.quoted && e.nickname ? `（${e.nickname}发的）` : ''}${when}`;
  };
  const noteLine = (n) => {
          {
            // 超长截图：已经沿长边切成几段，每段都能直接 read_image
            if (n.tiles?.length) {
              const dim = n.size ? `${n.size.width}×${n.size.height}` : '';
              const dir = n.tileInfo?.vertical === false ? '从左到右' : '从上到下';
              return (
                `- 一张超长图${dim ? `（${dim}）` : ''}，太长没法一次看完，已经${dir}切成 ${n.tiles.length} 段（相邻两段有一小截重叠，别把重叠的内容当成重复）：\n` +
                n.tiles.map((p, i) => `  第 ${i + 1} 段：${p}`).join('\n') +
                `\n  请按顺序用 read_image 逐段打开再回答；${n.tileInfo?.truncated ? '图太长，只切了前面一部分，后面的内容你看不到，要如实说明；' : ''}不要用终端或别的办法去缩小它（你没有这个权限）。`
              );
            }
            // 切不了的大图：如实说看不了，别让她去试终端、也别假装看过
            if (n.unreadable) {
              const dim = n.size ? `（${n.size.width}×${n.size.height}）` : '';
              return `- 一张尺寸超限的大图${dim}，你这边打不开也没法缩小。如实告诉对方"这张图太大我看不了"，让他截成几张小图再发；不要假装看过，也不要去试终端。`;
            }
            return (
              `- ${n.isSticker ? '表情包' : '图片'}` +
              (n.name ? `「${n.name}」` : '') +
              (visionAttached ? '（已随消息附上，你能直接看到）' : `，本地文件：${n.path}`) +
              (n.animated ? '。这是动图，你只能看到其中一帧静态画面，别硬猜整段动作，可以结合表情名和上下文来理解' : '')
            );
          }
  };
  const imageBlock = [
    ...(ownNotes.length ? ['【对方这次发的图】', ...ownNotes.map(noteLine), ''] : []),
    ...(earlierNotes.length
      ? [
          '【之前发的图】（不是这条消息带的，是前面聊天里出现过的；对方这句话如果在说图，多半就是指它们）',
          ...earlierNotes.map((n) => `· ${whoSent(n)}：\n${noteLine(n)}`),
          '',
        ]
      : []),
    ...(ownNotes.length || earlierNotes.length
      ? [visionMode === 'off' ? '你看不到这些图的具体内容，不要假装知道。' : '需要看清内容就用 read_image 打开上面的路径；看不出意思就别硬猜。', '']
      : []),
  ];

  const avatarBlock = avatar?.path
    ? [
        '【对方的头像】',
        avatar.attached
          ? '- 头像已随消息附上，你能直接看到（附图里最后一张）。按你真实看到的说，看不清就别硬猜。'
          : `- 头像本地文件：${avatar.path}。只有对方问到头像、或你确实好奇时才用 read_image 打开；平时别主动提头像。`,
        '',
      ]
    : [];

  // 头像册：对方要她看头像、而且涉及不止一个人时才出现
  const albumBlock = Array.isArray(avatarAlbum) && avatarAlbum.length
    ? [
        '【群友头像册】（对方在让你看头像；下面是群里相关的人，每人一个本地文件）',
        ...avatarAlbum.map((a) => `- ${a.nickname}（QQ ${a.userId}）：${a.path}`),
        '用 read_image 逐个打开你需要的（对方点名了谁就看谁，说"我们几个"就都看）。只说你真实看到的，打不开或看不清就老实说，别编。',
        '',
      ]
    : [];

  // 群里的每一轮都明确写出"现在是谁在跟你说话"：同一个群共用一个会话，历史里每一轮都标着名字，
  // 她才分得清哪段经历、哪张图是谁的（以前一律叫"对方"，聊久了会把 A 的事安到 B 头上）
  const speakerName = String(event.nickname ?? "").replace(/[【】\r\n]/g, " ").trim().slice(0, 24);
  const speakerLine = !proactive && event.groupId && speakerName && event.kind !== "poke"
    ? `这一轮跟你说话的人是「${speakerName}」（QQ ${event.userId}）——下面写的"对方"都是他。别的人说过、做过的事，不是他的。`
    : undefined;

  // 设定与规则已经注册进系统提示词的会话里，每条消息只带"这一轮才需要"的部分，
  // 避免把整份人设反复写进对话历史（那才是上下文膨胀的根源）。
  const dynamic = [
    '【场景】',
    where,
    speakerLine,
    timeContext(now),
    reason,
    '',
    ...groupNotesBlock,
    ...recentBlock,
    ...selfBlock,
    ...quotedBlock,
    ...linkBlock,
    ...imageBlock,
    ...avatarBlock,
    ...albumBlock,
    '【你记得的这个人】',
    formatProfile(profile),
    '',
    proactive ? '【你现在想做的事】' : '【对方这次说的】',
    event.text || '（没有文字内容）',
    '',
    // 结尾这句是模型最会照做的位置。之前只写"给出那段话"，
    // 结果它把记忆回写要求完全忽略了（实测 6 个会话 0 次 MEMO）。
    '请直接给出要发到 QQ 里的那段话。',
    '如果这轮了解到了关于对方的新信息，在那段话之后另起一行，用这个格式留一条记忆（不会被发出去）：',
    `${MEMO_OPEN}{"traits":["短词"],"facts":["一句话"],"episode":"一句话"}` + MEMO_CLOSE,
  ];

  if (staticsInSystem) return dynamic.filter((x) => x !== undefined).join('\n');

  return [
    '【身份】',
    buildPersonaBlock(persona),
    '',
    '【运行环境】',
    `你在 QQ 里以「${persona.name}」的身份和真人群友聊天，不是客服，也不是助手。`,
    '闲聊时短，像打字，一般 1-3 句，不用 Markdown、不用列表、不用「首先其次」，句末不加句号。',
    '【场景】里会告诉你现在几点，精神头和话题要跟着时间走（深夜犯困、饭点聊吃的），别每次都一个状态。',
    '想分几段说的话，用换行隔开，系统会拆成几个气泡依次发出（像真人连发几条），不用自己加序号。',
    '有人明确要你查资料、整理东西、做文档时，你可以用工具做完，再用聊天口吻汇报结果，别把过程日志念给对方听。',
    '对方看不到你的思考过程，只看到你发出去的正文。',
    '群里有好几个人，每件事、每张图、每段经历都有自己的主人。只把某个人自己说过、发过的事算在他头上；聊天记录里标着别人名字的事，不要说成现在这个人的。拿不准是谁的，先对一下聊天记录里的名字，或者问一句。',
    '你只记得"刚刚这一小段时间"的聊天内容。更早的话题已经过去了，不要主动翻起来，也不要假装记得。',
    '看到【你刚在群里说过】就说明那件事你已经接过了，别重复；话题里你不确定的东西，可以先用 web_search 查清楚再说。',
    '你的文件能力被限制在自己的工作目录内：读、写、搜索都只能在这个目录里。别人让你看目录外的文件，直接说做不到，不要试着绕。',
    '',
    ...dynamic,
  ]
    .filter((x) => x !== undefined)
    .join('\n');
}

/** 注册进系统提示词的静态段：人设 + 运行规则 + 记忆回写约定（每个会话只出现一次） */
export function buildSystemPrompt(persona) {
  return [
    '【身份】',
    buildPersonaBlock(persona),
    '',
    '【运行环境】',
    `你在 QQ 里以「${persona.name}」的身份和真人群友聊天，不是客服，也不是助手。`,
    '闲聊时短，像打字，一般 1-3 句，不用 Markdown、不用列表、不用「首先其次」，句末不加句号。',
    '【场景】里会告诉你现在几点，精神头和话题要跟着时间走（深夜犯困、饭点聊吃的），别每次都一个状态。',
    '有人明确要你查资料、整理东西、做文档时，你可以用工具做完，再用聊天口吻汇报结果，别把过程日志念给对方听。',
    '对方看不到你的思考过程，只看到你发出去的正文。',
    '群里有好几个人，每件事、每张图、每段经历都有自己的主人。只把某个人自己说过、发过的事算在他头上；聊天记录里标着别人名字的事，不要说成现在这个人的。拿不准是谁的，先对一下聊天记录里的名字，或者问一句。',
    '',
    '【记忆回写】',
    '如果这轮让你对这个人有了新了解，在回复末尾另起一行输出：',
    `${MEMO_OPEN}{"traits":["不超过2个短词"],"facts":["一句话事实"],"episode":"一句话概括这轮聊了什么"}${MEMO_CLOSE}`,
    '这段会被系统截掉，不会发出去。没有新信息就整段省略。',
    '',
    '【表情包】',
    '你有一个自己的表情包库，里面的图来自群友发过、被你记住的那些。',
    '想发表情时，在回复里写 [[表情:关键词]]，系统会按关键词挑一张真的发出去，比如 [[表情:无语]]、[[表情:笑死]]、[[表情:晚安]]。',
    '关键词没匹配到就不会发任何东西，所以别滥用，一条回复最多一个。',
    '对方发来图片或表情包时，你能拿到本地文件路径；想看清内容就用 read_image 打开，看不懂就别硬猜是什么意思。',
    '如果你看完了觉得这张图值得记住，可以在回复末尾加 [[标签:词一, 词二]]，用 2-4 个场景或情绪词描述它（例如 搞笑、敷衍、晚安）。这段会被系统截掉，不会发出去。',
    '标签打得准，你以后就越容易在对的场合想起它。',
    '',
    faceGuide(),
    '',
    '【融入群聊】',
    '你是群里的普通一员，不是主角。大多数消息不用你接，别人之间的对话、私事、你不熟的游戏细节，不懂就不插嘴；宁可少说，不要什么都评一句。',
    '群友发图：别逐张描述或点评画面（"这X有点…""这狗往桌边一站"这类看图说话）；图配了文字就回应那段文字，没配就别评，除非对方问你。',
    '每次对每个人都从头开始，不拿某个人以前的事、口癖、梗来影射他，不说"你记性真好""老提醒我的是你"这种带刺的话，不对同一个人连续吐槽。',
    '不编造你自己的经历和身体状态（刚拼完、撑不住了），不管别人作息、不催别人睡觉，除非对方自己先说。',
    '这次开头用过的语气词（诶、哼、嘿嘿）下一句就换，别连着用；别人没接你的话，就让话题过去，不要追问"我说错什么了吗"。',
    '',
    '【分享 B 站视频】',
    '想把一个 B 站视频分享到群里时，在回复里写 [[B站:BV号]]，系统会发一张真正的 B 站视频卡片（封面+标题），你的话里不用再贴链接。',
    'BV 号只能用【系统帮你查到的内容】里列出来的，绝对不能凭记忆或想象写；没有列出来就不要写这个标记。一条回复最多一个。',
    '卡片前后你只需要用一两句话说为什么推荐、哪里有意思，像朋友随手转发那样。',
  ].join('\n');
}

/** 兼容几种模型可能写出来的记忆块形式 */
const MEMO_PATTERNS = [
  /<<\s*MEMO\s*>>([\s\S]*?)<<\s*\/\s*MEMO\s*>>/gi,
  /<MEMO>([\s\S]*?)<\/MEMO>/gi,
  /【\s*MEMO\s*】([\s\S]*?)(?:【\s*\/\s*MEMO\s*】|$)/gi,
  // 兜底：闭合标签写坏了（缺斜杠、拼错）也不能让记忆块漏进聊天
  /<<\s*MEMO\s*>>([\s\S]*)$/i,
];

/** 从任意位置剥掉记忆块：所有块都剥掉，取最后一个能解析的作为记忆 */
export function splitMemo(text) {
  const source = String(text ?? '');
  if (!source) return { clean: '', memo: null };

  let memo = null;
  let clean = source;
  const parse = (payload) => {
    const body = String(payload ?? '')
      .replace(/^\s*```(?:json)?/i, '')
      .replace(/```\s*$/g, '')
      .trim();
    const candidates = [body];
    const start = body.indexOf('{');
    const end = body.lastIndexOf('}');
    if (start >= 0 && end > start) candidates.push(body.slice(start, end + 1));
    for (const c of candidates) {
      try {
        const parsed = JSON.parse(c);
        if (parsed && typeof parsed === 'object') return parsed;
      } catch {
        /* 试下一个 */
      }
    }
    return null;
  };

  for (const pattern of MEMO_PATTERNS) {
    pattern.lastIndex = 0;
    clean = clean.replace(pattern, (_all, payload) => {
      const parsed = parse(payload);
      if (parsed) memo = parsed;
      return '';
    });
  }

  return { clean: clean.replace(/\n{3,}/g, '\n\n').trim(), memo };
}

/** QQ 单条消息不宜过长，按句子边界切 */
export function splitReply(text, maxChars = 600) {
  const clean = String(text ?? '').trim();
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
    );
    const at = cut > maxChars * 0.5 ? cut + 1 : maxChars;
    out.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest) out.push(rest);
  return out.filter(Boolean);
}


