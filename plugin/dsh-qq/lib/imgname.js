/**
 * 从 OneBot 图片/表情段的 summary 里取出"表情的名字"。
 * 商城表情（mface）的 summary 是 "[无语]" 这样的名字，很有用；
 * 普通动画表情只有 "[动画表情]"、图片只有 "[图片]" 这类泛称，没信息量，丢掉。
 */
const GENERIC = new Set(['动画表情', '图片', '表情', '表情包', '动图', 'image', 'sticker']);

export function stickerName(summary) {
  const s = String(summary ?? '')
    .replace(/^\s*\[|\]\s*$/g, '')
    .trim();
  if (!s || s.length > 16 || GENERIC.has(s.toLowerCase())) return '';
  return s;
}
