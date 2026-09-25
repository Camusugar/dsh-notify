# @camusugar/dsh-notify

DSH 用户级插件：当会话**卡在等人操作**时（权限批准 / ask_user_question 提问 /
plan 模式方案确认），且应用窗口**不在前台**（最小化、切到别的窗口、失焦），弹一条
操作系统级系统通知（Windows toast / macOS 通知中心）。用户回到应用窗口，或回答完
对应请求后，通知自动消失。

> 已验证：DSH Desktop 0.1.7-rc.2（Windows）。通知走标准 Web Notification API，
> 理论上跨平台；macOS 要求应用为签名构建（UNNotification 限制）。

## 安装

```sh
dsh plugin add https://github.com/Camusugar/dsh-notify
```

## 特性

- 纯事件驱动：1 个 `uiSession.sessionStatus` 订阅 + 3 个标准 DOM 监听
  （visibilitychange / blur / focus），**没有任何定时器、轮询、React 渲染**。
- 不修改 DSH 本体；随 profile 安装，应用升级后仍保留。
- 容错设计：uiSession 服务缺失或形状漂移 → 静默禁用（console.warn），
  绝不向 Cordis loader 或共享发布器抛错；通知创建失败 → 跳过。
- 每个待决请求一条通知（按 key 去重），上限 16 条，超出静默抑制。
- **多会话并发**：状态快照按会话索引，插件一次遍历所有会话；各域 key
  （`approval:N` / `question:N`，含 plan-review）为模块级全局递增计数器，
  跨会话唯一。各会话通知独立弹出、独立关闭（某会话解决只关它那条）。
  body 首段带会话显示名（持久标题 → 工作区目录名 → 会话 id），方便区分。
- 中文/英文文案按 `navigator.language` 自动选择。

## 文件

```
├── package.json        bundle + client 插件清单（dsh.bundle / dsh.client）
├── cordis.patch.yml    插入一行 client 插件
├── lib/index.js        宿主端入口（空 apply；双脸包必须有宿主入口，否则宿主报 failed to import）
├── lib/client.js       浏览器端插件产物（window.__ModuleLoader__ 行）
└── smoke.mjs           回归测试（node smoke.mjs，7+1 用例，无需装依赖）
```

## 卸载

插件页 → 卸载 `@camusugar/dsh-notify`；或手动：

1. 退出应用
2. 编辑 `~/.dsh/profiles/desktop/package.json`（Windows：
   `C:\Users\<用户名>\.dsh\profiles\desktop\package.json`）：从
   `dsh.profile.bundles` 和 `dependencies` 中删除 `@camusugar/dsh-notify`
3. （可选）删除同目录 `node_modules\@camusugar`
4. 重启应用

## 如果插件把应用弄坏了（恢复手册）

**第一优先：应用内置恢复。** 启动失败时应用会弹致命错误对话框，选择
「禁用全部插件并重启」（disableAllPlugins）：它会把
`cordis.patch.yml` 备份为 `cordis.patch.yml.bak-<时间戳>`，并把
`dsh.profile.bundles` 重置为官方默认（dsh-base + dsh-web-app），然后重启。
之后可重新安装本插件。

**手动恢复**（保留你 cordis.patch.yml 里的模型等自定义配置）：

1. 退出应用（托盘图标退出；任务管理器结束所有 "DeepSeek Harness" 进程）
2. 编辑 `~/.dsh/profiles/desktop/package.json`：`dsh.profile.bundles` 数组里
   删掉 `"@camusugar/dsh-notify"`；`dependencies` 里删掉对应那一项
3. 重启应用 —— 其余配置（模型 provider 等）不受影响

**最后手段**（上面都不行时）：退出应用，把 `~/.dsh/profiles/desktop` 整个
目录改名成 `desktop.bak`，再启动应用 —— 应用会自动重建一个全新默认 profile。
**注意：这会丢掉 cordis.patch.yml 里的自定义（模型 provider 等），改名前先备份。**
