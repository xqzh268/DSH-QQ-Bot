# NapCat 侧配置（10 分钟）

插件已经写好了，剩下的是让 NapCat 把 QQ 事件推过来。

## 1. 装 NapCat，登录小号

1. 从 [NapCatQQ Releases](https://github.com/NapNeko/NapCatQQ/releases) 下对应系统的包（Windows 一般是 NapCat.Shell / 免安装包）。
2. 解压后运行启动脚本（一般是 `launcher.bat` 或 `napcat.bat`），会弹出一个二维码或 WebUI 地址。
3. 用**小号**扫码登录。
4. 登录成功后注意看控制台输出的 **WebUI 地址**和 **token**（形如 `http://127.0.0.1:6099/webui?token=xxxx`），后面要用。

> 小号必须**已经在这个群里**。NapCat 只是接管客户端，不会替你加群。

## 2. 在 NapCat 里加一个「WebSocket 客户端」（反向 WS）

打开 WebUI → 左侧「网络配置」→ 新建 → 选 **WebSocket 客户端**（有的版本叫「反向 WebSocket」）：

| 项 | 填什么 |
|---|---|
| 名称 | `dsh-qq-bot` |
| URL | `ws://127.0.0.1:7800/onebot?access_token=换成你自己的一串随机字符` |
| 消息格式 | `array`（必须是 array，不是 string/CQ 码） |
| 心跳间隔 | 默认即可（如 30000） |
| 启用 | ✅ |

URL 里的 `access_token` 必须和 `config.json` 里 `onebot.token` **完全一致**。改过 token 的话，两个地方都要改。

## 3. 先起 Harness，再连 NapCat

顺序很重要：插件是 WebSocket **服务端**，要先把 7800 端口监听起来，NapCat 才连得上。

1. 按仓库 README 把插件装进 DeepSeek Harness。
2. 启动（或重启）Harness 桌面应用，等到日志出现 `[dsh-qq] 就绪`。
3. 再启动 / 重载 NapCat 的反向 WS。

看到类似下面的日志就说明通了：

```
[dsh-qq] 等待 NapCat 连接：ws://127.0.0.1:7800/onebot
[dsh-qq] NapCat 已连接 127.0.0.1
[dsh-qq] 识别到 bot 账号 123456789
```

最后一行出现后，可以把那个 QQ 号填进 `config.json` 的 `bot.selfId`（不填也能跑，因为会自动识别，但填了重启后第一反应更快、@ 判断更稳）。

## 4. 第一次对话

1. 在群里 @小号 发一句「在吗」。
2. 插件日志应该出现 `收到` 以及 `kind: group`。
3. 如果仓库 `data/` 下生成了数据库或画像，说明整条链路通了。也可以在 Harness 侧边栏的 QQ 面板里看连接状态。

没反应就按这个顺序查：

| 现象 | 原因 |
|---|---|
| 日志没有「NapCat 已连接」 | URL 写错 / 端口被占 / token 不一致（NapCat 会静默失败，看它自己的日志） |
| 连上了但 `收到` 不出现 | NapCat 的消息格式不是 `array`，或者事件没订阅 |
| `收到` 有、但没回 | 群不在白名单 / 没被 @（`groupTrigger: at`）/ 后端报错 |
| 回复变成乱码或空 | 看 `data/plugin.log` 或 Harness 日志 |

## 5. 常见坑

- **端口冲突**：`listenPort: 7800` 被占用时，插件启动会报错。换端口后 NapCat 里的 URL 也要改。
- **只监听本机**：`listenHost` 默认 `127.0.0.1`，NapCat 在同机才行。跨机部署要改成 `0.0.0.0`，并且**必须**设 token。
- **别用大号**：小号被风控只损失一个号；大号被封损失通讯录。也不要在重要群里跑高频主动发言。
- **群名/群号**：`access.groups` 填群号（纯数字），不是群名。
- **换号重登**：NapCat 重新扫码后 `selfId` 会变，插件能自动适配，但 `config.json` 里最好同步更新。
