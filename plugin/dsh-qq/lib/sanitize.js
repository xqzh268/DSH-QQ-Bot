/**
 * 发送前的回复清理：把"不是人话"的东西在出门前擦掉。
 * 思路来自 dafeiyu-astrbot 的 face_convert（消息数组壳 / 思维链漏出 / 静默暗号 / 回声腔 / meta 口癖 / 标点），
 * 针对我们的场景改写：
 *  1. 拆格式壳：整条回复被套成 ['第一句', '第二句'] 或 [{"type":"text","text":"…"}]；
 *  2. 摘掉漏出来的思维链 <thought>/<think>/<thinking>（含没闭合的）；
 *  3. 静默暗号 [NO_REPLY]：整条就是它 → 不发；单独成行的 → 去掉；
 *  4. 回声腔："隐约听见/看到…"这种假装听见看见的尾巴（"没听清/看不清"这类诚实说明保留）；
 *  5. 外壳话术：整句丢掉"作为 AI 语言模型…""根据我的人设/系统提示…""我用 web_search 查了…"这类穿帮句。
 *     对方认真问"你是不是 AI/真人"时，不动身份相关的句子（不替她否认，也不替她抹掉诚实回答）；
 *  6. 标点：「」→ “”；顿号被当逗号用（后面跟"也/就/但/所以"这类分句连接词）改成逗号。
 * 代码块、行内代码、链接、引号里的引用内容整体保护，宁可少擦也不误删内容。
 * 擦光了就返回空串，由调用方当作"没话说"（不发"……"）。
 */

const SENTENCE_END = '。！？!?\\n';
const CLAUSE_STARTERS = '也|又|还|就|都|却|但|可是|不过|所以|因此|因为|然后|而且|并且|或者|或是|反而|其实|甚至|只是|才|再|已经|不会|不能|没|不|可|而';
const DUNHAO_CLAUSE_RE = new RegExp(`、(?=(?:${CLAUSE_STARTERS}))`, 'g');

const PROTECT_RE = /`[^`\n]+`|https?:\/\/\S+|“[^”\n]{1,300}”|【[^】\n]{1,160}】|\[\[[^\]]{1,80}\]\]|\[[A-Za-z0-9一-鿿]{1,8}\]/g;

/** 外壳话术：穿帮的"我是程序/按设定行事"。身份类单独一组，对方问身份时不动 */
const LEAK_IDENTITY = /作为(?:一个|一名)?(?:AI|ＡＩ|人工智能|语言模型|大语言模型|大模型|智能助手|聊天机器人)|(?:我|本)(?:只)?是(?:一个|一名)?(?:AI|ＡＩ|人工智能|语言模型|大语言模型|大模型|智能助手|聊天机器人|DeepSeek|ChatGPT)|我(?:没有|不具备)(?:真实的?)?(?:身体|感情|情感|个人经历)/i;
const LEAK_PROMPT = /PROTOCOL_ENFORCEMENT|(?:根据|按照|依照|遵循|遵守)(?:我的|你的|这个)?(?:人设|设定|角色设定|系统提示词?|提示词|system prompt)|(?:系统提示词?|system prompt|提示词)(?:里|中|要求|规定|写着)|<<\s*\/?\s*MEMO\s*>>/i;
/** 工具过程旁白：真人不会说"我调用了 web_search"（对方问"你怎么查的"时放行） */
const LEAK_TOOL = /(?:调用|使用|用了?)\s*(?:web_search|web_fetch|read_image|工具)|\b(?:web_search|web_fetch|read_image|tool_call)\b/i;

/** 对方是不是在认真问她的身份（是不是 AI / 真人） */
export function asksIdentity(text) {
  const s = String(text ?? '');
  return /(?:你|您|她).{0,8}(?:是不是|是否|到底是|究竟是|是).{0,6}(?:AI|ＡＩ|人工智能|机器人|真人|人类|bot|程序|模型|ChatGPT|DeepSeek|GPT)|(?:AI|机器人|真人|人工智能|bot)\s*[吗嘛么]|是人吗|是人是|真的是人|会不会是(?:AI|机器人)/i.test(s);
}

function protect(text) {
  const saved = [];
  const out = text.replace(PROTECT_RE, (m) => {
    saved.push(m);
    return `\u0000${saved.length - 1}\u0000`;
  });
  return { out, saved };
}
const restore = (text, saved) => saved.reduce((acc, v, i) => acc.split(`\u0000${i}\u0000`).join(v), text);

/** 对代码块外的部分逐段处理，代码块原样保留 */
function outsideCode(text, fn) {
  const parts = text.split('```');
  for (let i = 0; i < parts.length; i += 2) parts[i] = fn(parts[i]);
  return parts.join('```');
}

/** 拆"消息数组"外壳；不像聊天文字的数组（用户要的数据/代码）原样返回 */
export function unwrapShell(text) {
  const s = String(text ?? '').trim();
  if (s.length < 2 || s.length > 8000) return text;
  if (!'[('.includes(s[0]) || !'])'.includes(s[s.length - 1])) return text;
  let data;
  try {
    data = JSON.parse(s);
  } catch {
    // 单引号的 Python 风格数组：只在形状很像时才宽松处理
    if (!/^\[\s*(?:\{\s*'type'|')/.test(s)) return text;
    try {
      data = JSON.parse(s.replace(/\\'/g, '\u0001').replace(/'/g, '"').replace(/\u0001/g, "'"));
    } catch {
      return text;
    }
  }
  if (!Array.isArray(data) || !data.length) return text;
  const parts = [];
  let stringOnly = true;
  for (const item of data) {
    if (typeof item === 'string') {
      parts.push(item);
    } else if (item && typeof item === 'object' && ['plain', 'text'].includes(String(item.type ?? '').toLowerCase()) && typeof item.text === 'string') {
      stringOnly = false;
      parts.push(item.text);
    } else {
      return text; // 不认识的结构不要半拆
    }
  }
  if (!parts.length) return text;
  if (stringOnly) {
    // 纯字符串数组只有像"聊天句子"才拆，免得把用户要的 ['苹果','香蕉'] 数据改掉
    if (!parts.some((p) => /[\u4e00-\u9fff]/.test(p))) return text;
    if (!parts.some((p) => /[。！？!?…~～]\s*$/.test(p))) return text;
  }
  const cleaned = parts.map((p) => p.trim()).filter(Boolean).join('\n');
  return cleaned || text;
}

/** 摘掉思维链块；没闭合的从开头一路删到结尾 */
export function stripThoughts(text) {
  return String(text ?? '')
    .replace(/<(thought|think|thinking)>[\s\S]*?<\/\1>/gi, '')
    .replace(/<(thought|think|thinking)>[\s\S]*$/i, '')
    .replace(/<\/(?:thought|think|thinking)>/gi, '')
    .trim();
}

const NO_REPLY_RE = /(?:\s*[[【]\s*NO[_ -]?REPLY\s*[\]】]\s*)+/i;

/** "隐约听见/看到…"回声腔（诚实的"没听清/看不清"不在此列） */
const HEDGE_STOP = ',，.。！？!?;；、：:~…“”"‘’（）()【】\\[\\]\\s';
const HEDGE_RE = new RegExp(`[^${HEDGE_STOP}]{0,6}隐约(?:听见|听到|看到|飘来|飘进)[^${HEDGE_STOP}]{0,20}[，、：]?`, 'g');
const REQUEST_WORDS = /重发|再发|再说|再听|再看|发一遍|发一张|换一张|重新发|发个/;

function scrubSentences(text, { identityOk, toolOk }) {
  return outsideCode(text, (segment) => {
    const { out, saved } = protect(segment);
    const bad = (s) => LEAK_PROMPT.test(s) || (!toolOk && LEAK_TOOL.test(s)) || (!identityOk && LEAK_IDENTITY.test(s));
    if (!bad(out)) return segment;
    const parts = out.split(new RegExp(`(?<=[${SENTENCE_END}])`));
    // 含代码/链接/引用的句子整句保留（保护占位符 \0 在里面），宁可少擦
    const kept = parts.filter((s) => s.includes('\u0000') || !bad(s));
    let joined = restore(kept.join(''), saved).replace(/\n{2,}/g, '\n').trim().replace(/^[，、]+|[，、]+$/g, '');
    // 整句丢掉后可能剩下孤零零的右括号：哪种括号多出来就删哪种
    const count = (str, c) => str.split(c).length - 1;
    for (const [op, cl] of [["（", "）"], ["(", ")"], ["【", "】"], ["《", "》"]]) {
      while (count(joined, cl) > count(joined, op)) {
        const k = joined.lastIndexOf(cl);
        joined = joined.slice(0, k) + joined.slice(k + 1);
      }
      while (count(joined, op) > count(joined, cl)) {
        const k = joined.indexOf(op);
        joined = joined.slice(0, k) + joined.slice(k + 1);
      }
    }
    return joined.trim();
  });
}

function normalizePunct(text) {
  if (!text || !/[、「」]/.test(text)) return text;
  return outsideCode(text, (seg) => {
    const { out, saved } = protect(seg);
    const fixed = out.replace(/「/g, '“').replace(/」/g, '”').replace(DUNHAO_CLAUSE_RE, '，');
    return restore(fixed, saved);
  });
}

/**
 * 清理一条回复。
 * @param {string} text 模型的原始正文（记忆块、[[标记]] 之后的部分）
 * @param {{userText?:string, hedge?:boolean, punct?:boolean}} opts userText：对方这次说的话（判断是不是在问身份）；主动发言传空
 * @returns {{text:string, notes:string[]}} text 为空表示整条都该丢
 */
export function cleanReply(text, { userText = '', hedge = true, punct = true } = {}) {
  const notes = [];
  let cur = String(text ?? '');
  const step = (label, next) => {
    if (next !== cur) {
      notes.push(label);
      cur = next;
    }
  };

  step('拆掉消息数组外壳', unwrapShell(cur));
  step('摘掉漏出的思维链', stripThoughts(cur));

  if (NO_REPLY_RE.test(cur)) {
    if (cur.trim().replace(NO_REPLY_RE, '') === '') return { text: '', notes: [...notes, '静默暗号 [NO_REPLY]'] };
    step('去掉静默暗号', cur.split('\n').filter((l) => !(l.trim() && l.trim().replace(NO_REPLY_RE, '') === '')).join('\n').trim());
  }

  if (hedge && !REQUEST_WORDS.test(cur)) step('擦掉"隐约听见"回声腔', outsideCode(cur, (seg) => seg.replace(HEDGE_RE, '')).trim());

  step('清掉穿帮的外壳话术', scrubSentences(cur, { identityOk: asksIdentity(userText), toolOk: /工具|web_search|web_fetch|怎么(?:查|搜)|用什么(?:查|搜)|哪里(?:查|搜)的/.test(String(userText ?? "")) }));
  if (punct) step('规范中文标点', normalizePunct(cur));

  cur = cur.trim();
  if (!cur.replace(/[，。！？、：;；~～…\s.,!?]/g, '')) {
    // 只剩标点（或整条被擦光）：当作没话说，不发"……"
    if (notes.length) notes.push('擦光了，不发');
    return { text: notes.length ? '' : cur, notes };
  }
  return { text: cur, notes };
}

const OPENER_RE = /^(诶+|欸+|哼+|嘿嘿+|哈哈+|啊+|嗯嗯+|哎+|唔+)[，, ~～…]*/;
const SELF_DOUBT_RE = /(?:诶[，, ]*)?(?:是)?我(?:是不是)?(?:说错|用错|讲错)(?:什么|啥|词|了|吗|呀|嘛)*[？?]?/;

/**
 * 口癖降频：开头的语气词（诶 / 哼 / 嘿嘿…）她最近几句里刚用过，这句就去掉；
 * "是我说错什么了吗"这种自我怀疑最近说过就整句去掉。只改措辞，不动内容。
 * @param {string} text 清理后的回复
 * @param {string[]} recentSelf 她最近几条消息的文字（新的在后）
 */
export function varyTics(text, recentSelf = []) {
  const src = String(text ?? '');
  const prev = (recentSelf ?? []).map((x) => String(x ?? '').trim()).filter(Boolean).slice(-4);
  if (!src || !prev.length) return src;
  let out = src;
  const m = out.match(OPENER_RE);
  if (m) {
    const key = m[1][0];
    const rest = out.slice(m[0].length);
    if (rest.replace(/\s/g, '').length >= 2 && prev.some((p) => p.startsWith(key))) out = rest;
  }
  if (SELF_DOUBT_RE.test(out) && prev.some((p) => SELF_DOUBT_RE.test(p))) {
    const stripped = out.replace(SELF_DOUBT_RE, '').replace(/^[，, ]+|[，, ]+$/g, '').trim();
    if (stripped.length >= 2) out = stripped;
  }
  return out;
}
