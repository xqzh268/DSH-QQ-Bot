/**
 * 表情包库（含语义检索与学习闭环）。
 *
 * 检索不靠单一子串匹配，而是三路证据加权：
 *   1) 标签（她自己看图后打的，权重最高）
 *   2) 上下文（收到这张图时前后说了什么）
 *   3) 同义词扩展（"乐" → 搞笑/笑死/哈哈），补中文口语的跳跃
 * 另外用中文 bigram 重叠度做模糊兜底。
 *
 * 学习闭环：发出去之后，同一会话 120 秒内的下一条消息当作隐式反馈——
 * "哈哈哈/笑死/好可爱" 加分，"别刷屏/无语/什么啊" 减分并进冷却。
 */
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, existsSync, rmSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { stickerName } from './imgname.js';
import { imageSize } from './imgtile.js';

const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };

/** 中文口语同义词簇：任一词命中，同簇其它词也算命中 */
const SYNONYMS = [
  ['搞笑', '乐', '笑死', '哈哈', '好笑', '逗', '绷不住', '笑不活'],
  ['无语', '醉了', '离谱', '服了', 'emmm', '沉默', '问号'],
  ['可爱', '萌', '好可爱', '心都化了', 'awsl'],
  ['晚安', '睡了', '困了', '睡觉'],
  ['加油', '冲', '可以的', '稳住', '别慌', '支持'],
  ['安慰', '抱抱', '摸头', '别难过', '心疼', '辛苦', '心累', '累', '委屈', '难受', '撑不住'],
  ['敷衍', '哦', '嗯嗯', '收到', '行吧', '好家伙'],
  ['生气', '气死', '爆炸', '火大', '不爽'],
  ['震惊', '惊了', '竟然', '哇', '卧槽'],
];

const POSITIVE = /(哈{2,}|笑死|好笑|逗|可爱|绷不住|绝了|牛|赞|这表情|乐|艹|卧槽)/;
const NEGATIVE = /(别发|别刷|刷屏|无语|什么啊|烦|不好笑|尬|幼稚|停)/;

const FEEDBACK_WINDOW_MS = 120 * 1000;

function sniffMediaType(buf) {
  if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50) return 'image/png';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'GIF8') return 'image/gif';
  if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

/**
 * 是不是动图（多帧）。她的看图通道（DSH 附件服务）会把动图规范化成单帧，
 * 所以动图她只能看到其中一帧——要如实告诉她，别让她硬猜整个动作。
 *  - GIF：图形控制扩展块（21 F9 04）出现 ≥2 次即多帧
 *  - WebP：VP8X 头的动画标志位
 *  - PNG：存在 acTL（APNG）块
 */
export function isAnimated(buf, mediaType) {
  try {
    if (mediaType === 'image/gif') {
      let n = 0;
      for (let i = 0; i + 2 < buf.length && n < 2; i++) {
        if (buf[i] === 0x21 && buf[i + 1] === 0xf9 && buf[i + 2] === 0x04) n += 1;
      }
      return n >= 2;
    }
    if (mediaType === 'image/webp') return buf.toString('ascii', 12, 16) === 'VP8X' && (buf[20] & 0x02) !== 0;
    if (mediaType === 'image/png') return buf.subarray(0, 256).includes(Buffer.from('acTL'));
  } catch {
    /* 判断不了就当静态图 */
  }
  return false;
}

/** 中文按 2-gram 切，英文/数字按词切 */
function grams(text) {
  const s = String(text ?? '').toLowerCase().replace(/[\s\p{P}]+/gu, '');
  const out = new Set();
  for (let i = 0; i + 1 < s.length; i += 1) out.add(s.slice(i, i + 2));
  for (const w of String(text ?? '').toLowerCase().match(/[a-z0-9]{2,}/g) ?? []) out.add(w);
  return out;
}

function overlap(a, b) {
  if (!a.size || !b.size) return 0;
  let hit = 0;
  for (const g of a) if (b.has(g)) hit += 1;
  return hit / Math.min(a.size, b.size);
}

/** 把查询词扩成同义词集合 */
function expand(keyword) {
  const k = String(keyword ?? '').trim().toLowerCase();
  const set = new Set([k]);
  for (const cluster of SYNONYMS) {
    if (cluster.some((w) => k.includes(w) || w.includes(k))) {
      for (const w of cluster) set.add(w);
    }
  }
  return [...set].filter(Boolean);
}

export class StickerStore {
  constructor(projectDir, log = () => {}) {
    this.log = log;
    this.ok = false;
    this.dir = join(projectDir, 'data', 'stickers');
    this.lastSent = new Map(); // chatKey -> {hash, at}
    try {
      mkdirSync(this.dir, { recursive: true });
      this.db = new DatabaseSync(join(projectDir, 'data', 'qq-messages.db'));
      this.db.exec('PRAGMA journal_mode = WAL');
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS stickers (
          hash TEXT PRIMARY KEY,
          path TEXT NOT NULL,
          media_type TEXT,
          bytes INTEGER,
          sender_id TEXT,
          chat_key TEXT,
          context TEXT,
          tags TEXT,
          added_at INTEGER NOT NULL,
          used_at INTEGER,
          uses INTEGER DEFAULT 0
        );
      `);
      // 老库补列（学习闭环需要）
      for (const [col, decl] of [
        ['score', 'REAL DEFAULT 1.0'],
        ['description', 'TEXT'],
        ['last_used_at', 'INTEGER'],
        ['cooldown_until', 'INTEGER'],
      ]) {
        try {
          this.db.exec(`ALTER TABLE stickers ADD COLUMN ${col} ${decl}`);
        } catch {
          /* 列已存在 */
        }
      }
      this.db.exec('CREATE INDEX IF NOT EXISTS idx_sticker_score ON stickers(score)');
      this.stList = this.db.prepare('SELECT * FROM stickers ORDER BY added_at DESC LIMIT ?');
      this.stGet = this.db.prepare('SELECT * FROM stickers WHERE hash = ?');
      this.stInsert = this.db.prepare(
        'INSERT OR IGNORE INTO stickers (hash, path, media_type, bytes, sender_id, chat_key, context, tags, added_at, score) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1.0)',
      );
      this.stAll = this.db.prepare('SELECT * FROM stickers ORDER BY added_at DESC LIMIT 500');
      this.stTouch = this.db.prepare('UPDATE stickers SET uses = uses + 1, used_at = ?, last_used_at = ? WHERE hash = ?');
      this.stBump = this.db.prepare('UPDATE stickers SET score = min(5.0, coalesce(score, 1.0) + ?) WHERE hash = ?');
      this.stDrop = this.db.prepare('UPDATE stickers SET score = max(0.1, coalesce(score, 1.0) - ?), cooldown_until = ? WHERE hash = ?');
      this.stDelete = this.db.prepare('DELETE FROM stickers WHERE hash = ?');
      this.stCount = this.db.prepare('SELECT count(*) AS c FROM stickers');
      this.ok = true;
      log(`表情包库已打开：${this.count()} 张`);
    } catch (err) {
      log('表情包库不可用:', err?.message ?? err);
    }
  }

  count() {
    try {
      return Number(this.stCount?.get()?.c ?? 0);
    } catch {
      return 0;
    }
  }

  /** 下载一张图并识别格式；失败返回 null */
  async #download(img) {
    const url = img?.url;
    if (!url || !/^https?:/.test(url)) return null;
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length || buf.length > 8 * 1024 * 1024) return null;
    const mediaType = sniffMediaType(buf);
    if (!mediaType) return null;
    const hash = createHash('sha256').update(buf).digest('hex').slice(0, 32);
    return { buf, mediaType, hash, animated: isAnimated(buf, mediaType), size: imageSize(buf) };
  }

  /**
   * 只给她"看一眼"的图片：下载到 seen/ 缓存，不进表情包库、不入库。
   * 以前 autoSave=stickers 时普通图片（包括当成图片发的 GIF）根本不会被下载，
   * 她只看到文字「[图片]」，所以"看不懂图"。缓存里超过一天的文件顺手清掉。
   */
  async look(event, shouldLook, max = 3) {
    if (!Array.isArray(event?.images) || !event.images.length) return [];
    const seenDir = join(this.dir, 'seen');
    const out = [];
    try {
      mkdirSync(seenDir, { recursive: true });
      const cutoff = Date.now() - 24 * 3600 * 1000;
      // 顶层是下载的图；tiles/ 是长图切出来的段，一并按一天清理
      for (const base of [seenDir, join(seenDir, 'tiles')]) {
        if (!existsSync(base)) continue;
        for (const f of readdirSync(base)) {
          try {
            const p = join(base, f);
            const st = statSync(p);
            if (st.isFile() && st.mtimeMs < cutoff) rmSync(p, { force: true });
          } catch {
            /* 清理失败不影响看图 */
          }
        }
      }
    } catch (err) {
      this.log('图片缓存目录不可用:', err?.message ?? err);
      return [];
    }
    for (const img of event.images) {
      if (out.length >= max) break;
      try {
        if (typeof shouldLook === 'function' && !shouldLook(img)) continue;
        const got = await this.#download(img);
        if (!got) continue;
        const file = join(seenDir, `${got.hash}.${EXT[got.mediaType] ?? 'png'}`);
        if (!existsSync(file)) writeFileSync(file, got.buf);
        out.push({ hash: got.hash, path: file, mediaType: got.mediaType, isSticker: Boolean(img.isSticker), animated: got.animated, size: got.size, name: stickerName(img.summary), transient: true });
      } catch (err) {
        this.log('下载图片失败:', err?.message ?? err);
      }
    }
    if (out.length) this.log(`看图缓存 +${out.length}（不入表情包库）${out.some((o) => o.animated) ? '，含动图' : ''}`);
    return out;
  }

  async ingest(event, contextText = '', shouldIngest) {
    if (!this.ok || !Array.isArray(event.images) || !event.images.length) return [];
    const saved = [];
    for (const img of event.images) {
      try {
        if (typeof shouldIngest === 'function' && !shouldIngest(img)) continue;
        const got = await this.#download(img);
        if (!got) continue;
        const { buf, mediaType, hash } = got;
        const file = join(this.dir, `${hash}.${EXT[mediaType] ?? 'png'}`);
        if (!existsSync(file)) writeFileSync(file, buf);
        this.stInsert.run(
          hash,
          file,
          mediaType,
          buf.length,
          String(event.userId ?? ''),
          String(event.chatKey ?? ''),
          String(contextText ?? '').slice(0, 200),
          '',
          Date.now(),
        );
        saved.push({ hash, path: file, mediaType, isSticker: Boolean(img.isSticker), animated: got.animated, size: got.size, name: stickerName(img.summary) });
      } catch (err) {
        this.log('下载表情包失败:', err?.message ?? err);
      }
    }
    if (saved.length) this.log(`表情包入库 +${saved.length}，现有 ${this.count()} 张`);
    return saved;
  }

  list(limit = 50) {
    if (!this.ok) return [];
    try {
      return this.stList.all(Number(limit)).map((r) => ({ ...r }));
    } catch {
      return [];
    }
  }

  get(hash) {
    try {
      const row = this.stGet.get(String(hash));
      return row ? { ...row } : null;
    } catch {
      return null;
    }
  }

  /** 给某张图追加标签（她看过图之后自己打的词） */
  addTags(hash, tags) {
    const row = this.get(hash);
    if (!row) return false;
    const merged = new Set(
      String(row.tags ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    );
    for (const t of [].concat(tags ?? [])) {
      const w = String(t).trim();
      if (w) merged.add(w);
    }
    try {
      this.db.prepare('UPDATE stickers SET tags = ? WHERE hash = ?').run([...merged].join(','), String(hash));
      return true;
    } catch {
      return false;
    }
  }

  setTags(hash, tags) {
    try {
      this.db.prepare('UPDATE stickers SET tags = ? WHERE hash = ?').run(Array.isArray(tags) ? tags.join(',') : String(tags ?? ''), hash);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 按场景挑一张：同义词扩展 → 标签/上下文命中 → bigram 兜底 → 综合分
   */
  pick(keyword, chatKey = '', now = Date.now()) {
    if (!this.ok) return null;
    const query = expand(keyword);
    if (!query.length) return null;
    let rows;
    try {
      rows = this.stAll.all().map((r) => ({ ...r }));
    } catch {
      return null;
    }
    if (!rows.length) return null;

    const qGrams = grams(`${keyword} ${query.join(' ')}`);
    const scored = [];
    for (const row of rows) {
      if (row.cooldown_until && Number(row.cooldown_until) > now) continue;
      const tags = String(row.tags ?? '').toLowerCase();
      const context = String(row.context ?? '').toLowerCase();
      let hit = 0;
      for (const w of query) {
        if (!w) continue;
        if (tags.includes(w)) hit += 3;
        else if (context.includes(w)) hit += 1;
      }
      const sim = Math.max(overlap(qGrams, grams(tags)), overlap(qGrams, grams(context)) * 0.6);
      if (!hit && sim < 0.34) continue;
      const base = Number(row.score ?? 1);
      const usage = Math.log10((row.uses ?? 0) + 1) * 0.4;
      const recency = row.last_used_at ? Math.max(0, 1 - (now - Number(row.last_used_at)) / (24 * 3600 * 1000)) * 0.8 : 0;
      const total = hit * 1.2 + sim * 2 + base + usage - recency + Math.random() * 0.25;
      scored.push({ row, total });
    }
    if (!scored.length) return null;
    scored.sort((a, b) => b.total - a.total);
    const best = scored[0].row;
    try {
      this.stTouch.run(now, now, best.hash);
    } catch {}
    if (chatKey) this.lastSent.set(String(chatKey), { hash: best.hash, at: now });
    return { ...best, matchScore: Number(scored[0].total.toFixed(3)) };
  }

  /** 隐式反馈：发出去之后同会话的下一条消息。返回 'up' | 'down' | null */
  observeFeedback(chatKey, text, now = Date.now()) {
    const sent = this.lastSent.get(String(chatKey));
    if (!sent) return null;
    if (now - sent.at > FEEDBACK_WINDOW_MS) {
      this.lastSent.delete(String(chatKey));
      return null;
    }
    const t = String(text ?? '');
    if (NEGATIVE.test(t)) {
      try {
        this.stDrop.run(1.0, now + 24 * 3600 * 1000, sent.hash);
      } catch {}
      this.lastSent.delete(String(chatKey));
      this.log(`表情反馈：负面（${t.slice(0, 20)}），扣分并冷却 24h`);
      return 'down';
    }
    if (POSITIVE.test(t)) {
      try {
        this.stBump.run(0.6, sent.hash);
      } catch {}
      this.lastSent.delete(String(chatKey));
      this.log(`表情反馈：正面（${t.slice(0, 20)}），加分`);
      return 'up';
    }
    return null;
  }

  remove(hash) {
    if (!this.ok) return false;
    try {
      const row = this.get(hash);
      if (row?.path) rmSync(row.path, { force: true });
      this.stDelete.run(String(hash));
      return true;
    } catch {
      return false;
    }
  }

  close() {
    try {
      this.db?.close();
    } catch {}
  }
}


