// OneBot 层自测：模拟 NapCat 客户端，验证事件归一化 + API 往返。
import { WebSocket } from 'ws';
import { OneBot, normalize, extractText, mentionsSelf } from './dsh-qq/lib/onebot.js';

let failures = 0;
const ok = (m) => console.log(`  ✓ ${m}`);
const bad = (m, d = '') => {
  console.log(`  ✗ ${m}${d ? ` —— ${d}` : ''}`);
  failures += 1;
};

// 纯函数
extractText([{ type: 'at', data: { qq: '1' } }, { type: 'text', data: { text: ' 你好' } }], '1') === '你好'
  ? ok('消息段提取文本')
  : bad('消息段提取文本');
mentionsSelf([{ type: 'at', data: { qq: '10000' } }], '10000') ? ok('识别 @') : bad('识别 @');
normalize({ post_type: 'message', message_type: 'group', group_id: 1, user_id: 10000, message: [] }, '10000') === null
  ? ok('丢弃自己的消息')
  : bad('丢弃自己的消息');

// 分享卡片（B 站 / 小红书）：结构按 QQ 常见小程序卡 / 图文卡构造，非真实抓包
const biliCard = JSON.stringify({
  app: 'com.tencent.miniapp_01',
  prompt: '[QQ小程序]哔哩哔哩',
  meta: { detail_1: { title: '哔哩哔哩', desc: '【硬核】三分钟看懂量子计算', qqdocurl: 'https://b23.tv/AbCdEf?share_source=qq&t=1', preview: 'x' } },
});
const xhsCard = JSON.stringify({
  app: 'com.tencent.structmsg',
  meta: { news: { tag: '小红书', title: '周末探店｜这家咖啡绝了', desc: '今天打卡了一家藏在巷子里的店', jumpUrl: 'http://xhslink.com/a/XyZ?x=1' } },
});
const cardText = extractText([{ type: 'text', data: { text: '你们看这个 ' } }, { type: 'json', data: { data: biliCard } }], '1');
/哔哩哔哩/.test(cardText) && /量子计算/.test(cardText) && /b23\.tv\/AbCdEf/.test(cardText) && !/share_source/.test(cardText)
  ? ok('B 站小程序卡片：认出来源、标题、短链（去掉追踪参数）')
  : bad('B 站卡片解析', cardText);
const xt = extractText([{ type: 'json', data: { data: xhsCard } }], '1');
/小红书/.test(xt) && /周末探店/.test(xt) && /xhslink\.com/.test(xt) ? ok('小红书图文卡片能解析') : bad('小红书卡片解析', xt);
extractText([{ type: 'json', data: { data: 'not json' } }], '1') === '[卡片消息]' ? ok('坏卡片不抛异常，退回 [卡片消息]') : bad('坏卡片处理');
extractText([{ type: 'json', data: { data: '{"app":"x","prompt":"[分享]某标题"}' } }], '1').includes('某标题') ? ok('结构未知时用 prompt 兜底') : bad('prompt 兜底');
normalize({ post_type: 'message', message_type: 'group', group_id: 1, user_id: 2, message: [{ type: 'json', data: { data: biliCard } }] }, '10000')?.text.includes('量子计算')
  ? ok('只发了卡片的群消息，事件文本不再为空')
  : bad('纯卡片消息事件文本为空');

// 表情名称：商城表情带名字，泛称不带
extractText([{ type: 'mface', data: { summary: '[无语]' } }], '1') === '[表情包：无语]' ? ok('商城表情保留名字') : bad('商城表情名字', extractText([{ type: 'mface', data: { summary: '[无语]' } }], '1'));
extractText([{ type: 'image', data: { sub_type: 1, summary: '[动画表情]' } }], '1') === '[表情包]' ? ok('泛称「动画表情」不当名字') : bad('泛称被当名字');
extractText([{ type: 'image', data: { sub_type: 0 } }], '1') === '[图片]' ? ok('普通图片仍是 [图片]') : bad('普通图片文本变了');

const bot = new OneBot({ port: 7823, path: '/onebot', token: 'tk', log: () => {} });
await bot.start();

const ws = new WebSocket('ws://127.0.0.1:7823/onebot?access_token=tk');
const events = [];
bot.onEvent((e) => events.push(e));

// NapCat 收到 send_* 就回一个 echo
const apiCalls = [];
ws.on('message', (buf) => {
  const msg = JSON.parse(buf.toString());
  if (msg.action) {
    apiCalls.push(msg);
    if (msg.action === 'get_msg') {
      const id = Number(msg.params?.message_id);
      if (id === 555) {
        // 一条很久以前的、别人发的消息
        ws.send(JSON.stringify({ status: 'ok', retcode: 0, echo: msg.echo, data: { time: 1700000000, message_id: 555, sender: { user_id: 30003, nickname: '小李', card: '李同学' }, message: [{ type: 'text', data: { text: '周五的面试我过了' } }, { type: 'image', data: { url: 'http://x/a.png' } }] } }));
      } else {
        ws.send(JSON.stringify({ status: 'failed', retcode: 1200, wording: '消息不存在或已被撤回', echo: msg.echo }));
      }
      return;
    }
    ws.send(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 777 }, echo: msg.echo }));
  }
});

await new Promise((r) => ws.on('open', r));
ok('NapCat 客户端已连接');

ws.send(
  JSON.stringify({
    post_type: 'message',
    message_type: 'group',
    self_id: 10000,
    group_id: 88888,
    user_id: 20001,
    message_id: 1,
    sender: { card: '阿远' },
    message: [{ type: 'at', data: { qq: '10000' } }, { type: 'text', data: { text: ' 在吗' } }],
  }),
);
await new Promise((r) => setTimeout(r, 200));
events.length === 1 && bot.selfId === '10000' ? ok('事件送达 + 自动识别 selfId') : bad('事件送达', `events=${events.length} self=${bot.selfId}`);

const evt = normalize(events[0], bot.selfId);
evt.chatKey === 'group:88888' && evt.atMe && evt.text === '在吗'
  ? ok('归一化结果正确')
  : bad('归一化结果', JSON.stringify(evt));

const res = await bot.reply('group:88888', '在的', 1);
res?.message_id === 777 ? ok('API 调用拿到返回值') : bad('API 返回值');
apiCalls[0]?.action === 'send_group_msg' && apiCalls[0]?.params?.message?.length === 2
  ? ok('回复带引用发送')
  : bad('回复消息结构', JSON.stringify(apiCalls[0]));

// 取被引用的消息（右滑引用很久以前的话）
const q = await bot.getMessage('555');
q && q.nickname === '李同学' && q.text.includes('周五的面试我过了') && q.text.includes('[图片]') && q.at === 1700000000000 && q.mine === false && q.images === 1
  ? ok('get_msg：取到被引用消息的发送者、内容、时间')
  : bad('取被引用消息', JSON.stringify(q));
(await bot.getMessage('404')) === null ? ok('消息不存在/已撤回时返回 null，不抛异常') : bad('取不到时应为 null');
(await bot.getMessage('')) === null && (await bot.getMessage(null)) === null ? ok('空 id 直接返回 null，不发请求') : bad('空 id');
apiCalls.some((c) => c.action === 'get_msg' && c.params?.message_id === 555) ? ok('message_id 按数字传给 get_msg') : bad('get_msg 参数', JSON.stringify(apiCalls.filter((c) => c.action === 'get_msg')));
normalize({ post_type: 'message', message_type: 'private', user_id: 2, message: [{ type: 'reply', data: { id: '555' } }, { type: 'text', data: { text: '这个后来呢' } }] }, '10000')?.replyId === '555'
  ? ok('私聊里的引用也能解析出被引用的消息 id')
  : bad('私聊引用 id');

await bot.close();
ws.close();
console.log('');
if (failures) {
  console.log(`✗ ${failures} 项失败`);
  process.exit(1);
}
console.log('✓ OneBot 层验证通过');
