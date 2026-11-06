/**
 * 群友发来的链接 → 她看得懂的内容。
 *  - B 站（BV 号 / 视频页 / b23.tv 短链 / 小程序卡片里的链接）：走 BiliClient 取标题、UP 主、数据、简介；
 *  - 小红书（xiaohongshu.com / xhslink.com）：尽力读页面的 og:title / description。小红书对非登录访问限制很多，
 *    读不到就返回空，调用方只给她卡片里本来就有的标题摘要，不让她假装看过正文。
 * 只返回"系统查到的事实"，查不到的一律不返回。
 */
import { describeVideo, findBiliRefs } from './bili.js';

const XHS_RE = /https?:\/\/(?:www\.)?(?:xiaohongshu\.com|xhslink\.com)\/[^\s"'<>）)】\]]+/gi;
// 注意不能用微信 UA：小红书会把它跳去微信 OAuth 授权页
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

const decodeEntities = (s) =>
  String(s ?? '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&#(\d+);/g, (_m, n) => String.fromCodePoint(Number(n)));

/** 从 HTML 里取 og:title / og:description / description / <title>（纯函数，便于测试） */
export function parseMeta(html) {
  const text = String(html ?? '');
  const pick = (re) => {
    const m = text.match(re);
    return m ? decodeEntities(m[1]).replace(/\s+/g, ' ').trim() : '';
  };
  const metaContent = (key) =>
    pick(new RegExp(`<meta[^>]+(?:property|name)=["']${key}["'][^>]*content=["']([^"']*)["']`, 'i')) ||
    pick(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${key}["']`, 'i'));
  const title = metaContent('og:title') || pick(/<title[^>]*>([^<]*)<\/title>/i);
  const desc = metaContent('og:description') || metaContent('description');
  return { title: title.replace(/\s*-\s*小红书\s*$/, ''), desc };
}

/** 小红书登录墙 / 通用首页的标题不算内容 */
function isGenericXhs(title) {
  return !title || /^小红书\b|你的生活兴趣社区|登录|安全验证|验证/.test(title);
}

export class LinkReader {
  /**
   * @param {{bili?:import('./bili.js').BiliClient|null, fetchImpl?:Function, log?:Function, xhs?:boolean, timeoutMs?:number}} opts
   */
  constructor({ bili = null, fetchImpl = globalThis.fetch, log = () => {}, xhs = true, timeoutMs = 8000 } = {}) {
    this.bili = bili;
    this.fetch = fetchImpl;
    this.log = log;
    this.xhs = xhs;
    this.timeoutMs = timeoutMs;
    this.cache = new Map();
  }

  /** 文字里有没有值得去读的链接（便宜的同步判断，没有就别发任何请求） */
  static hasLinks(text) {
    const s = String(text ?? '');
    const r = findBiliRefs(s);
    return Boolean(r.bvids.length || r.avs.length || r.shorts.length || new RegExp(XHS_RE.source, 'i').test(s));
  }

  async readXhs(url) {
    if (this.cache.has(url)) return this.cache.get(url);
    let out = null;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
    try {
      const res = await this.fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9' }, redirect: 'follow', signal: ctl.signal });
      if (res.ok) {
        const html = (await res.text()).slice(0, 600 * 1024);
        const { title, desc } = parseMeta(html);
        if (!isGenericXhs(title)) out = { title, desc };
      }
    } catch (err) {
      this.log('读小红书链接失败:', err?.name === 'AbortError' ? '超时' : err?.message ?? err);
    } finally {
      clearTimeout(timer);
    }
    this.cache.set(url, out);
    if (this.cache.size > 100) this.cache.delete(this.cache.keys().next().value);
    return out;
  }

  /**
   * 把一段文字里的链接读成几行说明。最多处理 2 个 B 站视频 + 1 个小红书，总是 resolve（读不到就少几行）。
   * @returns {Promise<{notes:string[], videos:object[]}>} videos 供上层记下"她可以分享的 BV"
   */
  async notesFor(text) {
    const notes = [];
    let videos = [];
    try {
      if (this.bili) {
        videos = await this.bili.videosIn(text, 2);
        for (const v of videos) notes.push(`B站视频：${describeVideo(v)}`);
      }
      if (this.xhs) {
        const urls = [...String(text ?? '').matchAll(XHS_RE)].map((m) => m[0]);
        if (urls[0]) {
          const x = await this.readXhs(urls[0]);
          if (x) notes.push(`小红书笔记：《${x.title}》${x.desc ? `\n  摘要：${x.desc.slice(0, 160)}` : ''}（只读到了页面标题和摘要，正文看不到）`);
        }
      }
    } catch (err) {
      this.log('解析链接出错:', err?.message ?? err);
    }
    return { notes, videos };
  }
}
