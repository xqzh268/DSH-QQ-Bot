/**
 * 解析 DeepSeek Harness 的 home 与 profile。
 *
 * 官方约定：$DSH_HOME > ~/.dsh。桌面发行版（含第三方壳）常把 home
 * 放在 %LOCALAPPDATA%/<app>/dsh，所以再扫一层作为回退，不绑定某一家产品。
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export function officialDshHome() {
  return join(homedir(), '.dsh');
}

function addHome(found, path) {
  if (!path) return;
  const abs = resolve(path);
  if (found.includes(abs)) return;
  const profiles = join(abs, 'profiles');
  try {
    if (existsSync(profiles) && statSync(profiles).isDirectory()) found.push(abs);
  } catch {
    /* 忽略无法访问的候选 */
  }
}

/** 机器上能看到的 DSH home 列表（已去重） */
export function discoverDshHomes() {
  const found = [];
  const env = process.env.DSH_HOME?.trim();
  if (env) addHome(found, env);
  addHome(found, officialDshHome());
  const local = process.env.LOCALAPPDATA?.trim();
  if (local && existsSync(local)) {
    try {
      for (const name of readdirSync(local)) addHome(found, join(local, name, 'dsh'));
    } catch {
      /* LOCALAPPDATA 列不出就跳过扫描 */
    }
  }
  return found;
}

export function listProfiles(dshHome) {
  const dir = join(dshHome, 'profiles');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => {
    if (name === 'node_modules' || name.startsWith('.')) return false;
    const pkgPath = join(dir, name, 'package.json');
    if (!existsSync(pkgPath)) return false;
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
      return Boolean(pkg?.dsh?.profile);
    } catch {
      return false;
    }
  });
}

function scoreHome(home) {
  const profiles = listProfiles(home);
  const desktop = profiles.filter((p) => /^desktop/i.test(p)).length;
  return desktop * 100 + profiles.length;
}

/**
 * 解析 DSH home。
 * 1) 显式 $DSH_HOME（即使目录还不存在，也尊重用户指定）
 * 2) 已发现的 home 里，优先带 desktop profile 的
 * 3) 官方默认 ~/.dsh
 */
export function resolveDshHome() {
  const env = process.env.DSH_HOME?.trim();
  if (env) return resolve(env);
  const homes = discoverDshHomes();
  if (homes.length === 1) return homes[0];
  if (homes.length > 1) {
    const ranked = [...homes].sort((a, b) => scoreHome(b) - scoreHome(a));
    return ranked[0];
  }
  return officialDshHome();
}

function pickDesktop(profiles) {
  if (profiles.includes('desktop')) return 'desktop';
  const desktop = profiles.filter((p) => /^desktop/i.test(p)).sort();
  if (desktop.length === 1) return desktop[0];
  if (desktop.length > 1) return desktop[desktop.length - 1];
  return null;
}

/**
 * 解析要安装到的 profile。
 * 优先：命令行参数 > 名为 desktop 的 > desktop* > 唯一的 profile。
 * 多个候选且无法判断时抛错，列出名字让用户指定。
 */
export function resolveProfileName(dshHome, requested) {
  if (requested) return requested;
  const profiles = listProfiles(dshHome);
  const desktop = pickDesktop(profiles);
  if (desktop) return desktop;
  if (profiles.length === 1) return profiles[0];
  if (profiles.length === 0) {
    throw new Error(
      `在 ${dshHome} 里没有找到 DSH profile。请先启动一次 DeepSeek Harness，或设置 DSH_HOME 后重试。`,
    );
  }
  throw new Error(
    `无法自动判断 profile，请显式传入名字。候选：${profiles.join(', ')}\n例如：node plugin/install.mjs ${profiles[0]}`,
  );
}

export function profileDir(dshHome, profileName) {
  return join(dshHome, 'profiles', profileName);
}

/** 安装时把数据目录写进插件副本，运行时就能找到 config/persona，而不依赖本机绝对路径硬编码。 */
export function writePluginProjectDir(pluginDest, projectDir) {
  writeFileSync(join(pluginDest, 'project.json'), `${JSON.stringify({ projectDir }, null, 2)}\n`, 'utf8');
}

/** 克隆 standard preset 时跳过产品壳的包名，避免 QQ 受限 preset 绑死某一家发行版。 */
export const PRODUCT_SCOPES = ['@eduwork/', '@ustc/', '@chatecnu-work/'];

export function isProductScoped(pluginName) {
  const name = String(pluginName ?? '');
  return PRODUCT_SCOPES.some((p) => name.startsWith(p));
}

/**
 * 在各 profile 的 node_modules 里找带 preset-standard 的 patch，不绑定某一家包名。
 * 返回 { plugins, source } 或 null。
 */
export function loadStandardPresetPlugins(dshHome) {
  const files = [];
  for (const name of listProfiles(dshHome)) {
    const nm = join(dshHome, 'profiles', name, 'node_modules');
    if (existsSync(nm)) {
      for (const ent of readdirSync(nm, { withFileTypes: true })) {
        if (ent.name.startsWith('@')) {
          const scopeDir = join(nm, ent.name);
          try {
            for (const sub of readdirSync(scopeDir, { withFileTypes: true })) {
              const f = join(scopeDir, sub.name, 'cordis.patch.yml');
              if (existsSync(f)) files.push(f);
            }
          } catch {
            /* 跳过 */
          }
        } else {
          const f = join(nm, ent.name, 'cordis.patch.yml');
          if (existsSync(f)) files.push(f);
        }
      }
    }
    const own = join(dshHome, 'profiles', name, 'cordis.patch.yml');
    if (existsSync(own)) files.push(own);
  }

  for (const file of files) {
    try {
      const raw = readFileSync(file, 'utf8');
      const entries = JSON.parse(raw);
      if (!Array.isArray(entries)) continue;
      const std = entries.find((e) => e?.id === 'preset-standard' && e?.config?.plugins);
      if (std) return { plugins: std.config.plugins, source: file };
    } catch {
      /* 不是 JSON 的 YAML patch 跳过 */
    }
  }
  return null;
}

/** 找不到宿主 standard preset 时的通用回退：只用官方 @deepseek-ai 包。 */
export function genericQqPresetPlugins() {
  return [
    {
      id: 'persona',
      name: '@deepseek-ai/dsh-persona',
      config: {
        prefix: 'You are a chat partner living in a QQ group, powered by DeepSeek Harness.',
      },
    },
    {
      id: 'agent-instructions',
      name: '@deepseek-ai/dsh-agent-instructions',
      config: { maxBytes: 65536 },
    },
    { id: 'time-context', name: '@deepseek-ai/dsh-time-context' },
    { id: 'tool-fs', name: '@deepseek-ai/dsh-tool-fs' },
    {
      id: 'tool-fs-search',
      name: '@deepseek-ai/dsh-tool-fs-search',
      config: { sampleOverCapGlobResults: false },
    },
    {
      id: 'compaction',
      name: 'cordis:group',
      group: true,
      isolate: { compaction: true, toolResultPruner: true },
      config: [
        { id: 'compaction-basic', name: '@deepseek-ai/dsh-compaction-basic' },
        { id: 'command-compact', name: '@deepseek-ai/dsh-command-compact' },
        {
          id: 'tool-result-pruner',
          name: '@deepseek-ai/dsh-compaction-tool-result-pruner',
          config: { thresholdChars: 8192, headChars: 4096, tailChars: 1024 },
        },
      ],
    },
    {
      id: 'tool-todo',
      name: '@deepseek-ai/dsh-tool-todo',
      config: { allowParallelInProgress: false },
    },
    {
      id: 'tool-web',
      name: '@deepseek-ai/dsh-tool-web',
      config: { fetch: true, searchTimeoutMs: 60000 },
    },
  ];
}
