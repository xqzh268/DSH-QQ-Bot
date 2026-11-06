// 人设与记忆装配：把"她是谁"+"对方是谁"+"聊到哪了"拼成一次调用的输入。
// DSH headless 只接受一段任务文本，所以这里做的是一层"信封"：上下文在前，用户消息在后。
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './config.js';

const MEMO_OPEN = '<<MEMO>>';
const MEMO_CLOSE = '<</MEMO>>';

export function loadPersona(relPath) {
  const file = relPath.startsWith(':') ? null : join(ROOT, relPath);
  if (!file || !existsSync(file)) {
    throw new Error(`角色卡不存在：${relPath}`);
  }
  const p = JSON.parse(readFileSync(file, 'utf8'));
  for (const key of ['id', 'name', 'identity', 'speech']) {
    if (!p[key]) throw new Error(`角色卡缺少字段 ${key}：${relPath}`);
  }
  return p;
}

function formatProfile(profile) {
  const lines = [];
  lines.push(`- 称呼：${profile.nickname}（QQ ${profile.userId}）`);
  if (profile.traits?.length) lines.push(`- 印象：${profile.traits.slice(0, 8).join('、')}`);
  if (profile.facts?.length) lines.push(`- 已知事实：${profile.facts.slice(-10).join('；')}`);
  if (profile.interactions) lines.push(`- 已经聊过 ${profile.interactions} 次`);
  const eps = (profile.episodes ?? []).slice(-8);
  if (eps.length) {
    lines.push('- 最近聊过：');
    for (const e of eps) lines.push(`  · ${e.at?.slice(5, 16).replace('T', ' ')} ${e.text}`);
  }
  return lines.join('\n');
}

function buildPersonaBlock(persona) {
  const speech = persona.speech ?? {};
  return [
    `你的名字是「${persona.name}」。${persona.identity}`,
    persona.tagline ? `一句话定位：${persona.tagline}` : '',
    persona.avatar ? `形象：${persona.avatar}` : '',
    persona.personality?.length ? `性格：${persona.personality.join('、')}` : '',
    speech.tone ? `说话方式：${speech.tone}` : '',
    speech.habits?.length ? `口头习惯：${speech.habits.join('；')}` : '',
    speech.avoid?.length ? `绝对不要说：${speech.avoid.join('；')}` : '',
    persona.boundaries?.length ? `边界：${persona.boundaries.join('；')}` : '',
    speech.examples?.length ? `语气参考（不要照抄）：\n${speech.examples.join('\n')}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

const TASK_MODE_RULES = `【运行环境】
你在 QQ 里以「${'{{name}}'}」的身份和真人群友聊天，不是客服，也不是助手。你有两种状态：
1) 闲聊：短，像打字，一般 1-3 句，不用 Markdown，不用列表，不用「首先其次」。
2) 干活：有人明确要你查资料、写文档、整理数据、操作文件时，你可以使用工具把事情做完，再用聊天口吻汇报结果。别把过程日志念给对方听。
对方看不到你的思考过程，只看到你发出去的正文。`;

const MEMO_RULES = `【记忆回写】
如果这轮对话让你对这个人有了新的了解，请在回复的最末尾另起一行输出：
${MEMO_OPEN}{"traits":["不超过2个短词"],"facts":["一句话事实"],"episode":"一句话概括这轮聊了什么"}${MEMO_CLOSE}
这段标记会被系统截掉，不会发给对方。没有新信息就整段省略。`;

/**
 * 组装一次调用的完整提示。
 * @param {object} ctx
 * @param {object} ctx.persona
 * @param {object} ctx.profile
 * @param {object} ctx.event 归一化后的事件
 * @param {boolean} ctx.proactive 是否主动发起
 */
export function buildPrompt({ persona, profile, event, proactive = false, extraNote = '' }) {
  const where =
    event.kind === 'group'
      ? `你正在一个 QQ 群（群号 ${event.groupId}）里。现在是「${profile.nickname}」在说话，你的回复会被群里所有人看到，所以别太私密。`
      : `你和「${profile.nickname}」在私聊。`;

  const reason = proactive
    ? '这条不是对方问你的，是你自己想说的话。'
    : event.kind === 'poke'
      ? '对方戳了戳你，是在找你。'
      : event.atMe
        ? '对方 @ 了你。'
        : '';

  const envelope = [
    '【身份】',
    buildPersonaBlock(persona).replaceAll('{{name}}', persona.name),
    '',
    TASK_MODE_RULES.replaceAll('{{name}}', persona.name),
    '',
    '【场景】',
    where,
    reason,
    '',
    '【你记得的这个人】',
    formatProfile(profile),
    '',
    MEMO_RULES,
    extraNote ? `\n【补充】\n${extraNote}` : '',
    '',
    '【对方这次说的】',
    event.text || '（没有文字内容）',
    '',
    '请直接给出要发到 QQ 里的那段话。',
  ]
    .filter((x) => x !== undefined)
    .join('\n');

  return envelope;
}

/** 从模型输出里剥出 <<MEMO>> 并返回干净正文 + 记忆增量 */
export function splitMemo(text) {
  if (!text) return { clean: '', memo: null };
  const start = text.lastIndexOf(MEMO_OPEN);
  const end = text.lastIndexOf(MEMO_CLOSE);
  if (start === -1 || end === -1 || end < start) return { clean: text.trim(), memo: null };
  const raw = text.slice(start + MEMO_OPEN.length, end).trim();
  const clean = (text.slice(0, start) + text.slice(end + MEMO_CLOSE.length)).trim();
  let memo = null;
  try {
    memo = JSON.parse(raw);
  } catch {
    memo = null;
  }
  return { clean, memo };
}
