/**
 * 插件侧的人设与记忆：读项目里的 config.json / persona/*.json / data/profiles/*.json。
 *
 * 刻意与独立桥（src/）保持同一份数据格式：无论将来用哪条路线跑，
 * 她的记忆是同一份，换实现不丢人。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ProfileDB } from './profiledb.js';

const nowIso = () => new Date().toISOString();

function readJson(file, fallback) {
  try {
    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  mkdirSync(join(file, '..'), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  renameSync(tmp, file);
}

export class ProjectStore {
  constructor(projectDir) {
    this.dir = projectDir;
    this.cfg = readJson(join(projectDir, 'config.json'), {});
    this.configPath = join(projectDir, 'config.json');
    this.profileDir = join(projectDir, 'data', 'profiles');
    // 画像/记忆进本地数据库；老 JSON 会被自动迁移（文件改名 .migrated 保留备份）
    this.profilesDB = new ProfileDB(projectDir);
  }

  /** 合并写入 config.json（设置页用），返回新配置 */
  saveConfig(patch) {
    const next = { ...this.cfg, ...patch };
    writeJson(this.configPath, next);
    this.cfg = next;
    return next;
  }

  /** 列出所有角色卡（只取摘要，设置页用） */
  listPersonas() {
    const dir = join(this.dir, 'persona');
    try {
      return readdirSync(dir)
        .filter((f) => f.endsWith('.json'))
        .sort()
        .map((f) => {
          const p = JSON.parse(readFileSync(join(dir, f), 'utf8'));
          return { file: `persona/${f}`, id: p.id, name: p.name, tagline: p.tagline ?? '' };
        });
    } catch {
      return [];
    }
  }

  /** 读取某张角色卡（file 形如 persona/dafeiyu.json） */
  readPersona(file) {
    const rel = file ?? this.cfg?.persona?.active ?? 'persona/dafeiyu.json';
    const path = join(this.dir, rel);
    if (!existsSync(path)) throw new Error(`角色卡不存在：${path}`);
    return { file: rel, data: JSON.parse(readFileSync(path, 'utf8')) };
  }

  /** 保存角色卡 */
  writePersona(file, data) {
    const rel = file ?? this.cfg?.persona?.active ?? 'persona/dafeiyu.json';
    if (!rel.startsWith('persona/') || rel.includes('..')) throw new Error('非法路径');
    writeJson(join(this.dir, rel), data);
    return { file: rel, data };
  }

  persona() {
    const rel = this.cfg?.persona?.active ?? 'persona/dafeiyu.json';
    const file = join(this.dir, rel);
    if (!existsSync(file)) throw new Error(`角色卡不存在：${file}`);
    return JSON.parse(readFileSync(file, 'utf8'));
  }

  profile(userId, nickname) {
    if (this.profilesDB?.ok) return this.profilesDB.get(userId, nickname);
    // 降级：数据库不可用时退回 JSON 文件
    const file = join(this.profileDir, `${userId}.json`);
    const p = readJson(file, null);
    if (p) return p;
    const fresh = {
      userId: String(userId),
      nickname: nickname ?? String(userId),
      aliases: [],
      firstSeen: nowIso(),
      lastSeen: nowIso(),
      traits: [],
      facts: [],
      episodes: [],
      interactions: 0,
    };
    writeJson(file, fresh);
    return fresh;
  }

  saveProfile(p) {
    if (this.profilesDB?.ok) {
      this.profilesDB.save(p);
      return;
    }
    p.lastSeen = nowIso();
    writeJson(join(this.profileDir, `${p.userId}.json`), p);
  }

  /** 记忆页：所有联系人的摘要 */
  listProfiles() {
    if (this.profilesDB?.ok) return this.profilesDB.list();
    try {
      return readdirSync(this.profileDir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => {
          try {
            const p = JSON.parse(readFileSync(join(this.profileDir, f), 'utf8'));
            return {
              userId: p.userId,
              nickname: p.nickname,
              interactions: p.interactions ?? 0,
              traits: (p.traits ?? []).slice(0, 4),
              episodes: (p.episodes ?? []).length,
              lastSeen: p.lastSeen ?? null,
            };
          } catch {
            return null;
          }
        })
        .filter(Boolean)
        .sort((a, b) => String(b.lastSeen ?? '').localeCompare(String(a.lastSeen ?? '')));
    } catch {
      return [];
    }
  }

  readProfile(userId) {
    if (!/^\d+$/.test(String(userId))) throw new Error('非法 userId');
    if (this.profilesDB?.ok) return this.profilesDB.read(userId);
    return readJson(join(this.profileDir, `${userId}.json`), null);
  }

  deleteProfile(userId) {
    if (!/^\d+$/.test(String(userId))) throw new Error('非法 userId');
    if (this.profilesDB?.ok) return this.profilesDB.remove(userId);
    const file = join(this.profileDir, `${userId}.json`);
    if (existsSync(file)) rmSync(file);
    return true;
  }

  /** 新建一张角色卡（复制模板或空白） */
  createPersona({ file, from = 'persona/dafeiyu.json', name = '新角色' }) {
    if (!file || !/^persona\/[A-Za-z0-9_-]+\.json$/.test(file)) throw new Error('文件名只能是 persona/xxx.json');
    const target = join(this.dir, file);
    if (existsSync(target)) throw new Error('同名角色卡已存在');
    const base = readJson(join(this.dir, from), null);
    const data = base
      ? { ...base, id: file.replace(/^persona\//, '').replace(/\.json$/, ''), name }
      : {
          id: 'custom',
          name,
          version: 1,
          tagline: '',
          avatar: '',
          identity: '',
          personality: [],
          speech: { tone: '', habits: [], avoid: [], examples: [] },
          boundaries: [],
          proactive: { style: '', maxPerHour: 2, quietHours: '23:30-08:00' },
          taskMode: { whenAsked: '', howToReport: '' },
        };
    writeJson(target, data);
    return { file, data };
  }

  deletePersona(file) {
    if (!/^persona\/[A-Za-z0-9_-]+\.json$/.test(file)) throw new Error('非法路径');
    const active = this.cfg?.persona?.active;
    if (active === file) throw new Error('不能删除当前正在使用的角色卡');
    const target = join(this.dir, file);
    if (!existsSync(target)) throw new Error('文件不存在');
    rmSync(target);
    return true;
  }

  /**
   * 记一次交流。记忆不能完全押在"模型肯不肯输出 MEMO"上：
   * 无论有没有 memo，都本地记一条 episode 并累加互动次数。
   */
  rememberExchange(userId, nickname, { userText, replyText, memo = null, maxEpisodes = 40 }) {
    if (this.profilesDB?.ok) {
      return this.profilesDB.remember(userId, nickname, { userText, replyText, memo, maxEpisodes });
    }
    const p = this.profile(userId, nickname);
    if (memo) {
      if (Array.isArray(memo.traits)) {
        p.traits = Array.from(new Set([...(p.traits ?? []), ...memo.traits.map(String)])).slice(-12);
      }
      if (Array.isArray(memo.facts)) {
        p.facts = Array.from(new Set([...(p.facts ?? []), ...memo.facts.map(String)])).slice(-20);
      }
    }
    const episode = memo?.episode
      ? String(memo.episode).slice(0, 120)
      : `${String(userText ?? '').slice(0, 30)} → ${String(replyText ?? '').slice(0, 30)}`;
    p.episodes = [...(p.episodes ?? []), { at: nowIso(), text: episode }].slice(-maxEpisodes);
    p.interactions = (p.interactions ?? 0) + 1;
    this.saveProfile(p);
    return p;
  }
  applyMemo(userId, nickname, memo, maxEpisodes = 40) {
    const p = this.profile(userId, nickname);
    if (Array.isArray(memo.traits)) p.traits = Array.from(new Set([...(p.traits ?? []), ...memo.traits.map(String)])).slice(-12);
    if (Array.isArray(memo.facts)) p.facts = Array.from(new Set([...(p.facts ?? []), ...memo.facts.map(String)])).slice(-20);
    if (memo.episode) {
      p.episodes = [...(p.episodes ?? []), { at: nowIso(), text: String(memo.episode).slice(0, 120) }].slice(-maxEpisodes);
    }
    p.interactions = (p.interactions ?? 0) + 1;
    this.saveProfile(p);
    return p;
  }

  /** QQ 会话 → DSH sessionId 的映射，落在项目 data/ 下，方便跨实现复用 */
  bindings() {
    return readJson(join(this.dir, 'data', 'plugin-bindings.json'), {});
  }

  bind(chatKey, sessionId) {
    const all = this.bindings();
    all[chatKey] = { sessionId, updatedAt: nowIso() };
    writeJson(join(this.dir, 'data', 'plugin-bindings.json'), all);
    return all[chatKey];
  }

  unbind(chatKey) {
    const all = this.bindings();
    if (all[chatKey]) {
      delete all[chatKey];
      writeJson(join(this.dir, 'data', 'plugin-bindings.json'), all);
    }
    return true;
  }

  boundSession(chatKey) {
    return this.bindings()[chatKey]?.sessionId ?? null;
  }
}


