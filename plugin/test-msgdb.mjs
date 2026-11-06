// 消息库自测：落盘 / 读取 / 裁剪 / 主动发言时间 / 私聊计数 / 重开后仍在
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';

const safeRm = (dir) => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* Windows 下连接未关会 EPERM，忽略 */
  }
};
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MessageDB } from './dsh-qq/lib/msgdb.js';

let failures = 0;
const ok = (m) => console.log(`  ✓ ${m}`);
const bad = (m, d = '') => {
  console.log(`  ✗ ${m}${d ? ` —— ${d}` : ''}`);
  failures += 1;
};

const dir = mkdtempSync(join(tmpdir(), 'qqdb-'));
try {
  const db = new MessageDB(dir, () => {});
  if (!db.ok) throw new Error('消息库没打开');

  // 写入
  for (let i = 1; i <= 5; i += 1) {
    db.append({ chatKey: 'group:100', groupId: '100', userId: 'u1', nickname: '阿远', text: `第${i}条`, at: 1000 + i });
  }
  db.append({ chatKey: 'group:200', groupId: '200', userId: 'u2', nickname: '小李', text: '别的群', at: 2000 });

  const recent = db.recent('group:100', 3);
  recent.length === 3 && recent.at(-1).text === '第5条' && recent[0].text === '第3条'
    ? ok('按时间正序取最近 N 条')
    : bad('取最近 N 条', JSON.stringify(recent));

  db.count('group:100') === 5 ? ok('计数正确') : bad('计数', String(db.count('group:100')));
  db.count('group:200') === 1 ? ok('按会话隔离') : bad('会话隔离');

  // 最近发言的人（头像册用）：按 QQ 号去重、取最新昵称、排除她自己和非数字 id、按时间窗口过滤
  const t0 = Date.now();
  db.append({ chatKey: 'group:300', groupId: '300', userId: '111111', nickname: '旧名', text: 'a', at: t0 - 5000 });
  db.append({ chatKey: 'group:300', groupId: '300', userId: '111111', nickname: '新名', text: 'b', at: t0 - 4000 });
  db.append({ chatKey: 'group:300', groupId: '300', userId: '222222', nickname: '乙', text: 'c', at: t0 - 1000 });
  db.append({ chatKey: 'group:300', groupId: '300', userId: 'self', nickname: '我', text: 'd', at: t0 - 500, self: true });
  db.append({ chatKey: 'group:300', groupId: '300', userId: '333333', nickname: '很久以前', text: 'e', at: t0 - 5 * 3600 * 1000 });
  const ps = db.participants('group:300', 2 * 3600 * 1000, 8);
  ps.length === 2 && ps[0].userId === '222222' && ps[1].userId === '111111' && ps[1].nickname === '新名'
    ? ok('最近发言的人：去重、取最新昵称、排除自己和窗口外的人')
    : bad('participants', JSON.stringify(ps));

  // 主动发言时间
  db.setChime('group:100', 12345);
  db.setChime('group:100', 67890);
  db.getChime('group:100') === 67890 ? ok('主动发言时间可覆盖更新') : bad('chime 覆盖', String(db.getChime('group:100')));

  // 私聊计数
  db.addPrivateHit('u1');
  db.privateHits('u1', 3600 * 1000).length === 1 ? ok('私聊计数写入') : bad('私聊计数');
  db.privateHits('u1', 0).length === 0 ? ok('私聊计数按窗口过滤') : bad('窗口过滤');

  // 裁剪：塞 260 条只保留 200
  for (let i = 0; i < 260; i += 1) {
    db.append({ chatKey: 'group:300', groupId: '300', userId: 'u9', nickname: 'x', text: 'y', at: Date.now() });
  }
  await new Promise((r) => setTimeout(r, 50));
  const c300 = db.count('group:300');
  c300 <= 201 ? ok(`自动裁剪生效（剩 ${c300} 条）`) : bad('裁剪没生效', String(c300));

  db.close();

  // 重开：数据还在（这就是"重启不丢"的证明）
  const db2 = new MessageDB(dir, () => {});
  const again = db2.recent('group:100', 5);
  again.length === 5 && again.at(-1).text === '第5条' ? ok('重开后消息仍在') : bad('重开后消息丢了', JSON.stringify(again));
  db2.getChime('group:100') === 67890 ? ok('重开后主动发言时间仍在') : bad('重开后 chime 丢了');
  db2.privateHits('u1', 3600 * 1000).length === 1 ? ok('重开后私聊计数仍在') : bad('重开后私聊计数丢了');
  db2.close();
} finally {
  safeRm(dir);
}

console.log('');
if (failures) {
  console.log(`✗ ${failures} 项失败`);
  process.exit(1);
}
console.log('✓ 消息库验证通过');


