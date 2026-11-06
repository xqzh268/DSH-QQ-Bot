/**
 * 设置页的服务端接口：/dsh-qq/api/*
 *
 * 安全：DSH 的 raw webServer 路由**不带鉴权**，任何本机进程或 DNS 重绑定页面都能打。
 * 所以每个路由都必须过 connection 服务的围栏（和微信插件同一套做法），
 * 拿不到围栏就不注册接口——宁可不给页面，也不留后门。
 */
import { readFileSync } from 'node:fs';
import { QQ_TOOL_ALLOWLIST } from './guard.js';
import { validateConfigPatch, applyConfigPatch } from './confpatch.js';
import { buildListenUrl } from './onebot.js';

const MUTATING = new Set([
  '/dsh-qq/api/config',
  '/dsh-qq/api/persona/save',
  '/dsh-qq/api/memory/save',
  '/dsh-qq/api/stickers/save',
  '/dsh-qq/api/groupmem/save',
]);

function json(res, code, body) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

function readBody(req, limit = 512 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch (err) {
        reject(new Error(`JSON 解析失败：${err.message}`));
      }
    });
    req.on('error', reject);
  });
}

/** 复刻宿主的连接围栏：方法白名单 + 来源校验 + 写操作必须是 JSON */
function fence(connection, path, handler) {
  const mutating = MUTATING.has(path);
  return (req, res) => {
    const method = String(req.method ?? 'GET').toUpperCase();
    if (mutating ? method !== 'POST' : method !== 'GET' && method !== 'HEAD') {
      res.statusCode = 405;
      res.setHeader('Allow', mutating ? 'POST' : 'GET, HEAD');
      res.end('');
      return;
    }
    let rejection;
    try {
      rejection = connection.requestRejection(req);
    } catch {
      rejection = 403;
    }
    if (rejection !== undefined) {
      res.statusCode = rejection;
      res.end(rejection === 401 ? 'unauthorized' : 'forbidden');
      return;
    }
    if (mutating) {
      const type = String(req.headers?.['content-type'] ?? '').split(';')[0].trim().toLowerCase();
      if (type !== 'application/json') {
        res.statusCode = 415;
        res.end('');
        return;
      }
    }
    return handler(req, res);
  };
}

export function installApi(ctx, { store, brain, log }) {
  let web;
  let connection;
  try {
    web = ctx.get('webServer');
    connection = ctx.get('connection');
  } catch (err) {
    log('设置接口：取不到 webServer/connection，已禁用:', err?.message ?? err);
    return false;
  }
  if (!web?.register || typeof connection?.requestRejection !== 'function') {
    // 诊断信息：下次重启靠这几行定位到底缺什么
    let shapes = '(none)';
    try {
      shapes = JSON.stringify({
        webServer: typeof web,
        register: typeof web?.register,
        connection: typeof connection,
        requestRejection: typeof connection?.requestRejection,
        connectionKeys: connection
          ? Object.getOwnPropertyNames(Object.getPrototypeOf(connection) ?? {})
              .filter((k) => k !== 'constructor')
              .slice(0, 12)
          : [],
      });
    } catch {}
    log('设置接口：webServer 或连接围栏不可用（安全优先，不注册）', shapes);
    return false;
  }

  const route = (path, handler) => {
    try {
      web.register({ kind: 'exact', path, handler: fence(connection, path, handler) });
      return true;
    } catch (err) {
      const msg = String(err?.message ?? err);
      // 重复注册说明上一次已经注册成功（插件可能被重载），视为成功，保证幂等
      if (msg.includes('duplicate')) {
        log('设置接口：' + path + ' 已存在，跳过');
        return true;
      }
      log('设置接口：注册 ' + path + ' 失败', msg);
      return false;
    }
  };

  function onebotListen() {
    const ob = brain.onebot;
    if (ob && (ob.port || ob.listenUrl)) {
      return {
        url: typeof ob.listenUrl === 'function' ? ob.listenUrl() : buildListenUrl(ob),
        host: ob.host ?? '127.0.0.1',
        port: ob.port ?? 7800,
        path: ob.path ?? '/onebot',
        hasToken: Boolean(ob.token),
      };
    }
    const cfg = store.cfg ?? {};
    const spec = {
      host: cfg.onebot?.listenHost ?? '127.0.0.1',
      port: cfg.plugin?.onebotPort ?? cfg.onebot?.listenPort ?? 7800,
      path: cfg.onebot?.path ?? '/onebot',
      token: cfg.onebot?.token ?? '',
    };
    return { url: buildListenUrl(spec), host: spec.host, port: spec.port, path: spec.path, hasToken: Boolean(spec.token) };
  }

  // 状态总览
  route('/dsh-qq/api/state', (_req, res) => {
    const cfg = store.cfg ?? {};
    let persona = null;
    try {
      const active = store.readPersona(cfg.persona?.active);
      persona = { file: active.file, id: active.data.id, name: active.data.name, tagline: active.data.tagline ?? '' };
    } catch {}
    json(res, 200, {
      ok: true,
      persona,
      onebot: onebotListen(),
      config: {
        bot: cfg.bot ?? {},
        access: cfg.access ?? {},
        proactive: cfg.proactive ?? {},
        plugin: cfg.plugin ?? {},
        limits: cfg.limits ?? {},
        humanize: cfg.humanize ?? {},
        social: cfg.social ?? {},
        groupMemory: cfg.groupMemory ?? {},
        mail: cfg.mail ?? {},
      },
      // 页面的模型 / 邮件 / 主动发言统计表单从 /state 读这几项
      // （以前它们只出现在 /memory 里，且那里引用了未定义变量，页面拿不到）
      model: brain.currentModel?.() ?? null,
      mail: cfg.mail ?? {},
      ambientStats: brain.ambient?.stats ?? {},
      lastChimeAt: brain.ambient?.stats?.lastChimeAt ?? null,
      // 没写进配置文件时实际生效的值（页面用它显示默认值，不用自己再抄一份默认表）
      effective: {
        social: brain.social?.cfg ?? null,
        groupMemory: brain.groupMemory?.cfg ?? null,
        proactive: brain.ambient?.settings ?? null,
      },
      stats: {
        sessions: brain.qqAgents?.size ?? 0,
        toolAllowlist: [...QQ_TOOL_ALLOWLIST],
        online: Boolean(brain.onebot?.connected),
      },
    });
  });

  // 角色卡列表
  route('/dsh-qq/api/personas', (_req, res) => {
    json(res, 200, { ok: true, personas: store.listPersonas(), active: store.cfg?.persona?.active ?? null });
  });

  // 单张角色卡
  route('/dsh-qq/api/persona', (_req, res) => {
    try {
      const url = new URL(_req.url ?? '/', 'http://localhost');
      const file = url.searchParams.get('file') ?? undefined;
      json(res, 200, { ok: true, ...store.readPersona(file) });
    } catch (err) {
      json(res, 400, { ok: false, error: err.message });
    }
  });

  // 保存角色卡 / 切换当前角色卡 / 新建 / 删除
  route('/dsh-qq/api/persona/save', async (req, res) => {
    try {
      const body = await readBody(req);
      if (body.switchTo) {
        store.saveConfig({ ...store.cfg, persona: { ...(store.cfg.persona ?? {}), active: body.switchTo } });
        brain.cfg = store.cfg;
        try {
          brain.persona = store.persona();
        } catch {}
        json(res, 200, { ok: true, switched: body.switchTo });
        return;
      }
      if (body.create) {
        const created = store.createPersona(body.create);
        json(res, 200, { ok: true, ...created });
        return;
      }
      if (body.remove) {
        store.deletePersona(body.remove);
        json(res, 200, { ok: true, removed: body.remove });
        return;
      }
      const saved = store.writePersona(body.file, body.data);
      if (body.file === (store.cfg?.persona?.active ?? '')) {
        try {
          brain.persona = store.persona();
        } catch {}
      }
      json(res, 200, { ok: true, ...saved });
    } catch (err) {
      json(res, 400, { ok: false, error: err.message });
    }
  });

  // 保存配置（白名单、触发方式、主动发言等）
  route('/dsh-qq/api/config', async (req, res) => {
    try {
      const body = await readBody(req);
      // 先校验（类型不对整体拒绝，越界夹到范围内），再深合并——
      // 以前是浅合并，只提交 proactive.pause.sampleRate 会把整个 pause 对象换掉
      const { patch: cleaned, errors, clamped } = validateConfigPatch(body);
      if (errors.length) {
        json(res, 400, { ok: false, error: errors.join('；'), errors });
        return;
      }
      const patch = applyConfigPatch(store.cfg, cleaned);
      const next = store.saveConfig(patch);
      brain.cfg = next;
      if (clamped.length) log('配置值越界已夹到范围内：', JSON.stringify(clamped));
      json(res, 200, {
        ok: true,
        clamped,
        config: {
          access: next.access,
          bot: next.bot,
          proactive: next.proactive,
          limits: next.limits,
          humanize: next.humanize,
          social: next.social,
          groupMemory: next.groupMemory,
          mail: next.mail,
        },
      });
    } catch (err) {
      json(res, 400, { ok: false, error: err.message });
    }
  });

  // 记忆：联系人列表 + 群缓冲概览
  route('/dsh-qq/api/memory', (_req, res) => {
    json(res, 200, {
      ok: true,
      profiles: store.listProfiles(),
      groups: brain.ambient?.snapshot?.() ?? [],
    model: brain.currentModel?.() ?? null,
    mail: store.cfg?.mail ?? {},
    ambientStats: brain.ambient?.stats ?? {},
    lastChimeAt: brain.ambient?.stats?.lastChimeAt ?? null,
    });
  });

  // 记忆：单个联系人
  route('/dsh-qq/api/memory/profile', (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const userId = url.searchParams.get('userId');
      const profile = store.readProfile(userId);
      if (!profile) return json(res, 404, { ok: false, error: '没有这个人的画像' });
      json(res, 200, { ok: true, profile });
    } catch (err) {
      json(res, 400, { ok: false, error: err.message });
    }
  });

  // 模型与思考强度
  route('/dsh-qq/api/model/save', async (req, res) => {
    try {
      const body = await readBody(req);
      if (body.reset) {
        const n = brain.resetSessions?.() ?? 0;
        json(res, 200, { ok: true, reset: n });
        return;
      }
      const model = {
        provider: String(body.provider ?? '').trim(),
        model: String(body.model ?? '').trim(),
        reasoningEffort: String(body.reasoningEffort ?? '').trim(),
      };
      const next = store.saveConfig({ ...store.cfg, plugin: { ...(store.cfg.plugin ?? {}), model } });
      brain.cfg = next;
      log(`模型配置已更新：${model.provider || '默认'}/${model.model || '默认'}/${model.reasoningEffort || '默认'}`);
      json(res, 200, { ok: true, model: brain.currentModel?.() ?? null });
    } catch (err) {
      json(res, 400, { ok: false, error: err.message });
    }
  });

  // 记忆：编辑或删除
  route('/dsh-qq/api/memory/save', async (req, res) => {
    try {
      const body = await readBody(req);
      if (body.remove) {
        store.deleteProfile(body.remove);
        json(res, 200, { ok: true, removed: body.remove });
        return;
      }
      if (body.profile) {
        store.saveProfile(body.profile);
        json(res, 200, { ok: true, profile: body.profile });
        return;
      }
      json(res, 400, { ok: false, error: '缺少 profile 或 remove' });
    } catch (err) {
      json(res, 400, { ok: false, error: err.message });
    }
  });

  // 群级记忆：列表（梗 / 称呼关系 / 话题，每群一份）
  route('/dsh-qq/api/groupmem', (_req, res) => {
    const gm = brain.groupMemory;
    json(res, 200, {
      ok: true,
      enabled: gm?.cfg?.enabled ?? false,
      settings: gm?.cfg ?? null,
      groups: (gm?.list?.() ?? []).map((g) => ({ ...g, running: gm.isRunning?.(g.chatKey) ?? false })),
    });
  });

  // 群级记忆：编辑 / 清空 / 立即总结一次
  route('/dsh-qq/api/groupmem/save', async (req, res) => {
    try {
      const body = await readBody(req);
      const gm = brain.groupMemory;
      if (!gm) return json(res, 503, { ok: false, error: '群级记忆还没就绪' });
      const chatKey = String(body.chatKey ?? '');
      if (!/^group:\d+$/.test(chatKey)) return json(res, 400, { ok: false, error: 'chatKey 必须形如 group:123' });

      if (body.remove) {
        gm.remove(chatKey);
        return json(res, 200, { ok: true, removed: chatKey });
      }
      if (body.summarizeNow) {
        if (gm.isRunning(chatKey)) return json(res, 409, { ok: false, error: '正在总结中' });
        // 手动触发：后台跑，页面稍后刷新列表就能看到结果
        gm.summarize(chatKey).catch((err) => log('手动总结异常:', err?.message ?? err));
        return json(res, 202, { ok: true, started: chatKey });
      }
      if (body.notes) {
        const notes = gm.edit(chatKey, body.notes);
        if (!notes) return json(res, 400, { ok: false, error: '记忆内容不合法' });
        return json(res, 200, { ok: true, chatKey, notes });
      }
      json(res, 400, { ok: false, error: '缺少 notes、remove 或 summarizeNow' });
    } catch (err) {
      json(res, 400, { ok: false, error: err.message });
    }
  });

  // 表情包原图（设置页缩略图用；只读、按 hash 取）
  route('/dsh-qq/api/stickers/file', (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const hash = url.searchParams.get('hash');
      const item = (brain.stickers?.list?.(500) ?? []).find((s) => s.hash === hash);
      if (!item?.path) {
        res.statusCode = 404;
        res.end('');
        return;
      }
      const buf = readFileSync(item.path);
      res.statusCode = 200;
      res.setHeader('Content-Type', item.media_type || 'image/png');
      res.setHeader('Cache-Control', 'private, max-age=600');
      res.end(buf);
    } catch (err) {
      log('表情包文件读取失败:', err?.message ?? err);
      res.statusCode = 500;
      res.end(String(err?.message ?? err));
    }
  });

  // 表情包库
  route('/dsh-qq/api/stickers', (_req, res) => {
    const store2 = brain.stickers;
    json(res, 200, {
      ok: true,
      count: store2?.count?.() ?? 0,
      autoSave: store.cfg.stickers?.autoSave ?? 'stickers',
      visionMode: store.cfg.stickers?.visionMode ?? 'onDemand',
      items: (store2?.list?.(60) ?? []).map((s) => ({
        hash: s.hash,
        path: s.path,
        tags: s.tags ?? '',
        score: s.score ?? 1,
        uses: s.uses ?? 0,
        context: s.context ?? '',
        addedAt: s.added_at,
        uses: s.uses ?? 0,
      })),
    });
  });

  route('/dsh-qq/api/stickers/save', async (req, res) => {
    try {
      const body = await readBody(req);
      if (body.visionMode) {
        const next = store.saveConfig({
          ...store.cfg,
          stickers: { ...(store.cfg.stickers ?? {}), visionMode: body.visionMode },
        });
        brain.cfg = next;
        json(res, 200, { ok: true, visionMode: body.visionMode });
        return;
      }
      if (body.autoSave) {
        const next = store.saveConfig({ ...store.cfg, stickers: { ...(store.cfg.stickers ?? {}), autoSave: body.autoSave } });
        brain.cfg = next;
        json(res, 200, { ok: true, autoSave: body.autoSave });
        return;
      }
      if (body.remove) {
        brain.stickers?.remove?.(body.remove);
        json(res, 200, { ok: true, removed: body.remove });
        return;
      }
      if (body.tags && body.hash) {
        brain.stickers?.setTags?.(body.hash, body.tags);
        json(res, 200, { ok: true });
        return;
      }
      json(res, 400, { ok: false, error: '缺少参数' });
    } catch (err) {
      json(res, 400, { ok: false, error: err.message });
    }
  });

  log('设置接口已注册：/dsh-qq/api/*');
  return true;
}







