// 静态检查：插件里用到的内置函数/模块，是否都 import 了。
// 起因：api.js 用了 readFileSync 却没导入，运行期抛错被 catch 吞掉，页面显示破图。
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const dir = 'plugin/dsh-qq/lib';
const files = readdirSync(dir).filter((f) => f.endsWith('.js'));

// 需要被 import 的名字 → 来源（只用于提示）
const WATCH = [
  'readFileSync',
  'writeFileSync',
  'mkdirSync',
  'existsSync',
  'rmSync',
  'readdirSync',
  'appendFileSync',
  'statSync',
  'renameSync',
  'join',
  'dirname',
  'randomUUID',
  'createHash',
  'createServer',
  'DatabaseSync',
  'basename',
];

let bad = 0;
for (const file of files) {
  const src = readFileSync(join(dir, file), 'utf8');
  // 去掉 import 行，剩下的才是"使用处"
  const body = src
    .split('\n')
    .filter((l) => !/^\s*import\s/.test(l))
    .join('\n');
  const importLines = src
    .split('\n')
    .filter((l) => /^\s*import\s/.test(l))
    .join('\n');

  const missing = [];
  for (const name of WATCH) {
    const used = new RegExp(`(?<![.\\w])${name}\\s*\\(`).test(body);
    if (!used) continue;
    const imported = new RegExp(`\\b${name}\\b`).test(importLines);
    if (!imported) missing.push(name);
  }
  if (missing.length) {
    bad += 1;
    console.log(`✗ ${file}: 用了但没导入 → ${missing.join(', ')}`);
  } else {
    console.log(`✓ ${file}`);
  }
}

console.log('');
if (bad) {
  console.log(`✗ ${bad} 个文件有缺失导入`);
  process.exit(1);
}
console.log('✓ 导入完整性检查通过');


