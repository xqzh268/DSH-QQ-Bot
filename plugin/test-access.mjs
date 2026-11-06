// 准入白名单自测：群成员范围 / 戳一戳 / 私聊 / 主动插话
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Brain } from './dsh-qq/lib/brain.js';
import { Ambient } from './dsh-qq/lib/ambient.js';
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

function makeBrain(accessOverrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'qqaccess-'));
  const config = {
    access: {
      users: ['136638211'],
      groups: ['1032537893'],
      groupTrigger: 'at',
      replyPrivate: true,
      ...accessOverrides,
    },
    limits: { perUserCooldownSec: 0, perGroupPerHour: 100, maxReplyChars: 600 },
    memory: { maxEpisodes: 40 },
    proactive: { enabled: true, maxPerHour: 2, quietHours: [], ambient: { enabled: true, sampleRate: 1 } },
    stickers: { autoSave: 'off', visionMode: 'off' },
  };
  writeFileSync(join(dir, 'config.json'), JSON.stringify(config));
  const store = new ProjectStore(dir);
  const brain = new Brain({ ctx: { get: () => undefined }, onebot: {}, store, log: () => {} });
  return { brain, store, dir };
}

const ev = (kind, userId, groupId, extra = {}) => ({
  kind,
  userId: String(userId),
  groupId: groupId ? String(groupId) : null,
  chatKey: groupId ? `group:${groupId}` : `private:${userId}`,
  atMe: false,
  text: '在吗',
  ...extra,
});

// ---------- 模式一：群成员也要在市名单（默认） ----------
{
  const { brain, store, dir } = makeBrain();
  brain.decide(ev('group', '136638211', '1032537893', { atMe: true })).ok
    ? ok('[默认] 白名单内的群成员 @ → 回应')
    : no('[默认] 白名单成员被拦');

  const strangerAt = brain.decide(ev('group', '999999', '1032537893', { atMe: true }));
  !strangerAt.ok && strangerAt.why.includes('白名单') ? ok('[默认] 白名单外的群成员 @ → 拒绝') : no('[默认] 陌生人被放行', JSON.stringify(strangerAt));

  brain.decide(ev('group', '999999', '1032537893')).ok === false ? ok('[默认] 白名单外普通发言 → 拒绝') : no('[默认] 普通发言被放行');

  brain.decide(ev('poke', '136638211', '1032537893')).ok ? ok('[默认] 白名单内戳一戳 → 回应') : no('[默认] 自己人戳被拦');
  const strangerPoke = brain.decide(ev('poke', '999999', '1032537893'));
  !strangerPoke.ok ? ok('[默认] 白名单外戳一戳 → 拒绝') : no('[默认] 陌生人戳一戳被放行');

  brain.decide(ev('group', '136638211', '555555', { atMe: true })).ok === false ? ok('[默认] 不在白名单的群 → 拒绝') : no('[默认] 无关群被放行');

  brain.decide(ev('private', '136638211')).ok ? ok('[默认] 白名单内私聊 → 回应') : no('[默认] 自己人私聊被拦');
  brain.decide(ev('private', '999999')).ok === false ? ok('[默认] 白名单外私聊 → 拒绝') : no('[默认] 陌生人私聊被放行');

  const ambient = new Ambient({ brain, store, log: () => {} });
  brain.stickers?.close?.();
  ambient.db?.close?.();
  safeRm(dir);
}

// ---------- 模式二：群内成员全开 ----------
{
  const { brain, dir } = makeBrain({ groupMemberScope: 'group' });

  const strangerAt = brain.decide(ev('group', '999999', '1032537893', { atMe: true }));
  strangerAt.ok ? ok('[群内全开] 群友 @ → 回应（不用填 QQ 号）') : no('[群内全开] 群友被拦', JSON.stringify(strangerAt));

  const strangerPoke = brain.decide(ev('poke', '999999', '1032537893'));
  strangerPoke.ok ? ok('[群内全开] 群友戳一戳 → 回应') : no('[群内全开] 群友戳被拦');

  const otherGroup = brain.decide(ev('group', '999999', '555555', { atMe: true }));
  !otherGroup.ok ? ok('[群内全开] 非白名单群仍然拒绝') : no('[群内全开] 无关群被放行', JSON.stringify(otherGroup));

  const strangerPrivate = brain.decide(ev('private', '999999'));
  !strangerPrivate.ok ? ok('[群内全开] 陌生人私聊仍然拒绝') : no('[群内全开] 私聊也放行了（不该）');

  // 群里没被 @ 的普通消息仍然按 groupTrigger=at 拒绝
  brain.decide(ev('group', '999999', '1032537893')).ok === false ? ok('[群内全开] 没 @ 仍然不插嘴') : no('[群内全开] 普通消息被回应');

  brain.stickers?.close?.();
  safeRm(dir);
}

// ---------- 主动插话的用户校验 ----------
{
  const { brain, store, dir } = makeBrain();
  const ambient = new Ambient({ brain, store, log: () => {} });
  // 采样率 1、内容像能接的话，但人不在白名单 → 必须不触发
  const out = await ambient.maybeChime(ev('group', '999999', '1032537893', { text: '这个到底怎么弄啊' }));
  out === null ? ok('陌生人消息不触发主动插话') : no('陌生人触发了主动插话');
  ambient.stop();
  brain.stickers?.close?.();
  safeRm(dir);
}

console.log('');
if (bad) {
  console.log(`✗ ${bad} 项失败`);
  process.exit(1);
}
console.log('✓ 白名单准入验证通过');


