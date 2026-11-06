/**
 * 极简 RFC6455 WebSocket 服务端（仅服务端、仅文本帧）。
 *
 * 为什么不用 ws 包：插件要装进桌面应用的 profile 里，那里没有 npm 依赖可装，
 * 而 OneBot 只需要"接收 JSON 文本帧 + 发 JSON 文本帧"，协议子集很小。
 * 不支持：分片续帧、二进制、扩展协商。NapCat 与 OneBot 实现都用单帧文本，够用。
 */
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const OP_CONT = 0x0;
const OP_TEXT = 0x1;
const OP_BINARY = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

/** 解析一个 WebSocket 帧；Buffer 不够时返回 null（等更多数据） */
function parseFrame(buf) {
  if (buf.length < 2) return null;
  const b1 = buf[1];
  const masked = (b1 & 0x80) === 0x80;
  let len = b1 & 0x7f;
  let offset = 2;

  if (len === 126) {
    if (buf.length < 4) return null;
    len = buf.readUInt16BE(2);
    offset = 4;
  } else if (len === 127) {
    if (buf.length < 10) return null;
    const big = buf.readBigUInt64BE(2);
    if (big > 8n * 1024n * 1024n) throw new Error('frame too large');
    len = Number(big);
    offset = 10;
  }

  const maskLen = masked ? 4 : 0;
  if (buf.length < offset + maskLen + len) return null;

  const frame = { fin: (buf[0] & 0x80) === 0x80, opcode: buf[0] & 0x0f, masked };
  let payload;
  if (masked) {
    const mask = buf.subarray(offset, offset + 4);
    payload = Buffer.allocUnsafe(len);
    for (let i = 0; i < len; i += 1) payload[i] = buf[offset + 4 + i] ^ mask[i % 4];
  } else {
    payload = buf.subarray(offset, offset + len);
  }
  frame.payload = payload;
  frame.consumed = offset + maskLen + len;
  return frame;
}

/** 编一个服务端发出的文本帧 */
function encodeFrame(opcode, payload) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8');
  const len = data.length;
  let header;
  if (len < 126) {
    header = Buffer.allocUnsafe(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.allocUnsafe(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.allocUnsafe(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x80 | opcode;
  return Buffer.concat([header, data]);
}

class Connection extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.closed = false;
    this.fragments = [];

    socket.on('data', (chunk) => this.#onData(chunk));
    socket.on('close', () => this.#markClosed());
    socket.on('error', (err) => {
      this.emit('error', err);
      this.#markClosed();
    });
  }

  #markClosed() {
    if (this.closed) return;
    this.closed = true;
    this.emit('close');
  }

  #onData(chunk) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    for (;;) {
      let frame;
      try {
        frame = parseFrame(this.buffer);
      } catch (err) {
        this.close(1009, err.message);
        return;
      }
      if (!frame) return;
      this.buffer = this.buffer.subarray(frame.consumed);

      if (frame.opcode === OP_CLOSE) {
        this.close(1000, '');
        return;
      }
      if (frame.opcode === OP_PING) {
        this.socket.write(encodeFrame(OP_PONG, frame.payload));
        continue;
      }
      if (frame.opcode === OP_PONG) continue;

      // 文本/二进制，处理分片
      this.fragments.push(frame.payload);
      if (!frame.fin) continue;
      const payload = Buffer.concat(this.fragments);
      this.fragments = [];
      if (frame.opcode === OP_BINARY) continue; // 不用二进制
      this.emit('message', payload.toString('utf8'));
    }
  }

  send(text) {
    if (this.closed) return false;
    try {
      this.socket.write(encodeFrame(OP_TEXT, text));
      return true;
    } catch {
      return false;
    }
  }

  close(code = 1000, reason = '') {
    if (this.closed) return;
    try {
      const payload = Buffer.alloc(2 + Buffer.byteLength(reason));
      payload.writeUInt16BE(code, 0);
      payload.write(reason, 2, 'utf8');
      this.socket.write(encodeFrame(OP_CLOSE, payload));
    } catch {
      /* 忽略 */
    }
    try {
      this.socket.end();
    } catch {
      /* 忽略 */
    }
    this.#markClosed();
  }
}

/**
 * 起一个 WebSocket 服务端。
 * @param {{host?:string, port:number, path?:string, token?:string}} opts
 * @returns {Promise<{close:()=>Promise<void>, on:Function, connection:()=>Connection|null, port:number}>}
 */
export function createWebSocketServer({ host = '127.0.0.1', port, path = '/', token = '' }) {
  const emitter = new EventEmitter();
  let current = null;

  const server = createServer((req, res) => {
    res.writeHead(426, { 'content-type': 'text/plain' });
    res.end('WebSocket only');
  });

  server.on('upgrade', (req, socket) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    if (path && url.pathname !== path) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }
    if (token) {
      const got = url.searchParams.get('access_token') || (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
      if (got !== token) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
    }
    const key = req.headers['sec-websocket-key'];
    if (!key) {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }
    const accept = createHash('sha1')
      .update(key + GUID)
      .digest('base64');
    socket.write(
      [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${accept}`,
        '',
        '',
      ].join('\r\n'),
    );
    socket.setNoDelay(true);

    const conn = new Connection(socket);
    if (current && !current.closed) current.close(1000, 'replaced');
    current = conn;

    conn.on('message', (text) => emitter.emit('message', text, conn));
    conn.on('close', () => {
      if (current === conn) current = null;
      emitter.emit('close', conn);
    });
    conn.on('error', () => {});
    emitter.emit('connection', conn);
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      server.on('error', () => {});
      resolve({
        port: server.address()?.port ?? port,
        connection: () => current,
        on: (evt, fn) => emitter.on(evt, fn),
        close: () =>
          new Promise((done) => {
            try {
              current?.close(1001, 'server closing');
            } catch {}
            server.close(() => done());
          }),
      });
    });
  });
}
