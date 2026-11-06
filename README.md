# DSH-QQ-Bot

把 **QQ**（NapCat / OneBot v11）接进 **DeepSeek Harness** 的人格化通道插件。她不是问答机器人，是一个有名字、有脾气、记得住人的群友——被 @ 时能正经干活，闲下来能插话，聊久了会记得你是谁。

```
QQ 客户端
   │  小号扫码登录
NapCat（OneBot v11 协议端）
   │  反向 WebSocket
DeepSeek Harness 桌面应用
   └── dsh-qq 插件（本仓库）
         ├ 事件归一化   @我 / 私聊 / 戳一戳
         ├ 准入与限流   白名单 / 冷却 / 每小时上限
         ├ 人设与记忆   角色卡 + 用户画像 + 最近聊过
         └ 会话路由     每个群、每个人一条 DSH 会话
```

本插件按官方 DSH bundle 格式编写，可安装到任意 DeepSeek Harness（官方桌面版 / CLI profile 均可）。不绑定某一家二次发行版。

## 需要什么

- 已安装并可启动的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
- Node.js 20+（安装脚本用）
- [NapCat](https://github.com/NapNeko/NapCatQQ)（或其它 OneBot v11 反向 WebSocket 实现）和一个 QQ **小号**

## 安装

### 方式 A：桌面应用插件面板（推荐）

1. 打开 DeepSeek Harness → **插件** → 安装 → **Git 仓库**
2. 填入 `https://github.com/xqzh268/DSH-QQ-Bot.git`
3. 装完后按提示重启应用，侧边栏会出现「QQ」面板

配置、人设和记忆默认写在 `$DSH_HOME/dsh-qq`（Windows 一般是 `%USERPROFILE%\.dsh\dsh-qq`）。首次启动会自动放一份 `config.json` 和角色卡，在 QQ 面板里填 OneBot token、主人 QQ、允许活动的群号即可。

命令行等价于：

```bash
dsh plugin --profile desktop add github:xqzh268/DSH-QQ-Bot
```

桌面 profile 由 Electron 独占时，请用面板安装，不要用 CLI。

### 方式 B：从源码复制进 profile

适合改插件代码、或面板装不上的情况。仓库目录会同时当作数据目录：

```bash
git clone https://github.com/xqzh268/DSH-QQ-Bot.git
cd DSH-QQ-Bot
node plugin/install.mjs
```

脚本会探测 `$DSH_HOME`（未设置则 `~/.dsh`，并扫描本机其它 Harness home），优先装进 `desktop` / `desktop*` profile。多个 profile 时显式指定：

```bash
node plugin/install.mjs desktop
```

卸载：

```bash
# 面板里卸，或
dsh plugin --profile desktop remove dsh-qq
# 源码安装则：
node plugin/uninstall.mjs
```

## NapCat

协议端怎么配见 **[docs/NAPCAT.md](docs/NAPCAT.md)**。要点：

- 反向 WebSocket 指到 `ws://127.0.0.1:7800/onebot?access_token=<与 config.json 里 onebot.token 相同>`
- 消息格式必须是 `array`
- 先启动 Harness（插件先监听端口），再让 NapCat 连上来

## 配置要点

配置文件是仓库根目录的 `config.json`（从 `config.example.json` 复制，已在 `.gitignore` 里）。也可在 Harness 侧边栏的 QQ 面板里改。

| 配置 | 说明 |
|---|---|
| `onebot.listenPort` / `token` | 插件监听的端口和握手 token，必须和 NapCat 里的 URL 一致 |
| `bot.selfId` | 小号 QQ 号，留空会自动识别 |
| `bot.ownerId` | 你的 QQ 号：私聊永远理你，群聊仍要 @ 才回 |
| `access.groups` | 允许她活动的群号，**留空 = 所有群**，上线前务必填 |
| `access.users` | 允许驱动她的人，留空 = 所有人 |
| `access.groupTrigger` | `at`（默认）/ `always` / `smart`（命中 `keywords` 也说） |
| `plugin.agentPreset` | 默认 `qq`（无 shell 的受限 preset，由安装脚本写入） |
| `plugin.workspaceDir` | 她能读写的工作区，默认仓库下的 `qq-sandbox` |
| `proactive.enabled` | 主动发言，默认建议先观察再开 |

## 记忆是怎么工作的

1. **会话历史**：每个 `chatKey` 绑一个 DSH `session-id`，交给 DSH 自己管原始窗口。
2. **用户画像**：`data/profiles` 与本地 SQLite（`data/qq-messages.db`），存印象词、已知事实、最近摘要。
3. **回写机制**：每轮回复末尾模型会额外输出 `<<MEMO>>{...}<</MEMO>>`，插件截下来写进画像，**这段不会发到 QQ**。

## 角色卡

`persona/*.json`，可在 QQ 面板里热换：

| 文件 | 角色 | 定位 |
|---|---|---|
| `dafeiyu.json` | 大肥鱼大王 | 混在群里的活人网友，有事说事没事扯淡 |
| `daughter.json` | 大肥鱼闺女 | 软乎乎的小憨憨，说话慢半拍但很乖 |

对照见 `persona/INDEX.md`。

## 安全（别跳过这段）

群里任何人 @ 她就能驱动一次 DSH 会话。安装脚本会写入一个去掉 shell / 委派 / 插件管理的 `qq` preset，插件运行时还有工具白名单和工作区路径限制。即便如此：

- `access.groups` 和 `access.users` 一定要填，别留空上线。
- `onebot.token` 一定要设，否则本机任何程序都能冒充 NapCat。
- 只给小号用，别用大号；别在重要群/工作群里跑。

## 目录结构

```
plugin/dsh-qq/          DSH bundle（cordis 插件 + 客户端面板）
plugin/install.mjs      装进当前机器的 DSH profile
plugin/uninstall.mjs    卸掉
plugin/set-preset.mjs   写入/移除 QQ 受限 preset
persona/                角色卡模板
config.example.json     配置模板
docs/NAPCAT.md          NapCat 配置步骤
```

## 已知限制

- 无审批交互：QQ 会话走受限 preset，不能在群里批准危险工具。
- 单进程：多个群同时说话时排队。
- 图片会下载并做理解/表情包归档，但能力取决于当前模型。
