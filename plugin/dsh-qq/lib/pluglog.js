/**
 * 插件文件日志：装进桌面应用后，宿主 stdout 拿不到，出问题只能靠这个文件。
 * 写在项目目录 data/plugin.log，超过 1 MiB 自动截断保留后半部分。
 */
import { appendFileSync, mkdirSync, statSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const MAX_BYTES = 1024 * 1024;

export function createFileLog(projectDir) {
  const dir = join(projectDir, 'data');
  const file = join(dir, 'plugin.log');
  let disabled = false;

  return function fileLog(...args) {
    if (disabled) return;
    try {
      mkdirSync(dir, { recursive: true });
      if (existsSync(file) && statSync(file).size > MAX_BYTES) {
        const tail = readFileSync(file, 'utf8').slice(-MAX_BYTES / 2);
        writeFileSync(file, tail, 'utf8');
      }
      appendFileSync(file, `${new Date().toISOString()} ${args.map(String).join(' ')}\n`, 'utf8');
    } catch {
      disabled = true; // 日志失败不能影响主流程
    }
  };
}

