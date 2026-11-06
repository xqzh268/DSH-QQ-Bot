// 配置加载：config.json + 环境变量覆盖。零依赖。
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const DEFAULTS = {
  // ---- OneBot / NapCat ----
  onebot: {
    // NapCat 反向 WebSocket 监听在本机这个地址上；我们作为 WS 服务端等它连过来。
    listenHost: '127.0.0.1',
    listenPort: 7800,
    path: '/onebot',
    // 必须和 NapCat 里配置的 token 一致，为空表示不校验（仅本机测试时用）。
    token: '',
  },

  // ---- 身份 ----
  bot: {
    // bot 小号自己的 QQ 号，用来识别"@我"和被自己消息回环
    selfId: '',
    // 主人 QQ 号：可私聊下达管理命令
    ownerId: '',
  },

  // ---- 谁可以和她说话 ----
  access: {
    // 空数组 = 不限制。上线前务必填上你自己的群和 QQ 号。
    groups: [],
    users: [],
    // 群里的响应方式：at = 只有被 @ 才说话；always = 每条都回；smart = 被 @ 或命中关键词
    groupTrigger: 'at',
    keywords: ['在吗', '你怎么看', '帮我看', '求助'],
    // 私聊默认都回
    replyPrivate: true,
  },

  // ---- 人设与记忆 ----
  persona: {
    active: 'persona/dafeiyu.json',
  },
  memory: {
    // 每个用户画像的滚动摘要保留多少条
    maxEpisodes: 40,
    // 每轮结束后是否让模型回写画像（需要后端支持，mock 后端忽略）
    updateProfile: true,
  },

  // ---- 主动发言 ----
  proactive: {
    enabled: true,
    // 群里静默超过多少分钟，可以考虑插一句
    idleMinutes: 90,
    // 每小时最多主动发言次数（全局，防刷屏）
    maxPerHour: 2,
    // 免打扰时段，跨零点写法如 '23:30-08:00'
    quietHours: [],
  },

  // ---- 后端 ----
  backend: {
    // headless = 调 `dsh --profile headless --json`；mock = 假回答，用于自检
    kind: 'headless',
    dshBin: 'dsh',
    profile: 'headless',
    // 单轮超时（毫秒）
    timeoutMs: 180000,
    // 同时最多几个 DSH 会话在跑
    concurrency: 2,
    // 传给子进程的环境变量（例如 DEEPSEEK_API_KEY）
    env: {},
  },

  // ---- 防御 ----
  limits: {
    // 同一个人多少秒内不重复触发
    perUserCooldownSec: 5,
    // 每小时每群最多回多少条
    perGroupPerHour: 60,
    // 单条回复最大字符数，超出按 QQ 习惯切分
    maxReplyChars: 600,
  },
};

function deepMerge(base, extra) {
  if (Array.isArray(base) || Array.isArray(extra)) return extra ?? base;
  if (typeof base !== 'object' || base === null) return extra ?? base;
  if (typeof extra !== 'object' || extra === null) return base;
  const out = { ...base };
  for (const [k, v] of Object.entries(extra)) out[k] = deepMerge(base[k], v);
  return out;
}

export function loadConfig() {
  const file = join(ROOT, 'config.json');
  let user = {};
  if (existsSync(file)) {
    try {
      user = JSON.parse(readFileSync(file, 'utf8'));
    } catch (err) {
      throw new Error(`config.json 解析失败：${err.message}`);
    }
  }
  const cfg = deepMerge(DEFAULTS, user);

  // 环境变量覆盖（方便用 systemd / 计划任务注入秘密）
  const env = process.env;
  if (env.QQ_BOT_TOKEN) cfg.onebot.token = env.QQ_BOT_TOKEN;
  if (env.QQ_BOT_PORT) cfg.onebot.listenPort = Number(env.QQ_BOT_PORT);
  if (env.QQ_BOT_SELF_ID) cfg.bot.selfId = String(env.QQ_BOT_SELF_ID);
  if (env.QQ_BOT_OWNER_ID) cfg.bot.ownerId = String(env.QQ_BOT_OWNER_ID);
  if (env.QQ_BOT_COOLDOWN !== undefined) cfg.limits.perUserCooldownSec = Number(env.QQ_BOT_COOLDOWN);
  if (env.DEEPSEEK_API_KEY && !cfg.backend.env.DEEPSEEK_API_KEY) {
    cfg.backend.env.DEEPSEEK_API_KEY = env.DEEPSEEK_API_KEY;
  }

  return cfg;
}

/** 启动前自检：返回一串人类可读的警告，不阻塞启动，但会打印出来。 */
export function auditConfig(cfg) {
  const warn = [];
  if (!cfg.bot.selfId) warn.push('bot.selfId 未填：将无法判断"@我"，请在 NapCat 登录后填入小号 QQ 号。');
  if (!cfg.onebot.token) warn.push('onebot.token 为空：任何本机进程都能冒充 NapCat 推送消息，上线前请设置。');
  if (!cfg.access.groups.length) warn.push('access.groups 为空：所有群都能驱动她，建议至少填上你自己的群号。');
  if (!cfg.access.users.length) warn.push('access.users 为空：所有人（含陌生人私聊）都能和她说话。');
  if (cfg.backend.kind === 'headless' && !cfg.backend.env.DEEPSEEK_API_KEY && !process.env.DEEPSEEK_API_KEY) {
    warn.push('backend.env.DEEPSEEK_API_KEY 未设置：headless 后端可能报 MISSING_CREDENTIAL。');
  }
  return warn;
}
