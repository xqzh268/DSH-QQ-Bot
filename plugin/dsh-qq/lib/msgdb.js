/**
 * 本地轻量消息库：用 Node 内置的 node:sqlite（无第三方依赖）。
 *
 * 解决什么问题：原来的群消息缓冲只存在内存里，应用一重启，主动发言就"无据可依"了。
 * 落盘之后，重启后仍能读到"这个群最近在聊什么""上次主动说话是什么时候"。
 *
 * 三张表：
 *   messages     群/私聊消息流水（每个会话只保留最近 N 条，自动裁剪）
 *   chime        每个会话最后一次主动发言时间（重启后限流不会清零）
 *   private_hits 私聊主动找人的时间戳（按 24 小时窗口统计）
 *
 * 拿不到 sqlite 时自动降级为纯内存，不影响主流程。
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const KEEP_PER_CHAT = 200;

export class MessageDB {
  constructor(projectDir, log = () => {}) {
    this.log = log;
    this.ok = false;
    this.inserts = 0;
    try {
      const dir = join(projectDir, 'data');
      mkdirSync(dir, { recursive: true });
      this.db = new DatabaseSync(join(dir, 'qq-messages.db'));
      this.db.exec('PRAGMA journal_mode = WAL');
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          chat_key TEXT NOT NULL,
          group_id TEXT,
          user_id TEXT,
          nickname TEXT,
          text TEXT NOT NULL,
          at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_msg_chat_at ON messages(chat_key, at);
        CREATE TABLE IF NOT EXISTS chime (
          chat_key TEXT PRIMARY KEY,
          at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS private_hits (
          user_id TEXT NOT NULL,
          at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_private_user_at ON private_hits(user_id, at);
      `);
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS kv (
          key TEXT PRIMARY KEY,
          value TEXT
        );
      `);
      // 老库补列：self=1 表示这条是她自己发的（必须在所有 prepare 之前）
      try {
        this.db.exec('ALTER TABLE messages ADD COLUMN self INTEGER DEFAULT 0');
      } catch {
        /* 列已存在 */
      }
      this.stInsert = this.db.prepare(
        'INSERT INTO messages (chat_key, group_id, user_id, nickname, text, at, self) VALUES (?, ?, ?, ?, ?, ?, ?)',
      );
      // 群级记忆：每个群一行（梗 / 关系 / 话题的 JSON），watermark 是已经总结到的消息时间
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS group_notes (
          chat_key TEXT PRIMARY KEY,
          notes TEXT NOT NULL,
          watermark INTEGER NOT NULL DEFAULT 0,
          updated_at INTEGER NOT NULL DEFAULT 0,
          summaries INTEGER NOT NULL DEFAULT 0
        );
      `);
      this.stSince = this.db.prepare(
        'SELECT nickname, text, at, self FROM messages WHERE chat_key = ? AND at > ? ORDER BY id ASC LIMIT ?',
      );
      // 最近开过口的人（排除她自己）：每人取最新一次的昵称。
      // 裸列 + max() 在 SQLite 里取的是 max(at) 那一行（文档保证的行为）
      this.stParticipants = this.db.prepare(
        "SELECT user_id, nickname, max(at) AS at FROM messages WHERE chat_key = ? AND self = 0 AND at > ? AND user_id GLOB '[0-9]*' GROUP BY user_id ORDER BY max(at) DESC LIMIT ?",
      );
      this.stCountAfter = this.db.prepare('SELECT count(*) AS c FROM messages WHERE chat_key = ? AND at > ?');
      this.stRecent = this.db.prepare(
        'SELECT nickname, text, at, self FROM messages WHERE chat_key = ? ORDER BY id DESC LIMIT ?',
      );
      this.stCount = this.db.prepare('SELECT count(*) AS c FROM messages WHERE chat_key = ?');
      this.stPrune = this.db.prepare(
        'DELETE FROM messages WHERE chat_key = ? AND id NOT IN (SELECT id FROM messages WHERE chat_key = ? ORDER BY id DESC LIMIT ?)',
      );
      this.stGetChime = this.db.prepare('SELECT at FROM chime WHERE chat_key = ?');
      this.stSetChime = this.db.prepare(
        'INSERT INTO chime (chat_key, at) VALUES (?, ?) ON CONFLICT(chat_key) DO UPDATE SET at = excluded.at',
      );
      this.stPrivateHits = this.db.prepare('SELECT at FROM private_hits WHERE user_id = ? AND at > ?');
      this.stAddPrivate = this.db.prepare('INSERT INTO private_hits (user_id, at) VALUES (?, ?)');
      this.stPrunePrivate = this.db.prepare('DELETE FROM private_hits WHERE at < ?');
      this.ok = true;
      log('消息库已打开：data/qq-messages.db');
    } catch (err) {
      log('消息库不可用，主动发言将只依赖内存:', err?.message ?? err);
    }
  }

  getKv(key) {
    try {
      return this.db.prepare('SELECT value FROM kv WHERE key = ?').get(String(key))?.value ?? null;
    } catch {
      return null;
    }
  }

  setKv(key, value) {
    try {
      this.db
        .prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
        .run(String(key), String(value));
    } catch {}
  }

  /** 某条消息之后又来几条（判断要不要引用回复） */
  countAfter(chatKey, sinceAt) {
    if (!this.ok) return 0;
    try {
      return Number(this.stCountAfter.get(String(chatKey), Number(sinceAt ?? 0))?.c ?? 0);
    } catch {
      return 0;
    }
  }

  /** 她自己在群里说的话（用于"别重复已经接过的"） */
  selfSaid(chatKey, limit = 3) {
    if (!this.ok) return [];
    try {
      const rows = this.db
        .prepare('SELECT text, at FROM messages WHERE chat_key = ? AND self = 1 ORDER BY id DESC LIMIT ?')
        .all(String(chatKey), Number(limit));
      return rows.reverse().map((r) => ({ text: String(r.text ?? ''), at: Number(r.at) }));
    } catch {
      return [];
    }
  }

  append({ chatKey, groupId = null, userId = null, nickname = '', text = '', at = Date.now(), self = false }) {
    if (!this.ok) return false;
    try {
      this.stInsert.run(
      String(chatKey),
      groupId ? String(groupId) : null,
      userId ? String(userId) : null,
      String(nickname ?? ''),
      String(text ?? ''),
      Number(at),
      self ? 1 : 0,
    );
      this.inserts += 1;
      // 每个会话严格保留最近 KEEP_PER_CHAT 条：chat 量级下多一次计数很便宜
      const c = Number(this.stCount.get(String(chatKey))?.c ?? 0);
      if (c > KEEP_PER_CHAT) this.stPrune.run(String(chatKey), String(chatKey), KEEP_PER_CHAT);
      if (this.inserts % 100 === 0) this.stPrunePrivate.run(Date.now() - 7 * 24 * 3600 * 1000);
      return true;
    } catch (err) {
      this.log('写消息库失败:', err?.message ?? err);
      return false;
    }
  }

  /** 最近 limit 条，按时间正序返回 */
  recent(chatKey, limit = 12) {
    if (!this.ok) return [];
    try {
      const rows = this.stRecent.all(String(chatKey), Number(limit));
      return rows.reverse().map((r) => ({ nickname: r.nickname, text: r.text, at: Number(r.at), self: Number(r.self ?? 0) === 1 }));
    } catch {
      return [];
    }
  }

  /** sinceMs 毫秒内在这个会话里说过话的人：[{ userId, nickname, at }]，最近说话的在前 */
  participants(chatKey, sinceMs = 2 * 3600 * 1000, limit = 8) {
    if (!this.ok) return [];
    try {
      return this.stParticipants
        .all(String(chatKey), Date.now() - Number(sinceMs), Number(limit))
        .map((r) => ({ userId: String(r.user_id), nickname: String(r.nickname ?? ''), at: Number(r.at) }));
    } catch {
      return [];
    }
  }

  /** 某个时间点之后的消息（正序，最多 limit 条；超过时取最新的 limit 条） */
  since(chatKey, at, limit = 80) {
    if (!this.ok) return [];
    try {
      const rows = this.stSince.all(String(chatKey), Number(at ?? 0), 10000);
      return rows
        .slice(-Number(limit))
        .map((r) => ({ nickname: r.nickname, text: r.text, at: Number(r.at), self: Number(r.self ?? 0) === 1 }));
    } catch {
      return [];
    }
  }

  /** 读群级记忆；没有返回 null */
  getGroupNotes(chatKey) {
    if (!this.ok) return null;
    try {
      const row = this.db.prepare('SELECT notes, watermark, updated_at, summaries FROM group_notes WHERE chat_key = ?').get(String(chatKey));
      if (!row) return null;
      let notes = {};
      try {
        notes = JSON.parse(row.notes);
      } catch {}
      return { notes, watermark: Number(row.watermark), updatedAt: Number(row.updated_at), summaries: Number(row.summaries) };
    } catch {
      return null;
    }
  }

  setGroupNotes(chatKey, notes, watermark) {
    if (!this.ok) return false;
    try {
      this.db
        .prepare(
          `INSERT INTO group_notes (chat_key, notes, watermark, updated_at, summaries) VALUES (?, ?, ?, ?, 1)
           ON CONFLICT(chat_key) DO UPDATE SET notes = excluded.notes, watermark = excluded.watermark,
             updated_at = excluded.updated_at, summaries = group_notes.summaries + 1`,
        )
        .run(String(chatKey), JSON.stringify(notes ?? {}), Number(watermark ?? 0), Date.now());
      return true;
    } catch (err) {
      this.log('写群级记忆失败:', err?.message ?? err);
      return false;
    }
  }

  /** 所有群的记忆概览（设置页用） */
  listGroupNotes() {
    if (!this.ok) return [];
    try {
      return this.db
        .prepare('SELECT chat_key, notes, watermark, updated_at, summaries FROM group_notes ORDER BY updated_at DESC')
        .all()
        .map((r) => {
          let notes = {};
          try {
            notes = JSON.parse(r.notes);
          } catch {}
          return { chatKey: r.chat_key, notes, watermark: Number(r.watermark), updatedAt: Number(r.updated_at), summaries: Number(r.summaries) };
        });
    } catch {
      return [];
    }
  }

  /** 手工编辑：只改内容，保留水位线和总结次数（不会让已总结过的消息被重新总结） */
  editGroupNotes(chatKey, notes) {
    if (!this.ok) return false;
    try {
      this.db
        .prepare(
          `INSERT INTO group_notes (chat_key, notes, watermark, updated_at, summaries) VALUES (?, ?, 0, ?, 0)
           ON CONFLICT(chat_key) DO UPDATE SET notes = excluded.notes, updated_at = excluded.updated_at`,
        )
        .run(String(chatKey), JSON.stringify(notes ?? {}), Date.now());
      return true;
    } catch (err) {
      this.log('编辑群级记忆失败:', err?.message ?? err);
      return false;
    }
  }

  deleteGroupNotes(chatKey) {
    if (!this.ok) return false;
    try {
      this.db.prepare('DELETE FROM group_notes WHERE chat_key = ?').run(String(chatKey));
      return true;
    } catch {
      return false;
    }
  }

  count(chatKey) {
    if (!this.ok) return 0;
    try {
      return Number(this.stCount.get(String(chatKey))?.c ?? 0);
    } catch {
      return 0;
    }
  }

  getChime(chatKey) {
    if (!this.ok) return null;
    try {
      const row = this.stGetChime.get(String(chatKey));
      return row ? Number(row.at) : null;
    } catch {
      return null;
    }
  }

  setChime(chatKey, at = Date.now()) {
    if (!this.ok) return;
    try {
      this.stSetChime.run(String(chatKey), Number(at));
    } catch {}
  }

  privateHits(userId, windowMs) {
    if (!this.ok) return [];
    try {
      return this.stPrivateHits.all(String(userId), Date.now() - windowMs).map((r) => Number(r.at));
    } catch {
      return [];
    }
  }

  addPrivateHit(userId, at = Date.now()) {
    if (!this.ok) return;
    try {
      this.stAddPrivate.run(String(userId), Number(at));
    } catch {}
  }

  close() {
    try {
      this.db?.close();
    } catch {}
  }
}
