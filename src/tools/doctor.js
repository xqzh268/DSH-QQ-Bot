// 体检工具：配置、角色卡、DSH 入口、凭据，一次说清楚哪里不对。
// 用法：node src/tools/doctor.js [--live]
//   --live 会真的跑一轮 DSH（会消耗额度），用来验证凭据和链路
import { existsSync, readdirSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, auditConfig, ROOT } from '../config.js';
import { loadPersona } from '../prompt.js';
import { probeDsh } from '../backend/headless.js';

const live = process.argv.includes('--live');
const ok = (m) => console.log(`  ✓ ${m}`);
const warn = (m) => console.log(`  ! ${m}`);
const bad = (m) => console.log(`  ✗ ${m}`);

console.log('\n== 配置 ==');
let cfg;
try {
  cfg = loadConfig();
  ok('config.json 可解析');
} catch (err) {
  bad(err.message);
  process.exit(1);
}
if (!existsSync(join(ROOT, 'config.json'))) warn('还没有 config.json，正在用内置默认值（复制 config.example.json 开始改）');
console.log(`    OneBot 监听：ws://${cfg.onebot.listenHost}:${cfg.onebot.listenPort}${cfg.onebot.path}`);
console.log(`    token：${cfg.onebot.token ? '已设置' : '(空)'}`);
console.log(`    后端：${cfg.backend.kind} / profile=${cfg.backend.profile}`);
console.log(`    小号：${cfg.bot.selfId || '(空，会在收到第一条事件后自动识别)'}   主人：${cfg.bot.ownerId || '(空)'}`);
console.log(`    白名单群：${cfg.access.groups.length ? cfg.access.groups.join(', ') : '(空=所有群)'}`);

console.log('\n== 角色卡 ==');
try {
  const p = loadPersona(cfg.persona.active);
  ok(`${p.name} —— ${p.tagline ?? ''}`);
} catch (err) {
  bad(err.message);
}
try {
  const list = readdirSync(join(ROOT, 'persona')).filter((f) => f.endsWith('.json'));
  console.log(`    可选角色卡 ${list.length} 个：${list.join('、')}`);
} catch {
  bad('persona/ 目录不存在');
}

console.log('\n== 数据目录 ==');
try {
  const dir = join(ROOT, 'data');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '.doctor'), 'ok');
  rmSync(join(dir, '.doctor'));
  ok('data/ 可写');
} catch (err) {
  bad(`data/ 不可写：${err.message}`);
}

console.log('\n== DSH ==');
const probe = probeDsh(cfg);
if (probe.ok) ok(`入口可用：${probe.detail}`);
else bad(`入口不可用：${probe.detail}`);

const keyReady = Boolean(cfg.backend.env?.DEEPSEEK_API_KEY || process.env.DEEPSEEK_API_KEY);
if (cfg.backend.kind === 'headless') {
  if (keyReady) ok('DEEPSEEK_API_KEY 已提供给子进程');
  else warn('没有 DEEPSEEK_API_KEY：headless 会报 MISSING_CREDENTIAL（桌面端登录的凭据不会传给子进程）');
}

for (const w of auditConfig(cfg)) warn(w);

if (live) {
  console.log('\n== 实测一轮（会消耗额度）==');
  const { createHeadlessBackend } = await import('../backend/headless.js');
  const backend = createHeadlessBackend(cfg);
  const r = await backend.run({
    prompt: '请只回复两个字：收到',
    userText: '测试',
    nickname: 'doctor',
    personaName: 'doctor',
    sessionId: null,
  });
  if (r.error) {
    bad(`调用失败：${r.error}`);
    if (String(r.error).includes('MISSING_CREDENTIAL')) {
      console.log('    解决：在 config.json 的 backend.env.DEEPSEEK_API_KEY 填一个 DeepSeek API key，');
      console.log('          或者把后端改成跑在桌面宿主里（需要另做，见 README「凭据问题」）。');
    }
  } else {
    ok(`模型回答：${r.text.slice(0, 60)}`);
    ok(`会话 id：${r.sessionId}（耗时 ${r.took}ms）`);
  }
  await backend.close();
}

console.log('');
