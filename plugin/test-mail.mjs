// 邮件助理自测：工具权限分级 + 巡查节流
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installToolGuard, MAIL_READ_TOOLS } from './dsh-qq/lib/guard.js';
import { Ambient } from './dsh-qq/lib/ambient.js';

let bad = 0;
const ok = (m) => console.log(`  ✓ ${m}`);
const no = (m, d = '') => {
  console.log(`  ✗ ${m}${d ? ` —— ${d}` : ''}`);
  bad += 1;
};
const safeRm = (dir) => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {}
};

const OWNER = '136638211';

// ---------- 工具权限 ----------
{
  let handler = null;
  const brain = {
    isQqAgent: (id) => id === 'agent1',
    speakerFor: () => null,
    workspaceDir: () => 'D:\\ws',
    extraReadRoots: () => [],
    cfg: { bot: { ownerId: OWNER }, mail: { enabled: true } },
  };
  installToolGuard({ on: (_e, fn) => (handler = fn) }, brain, () => {});

  const run = async (name, speaker) => {
    brain.speakerFor = () => speaker;
    let passed = false;
    const result = await handler({ name, agent: { id: 'agent1' }, arguments: {} }, async () => {
      passed = true;
      return { kind: 'allow' };
    });
    return { passed, result };
  };

  MAIL_READ_TOOLS.size === 3 ? ok('只读邮件工具共 3 个') : no('工具集合大小异常', String(MAIL_READ_TOOLS.size));

  let r = await run('mail_find', { userId: OWNER, kind: 'private' });
  r.passed ? ok('主人私聊可以查邮件') : no('主人私聊被拦', JSON.stringify(r.result));

  r = await run('mail_read', { userId: OWNER, kind: 'private' });
  r.passed ? ok('主人私聊可以读邮件') : no('mail_read 被拦');

  r = await run('mail_list_folders', { userId: OWNER, kind: 'private' });
  r.passed ? ok('主人私聊可以列文件夹') : no('mail_list_folders 被拦');

  r = await run('mail_find', { userId: OWNER, kind: 'group' });
  !r.passed ? ok('主人在群里也拿不到邮件') : no('群里放开了邮件');

  r = await run('mail_find', { userId: '999999', kind: 'private' });
  !r.passed ? ok('陌生人私聊拿不到邮件') : no('陌生人能读邮件');

  r = await run('mail_send', { userId: OWNER, kind: 'private' });
  !r.passed ? ok('发邮件永久禁用（主人也不行）') : no('mail_send 被放行');

  brain.cfg.mail = { enabled: false };
  r = await run('mail_find', { userId: OWNER, kind: 'private' });
  !r.passed ? ok('关掉邮件助理后主人也不能查') : no('关闭后仍能用');
}

// ---------- 巡查节流 ----------
{
  const dir = mkdtempSync(join(tmpdir(), 'qqmail-'));
  try {
    const calls = [];
    const store = {
      dir,
      profile: () => ({}),
      readProfile: () => ({ nickname: '我' }),
      boundSession: () => 'session-x',
      listProfiles: () => [],
    };
    const brain = {
      cfg: {
        bot: { ownerId: OWNER },
        access: { groups: [] },
        mail: { enabled: true, watchMinutes: 30 },
        proactive: { enabled: true, maxPerHour: 9, quietHours: [], idle: { enabled: false }, private: { enabled: false }, ambient: { enabled: false } },
      },
      proactiveSay: async () => null,
      proactivePrivateSay: async (args) => {
        calls.push(args);
        return '有一条重要的';
      },
    };
    const ambient = new Ambient({ brain, store, log: () => {} });

    await ambient.sweep();
    calls.length === 1 ? ok('到点会去查一次邮件') : no('没有触发巡查', String(calls.length));
    calls[0]?.chatKey === `private:${OWNER}` ? ok('巡查走的是主人私聊会话') : no('会话不对', calls[0]?.chatKey);

    await ambient.sweep();
    calls.length === 1 ? ok('间隔未到不重复查') : no('重复巡查了', String(calls.length));

    // 把上次时间往前推 31 分钟 → 应该再查一次
    ambient.db.setKv('mail:lastCheck', Date.now() - 31 * 60000);
    await ambient.sweep();
    calls.length === 2 ? ok('超过间隔后会再查') : no('超时后没查', String(calls.length));

    brain.cfg.mail.enabled = false;
    ambient.db.setKv('mail:lastCheck', 0);
    await ambient.sweep();
    calls.length === 2 ? ok('关闭后不再巡查') : no('关闭后仍在查');

    ambient.stop();
  } finally {
    safeRm(dir);
  }
}

console.log('');
if (bad) {
  console.log(`✗ ${bad} 项失败`);
  process.exit(1);
}
console.log('✓ 邮件助理验证通过');
