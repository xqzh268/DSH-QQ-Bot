/**
 * 真正的 QQ 表情（小黄脸）：回复里写 [笑哭] 这样的名字，发出去时变成 OneBot 的 face 消息段。
 *
 * 表来源：plugin/dsh-qq/data/qface.json，由 plugin/gen-qface.mjs 从 NapCat 的 sysface 表抽出
 * （NapCat 发 face 段只认这张表里的 id，不在表里会报"不支持的ID"）。
 * 转换规则参考 dafeiyu-astrbot 的 face_convert：
 *   - 一条消息最多 N 个（默认 2）；
 *   - 同一个会话里，同一张脸最近用过就不再用（冷却，默认 10 分钟内最近 2 次）；
 *   - 看着像表情名但表里没有的 [短词]，去掉方括号留下文字，不让裸方括号漏出去。
 * 收到表情时反过来：id → 名字，写成 [表情:笑哭] 给她看，而不是一个看不出意思的 [表情]。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/** 通称/别名 → 表里的正式名（只收表里确实存在的目标，见测试） */
// 模型常自己编的名字（"思考""疑惑"这类）→ 表里最接近的脸
const ALIASES = { 思考: '托腮', 沉思: '托腮', 想想: '托腮', 疑惑: '疑问', 困惑: '疑问', 迷惑: '疑问', 问号: '疑问', 哭: '流泪', 哭哭: '流泪', 笑: '呲牙', 哈哈: '大笑', 脸红: '害羞', 吐舌: '调皮', 拜拜: '再见', 谢谢: '比心', 加油: '奋斗', 无语了: '无语', 汗颜: '流汗', 狗头: 'doge', 旺柴: '汪汪', 旺财: '汪汪', 扶额: '捂脸', 哭笑: '笑哭', 笑哭了: '笑哭', 点赞: '赞', ok: 'OK', Ok: 'OK', DOGE: 'doge', Doge: 'doge', no: 'NO', EMM: 'emm', Emm: 'emm' };

/** 给她的常用清单（写进提示词，不全列：表有 300 多个，全列太占 token）。每个名字都在表里，测试会校验 */
export const COMMON_FACES = [
  '微笑', '撇嘴', '发呆', '得意', '流泪', '害羞', '大哭', '尴尬', '调皮', '呲牙', '惊讶', '偷笑', '可爱', '白眼', '困', '流汗',
  '疑问', '晕', '衰', '鼓掌', '坏笑', '哈欠', '鄙视', '委屈', '亲亲', '可怜', '笑哭', 'doge', '无奈', '卖萌', '斜眼笑', '捂脸',
  '吃瓜', 'emm', '裂开', '666', 'OK', '赞', '爱心', '拥抱',
];

let cache = null;

/** 载入表：{ byName: Map<名,id>, byId: Map<id,名>, count } */
export function loadFaces(file = join(here, '..', 'data', 'qface.json')) {
  if (cache && file === cache.file) return cache;
  const byName = new Map();
  const byId = new Map();
  try {
    const list = JSON.parse(readFileSync(file, 'utf8'));
    // 同名多个 id（比如"微笑"有经典的 14 和隐藏的 452）：优先不隐藏的；同级取前面的
    for (const f of list) {
      if (!f || !Number.isFinite(Number(f.id)) || !f.name) continue;
      const prev = byName.get(f.name);
      if (!prev || (prev.hidden && !f.hidden)) byName.set(f.name, { id: Number(f.id), hidden: Boolean(f.hidden) });
      // id → 名：同一个 id 只会有一个名字；名字重复时保留非隐藏 id 对应的
      if (!byId.has(Number(f.id))) byId.set(Number(f.id), f.name);
    }
  } catch {
    /* 没有表就当没有表情：全部走文字 */
  }
  const names = new Map([...byName].map(([k, v]) => [k, v.id]));
  cache = { file, byName: names, byId, count: names.size };
  return cache;
}

/** 名字 → id；认不出返回 null（先查别名，再不区分大小写地查一次） */
export function faceId(name, table = loadFaces()) {
  const n = String(name ?? '').trim();
  if (!n) return null;
  const direct = table.byName.get(n) ?? table.byName.get(ALIASES[n] ?? '');
  if (direct !== undefined) return direct;
  const lower = n.toLowerCase();
  for (const [k, v] of table.byName) if (k.toLowerCase() === lower) return v;
  return null;
}

/** id → 名字；表里没有返回 '' */
export function faceName(id, table = loadFaces()) {
  return table.byId.get(Number(id)) ?? '';
}

/** 收到的 face 段 → 给她看的 "[表情:名字]"（认不出名字退回 [表情]） */
export function describeFaceSeg(seg, table = loadFaces()) {
  const d = seg?.data ?? {};
  const byId = faceName(d.id, table);
  // NapCat 的 face 段里带 raw.faceText（形如 "/笑哭"），表里没有时用它
  const raw = String(d.raw?.faceText ?? '').replace(/^\//, '').replace(/[\[\]]/g, '').trim();
  const name = byId || raw;
  return name && name.length <= 12 ? `[表情:${name}]` : '[表情]';
}

// [名字]、[表情:名字]、[表情：名字]；不碰 [[...]] 标记（调用方应已摘掉）
const FACE_RE = /(?<!\[)\[(?:表情\s*[:：]\s*)?([A-Za-z0-9一-鿿]{1,8})\](?!\])/g;

/**
 * 把一段文字拆成 OneBot 消息段数组（text / face）。
 * @param {string} text
 * @param {{enabled?:boolean, max?:number, history?:Array<[number,number]>, cooldownMs?:number, now?:number, table?:object}} opts
 *        history: 这个会话最近用过的 [id, 时间]，会被原地更新（冷却用）
 * @returns {{segments:Array, faces:number, stripped:number, dropped:number}}
 */
export function toSegments(text, { enabled = true, max = 2, history = [], cooldownMs = 10 * 60 * 1000, now = Date.now(), table = loadFaces() } = {}) {
  const s = String(text ?? '');
  const segments = [];
  let faces = 0;
  let stripped = 0;
  const unknown = [];
  let dropped = 0;
  let pos = 0;
  const push = (t) => {
    if (!t) return;
    const last = segments[segments.length - 1];
    if (last?.type === 'text') last.data.text += t;
    else segments.push({ type: 'text', data: { text: t } });
  };
  // 过期的冷却记录清掉
  for (let i = history.length - 1; i >= 0; i -= 1) if (now - history[i][1] > cooldownMs) history.splice(i, 1);

  for (const m of s.matchAll(FACE_RE)) {
    const name = m[1];
    push(s.slice(pos, m.index));
    pos = m.index + m[0].length;
    const id = enabled ? faceId(name, table) : null;
    if (id === null) {
      // 表里没有：方括号里的短词几乎一定是她想发表情却写了表里没有的名字，整个去掉（留着字面的"思考"很怪）；
      // 纯数字（[1] 之类序号）原样保留
      if (/^[0-9]+$/.test(name) || !enabled) push(m[0]);
      else {
        unknown.push(name);
        stripped += 1;
      }
      continue;
    }
    const recent = history.slice(-2).map((h) => h[0]);
    if (faces >= max || recent.includes(id)) {
      dropped += 1; // 超过每条上限 / 刚用过：这张脸直接不要（文字里也不留名字）
      continue;
    }
    segments.push({ type: 'face', data: { id: String(id) } });
    history.push([id, now]);
    if (history.length > 8) history.splice(0, history.length - 8);
    faces += 1;
  }
  push(s.slice(pos));
  // 脸被丢掉后可能留下多余空格
  for (const seg of segments) if (seg.type === 'text') seg.data.text = seg.data.text.replace(/[ \t]{2,}/g, ' ');
  return { segments: segments.filter((x) => x.type !== 'text' || x.data.text.trim() !== '' || segments.length === 1), faces, stripped, dropped, unknown };
}

/** 去掉所有 [名字] 表情标记（发送 face 失败时的文字退路；认得出的脸整个删掉，不认得的留文字） */
export function stripFaceMarks(text, table = loadFaces()) {
  return String(text ?? '')
    .replace(FACE_RE, (_m, name) => (/^[0-9]+$/.test(name) && faceId(name, table) === null ? _m : ''))
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/**
 * 表情回应（set_msg_emoji_like）用的 emoji_id。
 * NapCat 的 setEmojiLike 按 id 长度分流：≤3 位当 QQ 系统表情（type 1），更长的当 Unicode 表情（type 2）。
 * 所以表里的系统表情 id（都不超过 3 位）可以直接拿来贴；认不出名字返回 null。
 * 注意：QQ 客户端的"表情回应"面板只是表情表的一个子集，个别脸服务器可能不收，失败只写日志。
 * @returns {string|null}
 */
export function reactionId(name, table = loadFaces()) {
  const id = faceId(name, table);
  return id !== null && String(id).length <= 3 ? String(id) : null;
}

/** 从回复里摘出 [[贴:名字]] 标记（别名：回应 / 贴表情）：她想给对方这句话贴个表情回应 */
export function extractReactMarkers(text) {
  const names = [];
  const clean = String(text ?? '').replace(/\[\[\s*(?:贴表情|贴|回应)\s*[:：]\s*([^\]]{1,12}?)\s*\]\]/g, (_m, name) => {
    const n = String(name).trim().replace(/^\[|\]$/g, '');
    if (n && !names.includes(n)) names.push(n);
    return '';
  });
  return { clean: clean.replace(/\n{3,}/g, '\n\n').trim(), names };
}

/** 给系统提示词的一段：怎么写表情、可以用哪些 */
export function faceGuide() {
  return [
    '【QQ 表情】',
    '想带 QQ 自带的小黄脸表情时，直接在句子里写 [名字]，比如 [笑哭]、[捂脸]、[吃瓜]，系统会换成真正的表情。收到别人的表情会显示成 [表情:名字]。',
    `常用的有：${COMMON_FACES.map((n) => `[${n}]`).join('')}。只能用这些名字，别自己编；表里没有的名字会被整个去掉。`,
    '真人不会每句都带表情：一条回复最多一两个，多数时候不带，放在句末更自然；同一个表情别连着用。',
    '这和 [[表情:关键词]]（发一张表情包图片）不一样：小黄脸写在句子里，表情包是单独发的一张图。',
    '不想多说、一个表情就够了的时候，可以写 [[贴:名字]]（名字同上，如 [[贴:赞]]、[[贴:笑哭]]），系统会在对方这句话上贴一个表情回应，不发消息；也可以配一句话一起用。一次只贴一个，贴了就别再用同一个脸写在句子里。',
  ].join('\n');
}
