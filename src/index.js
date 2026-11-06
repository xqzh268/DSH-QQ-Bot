// 入口：装配所有部件，把 NapCat 的事件接到大脑上。
import { loadConfig, auditConfig } from './config.js';
import { createLogger } from './log.js';
import { OneBot } from './onebot.js';
import { normalize } from './normalize.js';
import { Store } from './store.js';
import { Brain } from './brain.js';
import { loadPersona } from './prompt.js';
import { createHeadlessBackend, probeDsh } from './backend/headless.js';
import { createMockBackend } from './backend/mock.js';

const log = createLogger('main');
const args = new Set(process.argv.slice(2));

async function main() {
  const cfg = loadConfig();
  if (args.has('--mock')) cfg.backend.kind = 'mock';

  log.info('启动 DSH-QQ 桥接', {
    profile: cfg.backend.profile,
    backend: cfg.backend.kind,
    persona: cfg.persona.active,
  });

  for (const w of auditConfig(cfg)) log.warn(w);

  const persona = loadPersona(cfg.persona.active);
  log.info(`角色卡已加载：${persona.name} —— ${persona.tagline ?? ''}`);

  const store = new Store();
  const onebot = new OneBot(cfg);

  let backend;
  if (cfg.backend.kind === 'mock') {
    backend = createMockBackend();
  } else {
    const probe = probeDsh(cfg);
    if (!probe.ok) {
      log.error('DSH 入口不可用：', probe.detail);
      log.error('请在 config.json 的 backend.dshBin 填 dsh 命令行或 bin.js 的完整路径，或用 --mock 跑离线自检。');
      process.exit(1);
    }
    backend = createHeadlessBackend(cfg);
    log.info('DSH 入口：', probe.detail);
  }

  const brain = new Brain({ cfg, store, onebot, backend, persona });

  onebot.onEvent(async (raw) => {
    const event = normalize(raw, onebot.selfId || cfg.bot.selfId);
    if (!event) return;
    log.info('收到', { kind: event.kind, chat: event.chatKey, from: event.nickname, text: event.text.slice(0, 40) });
    await brain.handle(event);
  });

  await onebot.start();

  // 主动发言巡检：每 5 分钟看一次群里是不是静太久了
  const timer = cfg.proactive.enabled
    ? setInterval(() => void proactiveSweep(cfg, store, brain), 5 * 60 * 1000)
    : null;
  if (timer) log.info(`主动发言已开启：群静默 ${cfg.proactive.idleMinutes} 分钟后会考虑说话`);

  const shutdown = async (sig) => {
    log.info('收到退出信号', sig);
    if (timer) clearInterval(timer);
    await backend.close();
    await onebot.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

async function proactiveSweep(cfg, store, brain) {
  for (const groupId of cfg.access.groups) {
    const chatKey = `group:${groupId}`;
    const s = store.getSession(chatKey);
    const last = s?.lastUserAt ?? s?.createdAt ?? s?.updatedAt;
    if (!last) continue; // 没聊过就不主动开口
    const idleMin = (Date.now() - new Date(last).getTime()) / 60000;
    if (idleMin < (cfg.proactive.idleMinutes ?? 90)) continue;
    const lastPoke = store.lastProactive(chatKey);
    if (lastPoke && Date.now() - new Date(lastPoke).getTime() < 3600 * 1000) continue;
    log.info('群已静默，考虑主动发言', { chatKey, idleMin: Math.round(idleMin) });
    await brain.proactiveSay(groupId);
  }
}

main().catch((err) => {
  log.error('启动失败', err.stack ?? err.message);
  process.exit(1);
});
