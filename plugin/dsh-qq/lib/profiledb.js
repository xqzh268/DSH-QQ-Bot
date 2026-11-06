/**
 * 用户画像 / 记忆的本地数据库存储。
 *
 * 以前画像散在 data/profiles/*.json 里：能落盘，但不是"库"——
 * 没法查询、没法事务、也没法跟消息库一起备份。现在统一进 data/qq-messages.db。
 *
 * 两张表：
 *   profiles  一人一行（昵称、别名、印象词、已知事实、互动次数、首末次时间）
 *   episodes  每轮一条记忆摘要（按人分组，超上限自动裁剪）
 *
 * 首次启动会把旧的 data/profiles/*.json 迁进来，迁移后把文件改名加 .migrated，
 * 不删除，留作备份。
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readdirSync, readFileSync, renameSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const nowIso = () => new Date().toISOString();

function parseArray(raw, fallback = []) {
  if (!raw) return fallback;
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : fallback;
  } catch {
    return fallback;
  }
}

export class ProfileDB {
  constructor(projectDir, log = () => {}) {
    this.ok = false;
    this.legacyDir = join(projectDir, 'data', 'profiles');
    try {
      mkdirSync(join(projectDir, 'data'), { recursive: true });
      this.db = new DatabaseSync(join(projectDir, 'data', 'qq-messages.db'));
      this.db.exec('PRAGMA journal_mode = WAL');
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS profiles (
          user_id TEXT PRIMARY KEY,
          nickname TEXT,
          aliases TEXT,
          first_seen TEXT,
          last_seen TEXT,
          traits TEXT,
          facts TEXT,
          interactions INTEGER DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS episodes (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id TEXT NOT NULL,
          at TEXT NOT NULL,
          text TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_ep_user ON episodes(user_id, id);
      `);
      this.ok = true;
      this.migrated = this.#migrateLegacy(log);
      if (this.migrated) log(`画像已从 JSON 迁移进数据库：${this.migrated} 人`);
    } catch (err) {
      log('画像数据库不可用:', err?.message ?? err);
    }
  }

  #migrateLegacy(log) {
    if (!existsSync(this.legacyDir)) return 0;
    let files;
    try {
      files = readdirSync(this.legacyDir).filter((f) => f.endsWith('.json'));
    } catch {
      return 0;
    }
    let count = 0;
    for (const f of files) {
      const path = join(this.legacyDir, f);
      try {
        const p = JSON.parse(readFileSync(path, 'utf8'));
        const userId = String(p.userId ?? f.replace(/\.json$/, ''));
        if (!/^\d+$/.test(userId)) continue;
        const exists = this.db.prepare('SELECT 1 FROM profiles WHERE user_id = ?').get(userId);
        if (!exists) {
          this.db
            .prepare(
              'INSERT INTO profiles (user_id, nickname, aliases, first_seen, last_seen, traits, facts, interactions) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            )
            .run(
              userId,
              String(p.nickname ?? userId),
              JSON.stringify(Array.isArray(p.aliases) ? p.aliases : []),
              String(p.firstSeen ?? nowIso()),
              String(p.lastSeen ?? nowIso()),
              JSON.stringify(Array.isArray(p.traits) ? p.traits : []),
              JSON.stringify(Array.isArray(p.facts) ? p.facts : []),
              Number(p.interactions ?? 0),
            );
          for (const ep of Array.isArray(p.episodes) ? p.episodes : []) {
            this.db.prepare('INSERT INTO episodes (user_id, at, text) VALUES (?, ?, ?)').run(userId, String(ep.at ?? nowIso()), String(ep.text ?? ''));
          }
          count += 1;
        }
        renameSync(path, `${path}.migrated`);
      } catch (err) {
        log(`迁移 ${f} 失败:`, err?.message ?? err);
      }
    }
    return count;
  }

  #row(userId) {
    return this.db.prepare('SELECT * FROM profiles WHERE user_id = ?').get(String(userId));
  }

  #episodes(userId, limit = 40) {
    const rows = this.db
      .prepare('SELECT at, text FROM episodes WHERE user_id = ? ORDER BY id DESC LIMIT ?')
      .all(String(userId), Number(limit));
    return rows.reverse().map((r) => ({ at: r.at, text: r.text }));
  }

  #shape(row, maxEpisodes = 40) {
    if (!row) return null;
    return {
      userId: row.user_id,
      nickname: row.nickname ?? row.user_id,
      aliases: parseArray(row.aliases),
      firstSeen: row.first_seen,
      lastSeen: row.last_seen,
      traits: parseArray(row.traits),
      facts: parseArray(row.facts),
      interactions: Number(row.interactions ?? 0),
      episodes: this.#episodes(row.user_id, maxEpisodes),
    };
  }

  /** 取画像（不存在则建一行） */
  get(userId, nickname) {
    const id = String(userId);
    const existing = this.#row(id);
    if (existing) {
      if (nickname && nickname !== existing.nickname) {
        const aliases = Array.from(new Set([...parseArray(existing.aliases), nickname])).slice(-6);
        this.db
          .prepare('UPDATE profiles SET nickname = ?, aliases = ?, last_seen = ? WHERE user_id = ?')
          .run(String(nickname), JSON.stringify(aliases), nowIso(), id);
      }
      return this.#shape(this.#row(id));
    }
    this.db
      .prepare(
        'INSERT INTO profiles (user_id, nickname, aliases, first_seen, last_seen, traits, facts, interactions) VALUES (?, ?, ?, ?, ?, ?, ?, 0)',
      )
      .run(id, String(nickname ?? id), '[]', nowIso(), nowIso(), '[]', '[]');
    return this.#shape(this.#row(id));
  }

  read(userId) {
    return this.#shape(this.#row(String(userId)));
  }

  /** 覆盖保存（设置页编辑画像用） */
  save(profile) {
    const id = String(profile.userId);
    this.db
      .prepare(
        `INSERT INTO profiles (user_id, nickname, aliases, first_seen, last_seen, traits, facts, interactions)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET
           nickname = excluded.nickname,
           traits = excluded.traits,
           facts = excluded.facts,
           last_seen = excluded.last_seen`,
      )
      .run(
        id,
        String(profile.nickname ?? id),
        JSON.stringify(Array.isArray(profile.aliases) ? profile.aliases : []),
        String(profile.firstSeen ?? nowIso()),
        nowIso(),
        JSON.stringify(Array.isArray(profile.traits) ? profile.traits : []),
        JSON.stringify(Array.isArray(profile.facts) ? profile.facts : []),
        Number(profile.interactions ?? 0),
      );
    return this.read(id);
  }

  /** 列表（设置页） */
  list(limit = 200) {
    const rows = this.db.prepare('SELECT * FROM profiles ORDER BY last_seen DESC LIMIT ?').all(Number(limit));
    return rows.map((row) => {
      const count = this.db.prepare('SELECT count(*) AS c FROM episodes WHERE user_id = ?').get(row.user_id)?.c ?? 0;
      return {
        userId: row.user_id,
        nickname: row.nickname,
        interactions: Number(row.interactions ?? 0),
        traits: parseArray(row.traits).slice(0, 4),
        episodes: Number(count),
        lastSeen: row.last_seen,
      };
    });
  }

  remove(userId) {
    this.db.prepare('DELETE FROM episodes WHERE user_id = ?').run(String(userId));
    this.db.prepare('DELETE FROM profiles WHERE user_id = ?').run(String(userId));
    return true;
  }

  /**
   * 记一次交流：不依赖模型是否输出 memo。
   * 有 memo 就用它的摘要与结构化字段，没有就用「对方说 X → 她回 Y」。
   */
  remember(userId, nickname, { userText, replyText, memo = null, maxEpisodes = 40 }) {
    const id = String(userId);
    this.get(id, nickname);
    let traits = parseArray(this.#row(id).traits);
    let facts = parseArray(this.#row(id).facts);
    if (memo && Array.isArray(memo.traits)) traits = Array.from(new Set([...traits, ...memo.traits.map(String)])).slice(-12);
    if (memo && Array.isArray(memo.facts)) facts = Array.from(new Set([...facts, ...memo.facts.map(String)])).slice(-20);

    const episode = memo?.episode
      ? String(memo.episode).slice(0, 120)
      : `${String(userText ?? '').slice(0, 30)} → ${String(replyText ?? '').slice(0, 30)}`;

    this.db.prepare('INSERT INTO episodes (user_id, at, text) VALUES (?, ?, ?)').run(id, nowIso(), episode);
    // 裁剪到上限，防止记忆无限增长
    this.db
      .prepare('DELETE FROM episodes WHERE user_id = ? AND id NOT IN (SELECT id FROM episodes WHERE user_id = ? ORDER BY id DESC LIMIT ?)')
      .run(id, id, Number(maxEpisodes));

    this.db
      .prepare('UPDATE profiles SET traits = ?, facts = ?, interactions = interactions + 1, last_seen = ? WHERE user_id = ?')
      .run(JSON.stringify(traits), JSON.stringify(facts), nowIso(), id);

    return this.read(id);
  }

  close() {
    try {
      this.db?.close();
    } catch {}
  }
}
