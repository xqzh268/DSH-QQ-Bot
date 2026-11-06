// 群记忆遗忘机制自测：休眠 / 唤醒 / 上限 / 保护期 / 手工编辑不丢休眠区 / 总结流程接入
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyForgetting, wakeFor, itemKey, hitsIn, forgetConfig } from './dsh-qq/lib/forget.js';
import { GroupMemory } from './dsh-qq/lib/groupmem.js';
import { MessageDB } from './dsh-qq/lib/msgdb.js';
import { renderNotes } from './dsh-qq/lib/groupmem.js';

let failed = 0;
const ok = (m) => console.log('  ✓', m);
const no = (m, d = '') => {
  failed += 1;
  console.log('  ✗', m, d);
};
const DAY = 86400000;
const safeRm = (d) => {
  try {
    rmSync(d, { recursive: true, force: true });
  } catch {}
};

// ---------- 关键词 ----------
itemKey('「懒鱼」梗：男子让我学别人家的鱼') === '懒鱼' ? ok('取「书名号」里的词当关键词') : no('书名号关键词不对', itemKey('「懒鱼」梗：x'));
itemKey('白米饭梗：男子说我就知道吃大米饭') === '白米饭梗' ? ok('没有书名号时取冒号前的词') : no('冒号前关键词不对', itemKey('白米饭梗：x'));
itemKey('甲 喊她女儿') === '甲 喊她女儿' ? ok('没标点的短句取整句（最多 8 字）') : no('短句关键词不对', itemKey('甲 喊她女儿'));
hitsIn('懒鱼', ['你这条懒鱼', '别的', '懒鱼！']) === 2 && hitsIn('x', ['x']) === 0 ? ok('统计触发次数；太短的词不统计') : no('hitsIn 不对');

// ---------- 休眠：闲置太久 + 触发少 ----------
{
  const now = Date.now();
  const lore = ['「热梗」天天说', '「冷梗」没人提', '「老梗」曾经很火', '「新梗」刚出现', '「梗五」x', '「梗六」x'];
  const stats = {
    热梗: { h: 5, t: now - DAY, c: now - 20 * DAY },
    冷梗: { h: 0, t: 0, c: now - 30 * DAY },
    老梗: { h: 9, t: now - 30 * DAY, c: now - 60 * DAY }, // 触发多，虽然闲置也不因闲置休眠
    新梗: { h: 0, t: 0, c: now - 1 * DAY },
    梗五: { h: 1, t: now - 2 * DAY, c: now - 9 * DAY },
    梗六: { h: 1, t: now - 2 * DAY, c: now - 9 * DAY },
  };
  const r = applyForgetting({ notes: { lore, relations: [], topics: ['话题'] }, stats, texts: ['聊点别的'], now });
  r.notes.lore.includes('「热梗」天天说') && r.notes.lore.includes('「老梗」曾经很火') && r.notes.lore.includes('「新梗」刚出现') ? ok('热梗、触发多的老梗、新条目（保护期）留在活跃区') : no('不该休眠的休眠了', JSON.stringify(r.notes.lore));
  !r.notes.lore.includes('「冷梗」没人提') && r.notes.dormant.lore.includes('「冷梗」没人提') ? ok('长期没人提、触发又少的转入休眠区（没有删除）') : no('冷梗没休眠', JSON.stringify(r.notes));
  r.notes.topics[0] === '话题' ? ok('话题不参与遗忘') : no('话题被动了');
  r.notes.lore.length + r.notes.dormant.lore.length === lore.length ? ok('活跃 + 休眠 = 原来的总数，没有凭空丢失') : no('条数对不上');
}

// ---------- 本次聊天里被提到：热度更新，不会休眠 ----------
{
  const now = Date.now();
  const stats = { 冷梗: { h: 0, t: 0, c: now - 30 * DAY } };
  const r = applyForgetting({ notes: { lore: ['「冷梗」没人提', '「甲」a', '「乙」b', '「丙」c', '「丁」d'], relations: [], topics: [] }, stats, texts: ['又是冷梗'], now });
  r.notes.lore.includes('「冷梗」没人提') && r.stats['冷梗'].h === 1 ? ok('这段聊天里提到了它，记一次触发、不休眠') : no('被提到却休眠了', JSON.stringify(r.notes.lore));
}

// ---------- 休眠区里的记忆被聊到：醒来；模型又写出来：不重复 ----------
{
  const now = Date.now();
  const r = applyForgetting({
    notes: { lore: ['「甲」a', '「乙」b', '「丙」c', '「丁」d'], relations: [], topics: [] },
    dormant: { lore: ['「睡梗」以前的梗', '「丙」c 的旧写法'], relations: [] },
    stats: {},
    texts: ['睡梗又回来了'],
    now,
  });
  r.notes.lore.includes('「睡梗」以前的梗') && r.changes.woke.length === 1 ? ok('休眠的记忆被聊到后回到活跃区') : no('没醒来', JSON.stringify(r));
  !r.notes.dormant.lore.some((t) => itemKey(t) === '丙') ? ok('模型重新写出的同关键词条目，不会在休眠区里重复存在') : no('休眠区有重复', JSON.stringify(r.notes.dormant));
}

// ---------- 活跃区上限：超出时最冷的休眠，且至少保留 minKeep ----------
{
  const now = Date.now();
  const lore = Array.from({ length: 16 }, (_, i) => `「梗${String.fromCharCode(65 + i)}」内容`);
  const stats = {};
  lore.forEach((t, i) => (stats[itemKey(t)] = { h: i, t: now - DAY, c: now - 3 * DAY }));
  const r = applyForgetting({ notes: { lore, relations: [], topics: [] }, stats, texts: [], now, cfg: { maxLore: 12 } });
  r.notes.lore.length === 12 && r.notes.dormant.lore.length === 4 ? ok('超过上限 12 条时，多出的 4 条最冷的转入休眠') : no('上限没生效', `${r.notes.lore.length}/${r.notes.dormant.lore.length}`);
  r.notes.dormant.lore.every((t) => ['梗a', '梗b', '梗c', '梗d'].includes(itemKey(t))) ? ok('休眠的是触发最少的那几条') : no('休眠对象不对', JSON.stringify(r.notes.dormant.lore));
  const r2 = applyForgetting({ notes: { lore: ['「甲」a', '「乙」b', '「丙」c'], relations: [], topics: [] }, stats: { 甲: { h: 0, t: 0, c: now - 99 * DAY }, 乙: { h: 0, t: 0, c: now - 99 * DAY }, 丙: { h: 0, t: 0, c: now - 99 * DAY } }, texts: [], now });
  r2.notes.lore.length === 3 ? ok('条数不多时不会一次清空（至少保留 minKeep 条）') : no('清空了', JSON.stringify(r2.notes));
}

// ---------- 休眠区上限：最冷的永久丢弃 ----------
{
  const now = Date.now();
  const lore = Array.from({ length: 10 }, (_, i) => `「冷${i}」x`);
  const stats = {};
  lore.forEach((t) => (stats[itemKey(t)] = { h: 0, t: 0, c: now - 90 * DAY }));
  const r = applyForgetting({ notes: { lore, relations: [], topics: [] }, stats, texts: [], now, cfg: { minKeep: 3, maxDormant: 2 } });
  r.notes.dormant.lore.length === 2 && r.changes.dropped.length === 5 ? ok('休眠区超上限时，最冷的被永久丢弃') : no('休眠区上限没生效', JSON.stringify([r.notes.dormant.lore.length, r.changes.dropped.length]));
}

// ---------- 总开关 ----------
{
  const now = Date.now();
  const lore = Array.from({ length: 20 }, (_, i) => `「梗${i}」x`);
  const r = applyForgetting({ notes: { lore, relations: [], topics: [] }, stats: {}, texts: [], now, cfg: { enabled: false } });
  r.notes.lore.length === 20 && r.notes.dormant.lore.length === 0 ? ok('关闭遗忘后全部保持活跃') : no('关闭后仍遗忘');
  forgetConfig({ maxLore: 9999, idleDays: -3 }).maxLore === 60 && forgetConfig({ idleDays: -3 }).idleDays === 1 ? ok('配置值被限制在合理范围内') : no('配置没限幅');
}

// ---------- 回复时唤醒 ----------
{
  const notes = { lore: ['「活」a'], relations: [], topics: [], dormant: { lore: ['「睡梗」以前的梗', '「别的」z'], relations: ['小呆 是她的外号'] } };
  const w = wakeFor({ notes, context: '今天又聊到睡梗了' });
  w.woken.length === 1 && w.notes.lore.includes('「睡梗」以前的梗') && !notes.lore.includes('「睡梗」以前的梗') ? ok('聊到休眠的记忆时临时带上，且不改原对象') : no('唤醒不对', JSON.stringify(w));
  wakeFor({ notes, context: '完全无关' }).woken.length === 0 ? ok('没提到就不唤醒') : no('乱唤醒');
  const many = wakeFor({ notes: { lore: [], relations: [], topics: [], dormant: { lore: ['「梗一」x', '「梗二」x', '「梗三」x', '「梗四」x'], relations: [] } }, context: '梗一梗二梗三梗四', cfg: { wake: 2 } });
  many.woken.length === 2 ? ok('一次最多唤醒 wake 条') : no('唤醒数量没限制', String(many.woken.length));
  const rendered = renderNotes(notes).join('\n');
  !rendered.includes('睡梗') ? ok('休眠的记忆不会被渲染进提示词') : no('休眠记忆进了提示词');
}

// ---------- 接入总结流程（真实库）----------
{
  const dir = mkdtempSync(join(tmpdir(), 'qqforget-'));
  try {
    const db = new MessageDB(dir, () => {});
    const logs = [];
    let reply = JSON.stringify({
      lore: ['「新梗」刚聊的', '「冷梗」没人提', '「甲」a', '「乙」b', '「丙」c', '「丁」d'],
      relations: [],
      topics: ['午饭'],
    });
    const brain = {
      cfg: { access: { groups: ['1'] }, groupMemory: { everyMessages: 5, minIntervalMinutes: 0, maxPerDay: 99, forget: { maxLore: 5, minKeep: 2 } } },
      persona: { name: '小鱼' },
      askOnce: async () => reply,
    };
    const gm = new GroupMemory({ brain, db, log: (...a) => logs.push(a.join(' ')) });
    const add = (n, text) => {
      for (let i = 0; i < n; i += 1) db.append({ chatKey: 'group:1', groupId: '1', userId: `u${i % 3}`, nickname: `u${i % 3}`, text: text(i), at: Date.now() + i });
    };
    add(8, (i) => `聊新梗 ${i}`);
    const n1 = await gm.summarize('group:1');
    n1.lore.length === 5 && n1.dormant.lore.length === 1 ? ok('总结后超过上限的记忆转入休眠区并落库') : no('总结没触发遗忘', JSON.stringify(n1));
    const saved = db.getGroupNotes('group:1').notes;
    saved.dormant.lore.length === 1 && !renderNotes(saved).join('').includes(saved.dormant.lore[0]) ? ok('落库的休眠区不会进提示词文字') : no('落库/渲染不对');
    const sleptKey = itemKey(saved.dormant.lore[0]);

    // 回复时提到它 → 醒来（不改库里的活跃区）
    const woke = gm.notesFor('group:1', `你还记得${sleptKey}吗`);
    woke.lore.some((t) => itemKey(t) === sleptKey) && !gm.notesFor('group:1', '无关').lore.some((t) => itemKey(t) === sleptKey)
      ? ok('回复时聊到休眠的记忆，临时带上；之后没提到又不带了')
      : no('回复时唤醒不对', JSON.stringify(woke));
    logs.some((l) => l.includes('唤醒了休眠的群记忆')) ? ok('唤醒会写日志') : no('没有唤醒日志');

    // 手工编辑只改活跃区，休眠区保留
    const edited = gm.edit('group:1', { lore: ['「手写」梗'], relations: [], topics: [] });
    edited.dormant?.lore?.length === 1 ? ok('手工编辑后休眠区仍保留') : no('编辑丢了休眠区', JSON.stringify(edited));

    // 休眠区里的被聊到 → 下次总结时醒来回到活跃区
    reply = JSON.stringify({ lore: ['「手写」梗'], relations: [], topics: [] });
    add(8, (i) => `${sleptKey} 又来了 ${i}`);
    const n2 = await gm.summarize('group:1');
    n2.lore.some((t) => itemKey(t) === sleptKey) && !(n2.dormant.lore ?? []).some((t) => itemKey(t) === sleptKey) ? ok('总结时发现休眠的被聊到了，回到活跃区') : no('总结时没醒来', JSON.stringify(n2));
    logs.some((l) => l.includes('群记忆遗忘')) ? ok('遗忘动作写进日志') : no('没有遗忘日志');
    db.close();
  } finally {
    safeRm(dir);
  }
}

console.log(failed ? `\n${failed} 项失败` : '\n✓ 群记忆遗忘机制验证通过');
process.exit(failed ? 1 : 0);
