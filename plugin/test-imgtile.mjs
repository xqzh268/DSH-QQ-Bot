// 长图切片自测：读尺寸 / 判断要不要切 / 切片规划 / 真实切图（Windows）/ 提示词
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { imageSize, needsTiling, planTiles, tileImage, MAX_SIDE } from './dsh-qq/lib/imgtile.js';
import { buildPrompt } from './dsh-qq/lib/prompt.js';

let bad = 0;
const ok = (m) => console.log(`  ✓ ${m}`);
const no = (m, d = '') => {
  console.log(`  ✗ ${m}${d ? ` —— ${d}` : ''}`);
  bad += 1;
};

// ---- 读文件头里的尺寸 ----
const png = Buffer.alloc(33);
Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png);
png.writeUInt32BE(1440, 16);
png.writeUInt32BE(11264, 20);
const s1 = imageSize(png);
s1?.width === 1440 && s1?.height === 11264 ? ok('PNG 头读出宽高') : no('PNG 尺寸', JSON.stringify(s1));

const gif = Buffer.concat([Buffer.from('GIF89a'), Buffer.from([0x40, 0x01, 0xb4, 0x00]), Buffer.alloc(10)]);
const s2 = imageSize(gif);
s2?.width === 320 && s2?.height === 180 ? ok('GIF 头读出宽高') : no('GIF 尺寸', JSON.stringify(s2));

// JPEG：SOI + APP0(16 字节) + SOF0(高 11264 = 0x2C00，宽 1440 = 0x05A0)
const jpg = Buffer.concat([
  Buffer.from([0xff, 0xd8]),
  Buffer.from([0xff, 0xe0, 0x00, 0x10]), Buffer.alloc(14),
  Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0x2c, 0x00, 0x05, 0xa0, 0x03]), Buffer.alloc(20),
]);
const s3 = imageSize(jpg);
s3?.width === 1440 && s3?.height === 11264 ? ok('JPEG 跳过 APP 段后读出 SOF 里的宽高') : no('JPEG 尺寸', JSON.stringify(s3));

const webp = Buffer.alloc(40);
webp.write('RIFF', 0);
webp.write('WEBP', 8);
webp.write('VP8X', 12);
webp.writeUIntLE(799, 24, 3);
webp.writeUIntLE(9999, 27, 3);
const s4 = imageSize(webp);
s4?.width === 800 && s4?.height === 10000 ? ok('WebP(VP8X) 读出宽高') : no('WebP 尺寸', JSON.stringify(s4));
imageSize(Buffer.from('not an image at all')) === null && imageSize(Buffer.alloc(0)) === null ? ok('认不出的内容返回 null，不抛异常') : no('坏数据处理');

// ---- 要不要切 ----
needsTiling({ width: 1440, height: 11264 }) ? ok('单边超过 8192：必须切') : no('超限没判断要切');
needsTiling({ width: 1080, height: 4000 }) ? ok('又细又长且超 400 万像素：切（不然会被压糊）') : no('细长图没判断要切');
!needsTiling({ width: 4000, height: 3000 }) ? ok('比例正常的大照片：不切，交给附件服务压') : no('大照片被切了');
!needsTiling({ width: 800, height: 3000 }) && !needsTiling(null) && !needsTiling({ width: 0, height: 0 }) ? ok('小图 / 无尺寸：不切') : no('小图被切了');

// ---- 切片规划 ----
const plan = planTiles({ width: 1440, height: 11264 });
const lastT = plan.tiles.at(-1);
plan.vertical && plan.tiles.length === 5 && plan.tiles[0].start === 0 && lastT.start + lastT.len === 11264 && !plan.truncated && plan.tiles.every((t) => t.len * 1440 <= 3500000 && t.len <= MAX_SIDE)
  ? ok('1440×11264 切 5 段：覆盖整张图，每段都在像素和边长限额内')
  : no('切片规划', JSON.stringify(plan));
plan.tiles.slice(1).every((t, i) => t.start < plan.tiles[i].start + plan.tiles[i].len) ? ok('相邻两段有重叠，不会把一行字切成两半') : no('没有重叠');
// 零头不单切一小条：最后一段往回拉成完整一段
const tail = planTiles({ width: 1440, height: 2361 + 2301 + 200 }); // 第二段之后只剩一点零头
const tailLast = tail.tiles.at(-1);
tailLast.len >= 2361 * 0.9 && tailLast.start + tailLast.len === 2361 + 2301 + 200 && !tail.truncated
  ? ok('末尾零头太短时，最后一段往回拉成完整一段，不留细条')
  : no('零头处理', JSON.stringify(tail.tiles));
// 窄长图：每段长宽比不超过 3:1
const narrow = planTiles({ width: 600, height: 9000 });
narrow.tiles.every((t) => t.len <= 1800) && !narrow.truncated && narrow.tiles.at(-1).start + narrow.tiles.at(-1).len === 9000
  ? ok('窄长图：每段长宽比 ≤ 3:1，仍覆盖整张图')
  : no('窄长图规划', JSON.stringify(narrow.tiles));
const huge = planTiles({ width: 1440, height: 60000 });
huge.tiles.length === 6 && huge.truncated && huge.covered < 60000 ? ok('特别长的图最多切 6 段，并标明"没切完"') : no('超长图上限', JSON.stringify({ n: huge.tiles.length, t: huge.truncated }));
const wide = planTiles({ width: 12000, height: 900 });
!wide.vertical && wide.tiles[0].len <= MAX_SIDE ? ok('横向的超宽图沿宽度方向切') : no('横图方向', JSON.stringify(wide));

// ---- 切图执行（用桩：任何平台都能测"结果收集 / 失败回退"）----
const dir = mkdtempSync(join(tmpdir(), 'qqtile-'));
try {
  const fakeRunner = async (args) => {
    const outDir = args[args.indexOf('-outDir') + 1];
    const prefix = args[args.indexOf('-prefix') + 1];
    const n = args[args.indexOf('-spec') + 1].split(';').length;
    const paths = [];
    for (let i = 1; i <= n; i += 1) {
      const p = join(outDir, `${prefix}-${i}.jpg`);
      writeFileSync(p, 'x');
      paths.push(p);
    }
    return paths.join('\r\n');
  };
  const r = await tileImage('whatever.jpg', { width: 1440, height: 11264 }, join(dir, 'a'), 'abc', { runner: fakeRunner });
  r?.paths.length === 5 && r.paths.every((p) => existsSync(p)) ? ok('切图结果被正确收集') : no('收集结果', JSON.stringify(r));
  let calls = 0;
  const counting = async (a) => {
    calls += 1;
    return fakeRunner(a);
  };
  await tileImage('whatever.jpg', { width: 1440, height: 11264 }, join(dir, 'a'), 'abc', { runner: counting });
  calls === 0 ? ok('同一张图切过就直接复用，不重复切') : no('重复切图', String(calls));
  const failed = await tileImage('whatever.jpg', { width: 1440, height: 11264 }, join(dir, 'b'), 'zzz', { runner: async () => { throw new Error('boom'); } });
  failed === null ? ok('切图出错时返回 null，不抛异常') : no('出错应返回 null');
  const partial = await tileImage('whatever.jpg', { width: 1440, height: 11264 }, join(dir, 'c'), 'ppp', { runner: async () => '' });
  partial === null ? ok('一段都没切出来也返回 null（不会把半截结果当成功）') : no('半截结果被当成功');

  // ---- 真实切图：Windows 上用 PowerShell 现生成一张 600×9000 的长 PNG ----
  if (process.platform === 'win32') {
    const src = join(dir, 'long.png');
    const gen = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-Command', `Add-Type -AssemblyName System.Drawing; $b = New-Object System.Drawing.Bitmap 600, 9000; $g = [System.Drawing.Graphics]::FromImage($b); $g.Clear([System.Drawing.Color]::White); $f = New-Object System.Drawing.Font 'Arial', 40; for ($y = 0; $y -lt 9000; $y += 300) { $g.DrawString("row " + $y, $f, [System.Drawing.Brushes]::Black, 10, $y) }; $b.Save('${src.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png)`],
      { encoding: 'utf8' },
    );
    if (gen.status !== 0 || !existsSync(src)) {
      no('生成测试长图失败', gen.stderr?.slice(0, 200));
    } else {
      const size = imageSize(readFileSync(src));
      size?.width === 600 && size?.height === 9000 ? ok('（真实）生成了 600×9000 的长 PNG') : no('长图尺寸不对', JSON.stringify(size));
      needsTiling(size) ? ok('（真实）这张图超过 8192，需要切') : no('应判断要切');
      const real = await tileImage(src, size, join(dir, 'real'), 'long');
      if (!real) no('（真实）PowerShell 切图返回 null');
      else {
        const sizes = real.paths.map((p) => imageSize(readFileSync(p)));
        real.paths.length >= 4 && real.paths.length <= 6 && sizes.every((s) => s && s.width === 600 && s.height <= MAX_SIDE && s.height <= 600 * 3) && sizes.every((s) => s.width * s.height <= 4194304)
          ? ok(`（真实）切成 ${real.paths.length} 段 JPEG，每段宽 600、长宽比不超过 3:1、都在 read_image 限额内`)
          : no('（真实）切出来的尺寸不对', JSON.stringify(sizes));
      }
    }
  } else {
    console.log('  - 非 Windows，跳过真实切图');
  }
} finally {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

// ---- 提示词 ----
const persona = { name: '测试', description: 'x', personality: [], habits: [], avoid: [], examples: [] };
const profile = { userId: '1', nickname: '甲', traits: [], facts: [], episodes: [], interactions: 0 };
const event = { kind: 'group', groupId: '1', chatKey: 'group:1', userId: '1', nickname: '甲', text: '你看这个', atMe: true, at: Date.now() };
const base = { persona, profile, event, staticsInSystem: true, visionMode: 'always' };
const tiled = buildPrompt({ ...base, imageNotes: [{ path: 'D:\\o.jpg', size: { width: 1440, height: 11264 }, tiles: ['D:\\t-1.jpg', 'D:\\t-2.jpg'], tileInfo: { vertical: true, truncated: false } }] });
/超长图（1440×11264）/.test(tiled) && /从上到下切成 2 段/.test(tiled) && tiled.includes('D:\\t-1.jpg') && tiled.includes('D:\\t-2.jpg') && /按顺序用 read_image/.test(tiled) && /不要用终端/.test(tiled) && !tiled.includes('D:\\o.jpg')
  ? ok('提示词：列出每一段的路径、要求按顺序看、禁止去试终端，不给原图路径')
  : no('长图提示词', tiled.slice(tiled.indexOf('【对方这次发的图】'), tiled.indexOf('【对方这次发的图】') + 500));
const cut = buildPrompt({ ...base, imageNotes: [{ path: 'D:\\o.jpg', size: { width: 1440, height: 90000 }, tiles: ['D:\\t-1.jpg'], tileInfo: { vertical: true, truncated: true } }] });
/只切了前面一部分/.test(cut) ? ok('图太长没切完时，提示词要求她如实说明后面看不到') : no('没切完的提示');
const unread = buildPrompt({ ...base, imageNotes: [{ path: 'D:\\o.jpg', size: { width: 20000, height: 900 }, unreadable: true }] });
/太大我看不了/.test(unread) && /不要假装看过/.test(unread) && !unread.includes('D:\\o.jpg') ? ok('切不了的大图：提示词让她如实说看不了，不给路径') : no('unreadable 提示', unread.slice(0, 300));
const normal = buildPrompt({ ...base, imageNotes: [{ path: 'D:\\n.png', isSticker: false }] });
normal.includes('D:\\n.png') && !/超长图|太大我看不了/.test(normal) ? ok('普通图片的提示词不受影响') : no('普通图片提示词被改了');

console.log('');
if (bad) {
  console.log(`✗ ${bad} 项失败`);
  process.exit(1);
}
console.log('✓ 长图切片验证通过');
