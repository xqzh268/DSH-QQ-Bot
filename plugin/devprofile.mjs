// 建一个"最小可启动"的开发 profile：只挂 dsh-base + dsh-web-app + dsh-qq。
// 部分桌面发行版的产品包只有 electron 宿主能解析，命令行起不来，
// 所以开发期用这个最小 profile 验证插件服务面；真实联调仍在桌面应用里做。
// 用法：node plugin/devprofile.mjs [profileName]  （默认 qqdev）
import { mkdirSync, writeFileSync, existsSync, cpSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveDshHome, writePluginProjectDir } from './dsh-env.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const name = process.argv[2] ?? 'qqdev';
const dshHome = resolveDshHome();
const dir = join(dshHome, 'profiles', name);

mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, 'cordis.yml'), '[]\n', 'utf8');
// 只在缺失时创建：否则会把已经写进去的 preset-qq 冲掉
if (!existsSync(join(dir, 'cordis.patch.yml'))) writeFileSync(join(dir, 'cordis.patch.yml'), '[]\n', 'utf8');
writeFileSync(
  join(dir, 'package.json'),
  JSON.stringify(
    {
      name: `dsh-profile-${name}`,
      private: true,
      type: 'module',
      dsh: {
        profile: {
          bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-qq'],
        },
      },
    },
    null,
    2,
  ),
  'utf8',
);

const dest = join(dir, 'node_modules', 'dsh-qq');
rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });
cpSync(join(here, 'dsh-qq'), dest, { recursive: true, filter: (p) => !p.includes('node_modules') });
writePluginProjectDir(dest, repoRoot);

console.log(`✓ 开发 profile 已就绪：${dir}`);
console.log('启动：');
console.log(`  dsh --profile ${name} --port 15200 --no-open`);
console.log(`  或设置 DSH_HOME=${dshHome} 后再启动桌面应用 / CLI`);
