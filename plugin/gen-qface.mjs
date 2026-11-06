// 从 NapCat 打包文件里抽出 QQ 系统表情表（napcat.mjs 里 sysface 那一大段 JSON），生成 plugin/dsh-qq/data/qface.json。
// NapCat 发 face 消息段时只认这张表里的 id（不在表里会报"不支持的ID"），所以以它为准。
// 用法：node plugin/gen-qface.mjs [napcat.mjs 路径]   （NapCat 升级后重跑一次）
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = process.argv[2] ?? join(here, '..', 'NapCat.Shell.Windows.Node', 'napcat', 'napcat.mjs');
const text = readFileSync(src, 'utf8');
// 表在一行里：const xxx = /* @__PURE__ */ JSON.parse('[{"QSid":"392","QDes":"/龙年快乐",...}]');
const m = text.match(/JSON\.parse\('(\[\{"QSid":"\d+","QDes":"[^\n]*?\}\])'\)/);
if (!m) {
  console.error('没找到表情表（NapCat 版本变了？）');
  process.exit(1);
}
const raw = JSON.parse(m[1]);
const faces = raw
  .filter((x) => /^\d+$/.test(String(x.QSid)) && typeof x.QDes === 'string' && x.QDes.startsWith('/'))
  .map((x) => ({ id: Number(x.QSid), name: x.QDes.slice(1), hidden: x.QHide === '1' || x.QHide === 1, ani: Boolean(x.AniStickerType) }));
const out = join(here, 'dsh-qq', 'data', 'qface.json');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(faces)}\n`);
console.log(`✓ ${faces.length} 个表情（其中隐藏 ${faces.filter((f) => f.hidden).length}）→ ${out}`);
