// OneBot v11 反向 WebSocket 服务端：NapCat 主动连过来（一个连接既收事件又发消息）。
import { WebSocketServer } from 'ws';
import { createLogger } from './log.js';

const log = createLogger('onebot');

export class OneBot {
  constructor(cfg) {
    this.cfg = cfg.onebot;
    this.selfId = cfg.bot?.selfId ? String(cfg.bot.selfId) : '';
    this.wss = null;
    this.socket = null;
    this.pending = new Map();
    this.seq = 0;
    this.handlers = new Set();
  }

  get connected() {
    return this.socket?.readyState === 1;
  }

  onEvent(fn) {
    this.handlers.add(fn);
    return () => this.handlers.delete(fn);
  }

  start() {
    return new Promise((resolve, reject) => {
      const server = new WebSocketServer({
        host: this.cfg.listenHost,
        port: this.cfg.listenPort,
        path: this.cfg.path,
        verifyClient: (info, done) => {
          const token = this.cfg.token;
          if (!token) return done(true);
          const url = new URL(info.req.url, 'http://localhost');
          const got =
            url.searchParams.get('access_token') ||
            (info.req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
          if (got === token) return done(true);
          log.warn('拒绝了一个 token 不匹配的连接', { ip: info.req.socket.remoteAddress });
          return done(false, 401, 'bad token');
        },
      });
      this.wss = server;

      server.on('listening', () => {
        log.info(`等待 NapCat 连接：ws://${this.cfg.listenHost}:${this.cfg.listenPort}${this.cfg.path}`);
        resolve();
      });
      server.on('error', (err) => (this.wss.listening ? log.error('WS 服务错误', err.message) : reject(err)));

      server.on('connection', (socket, req) => {
        if (this.socket && this.socket.readyState === 1) {
          log.warn('新的 NapCat 连接替换了旧连接');
          try {
            this.socket.close();
          } catch {}
        }
        this.socket = socket;
        log.info('NapCat 已连接', req.socket.remoteAddress);

        socket.on('message', (buf) => this.#handleFrame(buf));
        socket.on('close', () => {
          log.warn('NapCat 断开，等待重连');
          if (this.socket === socket) this.socket = null;
        });
        socket.on('error', (err) => log.error('WS 连接错误', err.message));
      });
    });
  }

  #handleFrame(buf) {
    let msg;
    try {
      msg = JSON.parse(buf.toString('utf8'));
    } catch {
      log.warn('收到非 JSON 帧，已忽略');
      return;
    }

    // 1) API 响应（带 echo）
    if (msg.echo !== undefined && this.pending.has(msg.echo)) {
      const { resolve, reject, timer } = this.pending.get(msg.echo);
      this.pending.delete(msg.echo);
      clearTimeout(timer);
      if (msg.status === 'ok' || msg.retcode === 0) resolve(msg.data);
      else reject(new Error(`${msg.wording ?? msg.message ?? 'onebot error'} (retcode=${msg.retcode})`));
      return;
    }

    // 2) 事件
    if (msg.post_type) {
      // 自动学习 bot 自己的 QQ 号，省得手填
      if (msg.self_id && String(msg.self_id) !== this.selfId) {
        this.selfId = String(msg.self_id);
        log.info('识别到 bot 账号', this.selfId);
      }
      for (const fn of this.handlers) {
        try {
          fn(msg);
        } catch (err) {
          log.error('事件处理异常', err.message);
        }
      }
    }
  }

  /** 调用 OneBot API */
  call(action, params = {}, timeoutMs = 15000) {
    if (!this.connected) return Promise.reject(new Error('NapCat 未连接'));
    this.seq += 1;
    const echo = `echo-${this.seq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(echo);
        reject(new Error(`OneBot API 超时：${action}`));
      }, timeoutMs);
      this.pending.set(echo, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ action, params, echo }));
    });
  }

  /** chatKey: 'group:123' | 'private:456' */
  async send(chatKey, text) {
    const [kind, id] = String(chatKey).split(':');
    if (kind === 'group') {
      return this.call('send_group_msg', { group_id: Number(id), message: [{ type: 'text', data: { text } }] });
    }
    return this.call('send_private_msg', { user_id: Number(id), message: [{ type: 'text', data: { text } }] });
  }

  /** 回复一条消息，尽量带引用，聊天里更自然 */
  async reply(chatKey, text, messageId = null) {
    const [kind, id] = String(chatKey).split(':');
    const message = [];
    if (messageId) message.push({ type: 'reply', data: { id: String(messageId) } });
    message.push({ type: 'text', data: { text } });
    if (kind === 'group') {
      return this.call('send_group_msg', { group_id: Number(id), message });
    }
    return this.call('send_private_msg', { user_id: Number(id), message });
  }

  async getLoginInfo() {
    return this.call('get_login_info', {});
  }

  async close() {
    try {
      this.socket?.close();
    } catch {}
    await new Promise((r) => (this.wss ? this.wss.close(() => r()) : r()));
  }
}
