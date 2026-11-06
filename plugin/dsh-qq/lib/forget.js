/**
 * 群记忆的遗忘机制：低触发 / 低价值的记忆不再进入每次发给模型的明文。
 *
 * 不是删除，而是"休眠"：
 *   - 活跃区（notes.lore / notes.relations）：每次都写进提示词。
 *   - 休眠区（notes.dormant.lore / .relations）：留在库里，平时不进提示词；
 *     聊天里再提到它的关键词时，被"唤醒"——这一次临时带上，并记一次触发。
 *   - 休眠区也有上限，超过就把最冷的永久丢掉。
 *
 * 触发 = 聊天内容里出现了这条记忆的关键词。关键词取「书名号」里的词，
 * 没有就取冒号前面的词，再没有就取开头几个字。统计按关键词记（模型每次总结都会改写句子，
 * 按整句记会对不上）。
 *
 * 全部由代码按规则决定，不额外调用模型；topics（正在聊的话题）自己会过期，不参与遗忘。
 */

export const FORGET_DEFAULTS = {
  enabled: true,
  idleDays: 7, // 连续多少天没被提到，且触发次数不多，就休眠
  keepHits: 3, // 累计触发达到这个次数的"老梗"，不因为闲置而休眠（超出活跃上限时仍可能休眠）
  maxLore: 12, // 活跃区上限：梗
  maxRelations: 8, // 活跃区上限：称呼与关系
  minKeep: 4, // 每一类至少留几条在活跃区（避免一次清空）
  maxDormant: 40, // 休眠区每类的上限
  wake: 3, // 一次最多唤醒几条
};

const DAY = 86400000;
const KINDS = ['lore', 'relations'];

export function forgetConfig(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const num = (v, d, lo, hi) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
  };
  const d = FORGET_DEFAULTS;
  return {
    enabled: r.enabled !== false,
    idleDays: num(r.idleDays, d.idleDays, 1, 365),
    keepHits: num(r.keepHits, d.keepHits, 1, 1000),
    maxLore: Math.round(num(r.maxLore, d.maxLore, 3, 60)),
    maxRelations: Math.round(num(r.maxRelations, d.maxRelations, 3, 60)),
    minKeep: Math.round(num(r.minKeep, d.minKeep, 0, 20)),
    maxDormant: Math.round(num(r.maxDormant, d.maxDormant, 0, 200)),
    wake: Math.round(num(r.wake, d.wake, 0, 10)),
  };
}

/** 一条记忆的关键词（用来判断聊天里有没有再提到它） */
export function itemKey(text) {
  const s = String(text ?? '').trim();
  const quoted = s.match(/[「『“"]([^」』”"]{1,10})[」』”"]/);
  if (quoted) return quoted[1].trim().toLowerCase();
  const head = s.split(/[：:，,；;。=＝]/)[0].trim();
  const k = (head.length >= 2 ? head : s).slice(0, 8);
  return k.toLowerCase();
}

/** 关键词在这些文字里出现了几次（每条文字最多算一次） */
export function hitsIn(key, texts) {
  if (!key || key.length < 2) return 0;
  let n = 0;
  for (const t of texts) if (String(t ?? '').toLowerCase().includes(key)) n += 1;
  return n;
}

function loadStats(raw) {
  try {
    const o = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return o && typeof o === 'object' && !Array.isArray(o) ? o : {};
  } catch {
    return {};
  }
}

export function parseStats(raw) {
  return loadStats(raw);
}

/** 这条记忆有多"热"：触发次数为主，越近被提到越热；新条目有一段保护期 */
function heat(stat, now) {
  const last = Math.max(stat.t || 0, stat.c || 0);
  const ageDays = Math.max(0, (now - last) / DAY);
  return (stat.h || 0) + 1 / (1 + ageDays);
}

/**
 * 总结之后调用：根据新聊天里的触发情况更新统计，决定谁休眠、谁醒来、谁被永久丢弃。
 * @param {object} p
 * @param {{lore:string[],relations:string[],topics:string[]}} p.notes 模型刚总结出的（活跃）记忆
 * @param {{lore?:string[],relations?:string[]}} [p.dormant] 之前的休眠区
 * @param {object} [p.stats] 触发统计 { [key]: {h,t,c} }
 * @param {string[]} p.texts 这一段新聊天的文字
 * @returns {{notes:object, stats:object, changes:{slept:string[],woke:string[],dropped:string[]}}}
 */
export function applyForgetting({ notes, dormant = {}, stats = {}, texts = [], now = Date.now(), cfg = FORGET_DEFAULTS }) {
  const c = forgetConfig(cfg);
  const st = { ...stats };
  const changes = { slept: [], woke: [], dropped: [] };
  const out = { ...notes, dormant: { lore: [], relations: [] } };

  const stat = (key) => (st[key] ??= { h: 0, t: 0, c: now });
  const bump = (key) => {
    const n = hitsIn(key, texts);
    if (n > 0) {
      const s = stat(key);
      s.h += n;
      s.t = now;
    }
    return n;
  };

  for (const kind of KINDS) {
    const active = [...(notes?.[kind] ?? [])];
    const sleeping = [...(dormant?.[kind] ?? [])];
    const activeKeys = new Set(active.map(itemKey));
    for (const it of active) bump(itemKey(it));

    // 休眠区里被再次提到的，醒来回到活跃区；模型自己又写出来的（同一个关键词），以活跃区为准
    const stillSleeping = [];
    for (const it of sleeping) {
      const k = itemKey(it);
      if (activeKeys.has(k)) continue;
      if (c.enabled && bump(k) > 0) {
        active.push(it);
        activeKeys.add(k);
        changes.woke.push(it);
      } else {
        stillSleeping.push(it);
      }
    }

    if (!c.enabled) {
      out[kind] = active;
      out.dormant[kind] = stillSleeping;
      continue;
    }

    // 决定谁休眠：闲置太久且不算"老梗"的，再加上超出活跃上限的最冷的
    const cap = kind === 'lore' ? c.maxLore : c.maxRelations;
    const scored = active.map((text, i) => {
      const s = stat(itemKey(text));
      const idle = (now - Math.max(s.t || 0, s.c || 0)) / DAY;
      return { text, i, s, idle, h: heat(s, now) };
    });
    const sleepIdx = new Set();
    const keepFloor = Math.min(c.minKeep, scored.length);
    const coldFirst = [...scored].sort((a, b) => a.h - b.h || a.i - b.i); // 同样冷：列表里靠前的先休眠
    let remaining = scored.length;
    for (const x of coldFirst) {
      if (remaining <= keepFloor) break;
      const idleCold = x.idle > c.idleDays && (x.s.h || 0) < c.keepHits;
      if (idleCold || remaining > cap) {
        sleepIdx.add(x.i);
        remaining -= 1;
      }
    }
    out[kind] = scored.filter((x) => !sleepIdx.has(x.i)).map((x) => x.text);
    const newlySlept = scored.filter((x) => sleepIdx.has(x.i)).map((x) => x.text);
    changes.slept.push(...newlySlept);

    // 休眠区：新休眠的 + 原来还睡着的；超上限就把最冷的永久丢掉
    let pool = [...stillSleeping, ...newlySlept];
    if (pool.length > c.maxDormant) {
      const ranked = pool.map((text, i) => ({ text, i, h: heat(stat(itemKey(text)), now) })).sort((a, b) => b.h - a.h || b.i - a.i);
      const keep = new Set(ranked.slice(0, c.maxDormant).map((x) => x.text));
      for (const t of pool) if (!keep.has(t)) changes.dropped.push(t);
      pool = pool.filter((t) => keep.has(t));
    }
    out.dormant[kind] = pool;
  }

  // 统计只保留还在用的关键词（活跃 + 休眠），免得无限增长
  const live = new Set();
  for (const kind of KINDS) {
    for (const t of out[kind] ?? []) live.add(itemKey(t));
    for (const t of out.dormant[kind] ?? []) live.add(itemKey(t));
  }
  for (const k of Object.keys(st)) if (!live.has(k)) delete st[k];
  return { notes: out, stats: st, changes };
}

/**
 * 回复时的唤醒：聊天里这一刻提到了某条休眠记忆的关键词，就临时带上它。
 * 返回 { notes, woken, stats }：notes 是新对象（不改传入的），woken 是被唤醒的条目。
 */
export function wakeFor({ notes, stats = {}, context = '', now = Date.now(), cfg = FORGET_DEFAULTS }) {
  const c = forgetConfig(cfg);
  if (!notes || !c.enabled || c.wake <= 0 || !context) return { notes, woken: [], stats };
  const texts = [String(context)];
  const woken = [];
  const next = { ...notes, lore: [...(notes.lore ?? [])], relations: [...(notes.relations ?? [])] };
  const st = { ...stats };
  for (const kind of KINDS) {
    const have = new Set(next[kind].map(itemKey));
    for (const it of notes.dormant?.[kind] ?? []) {
      if (woken.length >= c.wake) break;
      const k = itemKey(it);
      if (have.has(k) || hitsIn(k, texts) === 0) continue;
      next[kind].push(it);
      have.add(k);
      woken.push(it);
      const s = (st[k] ??= { h: 0, t: 0, c: now });
      s.h += 1;
      s.t = now;
    }
  }
  return { notes: woken.length ? next : notes, woken, stats: woken.length ? st : stats };
}
