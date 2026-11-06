// 上下文时效性自测：时间窗口 / 中断截断 / 她说过的内容 / 提示词渲染
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MessageDB } from './dsh-qq/lib/msgdb.js';
import { Ambient } from './dsh-qq/lib/ambient.js';
import { buildPrompt } from './dsh-qq/lib/prompt.js';

let bad = 0;
const ok = (m) => console.log(`  ✓ ${m}`);
const no = (m, d = '') => {
  console.log(`  ✗ ${m}${d ? ` —— ${d}` : ''}`);
  bad += 1;
};
const safeRm = (dir) => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {}
};

const MIN = 60 * 1000;

// ---------- MessageDB：self 标记 ----------
{
  const dir = mkdtempSync(join(tmpdir(), 'qqctx-'));
  const db = new MessageDB(dir, () => {});
  const key = 'group:9';
  const now = Date.now();
  db.append({ chatKey: key, groupId: '9', userId: 'u1', nickname: 'A', text: '群里说的', at: now - 1000 });
  db.append({ chatKey: key, groupId: '9', userId: 'self', nickname: '我', text: '她回的话', at: now, self: true });

  const rows = db.recent(key, 10);
  const others = rows.filter((r) => !r.self);
  const mine = db.selfSaid(key, 5);
  others.length === 1 && others[0].text === '群里说的' ? ok('self 标记正确（群友消息不算她说的）') : no('self 标记错误', JSON.stringify(rows));
  mine.length === 1 && mine[0].text === '她回的话' ? ok('能取回她自己说过的话') : no('selfSaid 失败', JSON.stringify(mine));
  db.close();
  safeRm(dir);
}

// ---------- Ambient.recent：时效窗口 + 中断截断 ----------
{
  const dir = mkdtempSync(join(tmpdir(), 'qqwin-'));
  try {
    const store = { dir, profile: () => ({}), boundSession: () => 's', listProfiles: () => [] };
    const brain = {
      cfg: { access: { groups: ['9'] }, proactive: { recentWindowMinutes: 30, topicGapMinutes: 20 } },
      proactiveSay: async () => null,
    };
    const ambient = new Ambient({ brain, store, log: () => {} });
    const key = 'group:9';
    const now = Date.now();
    // 2 小时前的旧话题 → 不该出现
    ambient.db.append({ chatKey: key, groupId: '9', userId: 'u1', nickname: 'A', text: '两小时前的话题', at: now - 120 * MIN });
    // 35 分钟前 → 超出 30 分钟窗口
    ambient.db.append({ chatKey: key, groupId: '9', userId: 'u1', nickname: 'A', text: '三十五分钟前', at: now - 35 * MIN });
    // 中断 25 分钟（> topicGap 20）→ 更早的应被截断
    ambient.db.append({ chatKey: key, groupId: '9', userId: 'u2', nickname: 'B', text: '二十五分钟前', at: now - 25 * MIN });
    ambient.db.append({ chatKey: key, groupId: '9', userId: 'u3', nickname: 'C', text: '刚刚说的话', at: now - 1 * MIN });

    const list = ambient.recent(key);
    const texts = list.map((x) => x.text);
    texts.includes('刚刚说的话') ? ok('当下的消息在上下文里') : no('当下消息丢失');
    !texts.some((t) => t.includes('两小时前')) ? ok('两小时前的旧话题被排除') : no('旧话题仍被翻出来', JSON.stringify(texts));
    !texts.some((t) => t.includes('二十五分钟前')) ? ok('中断超过阈值的前文被截断') : no('中断前的内容仍带着', JSON.stringify(texts));
    list.every((x) => typeof x.at === 'number') ? ok('上下文带时间戳（可判断新鲜度）') : no('缺少时间戳');

    // 她自己说的不算进"群里在聊"
    ambient.rememberSelf(key, '我已经回过这句了');
    !ambient.recent(key).some((x) => x.text === '我已经回过这句了') ? ok('她自己说的话不算群聊内容') : no('自己的话混进群聊上下文');
    ambient.selfSaid(key)[0]?.text === '我已经回过这句了' ? ok('她说过的话单独可取') : no('selfSaid 取不到');

    ambient.stop();
  } finally {
    safeRm(dir);
  }
}

// ---------- 提示词渲染 ----------
{
  const persona = { name: '阿棠', identity: 'x', speech: { tone: 't' }, personality: [], boundaries: [] };
  const profile = { userId: '1', nickname: '甲', traits: [], facts: [], episodes: [], interactions: 1 };
  const event = { kind: 'group', groupId: '9', chatKey: 'group:9', userId: '1', nickname: '甲', text: '刚才那个怎么弄', atMe: false };
  const now = Date.now();
  const out = buildPrompt({
    persona,
    profile,
    event,
    proactive: true,
    recent: [{ nickname: '乙', text: '这个boss怎么打', at: now - 2 * MIN }],
    selfSaid: [{ text: '先躲技能', at: now - 1 * MIN }],
  });
  out.includes('【你刚在群里说过】') ? ok('提示词包含"她刚说过"') : no('缺少 selfBlock');
  /\d{2}:\d{2}，\d+ 分钟前/.test(out) ? ok('提示词里群聊带具体时刻+相对时间') : no('缺少时间');
  /先躲技能（\d{2}:\d{2}，\d+ 分钟前）/.test(out) ? ok('她说过的话也带时间') : no('selfBlock 没渲染', out.slice(0, 300));
}

// ---------- 交织时间线 + 触发消息去重 ----------
{
  const dir = mkdtempSync(join(tmpdir(), 'qqtl-'));
  try {
    const store = { dir, profile: () => ({}), boundSession: () => 's', listProfiles: () => [] };
    const brain = { cfg: { access: { groups: ['9'] }, proactive: {} }, proactiveSay: async () => null };
    const ambient = new Ambient({ brain, store, log: () => {} });
    const key = 'group:9';
    const t = Date.now();
    const add = (nick, text, at, self = false) =>
      ambient.db.append({ chatKey: key, groupId: '9', userId: self ? 'self' : nick, nickname: nick, text, at, self });
    add('乙', '这个boss怎么打', t - 5000);
    add('我', '先躲技能', t - 4000, true);
    add('乙', '躲不掉啊', t - 3000);
    add('甲', '你们在说啥', t - 2000);
    add('甲', '帮我看一下', t - 1000); // 触发消息（合并范围 t-2000 ~ t-1000）

    const full = ambient.timeline(key);
    full.map((r) => r.text).join('|') === '这个boss怎么打|先躲技能|躲不掉啊|你们在说啥|帮我看一下'
      ? ok('她的话按真实先后和群友的话排在一起')
      : no('时间线顺序不对', full.map((r) => r.text).join('|'));
    full.find((r) => r.text === '先躲技能')?.self === true ? ok('她自己的发言带 self 标记') : no('self 标记丢了');

    const cut = ambient.timeline(key, { nickname: '甲', from: t - 2000, to: t - 1000 });
    !cut.some((r) => r.nickname === '甲') && cut.length === 3 ? ok('触发消息（含合并的那几条）从时间线里剔除，别人的不动') : no('去重不对', JSON.stringify(cut.map((r) => r.text)));

    const p = buildPrompt({
      persona: { name: '阿棠', identity: 'x', speech: {} },
      profile: { userId: '1', nickname: '甲', traits: [], facts: [], episodes: [], interactions: 0 },
      event: { kind: 'group', groupId: '9', text: '帮我看一下', atMe: true },
      staticsInSystem: true,
      timeline: cut,
      selfSaid: [{ text: '先躲技能', at: t }],
    });
    /我：先躲技能（/.test(p) ? ok('提示词里她的话标成「我」') : no('没有标「我」');
    !p.includes('【你刚在群里说过】') ? ok('有时间线时不再重复单列"她说过的话"') : no('selfBlock 重复出现');
    ambient.stop();
  } finally {
    safeRm(dir);
  }
}

console.log('');
if (bad) {
  console.log(`✗ ${bad} 项失败`);
  process.exit(1);
}
console.log('✓ 上下文时效性验证通过');


