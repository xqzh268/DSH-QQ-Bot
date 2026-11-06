// 离线自检：不需要 QQ、不需要模型凭据，验证从事件归一化到回消息、落记忆的整条链路。
// 用法：npm run selftest
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 必须赶在 store.js 被导入之前设置，让数据落到临时目录
const dataDir = mkdtempSync(join(tmpdir(), 'qqbot-selftest-'));
process.env.QQ_BOT_DATA = dataDir;

const { extractText, mentionsSelf, normalize } = await import('./normalize.js');
const { splitMemo } = await import('./prompt.js');
const { splitReply, inQuietHours, Brain } = await import('./brain.js');
const { Store } = await import('./store.js');
const { createMockBackend } = await import('./backend/mock.js');

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
    console.log(`  PASS  ${name}`);
  } catch (err) {
    results.push({ name, ok: false, err: err.message });
    console.log(`  FAIL  ${name}\n        ${err.message}`);
  }
}
async function checkAsync(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  PASS  ${name}`);
  } catch (err) {
    results.push({ name, ok: false, err: err.message });
    console.log(`  FAIL  ${name}\n        ${err.message}`);
  }
}

const SELF = '10000';
const persona = {
  id: 'test',
  name: '小九',
  tagline: '测试用',
  identity: '一个测试角色。',
  speech: { tone: '随意', habits: ['爱说嗯'], avoid: ['不说教'], examples: [] },
};

function fakeOnebot() {
  const sent = [];
  return {
    sent,
    connected: true,
    async send(chatKey, text) {
      sent.push({ chatKey, text, mode: 'send' });
      return {};
    },
    async reply(chatKey, text, messageId) {
      sent.push({ chatKey, text, messageId, mode: 'reply' });
      return {};
    },
  };
}

const cfg = {
  bot: { selfId: SELF, ownerId: '20001' },
  access: { groups: [], users: [], groupTrigger: 'at', keywords: ['在吗'], replyPrivate: true },
  limits: { perUserCooldownSec: 0, perGroupPerHour: 100, maxReplyChars: 600 },
  memory: { maxEpisodes: 40, updateProfile: true },
  proactive: { enabled: true, idleMinutes: 90, maxPerHour: 2, quietHours: [] },
  backend: { kind: 'mock' },
};

console.log('\n== 单元逻辑 ==');
check('文本提取（消息段数组）', () => {
  const msg = [
    { type: 'at', data: { qq: SELF } },
    { type: 'text', data: { text: ' 你好呀' } },
  ];
  assert.equal(extractText(msg), '你好呀');
});
check('文本提取（CQ 码字符串）', () => {
  assert.equal(extractText(`[CQ:at,qq=${SELF}] 在吗`), '在吗');
});
check('识别 @自己', () => {
  assert.equal(mentionsSelf([{ type: 'at', data: { qq: SELF } }], SELF), true);
  assert.equal(mentionsSelf([{ type: 'at', data: { qq: '999' } }], SELF), false);
});
check('剥掉 MEMO 标记', () => {
  const { clean, memo } = splitMemo('好的呀。\n<<MEMO>>{"traits":["好奇"],"facts":["在写代码"],"episode":"聊了代码"}<</MEMO>>');
  assert.equal(clean, '好的呀。');
  assert.equal(memo.traits[0], '好奇');
  assert.equal(memo.episode, '聊了代码');
});
check('坏 JSON 的 MEMO 不影响正文', () => {
  const { clean, memo } = splitMemo('嗯嗯\n<<MEMO>>{坏的}<</MEMO>>');
  assert.equal(clean, '嗯嗯');
  assert.equal(memo, null);
});
check('长回复切片不超过上限', () => {
  const long = '这是很长的一段话。'.repeat(200);
  const parts = splitReply(long, 600);
  assert.ok(parts.length > 1);
  for (const p of parts) assert.ok(p.length <= 600, `切片超长：${p.length}`);
});
check('免打扰时段（跨零点）', () => {
  const at2am = new Date('2026-11-01T02:00:00');
  const at12 = new Date('2026-11-01T12:00:00');
  assert.equal(inQuietHours(['23:30-08:00'], at2am), true);
  assert.equal(inQuietHours(['23:30-08:00'], at12), false);
});
check('机器人自己的消息被丢弃', () => {
  const evt = {
    post_type: 'message',
    message_type: 'group',
    group_id: 1,
    user_id: Number(SELF),
    message: [{ type: 'text', data: { text: '我自己' } }],
  };
  assert.equal(normalize(evt, SELF), null);
});

console.log('\n== 链路联调（mock 后端） ==');
const store = new Store();
const onebot = fakeOnebot();
const brain = new Brain({ cfg, store, onebot, backend: createMockBackend(), persona });

/** 造一条群消息事件 */
function groupEvent({ userId = '20001', text = '在吗', at = true, messageId = 1, nickname = '阿远' } = {}) {
  const evt = {
    post_type: 'message',
    message_type: 'group',
    group_id: 88888,
    user_id: Number(userId),
    message_id: messageId,
    sender: { nickname, card: nickname },
    message: [...(at ? [{ type: 'at', data: { qq: SELF } }] : []), { type: 'text', data: { text } }],
  };
  return normalize(evt, SELF);
}

await checkAsync('私聊能收到回复', async () => {
  const evt = normalize(
    {
      post_type: 'message',
      message_type: 'private',
      user_id: 20001,
      message_id: 11,
      sender: { nickname: '阿远' },
      message: [{ type: 'text', data: { text: '你是谁' } }],
    },
    SELF,
  );
  const out = await brain.handle(evt);
  assert.ok(out && out.length > 0, '应当产生回复');
  assert.equal(onebot.sent.length, 1);
  assert.equal(onebot.sent[0].mode, 'reply');
});

await checkAsync('群里没被 @ 就不说话（连主人都一样）', async () => {
  const before = onebot.sent.length;
  const out = await brain.handle(groupEvent({ text: '今天天气不错', at: false }));
  assert.equal(out, null);
  assert.equal(onebot.sent.length, before);
});

await checkAsync('群里被 @ 会说话', async () => {
  const before = onebot.sent.length;
  const out = await brain.handle(groupEvent({ text: '帮我看看这个 bug', messageId: 21 }));
  assert.ok(out);
  assert.equal(onebot.sent.length, before + 1);
});

await checkAsync('会话映射已落盘', async () => {
  const s = store.getSession('group:88888');
  assert.ok(s, '应当记录群会话');
  assert.equal(s.groupId, '88888');
});

await checkAsync('用户画像被写入并累积', async () => {
  const p = store.getProfile('20001');
  assert.ok(p.interactions >= 1, `interactions=${p.interactions}`);
  assert.ok(existsSync(join(dataDir, 'profiles', '20001.json')));
});

await checkAsync('免打扰期间不主动发言', async () => {
  const quietCfg = { ...cfg, proactive: { ...cfg.proactive, quietHours: ['00:00-23:59'] } };
  const b2 = new Brain({ cfg: quietCfg, store, onebot: fakeOnebot(), backend: createMockBackend(), persona });
  assert.equal(await b2.proactiveSay('88888'), null);
});

await checkAsync('主动发言在正常时段可以说话', async () => {
  const ob = fakeOnebot();
  const b3 = new Brain({ cfg, store, onebot: ob, backend: createMockBackend(), persona });
  const out = await b3.proactiveSay('88888');
  assert.ok(out, '应当主动说话');
  assert.equal(ob.sent[0].mode, 'send');
});

console.log('');
const failed = results.filter((r) => !r.ok);
rmSync(dataDir, { recursive: true, force: true });
if (failed.length) {
  console.log(`✗ ${failed.length}/${results.length} 项失败`);
  process.exit(1);
}
console.log(`✓ ${results.length} 项全部通过`);
