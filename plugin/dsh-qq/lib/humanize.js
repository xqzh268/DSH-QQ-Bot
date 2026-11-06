/**
 * 拟人化发送：把一段回复拆成"几个气泡"，并给每条配上像人打字的间隔。
 *
 * 为什么需要：一个真人不会把所有话塞进一条消息一次发完，也不会秒回。
 * 她之前的输出是"一整段 + 立即发送"，这正是机器人感的来源。
 *
 * 拆法：按句末标点切；太短的碎片并到上一条（人不会把"嗯。"单独发一条）；
 * 命中概率才真的拆开，否则合并成一条——避免机械地每条都拆。
 */

const SENTENCE_END = /(?<=[。！？!?…~～])\s*|\n+/;

/** 把一段话切成候选气泡 */
export function splitBubbles(text, { maxBubbles = 3, minLen = 6 } = {}) {
  const s = String(text ?? '').trim();
  if (!s) return [];
  const raw = s
    .split(SENTENCE_END)
    .map((x) => x.trim())
    .filter(Boolean);
  let pieces = raw;
  let joiner = '';
  if (raw.length <= 1) {
    // 没有句末标点时，退一步按"汉字之间的空格"切：她按人设不打句号，
    // 常这样断句——"诶 三块钱就要打工还啊 那我得打多久才能还完"。
    // 只切两侧都是非 ASCII 字符的空格，英文单词、数字、链接里的空格不动；
    // "@昵称 " 后面的空格是称呼和正文的分隔，也不切。
    const weak = s
      .replace(/(@[^\s@]+)[ \t\u3000]+/g, '$1\u0001')
      .split(/(?<=[^\x00-\x7F])[ \t\u3000]+(?=[^\x00-\x7F])/)
      .map((x) => x.replace(/\u0001/g, ' ').trim())
      .filter(Boolean);
    if (weak.length <= 1) return [s];
    pieces = weak;
    joiner = ' ';
  }

  const merged = [];
  for (const part of pieces) {
    const prev = merged[merged.length - 1];
    // 只有"上一条已经够长、这一条又太短"时才并进去；
    // 否则连短句也能独立成气泡（人也会单发一句"嗯。判"）
    // 只有 [笑哭] 这种表情标记的碎片，一定并进上一条（"哈哈！"后面单发一个表情很怪）
    if (prev && /^(?:\[[A-Za-z0-9\u4e00-\u9fff:：]{1,10}\])+$/.test(part)) merged[merged.length - 1] = prev + joiner + part;
    else if (prev && part.length < minLen && prev.length >= minLen) merged[merged.length - 1] = prev + joiner + part;
    else merged.push(part);
  }
  // 按空格切时，开头只有一两个字的语气词（"诶""嗯"）不单发，并进下一条；
  // 按标点切的保持原样（"嗯。"这种单发本来就是允许的）
  if (joiner && merged.length > 1 && merged[0].length <= 2) {
    merged.splice(0, 2, merged[0] + joiner + merged[1]);
  }
  if (merged.length <= 1) return [s];
  if (merged.length <= maxBubbles) return merged;
  return [...merged.slice(0, maxBubbles - 1), merged.slice(maxBubbles - 1).join('')];
}

/** 打字耗时：和字数相关，再加 ±25% 抖动，夹在上下限之间 */
export function typingDelay(text, cfg = {}, rnd = Math.random) {
  const min = Number(cfg.minTypingMs ?? 700);
  const max = Number(cfg.maxTypingMs ?? 6500);
  const perChar = Number(cfg.perCharMs ?? 55);
  const len = String(text ?? '').length;
  const base = Math.min(max, Math.max(min, len * perChar));
  const jitter = 0.75 + rnd() * 0.5;
  return Math.round(Math.max(250, Math.min(max, base * jitter)));
}

/** 两条气泡之间的停顿 */
export function bubbleGap(cfg = {}, rnd = Math.random, nextText = '') {
  const lo = Number(cfg.gapMinMs ?? 400);
  const hi = Number(cfg.gapMaxMs ?? 1600);
  const base = Math.round(lo + rnd() * Math.max(0, hi - lo));
  // 下一条越长，打字越久：别让一长句和一两个字隔同样的时间发出来
  const per = Number(cfg.gapPerCharMs ?? 60);
  const extra = Math.min(2500, String(nextText ?? '').length * (Number.isFinite(per) ? per : 0));
  return base + extra;
}

/**
 * 决定这次到底怎么发。
 * @returns {string[]} 要依次发出的气泡
 */
export function planBubbles(text, cfg = {}, rnd = Math.random) {
  const clean = String(text ?? '').trim();
  if (!clean) return [];
  if (cfg.enabled === false) return [clean];

  // 模型自己用空行分了段，说明它想发成几条：这是明确意图，不掷骰子、不看字数，
  // 否则没命中概率时会把空行原样塞进同一个气泡里（一条消息里出现空行，很不像人发的）。
  // 代码块不拆。段数超过上限时，多出来的并进最后一条。
  if (!/```/.test(clean) && /\n[ \t]*\n/.test(clean)) {
    const paras = clean.split(/\n[ \t]*\n+/).map((x) => x.trim()).filter(Boolean);
    if (paras.length > 1) {
      const max = Math.max(1, Number(cfg.maxBubbles ?? 3));
      return paras.length <= max ? paras : [...paras.slice(0, max - 1), paras.slice(max - 1).join('\n')];
    }
  }

  const candidates = splitBubbles(clean, {
    maxBubbles: Number(cfg.maxBubbles ?? 3),
    minLen: Number(cfg.minLen ?? 6),
  });
  if (candidates.length <= 1) return [clean];

  // 本来就短的话整句发出去：真人不会把二十来个字拆成两三条，
  // 人设里也明确禁止把完整句子拆成零碎短句
  const minSplitChars = Number(cfg.minSplitChars ?? 24);
  if (clean.length < minSplitChars) return [clean];

  // 命中概率才拆；否则照旧一条发完
  const p = Number(cfg.splitProbability ?? 0.55);
  if (rnd() > p) return [clean];
  return candidates;
}

/**
 * 打字风格收尾：真人在 QQ 里很少用句末句号，也很少把话说得严丝合缝。
 *  - 去掉末尾的「。」「，」「、」「;」（保留 ！？…~ 和括号/引号里的收尾）
 *  - 句中的「。」大概率换成空格，保留少量
 * 只处理短到中等长度的闲聊；长篇（带换行的列表、代码、链接）原样返回。
 */
export function polishText(text, cfg = {}, rnd = Math.random) {
  const s = String(text ?? '').trim();
  if (!s) return s;
  if (cfg.stripPeriod === false) return s;
  if (s.length > 120 || /[`\n]|https?:\/\/|\d\.\d/.test(s)) return s.replace(/[。，、；;]+$/u, '').trimEnd() || s;

  const keepMid = Number(cfg.keepMidPeriod ?? 0.25);
  let out = s.replace(/。(?=\S)/gu, (m) => (rnd() < keepMid ? m : ' '));
  out = out.replace(/[。，、；;]+$/u, '').trimEnd();
  return out || s;
}

/**
 * 回复节奏随时段变化：深夜更慢（困），饭点前后略慢，白天正常。
 * 返回一个乘在打字延迟上的系数。
 */
export function paceFactor(date = new Date(), cfg = {}) {
  if (cfg.timeAware === false) return 1;
  const h = date.getHours() + date.getMinutes() / 60;
  if (h >= 23.5 || h < 6) return 1.8;
  if (h < 8) return 1.4;
  if ((h >= 11.75 && h < 13) || (h >= 17.75 && h < 19)) return 1.25;
  return 1;
}
