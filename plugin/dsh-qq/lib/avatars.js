/**
 * QQ 头像：按 QQ 号下载并缓存到本地，让她能用 read_image 看（或随消息附上）。
 *
 * 地址用 QQ 官方公开的头像接口 https://q1.qlogo.cn/g?b=qq&nk=<QQ号>&s=640
 * （2026-11 在本机实测：返回 200 + image/jpeg）。
 * 缓存按文件修改时间算，默认 6 小时内不重复下载——人家换头像了过一会儿也能看到新的，
 * 又不会每条消息都访问一次网络。下载失败时若有旧缓存就用旧的。
 */
import { mkdirSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

const MAX_BYTES = 2 * 1024 * 1024;

function sniff(buf) {
  if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50) return { mediaType: 'image/png', ext: 'png' };
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8) return { mediaType: 'image/jpeg', ext: 'jpg' };
  if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'GIF8') return { mediaType: 'image/gif', ext: 'gif' };
  if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return { mediaType: 'image/webp', ext: 'webp' };
  return null;
}

const MIME_OF = { jpg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' };

/**
 * @param {string} dir        头像缓存目录（必须在只读工具允许的目录里，她才打得开）
 * @param {string} qq         QQ 号（只接受纯数字，防止拼出奇怪的 URL）
 * @param {{maxAgeMs?:number, size?:number, fetchImpl?:Function, urlOf?:Function}} opts
 * @returns {Promise<{path:string, mediaType:string, qq:string, fresh:boolean}|null>}
 */
export async function fetchAvatar(dir, qq, opts = {}) {
  const id = String(qq ?? '').trim();
  if (!/^\d{5,12}$/.test(id)) return null;
  const maxAge = Number(opts.maxAgeMs ?? 6 * 3600 * 1000);
  const doFetch = opts.fetchImpl ?? fetch;
  const urlOf = opts.urlOf ?? ((n, s) => `https://q1.qlogo.cn/g?b=qq&nk=${n}&s=${s}`);
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    return null;
  }
  const cached = ['jpg', 'png', 'gif', 'webp'].map((e) => join(dir, `${id}.${e}`)).find((p) => existsSync(p));
  if (cached && Date.now() - statSync(cached).mtimeMs < maxAge) {
    return { path: cached, mediaType: MIME_OF[cached.split('.').pop()], qq: id, fresh: false };
  }
  try {
    const res = await doFetch(urlOf(id, opts.size ?? 640), { signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const kind = sniff(buf);
    if (!buf.length || buf.length > MAX_BYTES || !kind) throw new Error('不是可用的图片');
    const file = join(dir, `${id}.${kind.ext}`);
    writeFileSync(file, buf);
    return { path: file, mediaType: kind.mediaType, qq: id, fresh: true };
  } catch {
    // 网络不通就退回旧缓存（过期的头像也比没有强）
    if (cached) return { path: cached, mediaType: MIME_OF[cached.split('.').pop()], qq: id, fresh: false };
    return null;
  }
}

/** 这句话是不是在说头像（说了才把头像随消息附上，平时只给路径） */
export function asksAboutAvatar(text) {
  return /头像|avatar|pfp|profile\s*pic/i.test(String(text ?? ''));
}