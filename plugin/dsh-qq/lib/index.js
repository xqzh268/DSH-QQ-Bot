/**
 * dsh-qq 插件入口。
 *
 * 铁律（实测代价换来）：apply() 绝不能抛。cordis 把 profile bundle 当必需件，
 * 一个抛错会把整个桌面应用启动搞挂。所以这里所有工作都扔进异步任务，
 * 失败只写日志，永远返回一个可用的 dispose。
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OneBot, normalize } from './onebot.js';
import { Brain } from './brain.js';
import { ProjectStore } from './persona.js';
import { installToolGuard } from './guard.js';
import { installApi } from './api.js';
import { createFileLog } from './pluglog.js';
import { Ambient } from './ambient.js';
import { Social } from './social.js';
import { GroupMemory } from './groupmem.js';

export const name = 'dsh-qq';
export const inject = [];

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** GitHub / 插件管理器安装时包根在 plugin/dsh-qq 的上两级；本地复制安装则没有这份布局。 */
function findPackageRoot() {
  const repo = join(PLUGIN_ROOT, '..', '..');
  if (existsSync(join(repo, 'config.example.json')) && existsSync(join(repo, 'persona'))) return repo;
  return PLUGIN_ROOT;
}

/** 数据目录：插件配置 > DSH_QQ_HOME > 安装器写入的 project.json > $DSH_HOME/dsh-qq > ~/.dsh/dsh-qq */
export function resolveProjectDir(rawConfig = {}) {
  if (rawConfig.projectDir) return rawConfig.projectDir;
  const fromEnv = process.env.DSH_QQ_HOME?.trim();
  if (fromEnv) return fromEnv;
  try {
    const marker = join(PLUGIN_ROOT, 'project.json');
    if (existsSync(marker)) {
      const bundled = JSON.parse(readFileSync(marker, 'utf8'));
      if (bundled?.projectDir) return bundled.projectDir;
    }
  } catch {
    /* 忽略损坏的 project.json */
  }
  const dshHome = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh');
  return join(dshHome, 'dsh-qq');
}

/** 从 Git 安装时数据目录是空的，把示例配置和角色卡拷过去。已有文件不覆盖。 */
export function seedProjectDir(projectDir, log = () => {}) {
  try {
    mkdirSync(projectDir, { recursive: true });
    const src = findPackageRoot();
    const example = join(src, 'config.example.json');
    const cfg = join(projectDir, 'config.json');
    if (!existsSync(cfg) && existsSync(example)) {
      copyFileSync(example, cfg);
      log('已创建 config.json，请在 QQ 面板里填入 OneBot token 和 QQ 号');
    }
    const personaSrc = join(src, 'persona');
    const personaDest = join(projectDir, 'persona');
    if (existsSync(personaSrc)) {
      mkdirSync(personaDest, { recursive: true });
      for (const name of readdirSync(personaSrc)) {
        if (!name.endsWith('.json')) continue;
        const dest = join(personaDest, name);
        if (!existsSync(dest)) copyFileSync(join(personaSrc, name), dest);
      }
    }
    mkdirSync(join(projectDir, 'qq-sandbox'), { recursive: true });
  } catch (err) {
    log('初始化数据目录失败:', err?.message ?? err);
  }
}

export function apply(ctx, rawConfig = {}) {
  const tag = '[dsh-qq]';
  const config = typeof rawConfig === 'object' && rawConfig ? rawConfig : {};
  const projectDir = resolveProjectDir(config);
  const fileLog = createFileLog(projectDir);
  const log = (...args) => {
    try {
      console.log(tag, ...args);
    } catch {}
    fileLog(tag, ...args);
  };
  seedProjectDir(projectDir, log);
  log('数据目录', projectDir);
  let onebot = null;
  let disposed = false;
  let bootTimer = null;
  let apiTimer = null;
  let apiDone = false;
  let apiStarted = 0;
  let brainAmbient = null;

  async function boot() {
    // 1) 等宿主把服务挂起来（cordis 按依赖顺序装配，apply 时还拿不到）
    const agents = await waitForService(ctx, 'agents', 60000);
    if (!agents) {
      log('60 秒内没等到 agents 服务，QQ 通道不启动');
      return;
    }
    log('agents 服务就绪');

    // 2) 项目数据与角色卡
    const store = new ProjectStore(projectDir);
    const cfg = store.cfg ?? {};
    const obCfg = cfg.onebot ?? {};
    const pluginCfg = cfg.plugin ?? {};

    // 3) OneBot 通道
    onebot = new OneBot({
      host: obCfg.listenHost ?? '127.0.0.1',
      port: pluginCfg.onebotPort ?? obCfg.listenPort ?? 7800,
      path: obCfg.path ?? '/onebot',
      token: obCfg.token ?? '',
      log: (...a) => log(...a),
    });

    // 4) 大脑
    const brain = new Brain({ ctx, onebot, store, log });
    try {
      brain.init({ agents });
    } catch (err) {
      log('角色卡加载失败，QQ 通道不启动:', err?.message ?? err);
      return;
    }

    // 4.5) 安全闸：配了受限 preset 却不存在时，宁可不启动，
    //      也不要让 QQ 会话落到默认 preset（可能带 shell）。
    const wantedPreset = pluginCfg.agentPreset;
    if (wantedPreset) {
      const presets = ctx.get('agentPresets');
      let known;
      try {
        if (typeof presets?.get === 'function') known = Boolean(presets.get(wantedPreset));
        else if (typeof presets?.list === 'function') {
          const list = presets.list();
          known = Array.isArray(list) ? list.some((p) => (p?.id ?? p) === wantedPreset) : undefined;
        }
      } catch (err) {
        log('preset 探测失败（按未知处理）:', err?.message ?? err);
      }
      if (known === false) {
        log(`配置的 preset "${wantedPreset}" 不存在，为避免用带 shell 的默认 preset，QQ 通道不启动。`);
        log('请确认 profile 的 cordis.patch.yml 里写入了 preset-qq，然后重启应用。');
        return;
      }
      log(`preset 检查：${wantedPreset} ${known === true ? '已注册' : '（无法确认，按存在处理）'}`);
    }

    // 4.6) 工具白名单闸：profile 的产品 bundle 在宿主层挂工具，preset 拿不掉，
    //      只能在派发层按 agent 拦。没有这道闸，她在 QQ 里等于有 mail/wechat/terminal。
    installToolGuard(ctx, brain, log);

    // 4.7) 设置页接口（带连接围栏；拿不到围栏就不注册）
    //      webServer/connection 往往比 agents 挂得晚，所以这里带重试。
    brain.onebot = onebot;
    const tryApi = () => {
      if (disposed || apiDone) return;
      try {
        if (installApi(ctx, { store, brain, log })) {
          apiDone = true;
          return;
        }
      } catch (err) {
        log('设置接口安装异常:', err?.message ?? err);
      }
      if (disposed) return;
      if (Date.now() - apiStarted < 120000) apiTimer = setTimeout(tryApi, 3000);
      else log('设置接口：重试超时，放弃');
    };
    apiStarted = Date.now();
    tryApi();

    // 5) 群消息缓冲 + 主动发言
    const ambient = new Ambient({ brain, store, log });
    brain.ambient = ambient;
    brain.recent = (chatKey) => ambient.recent(chatKey);
    ambient.start();
    brainAmbient = ambient;

    // 5.5) 轻量社交动作（复读 / 表情回应 / 戳回去）与群级记忆
    const social = new Social({ brain, ambient, onebot, log });
    brain.social = social;
    brain.groupMemory = new GroupMemory({ brain, db: ambient.db, log });
    ambient.groupMemory = brain.groupMemory;

    // 6) 事件 → 大脑
    onebot.onEvent((raw) => {
      const event = normalize(raw, onebot.selfId || cfg.bot?.selfId || '');
      if (!event) return;
      // 有人引用了她发过的消息：等同于 @ 她
      if (event.replyId && onebot.isMine(event.replyId)) {
        event.replyToMe = true;
        event.atMe = true;
      }
      log('收到', event.kind, event.chatKey, event.nickname, event.text.slice(0, 30));
      if (event.kind === 'group') ambient.note(event);
      brain
        .handle(event)
        .then(async (out) => {
          // 没接这条（没被 @、或不满足触发条件）时，依次考虑：复读 → 表情回应 → 主动插一句
          if (out || event.kind !== 'group') return out;
          if (await social.maybeRepeat(event)) return null;
          social.maybeReact(event).catch(() => {});
          return ambient.maybeChime(event);
        })
        .catch((err) => log('处理异常:', err?.message ?? err));
    });

    await onebot.start();
    if (disposed) await onebot.close();
    log('就绪');
  }

  // 异步启动，不阻塞宿主启动流程
  boot().catch((err) => log('启动失败:', err?.message ?? err));

  return () => {
    disposed = true;
    if (bootTimer) clearTimeout(bootTimer);
    if (apiTimer) clearTimeout(apiTimer);
    try {
      brainAmbient?.stop?.();
    } catch {}
    try {
      onebot?.close?.();
    } catch {}
    log('disposed');
  };
}

/** 轮询等一个服务出现（cordis 的 ctx.get 在服务未挂载时返回 undefined） */
function waitForService(ctx, name, timeoutMs) {
  return new Promise((resolve) => {
    const started = Date.now();
    const tick = () => {
      try {
        const value = ctx.get(name);
        if (value) return resolve(value);
      } catch {
        /* 服务代理可能抛错，忽略继续等 */
      }
      if (Date.now() - started > timeoutMs) return resolve(null);
      setTimeout(tick, 500);
    };
    tick();
  });
}
