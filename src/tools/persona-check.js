// 角色卡校验：字段完整性 + 类型 + 基础长度检查。改完人设跑一下再上线。
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../config.js';

const REQUIRED = ['id', 'name', 'identity', 'personality', 'speech', 'boundaries', 'proactive', 'taskMode'];
const SPEECH_KEYS = ['tone', 'habits', 'avoid', 'examples'];

const dir = join(ROOT, 'persona');
const files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
if (!files.length) {
  console.error('persona/ 下没有 .json 角色卡');
  process.exit(1);
}

let bad = 0;
for (const f of files) {
  const path = join(dir, f);
  const problems = [];
  let p;
  try {
    p = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    console.log(`✗ ${f}  JSON 解析失败：${err.message}`);
    bad += 1;
    continue;
  }
  for (const k of REQUIRED) if (!p[k]) problems.push(`缺字段 ${k}`);
  for (const k of SPEECH_KEYS) if (!p.speech?.[k]) problems.push(`speech.${k} 缺失`);
  if (p.personality && !Array.isArray(p.personality)) problems.push('personality 应为数组');
  if (p.speech?.examples && !Array.isArray(p.speech.examples)) problems.push('speech.examples 应为数组');
  if (p.identity && (p.identity.length < 60 || p.identity.length > 400)) {
    problems.push(`identity 长度 ${p.identity.length}，建议 60-400 字`);
  }
  if (p.name && p.name.length > 8) problems.push('name 太长，QQ 里不好叫');
  if (p.proactive && typeof p.proactive.maxPerHour !== 'number') problems.push('proactive.maxPerHour 应为数字');

  if (problems.length) {
    bad += 1;
    console.log(`✗ ${f}  ${problems.join('；')}`);
  } else {
    console.log(`✓ ${f}  ${p.name} —— ${p.tagline ?? ''}  (${p.identity.length} 字)`);
  }
}

console.log('');
if (bad) {
  console.log(`${bad} 个文件有问题`);
  process.exit(1);
}
console.log(`全部 ${files.length} 个角色卡可用`);
