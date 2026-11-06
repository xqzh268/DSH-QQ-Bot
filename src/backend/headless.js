// DSH headless 后端：spawn `dsh --profile headless --json`，读 NDJSON 事件流。
// 事件契约（0.2.1-rc.3 实测）：
//   {"type":"session","sessionId":"...","cwd":"..."}
//   {"type":"status","phase":"turn_start"|"step_start"|"step_end"|"turn_end", ...}
//   {"type":"final","text":"..."}          <- 最终回答在这里
//   turn_end.reason.kind === 'error'       <- 失败
import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { createLogger } from '../log.js';

const log = createLogger('dsh');

class Semaphore {
  constructor(n) {
    this.n = Math.max(1, n | 0);
    this.queue = [];
    this.active = 0;
  }
  async acquire() {
    if (this.active < this.n) {
      this.active += 1;
      return;
    }
    await new Promise((r) => this.queue.push(r));
    this.active += 1;
  }
  release() {
    this.active -= 1;
    const next = this.queue.shift();
    if (next) next();
  }
}

function resolveCommand(bin) {
  if (!bin) throw new Error('backend.dshBin 未配置');
  if (bin.endsWith('.js') || bin.endsWith('.mjs')) {
    if (!existsSync(bin)) throw new Error(`找不到 DSH 入口文件：${bin}`);
    return { cmd: process.execPath, prefix: [bin] };
  }
  return { cmd: bin, prefix: [] };
}

export function createHeadlessBackend(cfg) {
  const b = cfg.backend;
  const sem = new Semaphore(b.concurrency ?? 2);
  const { cmd, prefix } = resolveCommand(b.dshBin);
  const children = new Set();

  async function runOnce({ prompt, sessionId, timeoutMs }) {
    // 注意：`dsh headless --json -`（stdin 模式）会被 CLI 拒绝（"`-` must be the only task
    // argument"），所以任务文本只能走 argv。Windows 单条命令行上限约 32K，这里留足余量。
    const MAX_ARG = 24000;
    let task = prompt;
    if (task.length > MAX_ARG) {
      log.warn(`提示词过长（${task.length}），截断到 ${MAX_ARG}`);
      task = task.slice(0, 3000) + '\n（中间省略）\n' + task.slice(-(MAX_ARG - 3000));
    }

    const args = [...prefix, '--profile', b.profile, 'headless', '--json'];
    if (sessionId) args.push('--session-id', sessionId);
    args.push(task);

    const started = Date.now();
    const child = spawn(cmd, args, {
      cwd: process.cwd(),
      env: { ...process.env, ...(b.env ?? {}), DSH_NO_UPDATE_CHECK: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    children.add(child);

    let session = sessionId ?? null;
    let finalText = '';
    let failure = null;
    let stderr = '';
    let buf = '';

    const done = new Promise((resolve) => {
      const timer = setTimeout(() => {
        failure = failure ?? { message: `超时（${timeoutMs}ms）` };
        try {
          child.kill();
        } catch {}
      }, timeoutMs);

      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        buf += chunk;
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line) continue;
          let evt;
          try {
            evt = JSON.parse(line);
          } catch {
            continue;
          }
          if (evt.type === 'session' && evt.sessionId) session = evt.sessionId;
          else if (evt.type === 'final' && typeof evt.text === 'string') finalText = evt.text;
          else if (evt.type === 'status' && evt.phase === 'turn_end') {
            if (evt.reason?.kind === 'error') failure = evt.reason.error ?? { message: 'unknown' };
          }
        }
      });

      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => {
        stderr = (stderr + chunk).slice(-4000);
      });

      child.on('error', (err) => {
        failure = failure ?? { message: `无法启动 ${cmd}：${err.message}` };
      });

      child.on('close', (code) => {
        clearTimeout(timer);
        children.delete(child);
        if (!failure && code !== 0) failure = { message: `退出码 ${code}`, stderr };
        resolve();
      });
    });

    child.stdin.end();
    await done;

    const took = Date.now() - started;
    if (failure) {
      log.error('headless 失败', failure.message, stderr.slice(-400));
      return { text: '', sessionId: session, error: failure.message, took };
    }
    log.info(`headless 完成 ${took}ms`, { sessionId: session, chars: finalText.length });
    return { text: finalText, sessionId: session, error: null, took };
  }

  return {
    kind: 'headless',
    async run(req) {
      await sem.acquire();
      try {
        return await runOnce({ ...req, timeoutMs: b.timeoutMs ?? 180000 });
      } finally {
        sem.release();
      }
    },
    async close() {
      for (const c of children) {
        try {
          c.kill();
        } catch {}
      }
    },
  };
}

/** 探测 dsh 入口是否可用，返回 {ok, detail} */
export function probeDsh(cfg) {
  try {
    const { cmd, prefix } = resolveCommand(cfg.backend.dshBin);
    if (cmd === process.execPath) {
      const st = statSync(prefix[0]);
      return { ok: true, detail: `${prefix[0]} (${st.size} bytes)` };
    }
    return { ok: true, detail: cmd };
  } catch (err) {
    return { ok: false, detail: err.message };
  }
}
