// 记忆自测：MEMO 解析容错 + 不依赖模型的本地记录
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { splitMemo } from './dsh-qq/lib/prompt.js';
import { ProjectStore } from './dsh-qq/lib/persona.js';

const safeRm = (dir) => {
  try {
    safeRm(dir);
  } catch {
    /* Windows 上数据库连接未关时删不掉，忽略 */
  }
};

let bad = 0;
const ok = (m) => console.log(`  ✓ ${m}`);
const no = (m, d = '') => {
  console.log(`  ✗ ${m}${d ? ` —— ${d}` : ''}`);
  bad += 1;
};

// ---------- splitMemo ----------
{
  const r = splitMemo('好的呀。\n<<MEMO>>{"traits":["好奇"],"episode":"聊了代码"}<</MEMO>>');
  r.clean === '好的呀。' && r.memo?.traits?.[0] === '好奇' && r.memo?.episode === '聊了代码'
    ? ok('标准 <<MEMO>> 解析')
    : no('标准格式', JSON.stringify(r));
}
{
  const r = splitMemo('嗯\n<MEMO>{"episode":"x"}</MEMO>');
  r.clean === '嗯' && r.memo?.episode === 'x' ? ok('兼容 <MEMO> 单尖括号') : no('单尖括号', JSON.stringify(r));
}
{
  const r = splitMemo('行\n【MEMO】{"episode":"中文括号"}');
  r.clean === '行' && r.memo?.episode === '中文括号' ? ok('兼容【MEMO】') : no('中文括号', JSON.stringify(r));
}
{
  const r = splitMemo('好吧\n<<MEMO>>\n```json\n{"facts":["养猫"]}\n```\n<</MEMO>>');
  r.clean === '好吧' && r.memo?.facts?.[0] === '养猫' ? ok('兼容代码块包裹') : no('代码块', JSON.stringify(r));
}
{
  const r = splitMemo('就这样\n<<MEMO>>{坏的 JSON}<//MEMO>>');
  !r.clean.includes('MEMO') ? ok('坏 JSON 也不会泄漏到正文') : no('坏 JSON 泄漏', JSON.stringify(r.clean));
}
{
  const r = splitMemo('普通一句话，没有记忆块');
  r.clean === '普通一句话，没有记忆块' && r.memo === null ? ok('没有记忆块时正文不变') : no('无记忆块处理错误', JSON.stringify(r));
}
{
  const r = splitMemo('A\n<<MEMO>>{"episode":"一"}<</MEMO>>\nB\n<<MEMO>>{"episode":"二"}<</MEMO>>');
  r.clean.includes('A') && r.clean.includes('B') && !r.clean.includes('MEMO') ? ok('多块全部剥掉') : no('多块未剥净', JSON.stringify(r.clean));
}

// ---------- 本地记忆（不依赖模型） ----------
{
  const dir = mkdtempSync(join(tmpdir(), 'qqmemo-'));
  try {
    mkdirSync(join(dir, 'persona'), { recursive: true });
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ persona: { active: 'persona/01-warm.json' }, memory: { maxEpisodes: 40 } }));
    writeFileSync(join(dir, 'persona', '01-warm.json'), JSON.stringify({ id: 'w', name: '阿棠', identity: 'x', speech: { tone: 't' } }));
    const store = new ProjectStore(dir);

    // 没有任何 memo 也要记
    store.rememberExchange('136638211', '马里亚纳海猫', { userText: '今天好累', replyText: '那就早点睡', memo: null });
    let p = store.readProfile('136638211');
    p.interactions === 1 && p.episodes.length === 1 && p.episodes[0].text.includes('今天好累')
      ? ok('没有 memo 也记录互动与摘要')
      : no('本地记录失败', JSON.stringify(p));

    // 有 memo：合并 traits/facts，并用 memo 的 episode
    store.rememberExchange('136638211', '马里亚纳海猫', {
      userText: '我在写 codex 插件',
      replyText: '厉害',
      memo: { traits: ['较真'], facts: ['在写插件'], episode: '聊了他在写的插件' },
    });
    p = store.readProfile('136638211');
    p.interactions === 2 && p.traits.includes('较真') && p.facts.includes('在写插件') && p.episodes.at(-1).text === '聊了他在写的插件'
      ? ok('有 memo 时合并画像并累加次数')
      : no('memo 合并失败', JSON.stringify({ i: p.interactions, t: p.traits, f: p.facts, e: p.episodes.at(-1) }));

    // 重开后仍在
    store.profilesDB?.close?.();
    const store2 = new ProjectStore(dir);
    const p2 = store2.readProfile('136638211');
    p2.interactions === 2 && p2.episodes.length === 2 ? ok('重开后记忆仍在') : no('重开后丢失');
  } finally {
    safeRm(dir);
  }
}

// ---------- 迁移 + 落库验证 ----------
{
  const dir = mkdtempSync(join(tmpdir(), 'qqmigrate-'));
  try {
    mkdirSync(join(dir, 'persona'), { recursive: true });
    mkdirSync(join(dir, 'data', 'profiles'), { recursive: true });
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ persona: { active: 'persona/01-warm.json' } }));
    writeFileSync(join(dir, 'persona', '01-warm.json'), JSON.stringify({ id: 'w', name: '阿棠', identity: 'x', speech: { tone: 't' } }));
    // 模拟旧版留下的一份 JSON 画像
    writeFileSync(
      join(dir, 'data', 'profiles', '777777.json'),
      JSON.stringify({
        userId: '777777',
        nickname: '老用户',
        aliases: [],
        firstSeen: '2026-01-01T00:00:00.000Z',
        lastSeen: '2026-01-02T00:00:00.000Z',
        traits: ['话少'],
        facts: ['在写论文'],
        episodes: [{ at: '2026-01-02T00:00:00.000Z', text: '聊过论文' }],
        interactions: 5,
      }),
    );

    const store = new ProjectStore(dir);
    const p = store.readProfile('777777');
    p?.interactions === 5 && p?.episodes?.[0]?.text === '聊过论文'
      ? ok('旧 JSON 画像被迁进数据库')
      : no('迁移失败', JSON.stringify(p));
    !existsSync(join(dir, 'data', 'profiles', '777777.json')) && existsSync(join(dir, 'data', 'profiles', '777777.json.migrated'))
      ? ok('迁移后旧文件改名保留（不删除）')
      : no('旧文件状态不对', String(readdirSync(join(dir, 'data', 'profiles'))));

    // 再把 JSON 全部删掉，数据库里的记忆仍在 → 证明真的落在库里
    for (const f of readdirSync(join(dir, 'data', 'profiles'))) rmSync(join(dir, 'data', 'profiles', f));
    store.profilesDB?.close?.();
    const store3 = new ProjectStore(dir);
    const again = store3.readProfile('777777');
    store3.profilesDB?.close?.();
    again?.interactions === 5 ? ok('删掉 JSON 后记忆仍在（存在数据库里）') : no('删掉 JSON 就丢了');
  } finally {
    safeRm(dir);
  }
}

console.log('');
if (bad) {
  console.log(`✗ ${bad} 项失败`);
  process.exit(1);
}
console.log('✓ 记忆系统验证通过');


