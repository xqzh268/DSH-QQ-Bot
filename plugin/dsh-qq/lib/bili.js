/**
 * B 站只读客户端：搜索 / 取视频信息 / 解析短链，以及"把视频做成 QQ 小程序卡片"。
 *
 * 做法参考 dafeiyu-astrbot 的 bili_api.py（接口契约在那边被核对过）：
 *  - 游客也能用：先 GET /x/frontend/finger/spi 领 buvid3/buvid4，当 Cookie 带上（没有它搜索容易 412）；
 *  - WBI 签名：GET /x/web-interface/nav 里的 wbi_img.img_url / sub_url 取文件名（去扩展名）拼接，
 *    按 MIXIN 重排取前 32 位当 key；参数字典序排序 + wts，md5(query + key) 当 w_rid；
 *  - 搜索：/x/web-interface/wbi/search/type（search_type=video）；视频信息：/x/web-interface/view。
 *
 * 全程只读、不登录、不带任何账号信息。任何失败都返回 null / []，由调用方决定怎么办——
 * 绝不抛到聊天流程里，更不能让她"编"出一个没查到的视频。
 */
import { createHash } from 'node:crypto';

const API = 'https://api.bilibili.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const MIXIN = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
  37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
];

const BV_RE = /(BV[1-9A-HJ-NP-Za-km-z]{10})(?![A-Za-z0-9])/;
const SHORT_RE = /https?:\/\/(?:b23\.tv|bili2233\.cn)\/[A-Za-z0-9]+/i;
const VIDEO_URL_RE = /https?:\/\/(?:www\.|m\.)?bilibili\.com\/video\/(BV[1-9A-HJ-NP-Za-km-z]{10}|av\d+)/i;

/** WBI key：img_url / sub_url 的文件名（不含扩展名）拼起来，按 MIXIN 重排取 32 位 */
export function wbiKeyFrom(imgUrl, subUrl) {
  const stem = (u) => {
    try {
      const last = new URL(u).pathname.split('/').pop() ?? '';
      return last.replace(/\.[^.]+$/, '');
    } catch {
      return '';
    }
  };
  const raw = stem(imgUrl) + stem(subUrl);
  if (raw.length < 64) return null;
  return MIXIN.map((i) => raw[i]).join('').slice(0, 32);
}

/** 给参数加 wts 并算 w_rid（值里的 !'()* 会被去掉，与 B 站前端一致） */
export function wbiSign(params, key, nowSec = Math.floor(Date.now() / 1000)) {
  const values = {};
  for (const [k, v] of Object.entries(params)) values[k] = String(v).replace(/[!'()*]/g, '');
  values.wts = String(nowSec);
  const query = Object.keys(values)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(values[k])}`)
    .join('&')
    .replace(/\+/g, '%20');
  values.w_rid = createHash('md5').update(query + key).digest('hex');
  return values;
}

const stripHtml = (s) => String(s ?? '').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
const httpsUrl = (u) => {
  const s = String(u ?? '').trim();
  if (!s) return '';
  return s.startsWith('//') ? `https:${s}` : s.replace(/^http:\/\//i, 'https://');
};
/** 搜索结果的时长是 "12:34" 字符串，view 接口是秒数 */
function toSeconds(d) {
  if (typeof d === 'number') return d;
  const parts = String(d ?? '').split(':').map((x) => Number(x));
  if (!parts.length || parts.some((n) => !Number.isFinite(n))) return 0;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}
const num = (n) => (Number.isFinite(Number(n)) ? Number(n) : 0);

export function fmtCount(n) {
  const v = num(n);
  return v >= 10000 ? `${(v / 10000).toFixed(v >= 100000 ? 0 : 1)}万` : String(v);
}
export function fmtDuration(sec) {
  const s = Math.max(0, Math.round(num(sec)));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
}

/** 从一段文字里找出 B 站视频线索：BV 号、视频页链接、短链（还要靠网络展开） */
export function findBiliRefs(text) {
  const s = String(text ?? '');
  const bvids = [];
  for (const m of s.matchAll(new RegExp(BV_RE.source, 'g'))) if (!bvids.includes(m[1])) bvids.push(m[1]);
  const avs = [];
  for (const m of s.matchAll(/bilibili\.com\/video\/av(\d+)/gi)) if (!avs.includes(m[1])) avs.push(m[1]);
  const shorts = [];
  for (const m of s.matchAll(new RegExp(SHORT_RE.source, 'gi'))) if (!shorts.includes(m[0])) shorts.push(m[0]);
  return { bvids, avs, shorts };
}

/** 一条视频信息 → 给她看的一行/多行文字 */
export function describeVideo(v, { withDesc = true } = {}) {
  if (!v) return '';
  const bits = [
    `《${v.title}》`,
    v.author ? `UP主 ${v.author}` : '',
    v.duration ? `时长 ${fmtDuration(v.duration)}` : '',
    v.play !== undefined ? `播放 ${fmtCount(v.play)}` : '',
    v.like !== undefined && v.like !== null ? `点赞 ${fmtCount(v.like)}` : '',
    v.tname ? `分区 ${v.tname}` : '',
  ].filter(Boolean);
  const desc = withDesc ? String(v.desc ?? '').replace(/\s+/g, ' ').trim().slice(0, 120) : '';
  return `${bits.join('，')}（${v.bvid}）${desc ? `\n  简介：${desc}` : ''}`;
}

export class BiliClient {
  /**
   * @param {{fetchImpl?:Function, log?:Function, minGapMs?:number, now?:()=>number, timeoutMs?:number}} opts
   */
  constructor({ fetchImpl = globalThis.fetch, log = () => {}, minGapMs = 400, now = Date.now, timeoutMs = 12000 } = {}) {
    this.fetch = fetchImpl;
    this.log = log;
    this.minGapMs = minGapMs;
    this.now = now;
    this.timeoutMs = timeoutMs;
    this.cookie = '';
    this.wbi = null; // { key, exp }
    this.lastAt = 0;
    this.cache = new Map(); // key -> { v, exp }
    this.chain = Promise.resolve();
    this.blockedUntil = 0; // 被风控（412/-412）后的冷却
  }

  /** 串行 + 限速：B 站对游客很敏感，别并发打 */
  #queue(fn) {
    const run = this.chain.then(async () => {
      const wait = this.minGapMs - (this.now() - this.lastAt);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.lastAt = this.now();
      return fn();
    });
    this.chain = run.catch(() => {});
    return run;
  }

  async #raw(url, { withCookie = true, redirect = 'follow' } = {}) {
    const headers = { 'User-Agent': UA, Referer: 'https://www.bilibili.com/', Accept: 'application/json, text/plain, */*' };
    if (withCookie && this.cookie) headers.Cookie = this.cookie;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
    try {
      return await this.fetch(url, { headers, redirect, signal: ctl.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  /** 调一个 JSON 接口；code != 0 返回 null（-412/-352 之类视为被风控，歇一会儿） */
  async #json(path, params = {}, { withCookie = true } = {}) {
    if (this.now() < this.blockedUntil) return null;
    const qs = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString();
    const url = `${API}${path}${qs ? `?${qs}` : ''}`;
    try {
      const res = await this.#queue(() => this.#raw(url, { withCookie }));
      if (res.status === 412) {
        this.blockedUntil = this.now() + 10 * 60 * 1000;
        this.log('B站：被风控（HTTP 412），10 分钟内不再请求');
        return null;
      }
      if (!res.ok) return null;
      const body = await res.json();
      if (body?.code === -412 || body?.code === -352) {
        this.blockedUntil = this.now() + 10 * 60 * 1000;
        this.log(`B站：被风控（code ${body.code}），10 分钟内不再请求`);
        return null;
      }
      if (body?.code !== 0) return { __code: body?.code, __message: body?.message, data: body?.data };
      return { data: body.data ?? {} };
    } catch (err) {
      this.log('B站请求失败:', err?.name === 'AbortError' ? '超时' : err?.message ?? err);
      return null;
    }
  }

  /** 领游客指纹（buvid3/buvid4），只做一次 */
  async ensureFingerprint() {
    if (this.cookie) return true;
    const r = await this.#json('/x/frontend/finger/spi', {}, { withCookie: false });
    const d = r?.data;
    if (!d?.b_3) return false;
    const ok = (v) => typeof v === 'string' && v.length <= 256 && /^[A-Za-z0-9_%.\-+/|]+={0,2}$/.test(v);
    const parts = [];
    if (ok(d.b_3)) parts.push(`buvid3=${d.b_3}`);
    if (ok(d.b_4)) parts.push(`buvid4=${d.b_4}`);
    this.cookie = parts.join('; ');
    return Boolean(this.cookie);
  }

  async #wbiKey() {
    if (this.wbi && this.wbi.exp > this.now()) return this.wbi.key;
    // 游客取 nav 会返回 code -101，但 data.wbi_img 照样给
    const r = await this.#json('/x/web-interface/nav');
    const img = r?.data?.wbi_img;
    const key = img ? wbiKeyFrom(img.img_url, img.sub_url) : null;
    if (!key) return null;
    this.wbi = { key, exp: this.now() + 55 * 60 * 1000 };
    return key;
  }

  #cached(key) {
    const hit = this.cache.get(key);
    return hit && hit.exp > this.now() ? hit.v : undefined;
  }
  #store(key, v, ttlMs) {
    this.cache.set(key, { v, exp: this.now() + ttlMs });
    if (this.cache.size > 200) this.cache.delete(this.cache.keys().next().value);
    return v;
  }

  /** 视频详情。查不到（不存在 / 被风控 / 超时）返回 null */
  async view(id) {
    const text = String(id ?? '');
    const bv = text.match(BV_RE)?.[1];
    const av = !bv ? text.match(/^(?:av)?(\d+)$/i)?.[1] : null;
    if (!bv && !av) return null;
    const ck = `view:${bv ?? `av${av}`}`;
    const hit = this.#cached(ck);
    if (hit !== undefined) return hit;
    await this.ensureFingerprint();
    const r = await this.#json('/x/web-interface/view', bv ? { bvid: bv } : { aid: av });
    const d = r?.data;
    if (!d || r.__code || !d.bvid) return null;
    // 与请求的身份对得上才算数
    if (bv && d.bvid !== bv) return null;
    const v = {
      bvid: d.bvid,
      title: stripHtml(d.title),
      desc: String(d.desc ?? '').trim(),
      author: stripHtml(d.owner?.name),
      authorId: d.owner?.mid ?? null,
      pic: httpsUrl(d.pic),
      duration: num(d.duration),
      play: num(d.stat?.view),
      like: num(d.stat?.like),
      coin: num(d.stat?.coin),
      favorite: num(d.stat?.favorite),
      danmaku: num(d.stat?.danmaku),
      tname: String(d.tname ?? ''),
      pubdate: num(d.pubdate) * 1000,
      pages: Array.isArray(d.pages) ? d.pages.length : 1,
    };
    return this.#store(ck, v, 30 * 60 * 1000);
  }

  /** 关键词搜视频，返回最多 n 条（按综合排序）；任何问题返回 [] */
  async search(keyword, n = 5) {
    const word = String(keyword ?? '').trim().slice(0, 60);
    if (!word) return [];
    const ck = `search:${word}`;
    const hit = this.#cached(ck);
    if (hit !== undefined) return hit.slice(0, n);
    await this.ensureFingerprint();
    const key = await this.#wbiKey();
    if (!key) return [];
    const signed = wbiSign({ search_type: 'video', keyword: word, page: 1, page_size: Math.max(n, 10) }, key, Math.floor(this.now() / 1000));
    const r = await this.#json('/x/web-interface/wbi/search/type', signed);
    const list = r?.data?.result;
    if (!Array.isArray(list)) {
      if (r?.__code) this.log(`B站搜索被拒绝（code ${r.__code}）`);
      return [];
    }
    const out = list
      .filter((x) => x && x.bvid)
      .map((x) => ({
        bvid: String(x.bvid),
        title: stripHtml(x.title),
        desc: String(x.description ?? '').trim(),
        author: stripHtml(x.author),
        pic: httpsUrl(x.pic),
        duration: toSeconds(x.duration),
        play: num(x.play),
        like: num(x.like),
        danmaku: num(x.video_review),
        tname: String(x.typename ?? ''),
        pubdate: num(x.pubdate) * 1000,
      }));
    return this.#store(ck, out, 20 * 60 * 1000).slice(0, n);
  }

  /** b23.tv 短链 → BV 号（不跟着重定向走，只读 Location） */
  async resolveShort(url) {
    const u = String(url ?? '').match(SHORT_RE)?.[0];
    if (!u) return null;
    const ck = `short:${u}`;
    const hit = this.#cached(ck);
    if (hit !== undefined) return hit;
    try {
      const res = await this.#queue(() => this.#raw(u, { withCookie: false, redirect: 'manual' }));
      const loc = res.headers?.get?.('location') ?? '';
      const bv = String(loc).match(BV_RE)?.[1] ?? (VIDEO_URL_RE.exec(loc)?.[1] ?? null);
      return this.#store(ck, bv && /^BV/.test(bv) ? bv : null, 6 * 3600 * 1000);
    } catch (err) {
      this.log('B站短链展开失败:', err?.message ?? err);
      return null;
    }
  }

  /** 文字里提到的所有 B 站视频 → 详情（最多 limit 个；短链会先展开） */
  async videosIn(text, limit = 2) {
    const { bvids, avs, shorts } = findBiliRefs(text);
    const ids = [...bvids];
    for (const s of shorts) {
      if (ids.length >= limit) break;
      const bv = await this.resolveShort(s);
      if (bv && !ids.includes(bv)) ids.push(bv);
    }
    for (const a of avs) if (ids.length < limit) ids.push(`av${a}`);
    const out = [];
    for (const id of ids.slice(0, limit)) {
      const v = await this.view(id);
      if (v) out.push(v);
    }
    return out;
  }
}

/**
 * 通过 NapCat 的 get_mini_app_ark 生成"哔哩哔哩"小程序视频卡片（QQ 自己的卡片样式：封面 + 标题 + 哔哩哔哩小程序角标）。
 * 这个接口让 QQ 服务端出带签名的卡片数据，比自己拼 JSON 靠谱；拿不到就返回 null，由调用方退回文字+链接。
 *
 * @param {(action:string, params:object, timeoutMs?:number)=>Promise<any>} call onebot.call
 * @returns {Promise<string|null>} 可以直接放进 json 消息段 data.data 的字符串
 */
export async function buildBiliCard(call, video) {
  if (!video?.bvid || !video?.pic) return null;
  const title = String(video.title ?? '').slice(0, 60);
  const desc = String(video.author ? `UP主 ${video.author}` : video.desc ?? '').slice(0, 60) || title;
  try {
    const res = await call(
      'get_mini_app_ark',
      {
        type: 'bili',
        title,
        desc,
        picUrl: video.pic,
        jumpUrl: `pages/video/video?bvid=${video.bvid}`,
        webUrl: `https://www.bilibili.com/video/${video.bvid}`,
      },
      20000,
    );
    // OneBot 回包的 data 里再包一层 { data: ark }；不同版本可能少包一层，两种都认
    const ark = res?.data ?? res;
    if (!ark || typeof ark !== 'object') return null;
    if (typeof ark.app !== 'string' || !ark.meta) return null;
    return JSON.stringify(ark);
  } catch {
    return null;
  }
}

/** 从画像里的"特质/事实"短句提取可以拿去搜的词：去掉"喜欢/在玩/爱看"之类前缀，限长、去重 */
export function interestWords(items, max = 6) {
  const out = [];
  for (const raw of items ?? []) {
    const w = String(raw ?? '')
      .replace(/^(?:最近|正在|在|爱|喜欢|超爱|很爱|迷上了?|沉迷|常常?|经常)?(?:玩|看|追|听|打|做|研究|关注|练)?\s*/u, '')
      .replace(/[，。！？,.!?\s]+$/u, '')
      .trim();
    if (w.length < 2 || w.length > 16) continue;
    if (!out.includes(w)) out.push(w);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * 从搜索结果里挑适合"拿来分享"的：没分享过、时长适中（别拿 40 小时的流程实况）、有一定播放量。
 * 每个关键词最多出 2 条，保证话题有多样性。
 * @param {Array<{keyword?:string}&object>} results 已带 keyword/who 标注的结果
 */
export function pickDiscoverCandidates(results, { seen = [], maxMinutes = 15, minPlay = 3000, limit = 4 } = {}) {
  const seenSet = new Set(seen);
  const perKw = new Map();
  const out = [];
  const sorted = [...results].sort((a, b) => num(b.play) - num(a.play));
  for (const v of sorted) {
    if (!v?.bvid || seenSet.has(v.bvid) || out.some((o) => o.bvid === v.bvid)) continue;
    if (!v.pic) continue; // 没封面做不了卡片
    const sec = num(v.duration);
    if (sec < 20 || sec > maxMinutes * 60) continue;
    if (num(v.play) < minPlay) continue;
    const k = v.keyword ?? '';
    if ((perKw.get(k) ?? 0) >= 2) continue;
    perKw.set(k, (perKw.get(k) ?? 0) + 1);
    out.push(v);
    if (out.length >= limit) break;
  }
  return out;
}

/** 从回复里摘出 [[B站:BV号]] 标记，返回干净正文与 BV 号（去重保序） */
export function extractBiliMarkers(text) {
  const ids = [];
  const clean = String(text ?? '').replace(/\[\[\s*(?:B站|b站|哔哩哔哩|bilibili)\s*[:：]\s*([^\]]{1,40}?)\s*\]\]/gi, (_m, body) => {
    const bv = String(body).match(BV_RE)?.[1];
    if (bv && !ids.includes(bv)) ids.push(bv);
    return '';
  });
  return { clean: clean.replace(/\n{3,}/g, '\n\n').trim(), ids };
}

/** 文字退路：卡片做不出来时，发 链接（不是裸链接——前面有她自己的话） */
export function biliUrl(bvid) {
  return `https://www.bilibili.com/video/${bvid}`;
}
