/**
 * 把 QQ 专用受限 preset 追加到指定 profile 的 cordis.patch.yml。
 *
 * 为什么不用 JSON 整体重写：桌面 profile 的 patch 是 YAML（块序列），
 * 被别的组件拥有。整体解析再回写风险太大，所以采用"末尾追加一个受管块"：
 *
 *   # >>> dsh-qq preset (managed, do not edit) >>>
 *   - {"insert":[{"id":"preset-qq","name":"...","config":{...}}]}
 *   # <<< dsh-qq preset <<<
 *
 * 追加的是一行 JSON 流式映射，而 JSON 是合法 YAML，所以不改动任何已有内容，
 * 删除时按标记整段摘掉即可。
 *
 * 用法：
 *   node plugin/set-preset.mjs
 *   node plugin/set-preset.mjs <profileName>
 *   node plugin/set-preset.mjs <profileName> --remove
 */
import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  resolveDshHome,
  resolveProfileName,
  loadStandardPresetPlugins,
  genericQqPresetPlugins,
  isProductScoped,
} from './dsh-env.mjs';

const requestedProfile = process.argv.filter((a) => a !== '--remove')[2];
const remove = process.argv.includes('--remove');
const dshHome = resolveDshHome();
let profileName;
try {
  profileName = resolveProfileName(dshHome, requestedProfile);
} catch (err) {
  console.error(err.message ?? err);
  process.exit(1);
}
const patchPath = join(dshHome, 'profiles', profileName, 'cordis.patch.yml');

if (!existsSync(patchPath)) {
  console.error(`找不到 profile 的 cordis.patch.yml：${patchPath}`);
  process.exit(1);
}

const PRESET_ID = 'preset-qq';
const AGENT_PRESET_ID = 'qq';
const BEGIN = '# >>> dsh-qq preset (managed, do not edit) >>>';
const END = '# <<< dsh-qq preset <<<';
const DROP = new Set([
  'tool-bash',
  'tool-pwsh',
  'tool-jobs',
  'tool-schedule',
  'delegation',
  'present',
  'tool-ask-user',
  'command-goal',
  'tool-goal',
  'tool-skill',
  'skill-filesystem',
  'tool-plugin-manager',
  'tool-plugin-market',
  'planning',
]);

function buildDefinition() {
  const template = loadStandardPresetPlugins(dshHome);
  const sourcePlugins = template?.plugins ?? genericQqPresetPlugins();
  const plugins = [];
  for (const p of sourcePlugins) {
    if (DROP.has(p.id)) continue;
    if (isProductScoped(p.name)) continue;
    const copy = JSON.parse(JSON.stringify(p));
    if (copy.id === 'persona') {
      // 去掉 {{model}} 依赖：QQ 会话装配模型变量的时机不保证
      copy.config = {
        ...(copy.config ?? {}),
        prefix: 'You are a chat partner living in a QQ group, powered by DeepSeek Harness.',
      };
    }
    if (copy.id === 'tool-todo') {
      // 必填部署选择：QQ 里一次只推进一件事
      copy.config = { ...(copy.config ?? {}), allowParallelInProgress: false };
    }
    plugins.push(copy);
  }
  return {
    template: template?.source ?? '(generic @deepseek-ai fallback)',
    entry: {
      insert: [
        {
          id: PRESET_ID,
          name: '@deepseek-ai/dsh-agent-preset',
          config: { id: AGENT_PRESET_ID, name: 'QQ 通道（无 shell）', order: 90, plugins },
        },
      ],
    },
    plugins,
  };
}

/** 摘掉受管块，返回剩余文本 */
function stripManaged(text) {
  const lines = text.split(/\r?\n/);
  const out = [];
  let inside = false;
  for (const line of lines) {
    if (line.trim() === BEGIN) {
      inside = true;
      continue;
    }
    if (line.trim() === END) {
      inside = false;
      continue;
    }
    if (!inside) out.push(line);
  }
  return out.join('\n').trim();
}

const backup = `${patchPath}.bak-${Date.now()}`;
copyFileSync(patchPath, backup);

const original = readFileSync(patchPath, 'utf8');
const stripped = stripManaged(original);

if (remove) {
  writeFileSync(patchPath, stripped + '\n', 'utf8');
  console.log(`profile: ${profileName}`);
  console.log(`✓ 已移除受管块（备份：${backup}）`);
  process.exit(0);
}

const built = buildDefinition();

let content;
// 两种格式都要处理：
//   · 整份是 JSON/流式数组（[ ... ]）→ 解析后 push 再回写，否则会变成"数组 + 块序列"的非法文档
//   · 块序列（- id: ...）→ 末尾追加一项，YAML 里合法
let parsedArray = null;
try {
  const maybe = JSON.parse(stripped);
  if (Array.isArray(maybe)) parsedArray = maybe;
} catch {
  /* 不是 JSON，按块序列处理 */
}

if (parsedArray) {
  parsedArray.push(built.entry);
  content = JSON.stringify(parsedArray, null, 2) + '\n';
} else if (stripped === '') {
  content = `[${JSON.stringify(built.entry)}]\n`;
} else {
  content = `${stripped}\n${BEGIN}\n- ${JSON.stringify(built.entry)}\n${END}\n`;
}

writeFileSync(patchPath, content, 'utf8');

console.log(`profile: ${profileName}`);
console.log(`模板:    ${built.template}`);
console.log(`备份:    ${backup}`);
console.log(`✓ 已写入 ${PRESET_ID}（preset id = "${AGENT_PRESET_ID}"）`);
console.log('\n保留的工具：');
for (const p of built.plugins) console.log(`  · ${p.id.padEnd(20)} ${p.name}`);
console.log('\n已删除：' + [...DROP].join(', '));
