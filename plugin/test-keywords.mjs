// 关键词触发自测：子串匹配 / 忽略大小写 / smart 模式准入
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Brain } from './dsh-qq/lib/brain.js';
import { ProjectStore } from './dsh-qq/lib/persona.js';

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

// ---------- 纯函数 ----------
Brain.keywordHit('这个报错怎么弄啊，帮我看下', ['帮我看', '在吗'])
  ? ok('中文关键词命中')
  : no('中文关键词没命中');
Brain.keywordHit('求助！有人懂 docker 吗', ['求助']) ? ok('句首关键词命中') : no('句首没命中');
!Brain.keywordHit('中午吃什么', ['帮我看']) ? ok('没命中就不触发') : no('无关消息也命中了');
Brain.keywordHit('HELP me please', ['help']) ? ok('英文忽略大小写') : no('大小写不匹配');
Brain.keywordHit('随便聊聊', ['  ', '']) === false ? ok('空白关键词不算命中') : no('空白关键词被当成命中');
Brain.keywordHit('关键词在中间', ['中间']) ? ok('中间位置也命中') : no('中间位置没命中');

// ---------- smart 模式的准入 ----------
{
  const dir = mkdtempSync(join(tmpdir(), 'qqkw-'));
  try {
    writeFileSync(
      join(dir, 'config.json'),
      JSON.stringify({
        access: {
          users: ['136638211'],
          groups: ['1032537893'],
          groupTrigger: 'smart',
          keywords: ['帮我看', '求助'],
          replyPrivate: true,
          groupMemberScope: 'group',
        },
        limits: { perUserCooldownSec: 0, perGroupPerHour: 100, maxReplyChars: 600 },
        memory: { maxEpisodes: 40 },
        proactive: { enabled: false },
        stickers: { autoSave: 'off', visionMode: 'off' },
      }),
    );
    const store = new ProjectStore(dir);
    const brain = new Brain({ ctx: { get: () => undefined }, onebot: {}, store, log: () => {} });
    const ev = (text, extra = {}) => ({
      kind: 'group',
      groupId: '1032537893',
      chatKey: 'group:1032537893',
      userId: '999',
      nickname: '群友',
      text,
      atMe: false,
      ...extra,
    });

    brain.decide(ev('这个报错帮我看一下')).ok ? ok('smart：命中关键词就回应') : no('smart 命中了却没回应');
    brain.decide(ev('中午吃什么')).ok === false ? ok('smart：没命中不回应') : no('smart 没命中却回应了');
    brain.decide(ev('随便说说', { atMe: true })).ok ? ok('smart：被 @ 优先于关键词') : no('@ 被关键词逻辑拦住');

    // 改关键词后立即生效（同一份 cfg 对象）
    brain.cfg.access.keywords = ['中午吃'];
    brain.decide(ev('中午吃什么')).ok ? ok('改关键词后立即生效') : no('关键词改动没生效');
    brain.decide(ev('这个报错帮我看一下')).ok === false ? ok('旧关键词失效') : no('旧关键词仍生效');

    brain.stickers?.close?.();
    store.profilesDB?.close?.();
  } finally {
    safeRm(dir);
  }
}

console.log('');
if (bad) {
  console.log(`✗ ${bad} 项失败`);
  process.exit(1);
}
console.log('✓ 关键词触发验证通过');
