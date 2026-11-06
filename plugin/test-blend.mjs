// 融入群聊：对人的印象淡忘 / 口癖降频 / 话痨刹车 / 图片不算话题 / 气泡间隔随字数 / 分享不点名
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatProfile, buildSystemPrompt } from './dsh-qq/lib/prompt.js';
import { varyTics } from './dsh-qq/lib/sanitize.js';
import { bubbleGap, planBubbles } from './dsh-qq/lib/humanize.js';
import { Ambient } from './dsh-qq/lib/ambient.js';

let bad = 0;
const ok = (m) => console.log(`  ✓ ${m}`);
const no = (m, d = '') => {
  console.log(`  ✗ ${m}${d ? ` —— ${d}` : ''}`);
  bad += 1;
};
const t = (cond, m, d) => (cond ? ok(m) : no(m, d));

// ---------- 对人的印象淡忘 ----------
{
  const now = Date.parse('2026-11-05T12:00:00Z');
  const day = 86400000;
  const iso = (ms) => new Date(ms).toISOString();
  const p = {
    userId: '1', nickname: '正正',
    traits: ['爱玩游戏', '记仇', '话多', 'a', 'b', 'c', 'd'],
    facts: ['在上海', '老提醒我打武轩，记性真好', '养了猫'],
    interactions: 9,
    episodes: [
      { at: iso(now - 30 * day), text: '聊过电影' },
      { at: iso(now - 2 * day), text: '问了个报错' },
      { at: iso(now - 1 * day), text: '和她吵起来了' },
      { at: iso(now - 1 * day), text: '分享了一张照片' },
    ],
  };
  const out = formatProfile(p, now);
  t(!/聊过电影/.test(out), '超过 10 天的交流不再带上');
  t(/问了个报错/.test(out) && /分享了一张照片/.test(out), '近几天的交流还在');
  t(!/吵起来/.test(out), '带冲突色彩的交流不进提示词');
  t(!/记仇/.test(out) && !/记性真好/.test(out), '记仇 / 带刺的印象和事实被淡忘');
  t(/在上海/.test(out) && /养了猫/.test(out), '普通事实保留');
  t(out.split('、').length <= 5 + 2, '印象词有上限');
  t(/别拿来当梗/.test(out), '近况标注为背景而不是梗');
}

// ---------- 口癖降频 ----------
{
  t(varyTics('诶 这个我没见过', ['诶 好神奇', '哈哈']) === '这个我没见过', '最近刚用过"诶"开头，这句去掉');
  t(varyTics('诶 这个我没见过', ['好的', '哈哈']) === '诶 这个我没见过', '最近没用过就保留');
  t(varyTics('哼 才没有', ['诶 好神奇']) === '哼 才没有', '不同的语气词互不影响');
  t(varyTics('诶', ['诶 好神奇']) === '诶', '去掉后没内容就不动');
  t(varyTics('是我用错词了吗 这个梗我不太懂', ['诶 是我说错什么了吗']) === '这个梗我不太懂', '重复的自我怀疑整句去掉');
  t(varyTics('是我用错词了吗', ['好的']) === '是我用错词了吗', '第一次自我怀疑不动');
  t(varyTics('你好', []) === '你好', '没有历史就不动');
}

// ---------- 气泡间隔 / 主动气泡数 ----------
{
  const short = bubbleGap({ gapMinMs: 400, gapMaxMs: 400 }, () => 0, '好');
  const long = bubbleGap({ gapMinMs: 400, gapMaxMs: 400 }, () => 0, '这是一段比较长的话有二三十个字呢你看是不是更久');
  t(long > short + 800, '下一条越长间隔越久', `${short} vs ${long}`);
  t(bubbleGap({ gapMinMs: 400, gapMaxMs: 400, gapPerCharMs: 0 }, () => 0, '很长很长很长') === 400, 'gapPerCharMs=0 回到旧行为');
  t(bubbleGap({}, () => 0.5) >= 400, '不传文字也能用（兼容旧调用）');
  const text = '今天天气真好呀我们出去玩吧，我带了很多吃的东西给大家，还有水果和饮料哦，快点来';
  const n = planBubbles(text, { maxBubbles: 2, splitProbability: 1, minSplitChars: 10, minLen: 4 }, () => 0).length;
  t(n <= 2, '气泡上限生效', String(n));
}

// ---------- 提示词 ----------
{
  const sys = buildSystemPrompt({ name: '测试', identity: 'x', speech: {} });
  t(/【融入群聊】/.test(sys) && /看图说话/.test(sys) && /影射/.test(sys), '系统提示词带有融入群聊守则');
}

// ---------- 话痨刹车 / 图片不算话题 ----------
{
  const dirs = [];
  try {
    const mk = (proactive = {}) => {
      const dir = mkdtempSync(join(tmpdir(), 'qqblend-'));
      dirs.push(dir);
      const said = [];
      const brain = {
        cfg: {
          access: { users: [], groups: ['1'] },
          proactive: {
            enabled: true, maxPerHour: 99, quietHours: [],
            pause: { enabled: true, seconds: 15, sampleRate: 1 },
            ambient: { enabled: true, sampleRate: 1, minGapMinutes: 0 },
            idle: { enabled: false }, private: { enabled: false },
            ...proactive,
          },
        },
        proactiveSay: async (a) => { said.push(a.hint); return '接一句'; },
      };
      const store = { dir, profile: () => ({}), boundSession: () => 's', listProfiles: () => [] };
      const ambient = new Ambient({ brain, store, log: () => {} });
      return { ambient, said };
    };
    const feed = (a, rows) => {
      let at = Date.now() - 60000;
      for (const r of rows) a.db.append({ chatKey: 'group:1', groupId: '1', userId: r.self ? 'self' : '1001', nickname: r.self ? '我' : 'A', text: r.text, at: (at += 1000), self: Boolean(r.self) });
    };

    // 1) 她占比太高：不开口
    const hot = mk();
    feed(hot.ambient, Array.from({ length: 20 }, (_, i) => ({ text: i % 2 ? '这个报错到底怎么弄啊' : '我也不知道呀', self: i % 3 === 0 })).concat([{ text: '这个报错到底怎么弄啊' }]));
    await hot.ambient.maybeChimeOnPause('1', 'group:1');
    t(hot.said.length === 0, '她占比超过上限时停顿接话被刹住');
    t(hot.ambient.shareOk('group:1') === false, 'shareOk=false');

    // 2) 占比低：正常开口
    const cool = mk();
    feed(cool.ambient, Array.from({ length: 20 }, () => ({ text: '这个报错到底怎么弄啊' })));
    await cool.ambient.maybeChimeOnPause('1', 'group:1');
    t(cool.said.length === 1, '占比正常时可以接话');
    t(/只说一两句/.test(cool.said[0] ?? ''), '停顿接话提示要求短、别看图说话');

    // 3) 全是图片：不当话题
    const pics = mk();
    feed(pics.ambient, [{ text: '[图片]' }, { text: '[图片][图片]' }, { text: '[表情包]' }, { text: '[图片]' }]);
    await pics.ambient.maybeChimeOnPause('1', 'group:1');
    t(pics.said.length === 0, '只有图片 / 表情的一段不触发接话');

    // 4) 最后一条是她自己的：不连着说
    const selfLast = mk();
    feed(selfLast.ambient, [{ text: '这个报错到底怎么弄啊' }, { text: '这个报错到底怎么弄啊' }, { text: '这个报错到底怎么弄啊' }, { text: '我看看哦', self: true }]);
    await selfLast.ambient.maybeChimeOnPause('1', 'group:1');
    t(selfLast.said.length === 0, '她刚说完没人回，停顿接话不再追加');

    // 5) maxSelfShare=0 关闭刹车
    const off = mk({ maxSelfShare: 0 });
    feed(off.ambient, Array.from({ length: 20 }, (_, i) => ({ text: '这个报错到底怎么弄啊', self: i % 2 === 0 })).concat([{ text: '这个报错到底怎么弄啊' }]));
    t(off.ambient.shareOk('group:1') === true, 'maxSelfShare=0 时关闭刹车');
    [hot, cool, pics, selfLast, off].forEach((x) => x.ambient.stop());
  } finally {
    for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch {} }
  }
}

console.log(bad ? `\n✗ ${bad} 项失败` : '\n全部通过');
process.exit(bad ? 1 : 0);
