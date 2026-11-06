// 拟人化发送自测：切气泡 / 打字延迟 / 拆与不拆的概率
import { splitBubbles, typingDelay, bubbleGap, planBubbles, polishText, paceFactor } from './dsh-qq/lib/humanize.js';

let bad = 0;
const ok = (m) => console.log(`  ✓ ${m}`);
const no = (m, d = '') => {
  console.log(`  ✗ ${m}${d ? ` —— ${d}` : ''}`);
  bad += 1;
};

// 切分
const a = splitBubbles('你先别急。这事儿换谁都难受。要不要从头说说？');
a.length === 3 ? ok('按句末标点切成 3 条') : no('切分数量', JSON.stringify(a));

const b = splitBubbles('嗯。行吧，那就这样定了。');
b.length === 2 && b[1].startsWith('行吧') ? ok('过短碎片并入上一条') : no('碎片合并', JSON.stringify(b));

const c = splitBubbles('一句话没有标点');
c.length === 1 ? ok('无标点不拆') : no('无标点却被拆', JSON.stringify(c));

const d = splitBubbles('一。二。三。四。五。');
d.length === 3 ? ok('超过上限时合并尾部（3 条）') : no('上限合并', JSON.stringify(d));

const e = splitBubbles('第一行\n第二行\n第三行');
e.length >= 2 ? ok('按换行也能切') : no('换行切分', JSON.stringify(e));

// 打字延迟
const fast = typingDelay('短', { minTypingMs: 500, maxTypingMs: 5000, perCharMs: 50 }, () => 0.5);
const slow = typingDelay('这是一段明显更长的回复内容，用来验证延迟随字数增长', { minTypingMs: 500, maxTypingMs: 5000, perCharMs: 50 }, () => 0.5);
slow > fast ? ok(`延迟随字数增长（${fast}ms → ${slow}ms）`) : no('延迟没随字数变化');
fast >= 500 && slow <= 5000 ? ok('延迟被上下限夹住') : no('上下限失效', `${fast}/${slow}`);

const lo = typingDelay('测试抖动', { minTypingMs: 1000, maxTypingMs: 8000, perCharMs: 50 }, () => 0);
const hi = typingDelay('测试抖动', { minTypingMs: 1000, maxTypingMs: 8000, perCharMs: 50 }, () => 0.999);
lo !== hi ? ok('抖动生效（同样内容两次不同）') : no('没有抖动', `${lo}/${hi}`);

const gap = bubbleGap({ gapMinMs: 300, gapMaxMs: 1200 }, () => 0.5);
gap >= 300 && gap <= 1200 ? ok('气泡间隔在范围内') : no('间隔越界', String(gap));

// 拆与不拆（minSplitChars:0 关掉"短话不拆"，单独测概率；短话保护见后面）
const cfg = { splitProbability: 0.5, maxBubbles: 3, minLen: 6, minSplitChars: 0 };
const always = planBubbles('一。二。三。', { ...cfg, splitProbability: 1 }, () => 0.5);
always.length === 3 ? ok('概率命中时拆开') : no('命中却没拆', JSON.stringify(always));

const never = planBubbles('一。二。三。', { ...cfg, splitProbability: 0 }, () => 0.9);
never.length === 1 ? ok('概率未命中时合并成一条') : no('未命中却拆了', JSON.stringify(never));

const disabled = planBubbles('一。二。三。', { enabled: false }, () => 0);
disabled.length === 1 ? ok('关闭拟人化后不拆') : no('关闭后仍拆', JSON.stringify(disabled));

// 短话不拆
const shortText = planBubbles('你先别急。这事儿换谁都难受。', { splitProbability: 1, maxBubbles: 3, minLen: 6 }, () => 0);
shortText.length === 1 ? ok('不到 24 字的话整句发出，不拆碎') : no('短话被拆了', JSON.stringify(shortText));
const longText = planBubbles('你先别急，这事儿换谁都难受。要不要从头说说，我边吃边听你讲。', { splitProbability: 1, maxBubbles: 3, minLen: 6 }, () => 0);
longText.length === 2 ? ok('够长的话仍然可以拆') : no('长话没拆', JSON.stringify(longText));

// 她按人设不打句号、用空格断句：也要能拆（你截图里的三种回复）
const sp1 = splitBubbles('诶 三块钱就要打工还啊 那我得打多久才能还完');
sp1.length === 2 && sp1[0] === '诶 三块钱就要打工还啊' && sp1[1] === '那我得打多久才能还完' ? ok('空格断句：开头单字"诶"并进下一条，不单发') : no('空格断句', JSON.stringify(sp1));
const sp2 = splitBubbles('提成不敢想 一人一块五 刚好对半分');
sp2.length === 3 ? ok('三个短分句各成一条') : no('三分句', JSON.stringify(sp2));
const sp3 = splitBubbles('诶 晚上还有笔试啊 那你先垫两口再去做 别空着肚子', { maxBubbles: 4 });
sp3.length === 2 && sp3[0] === '诶 晚上还有笔试啊' && sp3[1] === '那你先垫两口再去做 别空着肚子'
  ? ok('四个分句：开头"诶"并入第一条；不足 6 字的结尾并进前一条（沿用原规则）')
  : no('四分句', JSON.stringify(sp3));
splitBubbles('hello world this is english').length === 1 && splitBubbles('买了 3 个苹果').length === 1 ? ok('英文单词、数字旁的空格不切') : no('误切英文/数字', JSON.stringify([splitBubbles('hello world this is english'), splitBubbles('买了 3 个苹果')]));
const sp4 = splitBubbles('@张三 你看这个东西是不是很离谱啊');
sp4.length === 1 ? ok('@昵称 后的空格不切') : no('@ 后被切开', JSON.stringify(sp4));
planBubbles('诶 三块钱就要打工还啊 那我得打多久才能还完', { splitProbability: 1, minSplitChars: 10, maxBubbles: 4 }, () => 0).length === 2
  ? ok('planBubbles：无标点的话在概率命中时会分条发')
  : no('planBubbles 没分条');
planBubbles('诶 三块钱就要打工还啊 那我得打多久才能还完', { splitProbability: 0.8, minSplitChars: 10 }, () => 0.9).length === 1
  ? ok('概率没命中时仍整条发（概率仍然有效）')
  : no('概率失效');

// 模型用空行分了段：必定拆成独立气泡（即使概率 0、字数短），空行不会留在同一条里
const para = '随便给点 意思意思就行\n\n我要一包辣条的钱 多了我也不会花';
const paraOut = planBubbles(para, { splitProbability: 0 }, () => 0.99);
paraOut.length === 2 && !paraOut.some((b) => /\n/.test(b)) ? ok('空行分段必拆成两条，不把空行塞进一条') : no('空行分段没拆', JSON.stringify(paraOut));
const para4 = planBubbles('一\n\n二\n\n三\n\n四', { splitProbability: 0, maxBubbles: 3 }, () => 0.99);
para4.length === 3 && para4[2] === '三\n四' ? ok('段数超过上限时并进最后一条') : no('段数上限处理不对', JSON.stringify(para4));
const code = planBubbles('看这个：\n```\na\n\nb\n```', { splitProbability: 1 }, () => 0);
code.length === 1 ? ok('代码块里的空行不拆') : no('代码块被拆了', JSON.stringify(code));
planBubbles(para, { enabled: false }, () => 0).length === 1 ? ok('关闭拟人化时仍整条发') : no('关闭拟人化后被拆');

// 打字风格收尾
const rndNever = () => 0.99; // 句中句号一律换掉
polishText('行吧，那就这样。', {}, rndNever) === '行吧，那就这样' ? ok('去掉句末句号') : no('句号没去', polishText('行吧，那就这样。', {}, rndNever));
polishText('真的假的！', {}, rndNever) === '真的假的！' ? ok('感叹号保留') : no('感叹号被动了');
polishText('哈哈哈……', {}, rndNever) === '哈哈哈……' ? ok('省略号保留') : no('省略号被动了');
polishText('先看日志。再看配置。', {}, rndNever) === '先看日志 再看配置' ? ok('句中句号换成空格') : no('句中句号处理不对', polishText('先看日志。再看配置。', {}, rndNever));
polishText('先看日志。再看配置。', {}, () => 0) === '先看日志。再看配置' ? ok('按概率保留少量句中句号') : no('保留概率没生效');
polishText('1. 装依赖\n2. 跑测试。', {}, rndNever).includes('\n') ? ok('列表/多行内容不改结构') : no('多行被破坏');
polishText('结束了。', { stripPeriod: false }) === '结束了。' ? ok('可以通过配置关闭') : no('关闭无效');

// 时段节奏
const at = (h, m = 0) => new Date(2026, 10, 2, h, m);
paceFactor(at(14)) === 1 ? ok('白天节奏正常') : no('白天节奏不对');
paceFactor(at(2)) > 1.5 ? ok('凌晨明显更慢') : no('凌晨没变慢');
paceFactor(at(12, 30)) > 1 && paceFactor(at(12, 30)) < 1.5 ? ok('饭点略慢') : no('饭点节奏不对');
paceFactor(at(2), { timeAware: false }) === 1 ? ok('可以关闭时段节奏') : no('关闭无效');

console.log('');
if (bad) {
  console.log(`✗ ${bad} 项失败`);
  process.exit(1);
}
console.log('✓ 拟人化发送验证通过');
