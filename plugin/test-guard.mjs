// 工具闸自测：白名单 + 文件路径 confinement（主人私聊除外，表情包目录只读例外）
import { installToolGuard, isInsideRoot, findOutsidePath } from './dsh-qq/lib/guard.js';

let bad = 0;
const ok = (m) => console.log(`  ✓ ${m}`);
const no = (m, d = '') => {
  console.log(`  ✗ ${m}${d ? ` —— ${d}` : ''}`);
  bad += 1;
};

const WS = 'D:\\Workspace\\Projects\\Deepseek-Bot\\qq-sandbox';
const STICKERS = 'D:\\Workspace\\Projects\\Deepseek-Bot\\data\\stickers';
const OWNER = '136638211';

// ---------- 纯函数 ----------
isInsideRoot(WS, 'notes.txt') ? ok('相对路径在工作区内') : no('相对路径被误判');
isInsideRoot(WS, WS + '\\a\\b.txt') ? ok('绝对路径在工作区内') : no('工作区内绝对路径被误判');
!isInsideRoot(WS, 'C:\\Windows\\win.ini') ? ok('系统文件在工作区外') : no('系统文件被放行');
!isInsideRoot(WS, '..\\..\\secret.txt') ? ok('.. 穿越被识别') : no('穿越没识别');
!isInsideRoot(WS, 'D:\\Workspace\\Projects\\Deepseek-Bot\\config.json') ? ok('上级目录文件在工作区外') : no('上级目录被放行');

findOutsidePath('read', { path: 'notes.txt' }, WS) === null ? ok('read 工作区内路径通过') : no('read 误拦');
findOutsidePath('read', { path: 'C:\\Windows\\win.ini' }, WS) ? ok('read 系统文件被拦') : no('read 系统文件没拦');
findOutsidePath('glob', { pattern: '*.md', path: 'D:\\' }, WS) ? ok('glob 的 path 也校验') : no('glob 没校验');
findOutsidePath('glob', { pattern: '**/*.md' }, WS) === null ? ok('纯 glob pattern 不被误判为路径') : no('glob pattern 被误判');
findOutsidePath('read_image', { path: STICKERS + '\\a.png' }, WS, [STICKERS]) === null
  ? ok('表情包目录对只读工具放行')
  : no('表情包目录被拦');
findOutsidePath('write', { path: STICKERS + '\\a.png', content: 'x' }, WS, [STICKERS])
  ? ok('表情包目录不允许写')
  : no('表情包目录被写入');

// ---------- 拦截器 ----------
let handler = null;
const ctx = { on: (evt, fn) => { handler = fn; } };
const brain = {
  isQqAgent: (id) => id === 'agent1',
  speakerFor: () => null,
  workspaceDir: () => WS,
  extraReadRoots: () => [STICKERS],
  cfg: { bot: { ownerId: OWNER } },
};
installToolGuard(ctx, brain, () => {});
handler ? ok('拦截器已注册') : no('拦截器没注册');

async function decide(exec, speaker) {
  brain.speakerFor = () => speaker;
  let passed = false;
  const result = await handler(exec, async () => {
    passed = true;
    return { kind: 'allow' };
  });
  return { passed, result };
}

const agent = { id: 'agent1' };

{
  const { passed } = await decide({ name: 'terminal_send', agent: { id: 'other' }, arguments: {} }, null);
  passed ? ok('非 QQ 会话不受影响') : no('误伤了普通会话');
}
{
  const { passed, result } = await decide({ name: 'terminal_send', agent, arguments: {} }, { userId: OWNER, kind: 'private' });
  !passed && result?.kind === 'deny' ? ok('非白名单工具被拒') : no('危险工具被放行');
}
{
  const { passed } = await decide({ name: 'read', agent, arguments: { path: 'C:\\Windows\\win.ini' } }, { userId: OWNER, kind: 'private' });
  passed ? ok('主人私聊可读本机任意文件') : no('主人私聊被拦');
}
{
  const { passed, result } = await decide({ name: 'read', agent, arguments: { path: 'C:\\Windows\\win.ini' } }, { userId: OWNER, kind: 'group' });
  !passed && result?.kind === 'deny' ? ok('主人在群里也受限') : no('群里放开了');
}
{
  const { passed, result } = await decide({ name: 'read', agent, arguments: { path: 'C:\\Windows\\win.ini' } }, { userId: '999999', kind: 'private' });
  !passed && result?.kind === 'deny' ? ok('陌生人私聊被拦') : no('陌生人私聊被放行');
}
{
  const { passed } = await decide({ name: 'read', agent, arguments: { path: 'notes.txt' } }, { userId: '999999', kind: 'group' });
  passed ? ok('群友可读工作区内文件') : no('群友读工作区也被拦');
}
{
  const { passed, result } = await decide(
    { name: 'write', agent, arguments: { path: 'D:\\Workspace\\Projects\\Deepseek-Bot\\config.json', content: 'x' } },
    { userId: '999999', kind: 'group' },
  );
  !passed && result?.kind === 'deny' ? ok('群友写配置文件被拦') : no('群友写配置被放行');
}
{
  const { passed } = await decide({ name: 'web_search', agent, arguments: { query: '你好' } }, { userId: '999999', kind: 'group' });
  passed ? ok('联网工具不受路径限制') : no('联网工具被误拦');
}
{
  const { passed } = await decide({ name: 'read_image', agent, arguments: { path: STICKERS + '\\a.png' } }, { userId: '999999', kind: 'group' });
  passed ? ok('群友可看她库里的表情图') : no('表情图被自己拦住');
}
{
  const { passed, result } = await decide(
    { name: 'write', agent, arguments: { path: STICKERS + '\\x.png', content: 'y' } },
    { userId: '999999', kind: 'group' },
  );
  !passed && result?.kind === 'deny' ? ok('表情包目录不允许写') : no('表情包目录被写');
}

console.log('');
if (bad) {
  console.log(`✗ ${bad} 项失败`);
  process.exit(1);
}
console.log('✓ 工具闸与路径校验验证通过');
