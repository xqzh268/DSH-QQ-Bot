// 模型配置自测：解析规则（跟随/覆盖/回退）+ 会话重建
import { Brain } from './dsh-qq/lib/brain.js';

let bad = 0;
const ok = (m) => console.log(`  ✓ ${m}`);
const no = (m, d = '') => {
  console.log(`  ✗ ${m}${d ? ` —— ${d}` : ''}`);
  bad += 1;
};

const HOST = { provider: 'deepseek', model: 'deepseek-flash', reasoningEffort: 'high' };

// 全空 → 跟随宿主
const a = Brain.resolveModel({}, HOST);
a?.provider === 'deepseek' && a?.model === 'deepseek-flash' && a?.reasoningEffort === 'high'
  ? ok('全空时跟随宿主默认（含思考强度）')
  : no('默认跟随失败', JSON.stringify(a));

// 覆盖 model
const b = Brain.resolveModel({ model: 'deepseek-pro' }, HOST);
b?.model === 'deepseek-pro' && b?.provider === 'deepseek' ? ok('只写 model 时 provider 跟随宿主') : no('部分覆盖失败', JSON.stringify(b));

// 全部覆盖
const c = Brain.resolveModel({ provider: 'x', model: 'y', reasoningEffort: 'low' }, HOST);
c?.provider === 'x' && c?.model === 'y' && c?.reasoningEffort === 'low' ? ok('全部覆盖生效') : no('全量覆盖失败', JSON.stringify(c));

// 关闭思考 → 不带字段（等于走 provider 默认）
const d = Brain.resolveModel({ reasoningEffort: 'off' }, HOST);
!('reasoningEffort' in d) ? ok('思考强度 off 时不传字段') : no('off 仍被传入', JSON.stringify(d));

// 没有任何来源可用的模型 → null（调用方据此不传 agentOptions）
Brain.resolveModel({}, null) === null ? ok('无任何模型来源时返回 null') : no('无来源却返回了对象');
Brain.resolveModel({ provider: 'x' }, null) === null ? ok('只有 provider 没有 model 时也返回 null') : ok('只有 provider 时不完整');

// 空白字符串视为未配置
const e = Brain.resolveModel({ provider: '   ', model: '  ' }, HOST);
e?.provider === 'deepseek' ? ok('空白配置不覆盖宿主') : no('空白配置覆盖了宿主', JSON.stringify(e));

// xhigh / max：适配器自定义档位，必须原样透传（不能被当成非法值丢掉）
const x = Brain.resolveModel({ reasoningEffort: 'xhigh' }, HOST);
x?.reasoningEffort === 'xhigh' ? ok('xhigh 档位原样透传') : no('xhigh 被改写', JSON.stringify(x));
const mx = Brain.resolveModel({ reasoningEffort: 'max' }, HOST);
mx?.reasoningEffort === 'max' ? ok('max 档位原样透传') : no('max 被改写', JSON.stringify(mx));

// 会话重建
{
  const bindings = {
    'group:1': { sessionId: 'session-a' },
    'private:2': { sessionId: 'session-b' },
  };
  const unbound = [];
  const store = { bindings: () => ({ ...bindings }), unbind: (k) => unbound.push(k) };
  const brain = Object.create(Brain.prototype);
  brain.store = store;
  brain.qqAgents = new Set(['session-a', 'session-b', 'session-c']);
  brain.log = () => {};
  const n = brain.resetSessions();
  n === 2 && unbound.length === 2 ? ok('重建会话会解绑所有聊天') : no('解绑数量不对', `${n}/${unbound.length}`);
  !brain.qqAgents.has('session-a') && !brain.qqAgents.has('session-b') && brain.qqAgents.has('session-c')
    ? ok('只清掉 QQ 会话，不影响其它会话')
    : no('清了不该清的', JSON.stringify([...brain.qqAgents]));
}

console.log('');
if (bad) {
  console.log(`✗ ${bad} 项失败`);
  process.exit(1);
}
console.log('✓ 模型配置验证通过');
