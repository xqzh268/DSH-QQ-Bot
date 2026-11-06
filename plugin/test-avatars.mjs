// 头像自测：下载缓存 / 过期刷新 / 失败回退旧缓存 / 非法 QQ 号 / 提示词
import { mkdtempSync, rmSync, existsSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { fetchAvatar, asksAboutAvatar } from './dsh-qq/lib/avatars.js';
import { buildPrompt } from './dsh-qq/lib/prompt.js';

let bad = 0;
const ok = (m) => console.log(`  ✓ ${m}`);
const no = (m, d = '') => {
  console.log(`  ✗ ${m}${d ? ` —— ${d}` : ''}`);
  bad += 1;
};

// 最小的 JPEG 头即可（只测下载与格式识别）
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]), Buffer.from('JFIF'), Buffer.alloc(32)]);
let hits = 0;
let mode = 'ok';
const server = createServer((req, res) => {
  hits += 1;
  if (mode === 'down') {
    res.writeHead(500);
    res.end();
  } else if (mode === 'html') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html>nope</html>');
  } else {
    res.writeHead(200, { 'content-type': 'image/jpeg' });
    res.end(JPG);
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const urlOf = (qq) => `http://127.0.0.1:${port}/g?nk=${qq}`;

const dir = mkdtempSync(join(tmpdir(), 'qqavatar-'));
try {
  const a = await fetchAvatar(dir, '136638211', { urlOf });
  a && existsSync(a.path) && a.mediaType === 'image/jpeg' && a.fresh ? ok('下载头像并落盘') : no('没下载下来', JSON.stringify(a));

  hits = 0;
  const b = await fetchAvatar(dir, '136638211', { urlOf });
  b && !b.fresh && hits === 0 ? ok('缓存期内不重复访问网络') : no('缓存没生效', `hits=${hits}`);

  // 让缓存过期
  const old = new Date(Date.now() - 7 * 3600 * 1000);
  utimesSync(a.path, old, old);
  hits = 0;
  const c = await fetchAvatar(dir, '136638211', { urlOf });
  c?.fresh && hits === 1 ? ok('缓存过期后重新下载（对方换头像能跟上）') : no('过期没刷新', `hits=${hits}`);

  // 下载失败：回退到旧缓存
  utimesSync(a.path, old, old);
  mode = 'down';
  const d = await fetchAvatar(dir, '136638211', { urlOf });
  d && d.path === a.path && !d.fresh ? ok('网络失败时退回旧头像') : no('失败时没回退', JSON.stringify(d));

  // 没缓存又失败 / 返回的不是图片：null，不抛异常
  const e = await fetchAvatar(dir, '99999999', { urlOf });
  e === null ? ok('没缓存又下载失败：返回 null，不影响回复') : no('应为 null', JSON.stringify(e));
  mode = 'html';
  const f = await fetchAvatar(dir, '88888888', { urlOf });
  f === null ? ok('返回的不是图片就拒收') : no('收下了非图片', JSON.stringify(f));
  mode = 'ok';

  // QQ 号必须是数字，防止拼出奇怪的 URL
  (await fetchAvatar(dir, '../etc', { urlOf })) === null && (await fetchAvatar(dir, '', { urlOf })) === null && (await fetchAvatar(dir, '12', { urlOf })) === null
    ? ok('非法 / 过短的 QQ 号直接拒绝')
    : no('非法 QQ 号没拒绝');

  asksAboutAvatar('你看我头像好看吗') && asksAboutAvatar('my avatar?') && !asksAboutAvatar('今天吃啥') ? ok('只在提到头像时才触发附图') : no('头像关键词判断不对');

  // 提示词
  const persona = { name: '测试', description: 'x', personality: [], habits: [], avoid: [], examples: [] };
  const profile = { userId: '136638211', nickname: '甲', traits: [], facts: [], episodes: [], interactions: 0 };
  const event = { kind: 'group', groupId: '1', chatKey: 'group:1', userId: '136638211', nickname: '甲', text: '看我头像', atMe: true, at: Date.now() };
  const base = { persona, profile, event, staticsInSystem: true };
  const p1 = buildPrompt({ ...base, avatar: { path: a.path, attached: false } });
  p1.includes('【对方的头像】') && p1.includes(a.path) && p1.includes('read_image') ? ok('没附图时提示词给出头像路径') : no('提示词没给路径', p1.slice(0, 200));
  const p2 = buildPrompt({ ...base, avatar: { path: a.path, attached: true } });
  p2.includes('已随消息附上') && !p2.includes(a.path) ? ok('已附图时提示词如实说"已附上"') : no('附图提示词不对');
  !buildPrompt({ ...base, avatar: null }).includes('【对方的头像】') ? ok('没有头像时不出现这一段') : no('无头像却出现了这一段');
} finally {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* Windows 上偶发占用，忽略 */
  }
  server.closeAllConnections?.();
  server.close();
}

console.log('');
if (bad) {
  console.log(`✗ ${bad} 项失败`);
  process.exit(1);
}
console.log('✓ 头像验证通过');
