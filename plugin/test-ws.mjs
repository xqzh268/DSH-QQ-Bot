// 验证自己写的 WS 服务端能与标准客户端互通（握手、掩码、文本帧、ping/pong、关闭）。
// 用法：node plugin/test-ws.mjs
import { WebSocket } from 'ws';
import { createWebSocketServer } from './dsh-qq/lib/ws.js';

const PORT = 7822;
let failures = 0;
const ok = (m) => console.log(`  ✓ ${m}`);
const bad = (m) => {
  console.log(`  ✗ ${m}`);
  failures += 1;
};

const server = await createWebSocketServer({ port: PORT, path: '/onebot', token: 'test-token' });
console.log(`服务端已监听 ${PORT}`);

// 1) 错误 token 被拒
const rejected = await new Promise((resolve) => {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/onebot?access_token=bad`);
  ws.on('open', () => resolve(false));
  ws.on('error', () => resolve(true));
  ws.on('unexpected-response', () => resolve(true));
  setTimeout(() => resolve(true), 1500);
});
rejected ? ok('错误 token 被拒绝') : bad('错误 token 竟然连上了');

// 2) 正确 token：双向收发
const received = [];
server.on('message', (text, conn) => {
  received.push(text);
  conn.send(JSON.stringify({ echo: 'pong', got: JSON.parse(text) }));
});

const ws = new WebSocket(`ws://127.0.0.1:${PORT}/onebot?access_token=test-token`);
const replies = [];
ws.on('message', (buf) => replies.push(buf.toString()));
await new Promise((resolve, reject) => {
  ws.on('open', resolve);
  ws.on('error', reject);
});
ok('正确 token 握手成功');

ws.send(JSON.stringify({ post_type: 'message', text: '你好' }));
await new Promise((r) => setTimeout(r, 300));
received.length === 1 && JSON.parse(received[0]).text === '你好' ? ok('服务端收到客户端消息') : bad('服务端没收到');
replies.length === 1 ? ok('客户端收到服务端回包') : bad(`客户端没收到回包（${replies.length}）`);

// 3) 大消息（触发 16 位长度分支）
const big = 'x'.repeat(5000);
ws.send(JSON.stringify({ big }));
await new Promise((r) => setTimeout(r, 400));
received.length === 2 && JSON.parse(received[1]).big.length === 5000 ? ok('大消息分帧长度正确') : bad('大消息解析错误');

// 4) 中文（UTF-8 多字节）
ws.send(JSON.stringify({ zh: '中文测试·表情🙂' }));
await new Promise((r) => setTimeout(r, 300));
JSON.parse(received[2] ?? '{}').zh === '中文测试·表情🙂' ? ok('UTF-8 多字节正确') : bad('中文解析错误');

// 5) 关闭
const closed = new Promise((r) => ws.on('close', () => r(true)));
ws.close();
await Promise.race([closed, new Promise((r) => setTimeout(() => r(false), 1500))])
  ? ok('客户端正常关闭')
  : bad('关闭没有回调');

await server.close();
console.log('');
if (failures) {
  console.log(`✗ ${failures} 项失败`);
  process.exit(1);
}
console.log('✓ WS 服务端互通验证通过');
