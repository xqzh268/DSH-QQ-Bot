# 外部聊天通道如何驱动 DSH 会话：API 形状（源码实证）

> 依据：DSH 官方微信通道插件的源码形状（下文简写 `src/`），所有 `文件:行号` 指该插件目录内文件。
> 该插件对 DSH **零运行时依赖**：不 import `@deepseek-ai/*`，全部服务经 `ctx.get("<name>")` 取结构类型（types.ts:1-8、sessions.ts:5-8）。

## 1. 拿到 agent 注册表后，怎么找到 / 创建会话

服务名 `"agents"`，类型 `AgentsService`（sessions.ts:87-89）：

```ts
// src/dsh/sessions.ts:28-33
export interface AgentsService {
  create(options: CreateAgentOptions): Promise<AgentHandle>;
  resume(options: ResumeAgentOptions): Promise<AgentHandle>;
  get(id: string): Agent | undefined;
  list(): Agent[];
}
```

- 按 id 取：`agents.get(sessionId)`。DSH 中 `Agent.id` **就是** `SessionId`（bridge.ts:3213-3214），不存在第二个 id。
- 列出现有 agent：`agents.list()`（仅进程内活着的）；持久化会话清单用 `sessionQuery.listSessions(): Promise<SessionRecord[]>`（ops.ts:135-136）。

**创建新会话 = `agents.create`（已找到可行路径）**：

```ts
// 节选自 src/dsh/sessions.ts:150-163
const sessionId = mintSessionId();          // `session-${crypto.randomUUID()}`，sessions.ts:78-80
const handle = await agents.create({
  sessionId,
  meta: { cwd: user.cwd, ...(presetForSession ? { agentPreset: presetForSession } : {}) },
  setup: agentSetup,                        // 关键：preset 在 setup 里 mount
});
```

`CreateAgentOptions` = `{ sessionId, meta?:{cwd?, agentPreset?}, agentOptions?:{provider?, model?}, setup? }`（types.ts:163-180）；恢复用 `ResumeAgentOptions` = `{ resumeSessionId, agentOptions?, setup? }`（types.ts:182-190）。`setup` 在新版签名是 `(agentCtx, agent?)`（types.ts:174-179）。

创建后源码还做两件必须的事：
1. `agentPresets.mount(agentCtx, agent?.session?.header?.agentPreset)`（sessions.ts:266-280）——漏掉则会话没有任何 preset 工具（pwsh/fs/web/skill…）。
2. `workspaceRegistry.resolveByPath(cwd)` → 无则 `create(cwd)` → `workspace.attachSession(sessionId)`（sessions.ts:171-193）——漏掉则 GUI 侧栏归入"未分组"。

## 2. 怎么把一条用户消息投递进去

```ts
// src/dsh/types.ts:55-63
export type UserMessageSource = { kind: "user" } | { kind: "plugin"; plugin: string };
export interface UserMessage {
  readonly id: string; readonly role: "user";
  readonly content: ContentBlock[]; readonly source: UserMessageSource;
}
```

- `content` 的 block 只有一种形状：`{ type: "text"; text: string }`（types.ts:11-16，`ContentBlock = TextBlock`）。桥接自己构造的也全是 text block（bridge.ts:2279、2348、2711-2717）；图片/文件先落盘再以纯路径或 `@文件` 引用写进 text block，不内联二进制（bridge.ts:2279-2286）。
- `source` 填 `{ kind: "user" }`，与 GUI 输入框消息完全一致；`{ kind:"plugin", plugin:"xxx" }` 在 GUI 会显示成"上下文注入"（types.ts:50-55、sessions.ts:212-218）。
- `id` 用 `createUserMessage` 生成：`crypto.randomUUID()`，随后 `structuredClone` + 深冻结；**无格式要求、无需自己拼**（messages.ts:26-40，id 在 :37）。
- `followup` vs `steer`（sessions.ts:195-229 注释、bridge.ts:2350-2359）：`followup` = 普通后续轮次；`steer` = 空闲时开一轮、运行中在最近 step 边界插入当前轮。**agent 正在跑时用哪个取决于 DSH 设置 `ui-conversation.busyEnter`**：`"queue"`→`followup`，`"steer"`→`steer`；空闲一律 `followup`。见下方唯一一组调用点：

```ts
// src/bridge/bridge.ts:2358-2359
const mode = agent.status === "running" ? this.ops.busyEnter() : "queue";
this.agents.followup(agent, blocks, mode, (id) => this.markWechatMessage(id));
```

## 3. 怎么读回助手的回复

读取面：`agent.session.snapshotEvents(fromSeq?, toSeqExclusive?)`（0.1.5+；旧 host 只有 `session.events`），桥接统一走 `sessionEvents(session)` 兼容函数（types.ts:72-122）。

**实际出现的事件 type 字符串**（`turn/end` 等的判定，bridge.ts:2808；其余见下）：`session`（首行 header）、`user/message`、`assistant/message`、`turn/start`、`turn/end`、`tool/call`、`tool/result`、`session/title`、`agent-preset/selected`、`agent/inbox/spliced`。注意 `agent/status`、`agent/assistant-stream`、`agent/error`、`session/disposed` 是 Cordis 总线事件（`context.on(...)`），**不在**会话日志里（index.ts:83-120）。完整集合未确认，以上仅为源码里实际读/写的字面量。

**一条助手正文消息**（注意消息在 `data.message`，不在顶层，bridge.ts:2803-2804）：

```ts
// 路径：ev.type === "assistant/message" → ev.data.message.content[i].text（block.type === "text"）
const data = ev.data as { turn?: number; step?: number; message?: { content?: { type: string; text?: string }[] } };
const text = (data?.message?.content ?? []).filter(b => b.type === "text" && b.text).map(b => b.text).join("\n");
```

兜底形状：`data.content[]`、`data.text`、`data.prompt`/`data.input`（ops.ts:858-870）。

**这一轮结束了**：日志事件 `turn/end`（bridge.ts:2917、3017-3047），其 `data.reason` 可能是字符串 `"error" | "aborted" | "stop"`，或 `{ kind: "error" | "aborted" }`（bridge.ts:3041-3042，两种都要判）。状态面：`agent.status` 只有 `"idle" | "running"`（types.ts:127），总线上 `agent/status` 载荷为 `{ agent: { id }, status }`（index.ts:107-113）；也可 `await agent.whenIdle()`（types.ts:149）。"会话是否已开跑"用 `turnBoundary` 投影：`openTurnStartSeq != null || lastTurn > 0`，无投影则回退到日志里是否出现 `turn/start`/`user/message`/`assistant/message`（ops.ts:1156-1173）。

**可复用的折叠函数**：`session-log.cjs` 的 `module.exports`（session-log.cjs:723-738）全是**按 `(cwd, sessionId)` 读磁盘 JSONL 的读取器**，不是 `snapshotEvents` 的折叠器：`readSessionEvents`（448，返回原始事件数组）、`readSessionListFacts`（671，折叠 preset/title/lastUserMessageTime）、`readSessionRuntimePreset`（719）、`locateSessionLog`、`projectKey`、`resolveDshHome`、`clearSessionLogCache` 等。把事件折成 `{role,text,time}` 的逻辑在 `DshOps.historyEntries` / `extractHistoryText`（ops.ts:844-907），但是 **private，不可直接复用**。

## 4. 怎么给会话指定 preset

- 创建时：`meta.agentPreset` 写进 header（sessions.ts:157），并在 `setup` 里 `agentPresets.mount(agentCtx, id)`（sessions.ts:271-280）；`agentPresets.defaultId` 是部署默认（ops.ts:197-202）。
- 运行期切换：`agentPresets.select(agent, agentPreset): Promise<string>`（ops.ts:194-214），由 `selectSessionPreset` 包装，失败码 `agent-preset/locked` 映射为 `{kind:"locked"}`（ops.ts:1186-1206）：

```ts
// src/dsh/ops.ts:1190-1199
if (typeof presets.select === "function") { await presets.select(agent, presetId); return { kind: "switched" }; }
// 老 host 无 select：重挂 + 手写同一个持久事件
await presets.recompose(agent.ctx, presetId);
agent.session?.append?.("agent-preset/selected", { agentPreset: presetId });
```

- **有"只在创建时生效"的限制**：`select` 拒绝已经开跑的会话（存在 open turn 或已完成过 turn → 抛 `agent-preset/locked`，ops.ts:209-211、1201-1203；判定见 ops.ts:1156-1173）。所以外部通道要指定 preset，可靠做法是**建会话时给 `meta.agentPreset`**，之后只能换新会话。

## 5. 坑

- `cancel` 必须传对象：`{kind:"user"|"parent"|"disposed"}` 或 `{kind:"hook", reason}`；0.2.x 起老的 `"user-stop"` 字符串会抛 `unreachable variant`（types.ts:139-148；实际调用 `agent.cancel({ kind: "user" })`，bridge.ts:4747）。
- 判忙只看 `agent.status`（`"idle"|"running"`），别自己维护状态位（types.ts:127、bridge.ts:2358）。
- session id 沿用 `session-<uuid>`（`mintSessionId`，与 GUI/session controller 同一铸造）：它同时是 `Agent.id` 和 workspace 归属键，自造格式会破坏列表/归组（sessions.ts:72-80、bridge.ts:3213）。
- `followup`/`steer` 会**同步**发 `agent/inbox/spliced`，所以消息 id 必须在调用**之前**登记好（sessions.ts:219-222）。
- `snapshotEvents()` 是 0.1.5+ 的可选方法，旧 host 上为 `undefined`（直接调用即 TypeError），用 `sessionEvents()` 兜底（types.ts:72-77、106-122）。
- `sessionQuery.listEvents` 自 0.1.2 起不带 `data`，重建正文必须用 `readSession(sessionId)`（ops.ts:138-146、957-968）。
- preset 的 `mount` 失败不会让 create 失败（仅 console.error），会出现"会话能跑但没工具"的静默降级（sessions.ts:276-279）。
- 会话归组写失败同样非致命，只在日志里留一行（sessions.ts:189-192）。
- 插件自有状态用"临时文件 + rename"原子替换（state.ts:153-168）；Windows 上 `0o600` 失效，只靠 ACL（secure-fs.ts:11-15）。
- 写入 DSH settings（preset/model 默认值）是异步且可能失败的，桥接会回落成"仅本进程生效"（ops.ts:1319-1322、bridge.ts:4734-4737）。

**未确认**：(a) `snapshotEvents()` 返回类型的完整枚举（只列出源码实际用到的 type）；(b) `turn/end.data` 除 `reason` 外的其余字段；(c) 是否存在除 `agents.create` 外的第二条创建路径（源码内仅此一处）。
