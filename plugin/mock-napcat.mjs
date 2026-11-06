// 假装自己是 NapCat：连上插件的 OneBot 端口，发一条群 @ 消息，看能不能收到回复。
// 用法：node plugin/mock-napcat.mjs [port]
import { WebSocket } from 'ws';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const cfg = JSON.parse(readFileSync(join(root, 'config.json'), 'utf8'));
const port = Number(process.argv[2] ?? cfg.onebot.listenPort ?? 7800);
const token = cfg.onebot.token ?? '';
const url = `ws://127.0.0.1:${port}${cfg.onebot.path ?? '/onebot'}?access_token=${token}`;

const SELF = '10000';
const replies = [];

console.log(`连接 ${url}`);
const ws = new WebSocket(url);
ws.on('message', (buf) => {
  const msg = JSON.parse(buf.toString());
  if (msg.action) {
    const text = (msg.params?.message ?? []).map((s) => (s.type === 'text' ? s.data.text : '')).join('');
    console.log(`\n[回给 QQ] ${msg.action}: ${text.slice(0, 200)}`);
    replies.push(text);
    ws.send(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 1 }, echo: msg.echo }));
  }
});
ws.on('error', (e) => {
  console.error('连接失败:', e.message);
  process.exit(1);
});

await new Promise((r) => ws.on('open', r));
console.log('已连上插件（假装 NapCat）');

ws.send(
  JSON.stringify({
    post_type: 'message',
    message_type: 'group',
    self_id: Number(SELF),
    group_id: 88888,
    user_id: 20001,
    message_id: 100,
    time: Math.floor(Date.now() / 1000),
    sender: { card: '阿远', nickname: '阿远' },
    message: [
      { type: 'at', data: { qq: SELF } },
      { type: 'text', data: { text: ' 你好，你是谁' } },
    ],
  }),
);
console.log('已发送群消息，等待回复（最多 90 秒）…');

const deadline = Date.now() + 90000;
while (Date.now() < deadline && replies.length === 0) {
  await new Promise((r) => setTimeout(r, 1000));
}

ws.close();
if (replies.length) {
  console.log('\n✓ 收到回复');
  process.exit(0);
}
console.log('\n✗ 90 秒内没有收到任何回复');
process.exit(2);
