// 把 plugin/dsh-qq 安装到指定 DSH profile：
//   1) 复制插件到 <profile>/node_modules/dsh-qq
//   2) 把 'dsh-qq' 加进 <profile>/package.json 的 dsh.profile.bundles
//   3) 写入受限 preset（调用 set-preset.mjs）
//   4) 把本仓库路径写入插件副本的 project.json，作为 config / 人设 / 记忆的数据目录
// 幂等，可反复执行。卸载用 uninstall.mjs。
// 用法：
//   node plugin/install.mjs                  自动检测 DSH_HOME 与 desktop profile
//   node plugin/install.mjs <profileName>
//   DSH_HOME=... node plugin/install.mjs <profileName>
import { cpSync, existsSync, readFileSync, writeFileSync, rmSync, mkdirSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { resolveDshHome, resolveProfileName, profileDir, writePluginProjectDir } from './dsh-env.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const src = join(here, 'dsh-qq');
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
  console.error('请先启动一次 DeepSeek Harness，或用 DSH_HOME / 参数指定正确的 home 与 profile。');
  process.exit(1);
}

const projectDir = process.env.DSH_QQ_HOME?.trim() || repoRoot;

// 1) 复制插件
const dest = join(destProfile, 'node_modules', 'dsh-qq');
rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });
cpSync(src, dest, { recursive: true, filter: (p) => !p.includes('node_modules') });
writePluginProjectDir(dest, projectDir);
console.log(`✓ 插件已复制到 ${dest}`);
console.log(`✓ 数据目录：${projectDir}`);

if (!existsSync(join(projectDir, 'config.json')) && existsSync(join(projectDir, 'config.example.json'))) {
  copyFileSync(join(projectDir, 'config.example.json'), join(projectDir, 'config.json'));
  console.log('✓ 已从 config.example.json 创建 config.json，请填入 OneBot token 和 QQ 号');
}

// 2) 注册 bundle
const pkgPath = join(destProfile, 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
pkg.dsh ??= {};
pkg.dsh.profile ??= {};
pkg.dsh.profile.bundles ??= [];
if (!pkg.dsh.profile.bundles.includes('dsh-qq')) {
  pkg.dsh.profile.bundles.push('dsh-qq');
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2), 'utf8');
  console.log(`✓ 已把 dsh-qq 加入 ${profileName} 的 bundles`);
} else {
  console.log('· bundles 里已经有 dsh-qq');
}

// 3) 受限 preset
const preset = spawnSync(process.execPath, [join(here, 'set-preset.mjs'), profileName], {
  stdio: 'inherit',
  env: process.env,
});
if (preset.status !== 0) {
  console.warn('⚠ preset 写入失败，QQ 会话将使用宿主默认 preset（可能带 shell 工具）');
}

console.log('\n完成。');
console.log(`DSH_HOME: ${dshHome}`);
console.log(`profile:  ${profileName}`);
console.log('接下来：重启 DeepSeek Harness 桌面应用');
console.log('启动后看日志里是否有：  [dsh-qq] 就绪');
console.log('\n出问题就用这条一键卸掉：');
console.log(`  node "${join(here, 'uninstall.mjs')}" ${profileName}`);
