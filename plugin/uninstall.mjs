/**
 * 从目标 profile 里彻底卸掉 dsh-qq：bundle 注册、插件文件、受限 preset 全清。
 * 万一插件让应用起不来，先跑这个再启动。
 *
 * 用法：
 *   node plugin/uninstall.mjs
 *   node plugin/uninstall.mjs <profileName>
 */
import { existsSync, readFileSync, writeFileSync, rmSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveDshHome, resolveProfileName, profileDir } from './dsh-env.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const requestedProfile = process.argv[2];

let dshHome;
let profileName;
let destProfile;
try {
  dshHome = resolveDshHome();
  profileName = resolveProfileName(dshHome, requestedProfile);
  destProfile = profileDir(dshHome, profileName);
} catch (err) {
  console.error(err.message ?? err);
  process.exit(1);
}

if (!existsSync(destProfile)) {
  console.error(`找不到 profile：${destProfile}`);
  process.exit(1);
}

const stamp = Date.now();
const results = [];

// 1) bundle 注册
const pkgPath = join(destProfile, 'package.json');
if (existsSync(pkgPath)) {
  copyFileSync(pkgPath, `${pkgPath}.bak-${stamp}`);
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  const bundles = pkg?.dsh?.profile?.bundles;
  if (Array.isArray(bundles) && bundles.includes('dsh-qq')) {
    pkg.dsh.profile.bundles = bundles.filter((b) => b !== 'dsh-qq');
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2), 'utf8');
    results.push('已从 bundles 移除 dsh-qq');
  } else {
    results.push('bundles 里本来就没有 dsh-qq');
  }
}

// 2) 插件文件
const pluginDir = join(destProfile, 'node_modules', 'dsh-qq');
if (existsSync(pluginDir)) {
  rmSync(pluginDir, { recursive: true, force: true });
  results.push('已删除 node_modules/dsh-qq');
}

// 3) 受限 preset
const patchPath = join(destProfile, 'cordis.patch.yml');
if (existsSync(patchPath)) {
  copyFileSync(patchPath, `${patchPath}.bak-${stamp}`);
  try {
    const raw = readFileSync(patchPath, 'utf8').trim();
    const entries = raw === '' || raw === '[]' ? [] : JSON.parse(raw);
    const cleaned = entries
      .filter((e) => e?.id !== 'preset-qq' || e?.insert)
      .map((e) => (Array.isArray(e?.insert) ? { ...e, insert: e.insert.filter((i) => i?.id !== 'preset-qq') } : e))
      .filter((e) => !(Array.isArray(e?.insert) && e.insert.length === 0));
    if (cleaned.length !== entries.length || JSON.stringify(cleaned) !== JSON.stringify(entries)) {
      writeFileSync(patchPath, JSON.stringify(cleaned, null, 2), 'utf8');
      results.push('已移除 preset-qq');
    } else {
      results.push('patch 里没有 preset-qq');
    }
  } catch (err) {
    results.push(`patch 解析失败（未改动）：${err.message}`);
  }
}

console.log(`DSH_HOME: ${dshHome}`);
console.log(`profile:  ${profileName}`);
for (const r of results) console.log(`  · ${r}`);
console.log(`\n备份后缀：.bak-${stamp}`);
console.log('现在可以正常启动应用了。');
console.log(`卸载脚本：${join(here, 'uninstall.mjs')}`);
