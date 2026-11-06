// 回环联调：起一个真实的桥进程 + 一个假的 NapCat 客户端，走完整 WebSocket 链路。
// 验证：token 鉴权、事件接收、@ 识别、后端调用、消息回发。
// 用法：node src/tools/loopback.js
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { loadConfig, ROOT } from '../config.js';

const cfg = loadConfig();
const PORT = Number(process.env.LOOPBACK_PORT ?? 7811);
const TOKEN = cfg.onebot.token || 'loopback-token';
const SELF_ID = 10000;
const dataDir = mkdtempSync(join(tmpdir(), 'qqbot-loop-'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (m) => console.log(`  ✓ ${m}`);
const bad = (m) => console.log(`  ✗ ${m}`);

const child = spawn(process.execPath, [join(ROOT, 'src', 'index.js'), '--mock'], {
  cwd: ROOT,
  env: {
    ...process.env,
    QQ_BOT_PORT: String(PORT),
    QQ_BOT_TOKEN: TOKEN,
    QQ_BOT_DATA: dataDir,
    QQ_BOT_COOLDOWN: '0',
    QQ_BOT_DEBUG: '1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let childOut = '';
child.stdout.on('data', (d) => (childOut += d));
child.stderr.on('data', (d) => (childOut += d));

function cleanup() {
  try {
    child.kill();
  } catch {}
  rmSync(dataDir, { recursive: true, force: true });
}

let failures = 0;
function expect(name, cond, detail = '') {
  if (cond) ok(name);
  else {
    bad(`${name}${detail ? ` —— ${detail}` : ''}`);
    failures += 1;
  }
}

try {
  // 等桥把端口听起来
  let up = false;
  for (let i = 0; i < 60; i += 1) {
    if (childOut.includes('等待 NapCat 连接')) {
      up = true;
      break;
    }
    await sleep(100);
  }
  expect('桥进程启动并监听端口', up, childOut.slice(-200));
  if (!up) throw new Error('桥没起来');

  // 1) 错误 token 必须被拒
  const rejected = await new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}${cfg.onebot.path}?access_token=wrong-token`);
    ws.on('open', () => resolve(false));
    ws.on('error', () => resolve(true));
    ws.on('unexpected-response', () => resolve(true));
    setTimeout(() => resolve(true), 2000);
  });
  expect('错误 token 被拒绝', rejected);

  // 2) 正确 token 连上并跑一个来回
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}${cfg.onebot.path}?access_token=${TOKEN}`);
  const replies = [];
  const sendCalls = [];

  ws.on('message', (buf) => {
    const msg = JSON.parse(buf.toString());
    if (msg.action) {
      sendCalls.push(msg);
      // 假装是 NapCat，回一个成功响应
      ws.send(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 9001 }, echo: msg.echo }));
      const text = msg.params?.message?.find((s) => s.type === 'text')?.data?.text ?? '';
      if (text) replies.push(text);
    }
  });

  await new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });
  ok('正确 token 可连接');
  await sleep(150);

  const groupMsg = {
    post_type: 'message',
    message_type: 'group',
    sub_type: 'normal',
    self_id: SELF_ID,
    group_id: 88888,
    user_id: 20001,
    message_id: 500,
    time: Math.floor(Date.now() / 1000),
    sender: { user_id: 20001, nickname: '阿远', card: '阿远' },
    message: [
      { type: 'at', data: { qq: String(SELF_ID) } },
      { type: 'text', data: { text: ' 你好，你是谁' } },
    ],
  };
  ws.send(JSON.stringify(groupMsg));

  for (let i = 0; i < 40 && replies.length === 0; i += 1) await sleep(100);
  expect('群里 @ 她能收到回复', replies.length > 0, '没有收到任何 send_group_msg');
  expect('回复走的是群消息接口', sendCalls[0]?.action === 'send_group_msg', sendCalls[0]?.action);
  expect('回复里带引用', sendCalls[0]?.params?.message?.[0]?.type === 'reply');
  expect('回复内容来自后端', (replies[0] ?? '').includes('离线自检'), replies[0]?.slice(0, 60));
  console.log(`    回复：${replies[0]?.slice(0, 70)}`);

  // 3) 没被 @ 的群消息不该触发
  const before = replies.length;
  ws.send(JSON.stringify({ ...groupMsg, message_id: 501, message: [{ type: 'text', data: { text: '今天天气不错' } }] }));
  await sleep(600);
  expect('没被 @ 不插话', replies.length === before);

  // 4) 戳一戳会触发
  const beforePoke = replies.length;
  ws.send(
    JSON.stringify({
      post_type: 'notice',
      notice_type: 'notify',
      sub_type: 'poke',
      self_id: SELF_ID,
      group_id: 88888,
      user_id: 20001,
      target_id: SELF_ID,
    }),
  );
  for (let i = 0; i < 40 && replies.length === beforePoke; i += 1) await sleep(100);
  expect('戳一戳会回应', replies.length > beforePoke);

  ws.close();
} catch (err) {
  bad(`联调异常：${err.message}`);
  failures += 1;
} finally {
  cleanup();
}

console.log('');
if (failures) {
  console.log(`✗ ${failures} 项失败`);
  process.exit(1);
}
console.log('✓ 回环链路全部通过');
