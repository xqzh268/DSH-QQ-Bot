/**
 * 长图切片。
 *
 * 背景：DSH 的 read_image 会拒收任一边超过 8192px 的图（IMAGE_DIMENSION_TOO_LARGE），
 * 就算收下，附件服务也会把图压到约 400 万像素——一张 1440×11264 的长截图会被压到字都糊掉。
 * QQ 会话又没有终端，模型想自己缩也缩不了。所以在交给她之前，先沿长边切成几段，
 * 每段都在限额内、字也看得清，让她按顺序一段一段看。
 *
 * 切图用 Windows 自带的 .NET System.Drawing（经 PowerShell），不引入任何依赖。
 * 只在 Windows 上可用；其它平台、WebP 长图、解码失败时返回 null，由上层如实告诉她"看不了"。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/** DSH 附件服务的默认限额（dsh-attachment-local：maxImageDimension / normalizedImageMaxPixels） */
export const MAX_SIDE = 8192;
export const NORMALIZED_PIXELS = 4194304;

/** 不解码，只读文件头拿宽高；认不出返回 null */
export function imageSize(buf) {
  try {
    if (buf.length > 24 && buf[0] === 0x89 && buf[1] === 0x50) return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    if (buf.length > 10 && buf.toString('ascii', 0, 3) === 'GIF') return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
      let i = 2;
      while (i + 9 < buf.length) {
        if (buf[i] !== 0xff) {
          i += 1;
          continue;
        }
        const marker = buf[i + 1];
        if (marker === 0xff) {
          i += 1;
          continue;
        }
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
        }
        if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
          i += 2;
          continue;
        }
        i += 2 + buf.readUInt16BE(i + 2);
      }
      return null;
    }
    if (buf.length > 30 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
      const kind = buf.toString('ascii', 12, 16);
      if (kind === 'VP8X') return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
      if (kind === 'VP8 ') return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
      if (kind === 'VP8L') {
        const b = buf.readUInt32LE(21);
        return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
      }
    }
  } catch {
    /* 头部不完整就当认不出 */
  }
  return null;
}

/**
 * 要不要切：
 *  - 任一边超过 8192：read_image 直接拒收，必须切
 *  - 又细又长（长边 ≥ 2.5 倍短边）且像素超过 400 万：会被压糊，切开更清楚
 * 普通大照片（比例正常）交给附件服务自己压，不切。
 */
export function needsTiling(size) {
  if (!size || !size.width || !size.height) return false;
  const long = Math.max(size.width, size.height);
  const short = Math.min(size.width, size.height);
  if (long > MAX_SIDE) return true;
  return long / short >= 2.5 && size.width * size.height > NORMALIZED_PIXELS;
}

/** 算每段多长（沿长边）。每段不超过 ~340 万像素，相邻段重叠一点，免得一行字被切成两半 */
export function planTiles(size, { maxTilePixels = 3400000, overlap = 60, maxTiles = 6 } = {}) {
  const vertical = size.height >= size.width;
  const across = vertical ? size.width : size.height; // 短边
  const along = vertical ? size.height : size.width; // 长边
  // 每段：像素不超预算、不超单边上限，长宽比也别太夸张（长边 ≤ 短边的 3 倍），
  // 否则窄长图会切出 1:10 的"细条"，模型看了效果不好
  const tileLen = Math.max(400, Math.min(MAX_SIDE, Math.floor(maxTilePixels / across), Math.floor(across * 3)));
  const tiles = [];
  let start = 0;
  while (tiles.length < maxTiles) {
    const len = Math.min(tileLen, along - start);
    tiles.push({ start, len });
    if (start + len >= along) break;
    let next = start + tileLen - overlap;
    // 剩下的零头太短：不单切一小条，把最后一段往回拉，凑满一整段
    if (along - next < tileLen * 0.3 && tiles.length < maxTiles) next = Math.max(0, along - tileLen);
    start = next;
  }
  const last = tiles[tiles.length - 1];
  const covered = last.start + last.len;
  return { vertical, tiles, along, covered, truncated: covered < along };
}

const PS = String.raw`
param([string]$src, [string]$outDir, [string]$prefix, [int]$vertical, [string]$spec)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$img = [System.Drawing.Image]::FromFile($src)
try {
  $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
  $enc = New-Object System.Drawing.Imaging.EncoderParameters(1)
  $enc.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, [long]92)
  $i = 0
  foreach ($t in ($spec -split ';')) {
    $p = $t -split ','
    $start = [int]$p[0]; $len = [int]$p[1]
    if ($vertical -eq 1) { $w = $img.Width; $h = $len; $rect = New-Object System.Drawing.Rectangle 0, $start, $w, $h }
    else { $w = $len; $h = $img.Height; $rect = New-Object System.Drawing.Rectangle $start, 0, $w, $h }
    $bmp = New-Object System.Drawing.Bitmap $w, $h
    $bmp.SetResolution($img.HorizontalResolution, $img.VerticalResolution)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.Clear([System.Drawing.Color]::White)
    $dest = New-Object System.Drawing.Rectangle 0, 0, $w, $h
    $g.DrawImage($img, $dest, $rect, [System.Drawing.GraphicsUnit]::Pixel)
    $g.Dispose()
    $i += 1
    $out = Join-Path $outDir ($prefix + '-' + $i + '.jpg')
    $bmp.Save($out, $codec, $enc)
    $bmp.Dispose()
    Write-Output $out
  }
} finally { $img.Dispose() }
`;

/**
 * 把一张长图切成几段，写到 outDir/<prefix>-N.jpg。
 * @returns {Promise<{paths:string[], width:number, height:number, vertical:boolean, truncated:boolean, covered:number, along:number}|null>}
 */
export async function tileImage(file, size, outDir, prefix, opts = {}) {
  if (process.platform !== 'win32' && !opts.runner) return null;
  const plan = planTiles(size, opts);
  try {
    mkdirSync(outDir, { recursive: true });
  } catch {
    return null;
  }
  // 已经切过就直接用（同一张图不会反复切）
  const wanted = plan.tiles.map((_, i) => join(outDir, `${prefix}-${i + 1}.jpg`));
  if (wanted.every((p) => existsSync(p))) return { paths: wanted, ...size, ...plan };

  const script = join(tmpdir(), `qq-tile-${process.pid}-${Date.now()}.ps1`);
  try {
    writeFileSync(script, `\ufeff${PS}`, 'utf8'); // 带 BOM，PowerShell 5.1 才会按 UTF-8 读中文路径
    const spec = plan.tiles.map((t) => `${t.start},${t.len}`).join(';');
    const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-src', file, '-outDir', outDir, '-prefix', prefix, '-vertical', plan.vertical ? '1' : '0', '-spec', spec];
    const run = opts.runner ?? ((a) => runPowerShell(a, opts.timeoutMs ?? 60000));
    const stdout = await run(args);
    const paths = String(stdout)
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s && existsSync(s));
    if (paths.length !== plan.tiles.length) return null;
    return { paths, ...size, ...plan };
  } catch {
    return null;
  } finally {
    try {
      rmSync(script, { force: true });
    } catch {
      /* 临时脚本删不掉不影响 */
    }
  }
}

function runPowerShell(args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', args, { windowsHide: true });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('切图超时'));
    }, timeoutMs);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`切图失败(${code}): ${err.slice(0, 200)}`));
    });
  });
}
