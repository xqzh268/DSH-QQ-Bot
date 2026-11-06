// 联网实测 B 站接口（不属于回归测试：依赖外网）。用法：node plugin/live-bili.mjs [关键词]
import { BiliClient, describeVideo } from './dsh-qq/lib/bili.js';

const c = new BiliClient({ log: (...a) => console.log('  log:', ...a) });
const kw = process.argv[2] ?? '影之刃零';
console.log('指纹', await c.ensureFingerprint(), c.cookie.slice(0, 30) + '…');
const list = await c.search(kw, 5);
console.log(`搜索「${kw}」→ ${list.length} 条`);
for (const v of list) console.log(' -', describeVideo(v, { withDesc: false }), v.pic ? '[有封面]' : '[无封面]');
if (list[0]) {
  const info = await c.view(list[0].bvid);
  console.log('view →', info ? describeVideo(info) : null);
}
const vs = await c.videosIn('看这个 https://www.bilibili.com/video/BV1GJ411x7h7/ 好玩');
console.log('链接解析 →', vs.map((v) => describeVideo(v, { withDesc: false })));
