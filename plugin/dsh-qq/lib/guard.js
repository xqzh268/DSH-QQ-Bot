/**
 * 工具白名单闸 + 文件路径 confinement。
 *
 * 两件为什么需要：
 * 1) profile 里的产品 bundle（mail/wechat/terminal/team/browser…）是在**宿主层**
 *    挂工具的，preset 拿不掉，所以只能在派发层按 agent 拦（tools/pre-execute）。
 * 2) 群友能驱动她之后，`read` 默认可以读本机任意文件——所以再加一层：
 *    非主人私聊时，所有文件路径必须落在 qq-sandbox 里。
 */
import { resolve, relative, isAbsolute, sep } from 'node:path';

export const QQ_TOOL_ALLOWLIST = new Set([
  'read', // 读文件
  'write', // 写文件
  'edit', // 改文件
  'glob', // 找文件
  'grep', // 搜内容
  'read_image', // 看图片
  'web_search', // 查资料
  'web_fetch', // 读网页
  'todo_write', // 待办
]);

/** 只读邮件工具：仅主人私聊可用（mail_send 不在其中，永不放行） */
export const MAIL_READ_TOOLS = new Set(['mail_find', 'mail_read', 'mail_list_folders']);

/** 这些工具的某个参数是文件路径，需要做工作区校验 */
const PATH_TOOLS = new Set(['read', 'write', 'edit', 'glob', 'grep', 'read_image']);

/** 一眼像路径：绝对路径、带分隔符、或 ~ 开头 */
function looksLikePath(v) {
  if (typeof v !== 'string' || !v) return false;
  if (v.length > 900) return false;
  if (/^[a-zA-Z]:[\\/]/.test(v)) return true; // C:\ / C:/
  if (v.startsWith('/') || v.startsWith('\\')) return true;
  if (v.startsWith('~')) return true;
  if (v.includes('/') || v.includes('\\')) return true;
  if (v === '.' || v === '..') return true;
  return false;
}

/** 目标是否在 root 之内（含 root 本身） */
export function isInsideRoot(root, target) {
  try {
    const base = resolve(root);
    const abs = resolve(base, String(target));
    const rel = relative(base, abs);
    if (rel === '') return true;
    return !rel.startsWith('..') && !isAbsolute(rel);
  } catch {
    return false;
  }
}

/** 收集一次调用里所有"像路径"的参数（键名或形态） */
export function collectPathArgs(args, depth = 0) {
  const out = [];
  if (depth > 3 || !args || typeof args !== 'object') return out;
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === 'string') {
      const keyLooksPath = /(path|file|dir|folder|root|cwd|target|source|destination)/i.test(key);
      if (keyLooksPath || looksLikePath(value)) out.push({ key, value });
    } else if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === 'string' && looksLikePath(item)) out.push({ key, value: item });
      }
    } else if (value && typeof value === 'object') {
      out.push(...collectPathArgs(value, depth + 1));
    }
  }
  return out;
}

/** 只读工具额外可访问的目录（表情包库）——写操作不享受这个例外 */
export const READ_ONLY_TOOLS = new Set(['read', 'read_image', 'glob', 'grep']);

/** 返回第一个越界的路径；没有则 null */
export function findOutsidePath(toolName, args, workspaceDir, extraReadRoots = []) {
  if (!PATH_TOOLS.has(toolName)) return null;
  const readable = READ_ONLY_TOOLS.has(toolName) ? [workspaceDir, ...extraReadRoots] : [workspaceDir];
  const candidates = collectPathArgs(args);
  for (const { key, value } of candidates) {
    // 纯 glob 模式（含 * ? [）不当路径校验，否则 "*.md" 会被误判
    if (/[*?[\]]/.test(value) && !value.includes(sep)) continue;
    if (!readable.some((root) => isInsideRoot(root, value))) return { key, value };
  }
  return null;
}

export function installToolGuard(ctx, brain, log) {
  if (typeof ctx?.on !== 'function') {
    log('ctx.on 不可用，工具白名单没装上（这是危险的，请告诉我）');
    return false;
  }
  try {
    ctx.on('tools/pre-execute', async (exec, next) => {
      try {
        const agentId = exec?.agent?.id ?? exec?.agentId ?? exec?.caller?.id;
        if (!brain.isQqAgent(agentId)) return next();

        const name = exec?.name ?? exec?.tool?.name ?? exec?.call?.name;
        brain.noteToolUse?.(agentId, name);

        // 先算身份：主人私聊才有额外权限
        const speaker = brain.speakerFor?.(agentId);
        const ownerId = String(brain.cfg?.bot?.ownerId ?? '');
        const isOwnerPrivate = Boolean(
          speaker && speaker.kind === 'private' && ownerId && String(speaker.userId) === ownerId,
        );

        if (!QQ_TOOL_ALLOWLIST.has(name)) {
          // 邮件只读：只有主人私聊能用，且配置里开了邮件助理
          const mailAllowed =
            MAIL_READ_TOOLS.has(name) && isOwnerPrivate && brain.cfg?.mail?.enabled !== false;
          if (!mailAllowed) {
            log(`已拦截 QQ 会话的工具调用：${name}${MAIL_READ_TOOLS.has(name) ? '（邮件只对主人私聊开放）' : ''}`);
            const hint = MAIL_READ_TOOLS.has(name)
              ? '邮件我只能私下帮你看，群里或者别人问都不行。'
              : `我在 QQ 里没有「${name}」这个能力。我能做的：读写工作目录里的文件、搜索、联网查资料。`;
            return { kind: 'deny', reason: hint };
          }
        }

        // 文件路径 confinement：主人私聊放开，其余一律锁在 qq-sandbox
        const unrestricted = isOwnerPrivate;

        if (!unrestricted) {
          const workspaceDir = brain.workspaceDir?.() ?? '';
          const extraRoots = brain.extraReadRoots?.() ?? [];
          const bad = workspaceDir ? findOutsidePath(name, exec?.arguments ?? {}, workspaceDir, extraRoots) : null;
          if (bad) {
            log(`已拦截越界路径：${name} ${bad.key}=${bad.value}`);
            const short = String(bad.value).slice(0, 120);
            return {
              kind: 'deny',
              reason:
                `我只能访问自己的工作目录，不能碰 ${short}。` +
                '如果要处理文件，请先把内容贴给我，或者我把结果写到工作目录里给你。',
            };
          }
        }

        return next();
      } catch (err) {
        log('工具闸异常，按放行处理:', err?.message ?? err);
        return next();
      }
    });
    log(`工具白名单已安装（${QQ_TOOL_ALLOWLIST.size} 项），文件路径限制为工作目录内（主人私聊除外）`);
    return true;
  } catch (err) {
    log('工具白名单安装失败:', err?.message ?? err);
    return false;
  }
}
