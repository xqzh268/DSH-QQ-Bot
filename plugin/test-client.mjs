// 设置页冒烟测试：在迷你 React 运行时里真正渲染"数据已加载"的大树。
// 目的：抓住"引用未定义变量"这类会让整个 QQ 设置栏目直接消失的错。
// 之前的版本只渲染到 loading 分支，抓不到（已用变异测试验证）。
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

let bad = 0;
const ok = (m) => console.log(`  ✓ ${m}`);
const no = (m, d = '') => {
  console.log(`  ✗ ${m}${d ? ` —— ${d}` : ''}`);
  bad += 1;
};

const source = process.argv[2] ?? 'plugin/dsh-qq/lib/client.js';
const code = readFileSync(source, 'utf8');

// ---------- 迷你 React ----------
const hooks = [];
let cursor = 0;
let dirty = false;
let pendingEffects = [];
let renderErrors = [];

const react = {
  useState(initial) {
    const i = cursor++;
    if (!(i in hooks)) hooks[i] = typeof initial === 'function' ? initial() : initial;
    const set = (v) => {
      hooks[i] = typeof v === 'function' ? v(hooks[i]) : v;
      dirty = true;
    };
    return [hooks[i], set];
  },
  useEffect(fn) {
    pendingEffects.push(fn);
  },
  useMemo(fn) {
    return fn();
  },
  useCallback(fn) {
    return fn;
  },
  useRef(v) {
    const i = cursor++;
    if (!(i in hooks)) hooks[i] = { current: v };
    return hooks[i];
  },
  createElement(...args) {
    return { type: args[0], props: args[1] ?? {}, children: args.slice(2) };
  },
  Fragment: 'Fragment',
};

// ---------- 假后端：给一份完整 state ----------
const statePayload = {
  ok: true,
  config: {
    access: {
      groups: ['1032537893'],
      users: ['136638211'],
      groupTrigger: 'smart',
      keywords: ['帮我看', '求助'],
      groupMemberScope: 'group',
      replyPrivate: true,
    },
    limits: { perUserCooldownSec: 5, perGroupPerHour: 60, maxReplyChars: 600 },
    proactive: {
      enabled: true,
      maxPerHour: 2,
      quietHours: ['23:30-08:00'],
      idle: { enabled: true, minutes: 45 },
      pause: { enabled: true, seconds: 90 },
      ambient: { enabled: true, sampleRate: 0.15 },
      private: { enabled: false, idleHours: 24, maxPerDay: 1 },
    },
    humanize: { enabled: true, splitProbability: 0.55, maxBubbles: 3, perCharMs: 55, minTypingMs: 700, maxTypingMs: 6500 },
    stickers: { autoSave: 'stickers', visionMode: 'onDemand' },
    bot: { ownerId: '136638211', selfId: '780921051' },
    plugin: { workspaceDir: 'D:\\ws' },
  },
  onebot: { url: 'ws://127.0.0.1:7800/onebot?access_token=x', host: '127.0.0.1', port: 7800, path: '/onebot', hasToken: true },
  persona: { file: 'persona/01-warm.json' },
  personas: [{ file: 'persona/01-warm.json', name: '阿棠' }],
  memory: { profiles: [], groups: [{ groupId: '1032537893', size: 6 }] },
  ambientStats: { seen: 10, joinable: 3, pauseTried: 2, pauseHit: 1 },
  lastChimeAt: Date.now() - 60000,
  stickers: { count: 0, items: [] },
};
const fetchStub = (url) => {
  const body = url.includes('/state')
    ? statePayload
    : url.includes('/persona?')
      ? { ok: true, data: { name: '阿棠', tagline: '温柔', identity: 'x', personality: ['温柔'], boundaries: [], speech: { habits: [], avoid: [], examples: [] } } }
    : url.includes('/memory')
      ? { ok: true, profiles: [], groups: [] }
      : url.includes('/stickers')
        ? { ok: true, count: 0, items: [], autoSave: 'stickers', visionMode: 'onDemand' }
        : { ok: true };
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
};

const styleEl = () => ({ setAttribute() {}, appendChild() {}, textContent: '', id: '' });
const sandbox = {
  console,
  setTimeout,
  clearTimeout,
  Promise,
  fetch: fetchStub,
  // 组件会往 head 里插一段 <style>
  document: {
    getElementById: () => null,
    createElement: () => styleEl(),
    head: { appendChild() {} },
    body: { appendChild() {} },
  },
};
sandbox.window = {
  __ModuleLoader__: {
    load({ factory }) {
      sandbox.__factory = factory;
    },
  },
};
vm.createContext(sandbox);
try {
  vm.runInContext(code, sandbox, { filename: source });
  ok('client.js 可加载');
} catch (err) {
  no('client.js 加载失败', err.message);
  process.exit(1);
}

const factory = sandbox.__factory;
const mod = factory((name) => {
  if (name === 'react') return react;
  throw new Error(`未知依赖：${name}`);
});

let Component = null;
let SidebarIcon = null;
const registered = [];
const ctx = {
  slots: {
    inject(_n, cb) {
      cb();
    },
    register(spec, comp) {
      registered.push(spec);
      if (spec.name === 'main') Component = comp;
      else if (spec.name === 'sidebar.panellist') SidebarIcon = comp;
      return () => {};
    },
  },
  locale: { register: () => () => {}, bind: () => (k) => k },
};
const own = (fn) => {
  const d = fn();
  return d;
};
try {
  mod.apply(ctx, { own });
  Component ? ok('注册主界面面板（main）') : no('没注册 main 面板');
  SidebarIcon ? ok('注册侧边栏入口（sidebar.panellist）') : no('没注册侧边栏入口');
  const mainSpec = registered.find((s) => s.name === 'main');
  const rowSpec = registered.find((s) => s.name === 'sidebar.panellist');
  mainSpec && rowSpec && mainSpec.key === rowSpec.id ? ok('面板 key 与入口 id 一致（点入口才会显示面板）') : no('main.key 与 panellist.id 不一致', JSON.stringify({ mainSpec, rowSpec }));
  registered.some((s) => s.name === 'settings.section') ? no('不应再往设置页注册 settings.section') : ok('设置页里不再重复注册 QQ 页');
  typeof rowSpec?.label === 'function' && rowSpec.label() ? ok('入口有文字标签') : no('入口缺少 label');
  const icon = SidebarIcon?.({ size: 16, active: true });
  icon && icon.type === 'svg' ? ok('侧边栏图标是 SVG') : icon && typeof icon.type === 'function' ? ok('侧边栏图标可渲染') : no('侧边栏图标渲染异常');
} catch (err) {
  no('apply() 抛错', err.message);
}

// ---------- 渲染直到稳定（含 effect 拉数据后的重渲染） ----------
async function renderUntilStable(Comp, maxPass = 6) {
  let tree = null;
  for (let pass = 0; pass < maxPass; pass += 1) {
    cursor = 0;
    dirty = false;
    pendingEffects = [];
    try {
      tree = Comp();
    } catch (err) {
      renderErrors.push(`第 ${pass + 1} 次渲染：${err.name}: ${err.message}`);
      return { loaded: false, tree: null };
    }
    const effects = pendingEffects;
    pendingEffects = [];
    for (const fn of effects) {
      try {
        fn();
      } catch (err) {
        renderErrors.push(`effect：${err.name}: ${err.message}`);
        return false;
      }
    }
    // 等 fetch 的 promise 回调把 setState 打进来
    await new Promise((r) => setTimeout(r, 20));
    if (!dirty) return { loaded: true, tree };
  }
  return { loaded: true, tree };
}

// 面板按标签分页，每页只渲染当前页：必须把每个标签都渲染一遍，
// 否则某一页里的未定义变量会一直躲着不被发现。
const TABS = ['overview', 'persona', 'access', 'proactive', 'human', 'memory', 'stickers', 'model'];
const texts = [];
let tabsOk = 0;
let lastResult = null;
const walk = (node) => {
  if (node == null) return;
  if (typeof node === 'string' || typeof node === 'number') {
    texts.push(String(node));
    return;
  }
  if (Array.isArray(node)) {
    node.forEach(walk);
    return;
  }
  if (typeof node === 'object') {
    walk(node.props?.title);
    walk(node.props?.label);
    walk(node.children);
  }
};
for (const id of TABS) {
  hooks.length = 0; // 每个标签从头初始化 state
  sandbox.window.localStorage = { getItem: () => id, setItem() {} };
  renderErrors = [];
  const result = await renderUntilStable(Component);
  lastResult = result;
  if (result.loaded && !renderErrors.length) {
    tabsOk += 1;
    walk(result.tree);
  } else no(`标签「${id}」渲染抛错`, renderErrors[0] ?? '未知');
}
tabsOk === TABS.length ? ok(`${TABS.length} 个标签页都能完整渲染（含数据加载后）`) : no('有标签页渲染失败');

const joined = texts.join('|');
const expects = [
  ['NapCat', '状态区'],
  ['反向 WebSocket', '概览复制卡片'],
  ['复制', '一键复制按钮'],
  ['保存角色卡', '角色页保存按钮'],
  ['保存对话规则', '对话规则页保存按钮'],
  ['保存主动发言设置', '主动发言保存按钮'],
  ['保存说话方式', '说话方式保存按钮'],
  ['保存社交动作设置', '社交动作保存按钮'],
  ['保存群记忆设置', '群记忆保存按钮'],
  ['保存模型配置', '模型保存按钮'],
  ['保存邮件设置', '邮件保存按钮'],
];
for (const [needle, what] of expects) joined.includes(needle) ? ok(`${what}存在`) : no(`缺少${what}`);
void lastResult;

console.log('');
if (bad) {
  console.log(`✗ ${bad} 项失败`);
  process.exit(1);
}
console.log('✓ 设置页冒烟测试通过');

