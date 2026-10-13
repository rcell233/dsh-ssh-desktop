# macOS 适配分析与 TODO

## 范围与结论

基线：上游 `yybai25/dsh-ssh-desktop` 的 `285d4bc`；个人 fork：
<https://github.com/rcell233/dsh-ssh-desktop>。本地 `origin` 指向个人 fork，
`upstream` 保留上游。审计日期：2026-10-14。

这是 Electron + 纯 Node SSH 引擎，不需要重写客户端。真正需要适配的是
Windows 专属桌面 API、标题栏与菜单、系统 SSH 选择，以及安装包和验证流程。
目标是 macOS 13 Ventura 及以上，分别提供 Apple Silicon（arm64）和 Intel（x64）构建。
保留 Windows 支持。本次不增加自动更新、不上架 Mac App Store。

**Mac 是本地客户端；DSH 仍在远端 Linux 上运行。** `packages/core/lib/remote.js`
和 `install.js` 中的 systemd、`/proc`、Linux Node 下载包是远端逻辑，不应因为
客户端换成 Mac 而改为 Darwin。服务器插件握手、租约、任务通知协议无需改版。

当前开发主机为 Linux/WSL，Node 24.14.0。Linux 测试不能证明 macOS 原生 API、
DMG 安装、通知授权或睡眠行为正确；后文单独记录 Mac CI 和实机验收结果。

## 改动清单与顺序

复选框只表示对应实现或验证已经完成；外部条件不足的项目保留未勾选。

- [x] 0. 确认 GitHub 身份、创建个人 fork、保留 upstream 并切换 origin。
- [x] 1. 审查 core / desktop / server-plugin / 打包脚本并记录本清单。
- [x] 2. 本机 SSH 与进程生命周期。
  - macOS 优先使用系统 `/usr/bin/ssh`，兼容 Apple Keychain 配置，避免依赖 Finder 启动时的 PATH。
  - 检查 SSH 可用性，缺少客户端或启动失败应报告错误，不能使主进程崩溃。
  - 隧道使用随机 LocalCommand 回执、监听探测与进程状态共同确认就绪，拒绝启动期间被其他程序抢占的端口；内部回执不写入用户日志。
  - 显式隔离用户 `ControlMaster` / `ControlPath` / `ControlPersist` 及后台启动设置，确保应用拥有并能终止端口转发进程。
  - 保留 `~/.ssh/config`、IdentityFile、ProxyJump、SSH_AUTH_SOCK；不读取密钥、不自动改用户 SSH 配置。
  - 补覆盖平台选择、参数与失败清理的回归测试。
- [x] 3. 窗口与标题栏。
  - Mac 使用系统原生标题栏和左侧红黄绿按钮；Windows 保持现有自绘标题栏。
  - `backgroundMaterial: acrylic`、`setTitleBarOverlay` 等 API 按支持的平台调用。
  - Mac remote preload 只暴露现有受校验 bridge，不注入 Windows 标题栏属性、菜单和拖动区域。
  - 本地首页不再为 Mac 保留 Windows 标题栏空白；连接管理层尺寸与远端视图保持正确。
- [x] 4. macOS 菜单与键盘。
  - 系统菜单提供应用/连接/编辑/显示/窗口，包含关于、隐藏、服务、退出等惯例。
  - 支持 Cmd+Q、Cmd+W、Cmd+C/V/X/A/Z、Cmd+Shift+Z、Cmd+R、开发者工具快捷键。
  - 菜单动作正确作用于当前远端页面或本地输入框，不能误刷新隐藏的首页。
  - 从系统菜单可打开连接管理、切换服务器、重连、重启和测试通知。
- [x] 5. Dock、菜单栏图标与生命周期。
  - Mac 图标使用 PNG/ICNS；菜单栏使用带 Retina 版本的单色 Template 图标。
  - 红色关闭按钮隐藏窗口并保持连接；Dock 点击、菜单栏和第二实例均可恢复。
  - Mac 关闭最后一个窗口不直接退出；真正退出仍执行 keep/stop 策略和超时清理。
  - Windows `displayBalloon` 限定 Windows；菜单栏图标异常不能让 Mac 无法返回窗口。
- [x] 6. 通知与未读角标。
  - Windows 保留任务栏 overlay；Mac 使用 Dock badge，避免调用 Windows 专用方法。
  - 清除未读时同步清除角标和注意提示；点击通知能激活对应连接。
  - 通知提示与故障文案区分系统；记录签名、系统通知权限、勿扰模式的验收条件。
- [x] 7. 开发环境与图标。
  - 提供 macOS/Linux shell 启动脚本和根目录 start 命令；清除继承的 ELECTRON_RUN_AS_NODE。
  - 固定兼容的 pnpm 版本，确保 Electron postinstall 被允许并实际安装运行时。
  - Node 最低版本与 Electron 依赖一致；无需运行 Windows runtime 复制脚本。
  - builder 从现有品牌 PNG 生成 Mac ICNS；新增可复现的终端字形菜单栏模板图，保持现有版权声明。
- [x] 8. 打包。
  - 将平台/架构从硬编码 Windows x64 改为明确的构建参数，默认宿主平台/架构。
  - Mac 产物为 DMG + ZIP，文件名含版本与架构，避免双架构覆盖。
  - 仅在平台/架构一致时复用本机 Electron；跨架构下载对应运行时。
  - 修正 `.app/Contents/Resources` 路径；完整打包 core、插件 tarball、图标、LICENSE 和 NOTICE。
  - 插件每次打包生成最新 tarball，避免版本号未变时复用旧代码。
  - 区分 ad-hoc 本地签名与 Developer ID 签名/Apple notarization，默认不发布 release。
- [ ] 9. 自动验证与 CI。
  - 跑原有三个包全部测试，记录基线及适配后的结果。
  - 新增平台行为和打包回归验证；Electron smoke 保留 cookie、bridge 和安全边界检查。
  - Mac 双架构原生 runner 安装、测试、打包并保留构建产物；保留 Windows 回归。
  - 验证实际 .app 架构、Info.plist、打包资源与签名，不以“脚本成功退出”代替产物检查。
- [ ] 10. 文档与交付。
  - README 写明 Mac 安装、CPU 选择、SSH/Keychain/agent、Finder PATH、开发/打包、数据与日志目录。
  - 记录 macOS 原生验收步骤、完成证据与剩余限制。
  - 将适配提交推送到个人 fork，提供仓库、提交及可用的 CI/产物链接。

## 重点设计与风险

### 现有功能可以沿用

`app.getPath('appData')` 可在 Mac 得到 `~/Library/Application Support`，再拼接
`DSH SSH Desktop`；存储层已注入目录、使用原子写入和私有文件模式。
HTTP loopback、cookie 分区、IPC 校验、远端安装确认和 VS Code Remote-SSH URL
均无 Windows 绑定。休眠恢复已有 `powerMonitor.resume → manager.resume()`，需在
Mac 实机确认系统事件与 SSH 连接恢复，不能仅靠模拟事件宣称完成。

### 需要避免的兼容性陷阱

1. `setOverlayIcon`、`displayBalloon` 是 Windows 专用；`setTitleBarOverlay` 不适用于 Mac。
2. 简单把 Ctrl 全部换成 Cmd 不够，原生菜单必须操作真正获得焦点的 WebContentsView。
3. Finder 启动的环境不同于交互式 zsh。固定系统 SSH 解决客户端路径问题；用户
   ProxyCommand 若调用 Homebrew 工具，仍应在 SSH 配置里填写绝对路径。无需执行用户
   shell 初始化脚本或复制全部终端环境。
4. 用户启用 SSH 连接复用/后台运行时，子进程退出不代表端口已关闭，需明确保持转发所有权。
5. 无证书可以做 ad-hoc 测试包，但不等于已通过 Gatekeeper 或通知事件可用。
   Developer ID 和 notarization 需要维护者的 Apple 账号与证书，不能伪造或自动申请。
6. Mac 通知、Dock、菜单栏外观、全屏、键盘焦点及睡眠恢复必须有原生验证。

## Mac 实机验收（待执行）

- [ ] arm64 与 x64 分别从 DMG 拖入 Applications 并从 Finder 启动；不依赖终端 PATH。
- [ ] 默认 SSH、带口令且已加入 agent/Keychain 的密钥、ProxyJump/Include 均可连接。
- [ ] 首次 token 登录、下次 cookie 复用、多服务器切换、断线自动恢复。
- [ ] 首页/连接管理/远端 UI 无遮挡；拖动、红黄绿按钮、全屏和深浅模式正常。
- [ ] 本地输入框与远端编辑器的 Cmd 快捷键、菜单编辑、刷新和开发者工具均指向当前页面。
- [ ] 关闭窗口保持 SSH；Dock/菜单栏/二次启动/点击通知均可返回正确连接。
- [ ] 任务通知、权限拒绝、勿扰、未读角标增减清零；签名包通知点击事件正常。
- [ ] 合盖睡眠/唤醒后重连；网络切换后恢复；退出 keep 和 stop 两种策略正确。
- [ ] 安装升级上传的插件来自当前源码；VS Code Remote-SSH 打开远端目录。
- [ ] 诊断导出及日志脱敏；重装保留数据；清晰说明手动删除数据位置。

## 依据

- [Electron BrowserWindow 平台 API](https://www.electronjs.org/docs/latest/api/browser-window)
- [Electron 菜单角色和 macOS 约定](https://www.electronjs.org/docs/latest/api/menu-item)
- [Electron 通知与签名要求](https://www.electronjs.org/docs/latest/tutorial/notifications)
- [Electron 44 的 macOS 13 最低要求](https://www.electronjs.org/blog/electron-44-0)
- [electron-builder macOS 配置](https://www.electron.build/v26/docs/mac/)
- [electron-builder 多平台构建](https://www.electron.build/docs/features/multi-platform-build/)

## 执行记录

- 2026-10-14：已创建个人 fork 并配置 remotes；完成首次静态审计并建立 TODO。
- `b042921`：分析与 TODO 已先行提交并推送。
- `c2815b2`：完成第 2–8 项实现，推送个人 fork 并启动三平台 CI。
- core 本地全套 133 项通过；平台 API、Mac 菜单/preload、打包参数及 builder schema 回归通过。
- 原有 start-script 测试失败已定位为测试误调用开发机 systemd 用户服务，改为确定性的测试 stub 后通过；没有修改远端 DSH 协议。
- 首轮本地与三平台 CI 暴露了窗口关闭回调重复清理 WebContents 导致的退出挂起；修复后，Linux/WSL 的 `DSH_SSH_DESKTOP_REQUIRE_ELECTRON=1 xvfb-run -a pnpm test` 全部通过，Chromium sandbox 保持启用。
- SSH 就绪回执除模拟子进程竞争测试外，已用独立本地 sshd、临时密钥实测端到端转发；未读取或修改用户真实 SSH 配置和密钥。
- 原生 CI：[首次运行](https://github.com/rcell233/dsh-ssh-desktop/actions/runs/38485979154)，首轮退出问题已修复；最终构建结果待回填。
