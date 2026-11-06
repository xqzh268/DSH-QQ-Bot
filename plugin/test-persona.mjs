// 角色卡管理自测：新建（复制）/ 列表 / 删除 / 非法路径拒绝
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectStore } from './dsh-qq/lib/persona.js';

const safeRm = (dir) => {
  try {
    safeRm(dir);
  } catch {
    /* Windows 上数据库连接未关时删不掉，忽略 */
  }
};

let bad = 0;
const ok = (m) => console.log(`  ✓ ${m}`);
const no = (m, d = '') => {
  console.log(`  ✗ ${m}${d ? ` —— ${d}` : ''}`);
  bad += 1;
};

const dir = mkdtempSync(join(tmpdir(), 'qqpersona-'));
try {
  mkdirSync(join(dir, 'persona'), { recursive: true });
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ persona: { active: 'persona/01-warm.json' } }));
  writeFileSync(
    join(dir, 'persona', '01-warm.json'),
    JSON.stringify({ id: 'warm', name: '阿棠', tagline: '测试', identity: 'x', speech: { tone: 't' } }),
  );

  const store = new ProjectStore(dir);

  const before = store.listPersonas();
  before.length === 1 && before[0].name === '阿棠' ? ok('列出已有角色卡') : no('列表', JSON.stringify(before));

  const created = store.createPersona({ file: 'persona/custom-abc.json', from: 'persona/01-warm.json', name: '阿棠·副本' });
  created.data.name === '阿棠·副本' && created.data.id === 'custom-abc'
    ? ok('复制新建：名字与 id 正确')
    : no('复制新建', JSON.stringify(created.data));

  existsSync(join(dir, 'persona', 'custom-abc.json')) ? ok('新文件已落盘') : no('文件未落盘');
  store.listPersonas().length === 2 ? ok('列表变 2 张') : no('列表数量');

  // 同名再建要报错
  let err = null;
  try {
    store.createPersona({ file: 'persona/custom-abc.json', from: 'persona/01-warm.json', name: 'x' });
  } catch (e) {
    err = e;
  }
  err ? ok('同名重复创建被拒绝') : no('同名没有被拒绝');

  // 删除正在使用的角色卡要报错
  let err2 = null;
  try {
    store.deletePersona('persona/01-warm.json');
  } catch (e) {
    err2 = e;
  }
  err2 ? ok('禁止删除当前使用的角色卡') : no('删除了正在使用的卡');

  store.deletePersona('persona/custom-abc.json');
  store.listPersonas().length === 1 ? ok('删除生效') : no('删除未生效');

  // 非法路径
  let err3 = null;
  try {
    store.createPersona({ file: '../../evil.json', from: 'persona/01-warm.json', name: 'x' });
  } catch (e) {
    err3 = e;
  }
  err3 ? ok('拒绝路径穿越') : no('路径穿越没有被拒绝');
} finally {
  safeRm(dir);
}

console.log('');
if (bad) {
  console.log(`✗ ${bad} 项失败`);
  process.exit(1);
}
console.log('✓ 角色卡管理验证通过');
