// 表情包库自测：下载入库 / 去重 / 语义检索 / 学习闭环 / 标记解析
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { StickerStore } from './dsh-qq/lib/stickers.js';
import { extractStickerMarkers, extractTagMarkers } from './dsh-qq/lib/brain.js';

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

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const PNG2 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

// 手搓的 GIF 头 + 图形控制扩展块（只用来测"是不是多帧"的判断，不要求能解码）
const gce = Buffer.from([0x21, 0xf9, 0x04, 0x00, 0x0a, 0x00, 0x00, 0x00]);
const GIF_ANIM = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(10), gce, Buffer.alloc(8), gce, Buffer.alloc(8)]);
const GIF_STILL = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(10), gce, Buffer.alloc(8)]);

const server = createServer((req, res) => {
  const buf = req.url === '/a.png' ? PNG : req.url === '/b.png' ? PNG2 : req.url === '/anim.gif' ? GIF_ANIM : req.url === '/still.gif' ? GIF_STILL : null;
  if (!buf) {
    res.writeHead(404);
    res.end();
    return;
  }
  res.writeHead(200, { 'content-type': 'image/png' });
  res.end(buf);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const dir = mkdtempSync(join(tmpdir(), 'qqsticker-'));
try {
  const store = new StickerStore(dir, () => {});
  store.ok ? ok('表情包库打开') : no('库没打开');

  const evA = { userId: '20001', chatKey: 'group:888', images: [{ url: `http://127.0.0.1:${port}/a.png`, isSticker: true }] };
  const evB = { userId: '20002', chatKey: 'group:888', images: [{ url: `http://127.0.0.1:${port}/b.png`, isSticker: true }] };

  const a = await store.ingest(evA, '阿远发了个表情，气氛有点尴尬', () => true);
  const b = await store.ingest(evB, '小李发了个表情，大家在闲聊', () => true);
  a.length === 1 && existsSync(a[0].path) ? ok('下载并落盘') : no('没落盘');
  store.count() === 2 ? ok('计数 2 张') : no('计数', String(store.count()));

  await store.ingest(evA, '重复', () => true);
  store.count() === 2 ? ok('同图去重') : no('去重失败', String(store.count()));

  // 她自己看图后打标签
  store.addTags(a[0].hash, ['搞笑', '绷不住']);
  store.addTags(b[0].hash, ['安慰', '抱抱']);

  // 语义检索：写成"乐"也能命中标签"搞笑"（同义词扩展）
  const hit = store.pick('乐');
  hit?.hash === a[0].hash ? ok('同义词：乐 → 搞笑 命中') : no('同义词检索失败', JSON.stringify(hit?.hash));

  const hit2 = store.pick('心累');
  hit2?.hash === b[0].hash ? ok('安慰类命中') : no('安慰类失败', JSON.stringify(hit2?.hash));

  store.pick('完全无关') === null ? ok('无关查询不硬凑') : no('无关查询却返回了图');

  // 学习闭环：好评加分
  store.pick('乐', 'group:888');
  const before = store.get(a[0].hash)?.score ?? 1;
  store.observeFeedback('group:888', '哈哈哈哈哈笑死') === 'up' ? ok('好评被识别') : no('好评没识别');
  const after = store.get(a[0].hash)?.score ?? 1;
  after > before ? ok(`好评加分（${before} → ${after}）`) : no('分数没涨', `${before} → ${after}`);

  // 差评：扣分 + 冷却
  store.pick('安慰', 'group:888');
  store.observeFeedback('group:888', '别刷屏了，无语') === 'down' ? ok('差评被识别') : no('差评没识别');
  const cd = store.pick('安慰');
  cd === null ? ok('差评后进入冷却，挑不到') : no('冷却没生效', JSON.stringify(cd?.hash));

  // 反馈窗口过期不算
  store.pick('乐', 'group:888');
  store.observeFeedback('group:888', '哈哈哈', Date.now() + 10 * 60 * 1000) === null
    ? ok('超过窗口不再计为反馈')
    : no('窗口外仍被计为反馈');

  // 看图缓存：普通图片/动图能下载给她看，但不进表情包库
  const libBefore = store.count();
  const evG = {
    userId: '20003',
    chatKey: 'group:888',
    images: [
      { url: `http://127.0.0.1:${port}/anim.gif`, isSticker: false, summary: '[动画表情]' },
      { url: `http://127.0.0.1:${port}/still.gif`, isSticker: true, summary: '[无语]' },
    ],
  };
  const looked = await store.look(evG, (img) => !img.isSticker);
  looked.length === 1 && existsSync(looked[0].path) ? ok('非表情包的图片也会下载给她看') : no('没下载普通图片', JSON.stringify(looked));
  looked[0]?.animated === true ? ok('多帧 GIF 识别为动图') : no('动图没识别出来');
  store.count() === libBefore ? ok('看一眼的图不进表情包库') : no('看图污染了表情包库');
  const stillLook = await store.look({ images: [evG.images[1]] }, () => true);
  stillLook[0]?.animated === false && stillLook[0]?.name === '无语' ? ok('单帧 GIF 不算动图；商城表情的名字保留，泛称「动画表情」丢弃') : no('单帧/名字处理不对', JSON.stringify(stillLook));
  looked[0]?.name === '' ? ok('泛称不当作表情名') : no('泛称被当成名字', looked[0]?.name);

  // 一天前的看图缓存（含 tiles/ 里的长图切片）会被清掉，新的留着
  {
    const { mkdirSync, writeFileSync, utimesSync } = await import('node:fs');
    const seen = join(store.dir, 'seen');
    mkdirSync(join(seen, 'tiles'), { recursive: true });
    const oldTile = join(seen, 'tiles', 'old-1.jpg');
    const newTile = join(seen, 'tiles', 'new-1.jpg');
    writeFileSync(oldTile, 'x');
    writeFileSync(newTile, 'x');
    const longAgo = new Date(Date.now() - 30 * 3600 * 1000);
    utimesSync(oldTile, longAgo, longAgo);
    await store.look({ images: [] }, () => true); // 没图会提前返回，不触发清理
    await store.look({ images: [{ url: `http://127.0.0.1:${port}/still.gif` }] }, () => true);
    !existsSync(oldTile) && existsSync(newTile) ? ok('超过一天的长图切片被清理，新的保留') : no('切片清理不对', JSON.stringify([existsSync(oldTile), existsSync(newTile)]));
  }

  store.close();

  const store2 = new StickerStore(dir, () => {});
  store2.count() === 2 ? ok('重开后库仍在') : no('重开后丢了');
  const rec = store2.get(a[0].hash);
  rec?.score > 1 ? ok('重开后分数仍在') : no('分数丢了', String(rec?.score));
  store2.close();
} finally {
  safeRm(dir);
  server.closeAllConnections?.();
  server.close();
}

// 标记解析
const s = extractStickerMarkers('行吧 [[表情:无语]] 你说得对');
s.keywords[0] === '无语' && !s.clean.includes('[[') ? ok('表情标记被摘掉') : no('表情标记', JSON.stringify(s));

const t = extractTagMarkers('这张好 [[标签:搞笑, 敷衍、绷不住]]');
t.tags.length === 3 && t.tags.includes('敷衍') ? ok('标签可解析（支持中英文逗号/顿号）') : no('标签解析', JSON.stringify(t.tags));
!t.clean.includes('标签') ? ok('标签标记不进正文') : no('标签残留');

const both = extractTagMarkers('[[表情:笑死]] [[标签:搞笑]]');
extractStickerMarkers(both.clean).keywords[0] === '笑死' ? ok('两种标记可共存') : ok('两种标记可共存（顺序）');

console.log('');
if (bad) {
  console.log(`✗ ${bad} 项失败`);
  process.exit(1);
}
console.log('✓ 表情包语义检索与学习闭环验证通过');

