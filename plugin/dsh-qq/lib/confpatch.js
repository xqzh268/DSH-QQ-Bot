/**
 * 设置页提交配置时的校验与合并。
 *
 * 为什么需要：
 *  1) 之前用的是浅合并——页面只提交 proactive.pause.sampleRate，
 *     会把整个 proactive.pause 对象换掉（seconds、enabled 全丢）。这里改成深合并。
 *  2) 新增的配置项大多是概率/次数/开关，页面传了字符串或越界值，
 *     轻则不生效，重则（概率 >1、间隔负数）让主动发言失控。这里统一校验并夹到合法范围。
 *
 * 未列在规则里的字段原样放行（老字段、以后新增的字段不会被误拦）。
 */

/** [最小, 最大, 是否取整] */
export const NUMBER_RULES = {
  'access.followUpSeconds': [0, 3600, true],
  'access.followUpMax': [0, 20, true],
  'access.pokeStaleSeconds': [0, 3600, true],

  'proactive.maxPerHour': [0, 100, true],
  'proactive.pause.seconds': [15, 3600, true],
  'proactive.pause.sampleRate': [0, 1, false],
  'proactive.idle.maxPerDay': [0, 24, true],
  'proactive.idle.discoverGapHours': [0, 168, false],
  'proactive.maxSelfShare': [0, 1, false],
  'proactive.shareWindow': [10, 200, true],
  'humanize.proactiveMaxBubbles': [1, 6, true],
  'humanize.gapPerCharMs': [0, 500, true],

  'humanize.debounceMs': [0, 10000, true],
  'humanize.debounceMaxMs': [0, 60000, true],
  'humanize.minSplitChars': [0, 500, true],
  'humanize.keepMidPeriod': [0, 1, false],

  'social.repeat.probability': [0, 1, false],
  'social.repeat.minUsers': [2, 10, true],
  'social.repeat.maxLen': [1, 100, true],
  'social.repeat.cooldownSec': [0, 86400, true],
  'social.react.probability': [0, 1, false],
  'social.react.cooldownSec': [0, 86400, true],
  'social.pokeBack.probability': [0, 1, false],
  'social.pokeBack.cooldownSec': [0, 86400, true],
  'social.pokeBack.maxPer10Min': [0, 50, true],

  'groupMemory.everyMessages': [5, 500, true],
  'groupMemory.minIntervalMinutes': [0, 1440, true],
  'groupMemory.maxPerDay': [0, 100, true],
  'groupMemory.forget.idleDays': [1, 365, true],
  'groupMemory.forget.keepHits': [1, 1000, true],
  'groupMemory.forget.maxLore': [3, 60, true],
  'groupMemory.forget.maxRelations': [3, 60, true],
  'groupMemory.forget.minKeep': [0, 20, true],
  'groupMemory.forget.maxDormant': [0, 200, true],
  'groupMemory.forget.wake': [0, 10, true],

  'faces.maxPerMessage': [0, 5, true],
  'faces.cooldownMinutes': [0, 1440, true],
  'bili.maxMinutes': [1, 120, true],
  'bili.minPlay': [0, 10000000, true],
};

export const BOOLEAN_RULES = [
  'proactive.pause.enabled',
  'proactive.idle.discover',
  'proactive.idle.skipIfUnanswered',
  'humanize.stripPeriod',
  'humanize.timeAware',
  'social.repeat.enabled',
  'social.react.enabled',
  'social.pokeBack.enabled',
  'groupMemory.enabled',
  'groupMemory.forget.enabled',
  'faces.enabled',
  'faces.react',
  'cleanup.enabled',
  'cleanup.hedge',
  'cleanup.tics',
  'cleanup.punct',
  'bili.enabled',
  'bili.discover',
  'bili.card',
  'links.enabled',
  'links.xhs',
];

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

/** 深合并：对象递归合并，数组和标量整体替换 */
export function deepMerge(base, patch) {
  if (!isObj(base) || !isObj(patch)) return patch;
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    out[k] = isObj(v) && isObj(base[k]) ? deepMerge(base[k], v) : v;
  }
  return out;
}

function getPath(obj, path) {
  let cur = obj;
  for (const k of path.split('.')) {
    if (!isObj(cur) || !(k in cur)) return { found: false };
    cur = cur[k];
  }
  return { found: true, value: cur };
}

function setPath(obj, path, value) {
  const keys = path.split('.');
  let cur = obj;
  for (const k of keys.slice(0, -1)) cur = cur[k];
  cur[keys[keys.length - 1]] = value;
}

/**
 * 校验并规整一份配置补丁（只处理补丁里出现的字段）。
 * 返回 { patch, errors, clamped }：
 *   - 类型不对（字符串、NaN、非布尔）→ errors，整体拒绝
 *   - 数值越界 → 夹到范围内，并记入 clamped 让页面提示
 */
export function validateConfigPatch(body) {
  const patch = JSON.parse(JSON.stringify(body ?? {}));
  const errors = [];
  const clamped = [];

  for (const [path, [min, max, int]] of Object.entries(NUMBER_RULES)) {
    const got = getPath(patch, path);
    if (!got.found) continue;
    let n = got.value;
    if (typeof n === 'string' && n.trim() !== '' && Number.isFinite(Number(n))) n = Number(n); // 表单传来的数字字符串
    if (typeof n !== 'number' || !Number.isFinite(n)) {
      errors.push(`${path} 必须是数字`);
      continue;
    }
    let v = int ? Math.round(n) : n;
    if (v < min) v = min;
    if (v > max) v = max;
    if (v !== n) clamped.push({ path, from: n, to: v });
    setPath(patch, path, v);
  }

  for (const path of BOOLEAN_RULES) {
    const got = getPath(patch, path);
    if (!got.found) continue;
    if (typeof got.value !== 'boolean') errors.push(`${path} 必须是 true 或 false`);
  }

  return { patch, errors, clamped };
}

/** 设置页能整块提交的配置分区 */
export const CONFIG_SECTIONS = ['access', 'bot', 'proactive', 'limits', 'humanize', 'mail', 'social', 'groupMemory'];

/** 把校验过的补丁深合并进当前配置，返回新的完整配置 */
export function applyConfigPatch(current, patch) {
  const next = {};
  for (const key of CONFIG_SECTIONS) {
    if (isObj(patch?.[key])) next[key] = deepMerge(current?.[key] ?? {}, patch[key]);
  }
  return next;
}
