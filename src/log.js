// 极简日志：带时间戳和模块名，写到 stdout，必要时落文件。
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './config.js';

const LOG_DIR = join(ROOT, 'data', 'logs');
let fileReady = false;

function stamp() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function write(level, scope, args) {
  const text = args
    .map((a) => (typeof a === 'string' ? a : safeJson(a)))
    .join(' ');
  const line = `${stamp()} ${level.padEnd(5)} [${scope}] ${text}`;
  if (level === 'ERROR') console.error(line);
  else console.log(line);
  if (!fileReady) {
    try {
      mkdirSync(LOG_DIR, { recursive: true });
      fileReady = true;
    } catch {
      return;
    }
  }
  if (fileReady) {
    try {
      const day = stamp().slice(0, 10);
      appendFileSync(join(LOG_DIR, `${day}.log`), line + '\n', 'utf8');
    } catch {
      /* 日志失败不能影响主流程 */
    }
  }
}

function safeJson(v) {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export function createLogger(scope) {
  return {
    info: (...a) => write('INFO', scope, a),
    warn: (...a) => write('WARN', scope, a),
    error: (...a) => write('ERROR', scope, a),
    debug: (...a) => {
      if (process.env.QQ_BOT_DEBUG) write('DEBUG', scope, a);
    },
  };
}
