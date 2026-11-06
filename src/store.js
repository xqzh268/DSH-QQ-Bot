// 记忆与状态落盘：会话映射、用户画像、主动发言记账。零依赖，JSON + 原子写。
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { ROOT } from './config.js';

// 允许自检脚本把数据写到临时目录，别污染真实画像
const DATA = process.env.QQ_BOT_DATA || join(ROOT, 'data');

function readJson(file, fallback) {
  try {
    if (!existsSync(file)) return fallback;
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  renameSync(tmp, file);
}

const nowIso = () => new Date().toISOString();

export class Store {
  constructor() {
    this.sessionsFile = join(DATA, 'sessions.json');
    this.stateFile = join(DATA, 'state.json');
    this.profileDir = join(DATA, 'profiles');
    this.sessions = readJson(this.sessionsFile, {});
    this.state = readJson(this.stateFile, { proactive: {}, counters: {} });
  }

  // ---------- 会话映射 ----------
  /** chatKey: 'private:123' | 'group:456' */
  getSession(chatKey) {
    return this.sessions[chatKey] ?? null;
  }

  setSession(chatKey, patch) {
    const prev = this.sessions[chatKey] ?? { chatKey, createdAt: nowIso() };
    this.sessions[chatKey] = { ...prev, ...patch, updatedAt: nowIso() };
    writeJson(this.sessionsFile, this.sessions);
    return this.sessions[chatKey];
  }

  touchSession(chatKey, who) {
    const s = this.sessions[chatKey];
    if (!s) return;
    if (who === 'bot') s.lastBotAt = nowIso();
    else s.lastUserAt = nowIso();
    writeJson(this.sessionsFile, this.sessions);
  }

  // ---------- 用户画像 ----------
  profilePath(userId) {
    return join(this.profileDir, `${userId}.json`);
  }

  getProfile(userId, nickname) {
    const p = readJson(this.profilePath(userId), null);
    if (p) {
      if (nickname && nickname !== p.nickname) {
        p.nickname = nickname;
        p.aliases = Array.from(new Set([...(p.aliases ?? []), nickname])).slice(-6);
        writeJson(this.profilePath(userId), p);
      }
      return p;
    }
    const fresh = {
      userId: String(userId),
      nickname: nickname ?? String(userId),
      aliases: [],
      firstSeen: nowIso(),
      lastSeen: nowIso(),
      // 画像正文由模型按轮次回写，这里只约定形状，不限制具体字段
      traits: [],
      facts: [],
      episodes: [],
      interactions: 0,
    };
    writeJson(this.profilePath(userId), fresh);
    return fresh;
  }

  saveProfile(profile) {
    profile.lastSeen = nowIso();
    writeJson(this.profilePath(profile.userId), profile);
  }

  appendEpisode(userId, text, at = nowIso()) {
    const p = this.getProfile(userId);
    p.episodes.push({ at, text });
    const cap = 40;
    if (p.episodes.length > cap) p.episodes = p.episodes.slice(-cap);
    p.interactions += 1;
    this.saveProfile(p);
    return p;
  }

  // ---------- 限流 ----------
  /** 简单的滑动窗口：key 维度计数，返回 true 表示允许 */
  allow(key, limit, windowMs) {
    const t = Date.now();
    const bucket = this.state.counters[key] ?? [];
    const alive = bucket.filter((ts) => t - ts < windowMs);
    if (alive.length >= limit) {
      this.state.counters[key] = alive;
      return false;
    }
    alive.push(t);
    this.state.counters[key] = alive;
    writeJson(this.stateFile, this.state);
    return true;
  }

  // ---------- 主动发言 ----------
  markProactive(chatKey) {
    this.state.proactive[chatKey] = nowIso();
    writeJson(this.stateFile, this.state);
  }

  lastProactive(chatKey) {
    return this.state.proactive[chatKey] ?? null;
  }
}

export default new Store();
