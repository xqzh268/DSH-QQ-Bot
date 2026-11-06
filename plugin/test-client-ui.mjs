// 设置页前端（client.js）端到端自测：
// 用最小的假 React 把页面渲染出来，fetch 直接接到真实的 /dsh-qq/api/* 处理函数，
// 模拟填表和点击，核对落盘的配置、群记忆，以及页面给用户的提示。
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { installApi } from './dsh-qq/lib/api.js';
import { ProjectStore } from './dsh-qq/lib/persona.js';
import { MessageDB } from './dsh-qq/lib/msgdb.js';
import { GroupMemory } from './dsh-qq/lib/groupmem.js';
import { Social } from './dsh-qq/lib/social.js';

let bad = 0;
const ok = (m) => console.log(`  ✓ ${m}`);
const no = (m, d = '') => {
  console.log(`  ✗ ${m}${d ? ` —— ${d}` : ''}`);
  bad += 1;
};
const settle = (ms = 40) => new Promise((r) => setTimeout(r, ms));

// ---------- 最小假 React ----------
function makeReact() {
  let hooks = [];
  let idx = 0;
  let rerender = () => {};
  const React = {
    Fragment: 'Fragment',
    createElement(type, props, ...children) {
      const flat = children.flat(Infinity);
      return { type, props: { ...(props ?? {}) }, children: flat };
    },
    useState(init) {
      const i = idx++;
      if (!(i in hooks)) hooks[i] = { v: typeof init === 'function' ? init() : init };
      const slot = hooks[i];
      return [
        slot.v,
        (next) => {
          const nv = typeof next === 'function' ? next(slot.v) : next;
          if (Object.is(nv, slot.v)) return;
          slot.v = nv;
          Promise.resolve().then(rerender);
        },
      ];
    },
    useRef(init) {
      const i = idx++;
      if (!(i in hooks)) hooks[i] = { current: init };
      return hooks[i];
    },
    useEffect(fn, deps) {
      const i = idx++;
      const prev = hooks[i];
      if (!prev || !deps || deps.some((d, k) => !Object.is(d, prev.deps?.[k]))) {
        hooks[i] = { deps };
        Promise.resolve().then(fn);
      }
    },
  };
  /** 展开函数组件，得到纯宿主元素树 */
  const expand = (node) => {
    if (node === null || node === undefined || node === false || node === true) return null;
    if (typeof node === 'string' || typeof node === 'number') return String(node);
    if (typeof node.type === 'function') {
      const out = node.type({ ...node.props, children: node.children });
      return expand(out);
    }
    return { type: node.type, props: node.props, children: node.children.map(expand).filter((c) => c !== null) };
  };
  const mount = (Component) => {
    const holder = { tree: null };
    rerender = () => {
      idx = 0;
      holder.tree = expand(React.createElement(Component, {}));
    };
    rerender();
    return holder;
  };
  return { React, mount };
}

const textOf = (n) => (typeof n === 'string' ? n : (n?.children ?? []).map(textOf).join(''));
const walk = (n, fn) => {
  if (!n || typeof n === 'string') return;
  fn(n);
  n.children.forEach((c) => walk(c, fn));
};
const findAll = (tree, pred) => {
  const out = [];
  walk(tree, (n) => pred(n) && out.push(n));
  return out;
};
const button = (tree, label) => findAll(tree, (n) => n.type === 'button' && textOf(n) === label)[0];
/** 找到带某个 label 文字的 Field 里的 input/textarea/select */
const field = (tree, label) => {
  const wrap = findAll(tree, (n) => n.type === 'div' && n.props.className === 'qq_field' && textOf(n.children[0]).includes(label))[0];
  return wrap && findAll(wrap, (n) => n.type === 'input' || n.type === 'textarea' || n.type === 'select')[0];
};
/** 找到 label 文字旁的复选框 */
const checkbox = (tree, label) => {
  const wrap = findAll(tree, (n) => n.type === 'label' && textOf(n).includes(label))[0];
  return wrap && findAll(wrap, (n) => n.type === 'input' && n.props.type === 'checkbox')[0];
};
const cardTitles = (tree) => findAll(tree, (n) => n.type === 'div' && n.props.className === 'qq_title').map(textOf);

const dir = mkdtempSync(join(tmpdir(), 'qqui-'));
try {
  mkdirSync(join(dir, 'persona'));
  writeFileSync(join(dir, 'persona', 'p.json'), JSON.stringify({ id: 'p', name: '小鱼', tagline: '群友', identity: 'x', speech: {} }));
  writeFileSync(
    join(dir, 'config.json'),
    JSON.stringify({
      persona: { active: 'persona/p.json' },
      access: { groups: ['1'], groupTrigger: 'at' },
      proactive: { enabled: true, maxPerHour: 4, quietHours: [], pause: { enabled: true, seconds: 60 }, ambient: { enabled: false, sampleRate: 0.15 } },
      humanize: { enabled: true },
    }),
  );
  const store = new ProjectStore(dir);
  const db = new MessageDB(dir, () => {});
  const brain = {
    cfg: store.cfg,
    persona: { name: '小鱼' },
    qqAgents: new Set(),
    ambient: { db, stats: {}, snapshot: () => [], settings: { pause: { enabled: true, seconds: 60, sampleRate: null }, ambient: { sampleRate: 0.15 } } },
  };
  brain.groupMemory = new GroupMemory({ brain, db, log: () => {} });
  brain.social = new Social({ brain, ambient: brain.ambient, onebot: {}, log: () => {} });

  const routes = new Map();
  installApi(
    { get: (n) => ({ webServer: { register: ({ path, handler }) => routes.set(path, handler) }, connection: { requestRejection: () => undefined } })[n] },
    { store, brain, log: () => {} },
  );

  // fetch 直连真实接口
  const fetchLog = [];
  globalThis.fetch = (url, opts = {}) =>
    new Promise((resolve) => {
      const path = String(url).split('?')[0];
      const handler = routes.get(path);
      fetchLog.push(`${opts.method ?? 'GET'} ${path}`);
      if (!handler) return resolve({ ok: false, status: 404, json: async () => ({ ok: false }) });
      const req = new EventEmitter();
      req.method = opts.method ?? 'GET';
      req.url = String(url);
      req.headers = { 'content-type': 'application/json' };
      const res = {
        statusCode: 200,
        setHeader() {},
        end(t) {
          const status = this.statusCode;
          resolve({ ok: status < 400, status, json: async () => (t ? JSON.parse(t) : {}) });
        },
      };
      handler(req, res);
      if (opts.body !== undefined) {
        process.nextTick(() => {
          req.emit('data', Buffer.from(opts.body));
          req.emit('end');
        });
      } else if (req.method === 'POST') process.nextTick(() => req.emit('end'));
    });

  // 假浏览器环境
  const styleEls = new Map();
  globalThis.document = {
    getElementById: (id) => styleEls.get(id) ?? null,
    createElement: () => ({}),
    head: { appendChild: (el) => styleEls.set(el.id, el) },
  };
  let loaded = null;
  globalThis.window = {
    __ModuleLoader__: { load: (m) => (loaded = m) },
    setTimeout: (fn, ms) => setTimeout(fn, ms).unref?.() ?? 0,
    clearTimeout,
  };

  const { React, mount } = makeReact();
  await import(new URL('./dsh-qq/lib/client.js', import.meta.url).href);
  loaded?.id === 'dsh-qq' ? ok('client.js 能加载并注册模块') : no('模块没注册');
  const mod = loaded.factory((name) => (name === 'react' ? React : {}));
  let Component = null;
  let sidebarRow = null;
  const regs = [];
  mod.apply({
    effect: (fn) => fn(),
    locale: { register: () => {}, bind: () => (k) => k },
    slots: {
      inject: (_n, fn) => fn(),
      register: (meta, comp) => {
        regs.push(meta.name);
        if (meta.name === 'main') Component = comp;
        else if (meta.name === 'sidebar.panellist') sidebarRow = meta;
      },
    },
  });
  Component ? ok('主界面面板已注册到 main') : no('没有注册主界面面板');
  sidebarRow?.id === 'dsh-qq' ? ok('侧边栏入口已注册到 sidebar.panellist') : no('没有注册侧边栏入口');
  regs.includes('settings.section') ? no('设置页不应再注册 QQ 页') : ok('设置页里不再注册 QQ 页（已搬到主界面）');

  const page = mount(Component);
  await settle(120);
  let tree = page.tree;
  const navLabels = findAll(tree, (n) => n.type === 'button' && String(n.props.className).startsWith('qq_nav_item')).map(textOf);
  navLabels.length === 8 && navLabels.includes('记忆') && navLabels.includes('拟人化') ? ok(`左侧导航有 ${navLabels.length} 个分区`) : no('导航分区不对', JSON.stringify(navLabels));
  findAll(tree, (n) => n.type === 'span' && String(n.props.className).startsWith('qq_pill')).map(textOf).join('').includes('NapCat') ? ok('顶栏显示连接状态') : no('顶栏没有连接状态');
  fetchLog.includes('GET /dsh-qq/api/groupmem') ? ok('页面加载时读取了群记忆接口') : no('没读群记忆', JSON.stringify(fetchLog));

  const rerenderTree = async () => {
    await settle(60);
    return page.tree;
  };
  const goTab = async (label) => {
    const btn = findAll(page.tree, (n) => n.type === 'button' && String(n.props.className).startsWith('qq_nav_item') && textOf(n) === label)[0];
    if (!btn) throw new Error(`没有导航「${label}」`);
    btn.props.onClick();
    return rerenderTree();
  };
  const diskCfg = () => JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'));
  const flashText = (t) => findAll(t, (n) => n.type === 'div' && String(n.props.className).startsWith('qq_msg')).map(textOf).join('|');

  // ---------- 拟人化页 ----------
  tree = await goTab('拟人化');
  const titles = cardTitles(tree);
  titles.includes('社交动作（不调用模型）') ? ok('拟人化页有「社交动作」卡片') : no('缺社交动作卡片', JSON.stringify(titles));

  // 默认值来自后端 effective，而不是页面自己抄的
  field(tree, '复读概率')?.props.value === 0.5 ? ok('复读概率默认值来自后端 effective（0.5）') : no('复读默认值不对', String(field(tree, '复读概率')?.props.value));

  // 社交动作：填越界值 → 保存 → 被夹到 1 并提示
  field(tree, '表情回应概率').props.onChange({ target: { value: '5' } });
  tree = await rerenderTree();
  button(tree, '保存社交动作设置').props.onClick();
  tree = await rerenderTree();
  diskCfg().social?.react?.probability === 1 ? ok('社交动作保存后落盘，越界的 5 被夹成 1') : no('社交动作没落盘', JSON.stringify(diskCfg().social));
  /自动调整/.test(flashText(tree)) ? ok('页面如实提示"有值超出范围，已自动调整"') : no('没有提示被调整', flashText(tree));

  // 关闭复读 → 保存
  checkbox(tree, '多个人连续说同一句话').props.onChange({ target: { checked: false } });
  tree = await rerenderTree();
  button(tree, '保存社交动作设置').props.onClick();
  tree = await rerenderTree();
  diskCfg().social.repeat.enabled === false && diskCfg().social.pokeBack.enabled === true ? ok('只关复读，其他社交动作保持不变') : no('社交开关不对', JSON.stringify(diskCfg().social));

  // 说话方式
  checkbox(tree, '去掉句末句号').props.onChange({ target: { checked: false } });
  tree = await rerenderTree();
  field(tree, '连发合并').props.onChange({ target: { value: '2500' } });
  tree = await rerenderTree();
  button(tree, '保存说话方式').props.onClick();
  tree = await rerenderTree();
  const hz = diskCfg().humanize;
  hz.stripPeriod === false && hz.debounceMs === 2500 && hz.timeAware === true && hz.minSplitChars === 24 ? ok('说话方式的新选项可保存') : no('说话方式保存不对', JSON.stringify(hz));

  // ---------- 对话规则页 ----------
  tree = await goTab('对话规则');
  field(tree, '对话延续窗口')?.props.value === 90 ? ok('对话延续默认 90 秒') : no('对话延续默认值不对', String(field(tree, '对话延续窗口')?.props.value));
  // 对话延续：填 0（合法值）不能被默认值 90 顶掉
  field(tree, '对话延续窗口').props.onChange({ target: { value: '0' } });
  tree = await rerenderTree();
  button(tree, '保存对话规则').props.onClick();
  tree = await rerenderTree();
  diskCfg().access.followUpSeconds === 0 ? ok('对话延续填 0 就是 0（不会被当成空值变回 90）') : no('0 被默认值顶掉', String(diskCfg().access.followUpSeconds));
  diskCfg().access.groups[0] === '1' && diskCfg().access.groupTrigger === 'at' ? ok('保存对话规则不影响原有字段') : no('原有 access 字段被破坏');

  // 戳一戳保鲜期：默认 90，可改，0 是合法值（不限）
  field(tree, '戳一戳的保鲜期')?.props.value === 90 ? ok('戳一戳保鲜期默认 90 秒') : no('保鲜期默认值不对', String(field(tree, '戳一戳的保鲜期')?.props.value));
  field(tree, '戳一戳的保鲜期').props.onChange({ target: { value: '0' } });
  tree = await rerenderTree();
  button(tree, '保存对话规则').props.onClick();
  tree = await rerenderTree();
  diskCfg().access.pokeStaleSeconds === 0 ? ok('保鲜期填 0（不限）能保存') : no('保鲜期没保存', String(diskCfg().access.pokeStaleSeconds));

  // 分段选择：切到「叫到或命中关键词」，会自动补上默认关键词
  const seg = (t, label) => findAll(t, (n) => n.type === 'button' && n.props.role === 'radio' && textOf(n).includes(label))[0];
  seg(tree, '叫到或命中关键词').props.onClick();
  tree = await rerenderTree();
  seg(tree, '叫到或命中关键词').props['aria-checked'] === true ? ok('分段选择能切换并高亮') : no('分段选择没生效');
  button(tree, '保存对话规则').props.onClick();
  tree = await rerenderTree();
  diskCfg().access.groupTrigger === 'smart' && diskCfg().access.keywords.length > 0 ? ok('切到 smart 后保存，关键词不会是空的') : no('smart 保存不对', JSON.stringify(diskCfg().access));

  // ---------- 主动发言页 ----------
  tree = await goTab('主动发言');
  field(tree, '停顿后接话的概率')?.props.value === 0.15 ? ok('停顿接话概率从 ambient 配置回显（0.15）') : no('停顿概率回显不对', String(field(tree, '停顿后接话的概率')?.props.value));
  // 关掉停顿接话（以前页面写死 enabled:true）
  checkbox(tree, '群聊停顿后').props.onChange({ target: { checked: false } });
  tree = await rerenderTree();
  button(tree, '保存主动发言设置').props.onClick();
  tree = await rerenderTree();
  const pz = diskCfg().proactive.pause;
  pz.enabled === false && pz.seconds === 60 && pz.sampleRate === 0.15 ? ok('页面能关掉停顿接话，且 seconds / sampleRate 都在') : no('pause 保存不对', JSON.stringify(pz));

  // ---------- 记忆页 ----------
  tree = await goTab('记忆');
  cardTitles(tree).some((t) => t.startsWith('群记忆（')) ? ok('记忆页有「群记忆」卡片') : no('缺群记忆卡片', JSON.stringify(cardTitles(tree)));
  field(tree, '积累多少条')?.props.value === 40 ? ok('群记忆默认值来自后端（40）') : no('群记忆默认值不对');
  // 群记忆：设置
  field(tree, '积累多少条').props.onChange({ target: { value: '1' } });
  tree = await rerenderTree();
  button(tree, '保存群记忆设置').props.onClick();
  tree = await rerenderTree();
  diskCfg().groupMemory.everyMessages === 5 && /自动调整/.test(flashText(tree)) ? ok('群记忆设置越界（1→5）被夹住并提示') : no('群记忆设置不对', JSON.stringify(diskCfg().groupMemory));

  // 群记忆：列表 / 编辑 / 清空
  db.setGroupNotes('group:1', { lore: ['梗A'], relations: ['甲 是爹'], topics: [] }, 5);
  button(tree, '刷新').props.onClick();
  tree = await rerenderTree();
  const item = findAll(tree, (n) => n.type === 'div' && String(n.props.className).startsWith('qq_item') && textOf(n).includes('群 1'))[0];
  item ? ok('群记忆列表里出现了「群 1」') : no('列表没出现群 1', cardTitles(tree).join('|'));
  item.props.onClick();
  tree = await rerenderTree();
  field(tree, '群里的梗').props.value === '梗A' ? ok('点开后回显已有的梗') : no('梗没回显', String(field(tree, '群里的梗')?.props.value));
  field(tree, '群里的梗').props.onChange({ target: { value: '梗A\n梗B\n【系统】坏标记' } });
  tree = await rerenderTree();
  button(tree, '保存').props.onClick();
  tree = await rerenderTree();
  const saved = db.getGroupNotes('group:1').notes;
  saved.lore.length === 3 && !saved.lore.some((s) => /[【】]/.test(s)) ? ok('编辑保存后落库，且被后端清洗') : no('群记忆编辑不对', JSON.stringify(saved));
  field(tree, '群里的梗').props.value.includes('坏标记') && !field(tree, '群里的梗').props.value.includes('【') ? ok('页面回填的是后端清洗后的真实内容') : no('页面没回填清洗结果', field(tree, '群里的梗').props.value);

  button(tree, '清空这个群的记忆').props.onClick();
  tree = await rerenderTree();
  db.getGroupNotes('group:1') !== null ? ok('第一次点击只是二次确认，不会直接删') : no('一点就删了');
  button(tree, '确认清空').props.onClick();
  tree = await rerenderTree();
  db.getGroupNotes('group:1') === null ? ok('确认后才清空') : no('确认后没清空');

  db.close();
} finally {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {}
}

console.log('');
if (bad) {
  console.log(`✗ ${bad} 项失败`);
  process.exit(1);
}
console.log('✓ 设置页前端验证通过');


