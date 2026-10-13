# DSH SSH Desktop

在 Windows 和 macOS 上使用**运行在服务器上的** DeepSeek Harness（DSH）。

*A Windows and macOS desktop shell for a [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) that runs on a remote server: it starts or reuses `dsh web` there over the system ssh, forwards its port, and shows the remote UI in its own window — with multi-server support, desktop notifications, one-click server install and a companion DSH plugin (`dsh-desktop-link`).*

> **非官方项目。** 本项目是社区开发的第三方工具，与 DeepSeek 没有隶属或背书关系。应用图标中的鲸鱼标志及「DeepSeek」名称归 DeepSeek 所有，这里仅用于标明所连接的软件；如权利人有异议，请提 issue，我会替换。
>
> *Unofficial, community-made tool, not affiliated with or endorsed by DeepSeek. The whale logo in the app icon and the DeepSeek name belong to DeepSeek and are used only to identify the software this connects to.*

应用通过系统自带的 ssh 登录服务器，启动或复用那里的 `dsh web`，把它的端口转发到本机，再在自己的窗口里显示 DSH 的界面。DSH、它的 profile、会话和工作区都留在服务器上；本机只负责显示，不运行 DSH，也不保存任何密钥。

- 可以同时连接多台服务器，在窗口里切换
- 远端任务完成时弹出系统通知，Windows 任务栏 / macOS Dock 显示未读角标
- 会话顶部有「VS Code」按钮，通过 Remote-SSH 打开会话所在的目录
- 能在服务器上一键安装或升级 DSH 和配套插件，只写入你的家目录，不需要 root
- 断线或电脑睡眠唤醒后自动重连；可以选择退出应用时是否停止远端 DSH

## 截图

<table>
  <tr>
    <td width="50%"><img src="docs/screenshots/sessions.png" alt="连接管理：多台服务器，一键连接、断开、重启或停止远端"></td>
    <td width="50%"><img src="docs/screenshots/install.png" alt="安装与升级：安装前列出每一步要执行的命令"></td>
  </tr>
  <tr>
    <td align="center">多台服务器，状态一目了然</td>
    <td align="center">一键安装 Node.js、DSH 和配套插件，每一步先列出来再执行</td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/screenshots/server.png" alt="服务器：ssh 目标、dsh 路径、Node 版本和插件状态"></td>
    <td width="50%"><img src="docs/screenshots/settings.png" alt="连接设置：ssh 别名、工作区、端口和退出策略"></td>
  </tr>
  <tr>
    <td align="center">连接前自动探测服务器环境和插件状态</td>
    <td align="center">每台服务器单独设置，身份和跳板机交给 ~/.ssh/config</td>
  </tr>
</table>

*截图中的服务器名和地址均为示例。*

## 安装

本仓库是 [yybai25/dsh-ssh-desktop](https://github.com/yybai25/dsh-ssh-desktop) 的 macOS 适配 fork。
改动分析、实施状态和实机验收清单见 [macOS 适配 TODO](docs/macos-adaptation.md)。

### macOS

要求 **macOS 13 Ventura 或更新版本**。Apple Silicon（M 系列）选择 `arm64`，Intel Mac 选择 `x64`；在「 → 关于本机」确认芯片类型。

1. 从本 fork 的 [GitHub Actions](https://github.com/rcell233/dsh-ssh-desktop/actions/workflows/build.yml) 成功构建中下载对应架构的产物，或按下方命令在 Mac 上自行打包。下载 Actions 产物需要登录 GitHub。
2. 打开 `DSH-SSH-Desktop-<版本>-mac-<架构>.dmg`，将 **DSH SSH Desktop.app** 拖入 Applications，然后从 Applications 启动。ZIP 也可解压后把应用移到 Applications。
3. 默认构建只有 **ad-hoc 本地签名**，没有 Apple Developer ID 签名或公证。若 Gatekeeper 拦截，确认来源可信后，在「系统设置 → 隐私与安全性」中按系统提示允许打开；不要关闭全局系统安全检查。面向普通用户分发的签名构建方式见下文。

macOS 通知需允许系统通知权限，事件行为还依赖应用签名。开发态 Electron 和 ad-hoc 测试包的表现不能代替正式签名包的通知验收，详见 [Electron 通知说明](https://www.electronjs.org/docs/latest/tutorial/notifications)。

### Windows

运行 `DSH-SSH-Desktop-Setup-<版本>.exe`。默认只为当前用户安装，不需要管理员权限，也可以在安装时更改安装位置。

安装包**没有数字签名**，第一次运行时 Windows SmartScreen 可能提示「Windows 已保护你的电脑」。点「更多信息」，再点「仍要运行」即可。

## 准备

1. **系统 ssh 能非交互登录服务器。** Windows 使用系统 OpenSSH（`C:\Windows\System32\OpenSSH\ssh.exe`）和 `%USERPROFILE%\.ssh\config`；macOS 使用 `/usr/bin/ssh` 和 `~/.ssh/config`。在配置中设置 Host 别名、身份文件、端口和跳板机，先在终端确认主机指纹并完成私钥解锁，再运行 `ssh -o BatchMode=yes <别名> true` 确认无需交互。应用不提供密码输入框。
2. **服务器上有 DSH。** 如果还没有，添加服务器后在「连接管理 → 安装与升级」里检查一下，按提示一键安装：Node.js、pnpm、DSH 和配套插件 dsh-desktop-link 会装进 `~/.local/opt` 和 `~/.dsh`。

### macOS SSH 配置示例

```sshconfig
Host my-server
    HostName server.example.com
    User your-user
    IdentityFile ~/.ssh/id_ed25519
    AddKeysToAgent yes
    UseKeychain yes
```

对带口令的密钥，可先在 Mac Terminal 中运行 `/usr/bin/ssh-add --apple-use-keychain ~/.ssh/id_ed25519`，然后运行 `/usr/bin/ssh -o BatchMode=yes my-server true`。
`UseKeychain` 是 Apple 系统 OpenSSH 扩展，因此应用固定使用 `/usr/bin/ssh`。第三方 SSH agent（例如密码管理器）可通过 `IdentityAgent` 指定 socket；应用保留系统继承的 `SSH_AUTH_SOCK`，不创建或替换你的 agent。[Apple OpenSSH 配置说明](https://developer.apple.com/library/archive/technotes/tn2449/_index.html)

Finder 启动应用时不会执行 `.zshrc`。如果 `ProxyCommand` / `Match exec` 使用 Homebrew 等工具，请在 SSH 配置中写工具的**绝对路径**（例如 `/opt/homebrew/bin/cloudflared`），并确保这些工具也无需交互。应用会隔离 SSH 连接复用和后台启动设置，以便准确关闭自己创建的隧道，其他身份与跳板配置保持由 OpenSSH 解析。

服务器目前仍要求 Linux；Mac 客户端并不表示一键安装支持 macOS 服务器。

## 使用

1. 打开应用，在「应用 → 连接管理 → 添加服务器」里填写 ssh 别名和服务器上的工作目录，然后保存。
2. 点「连接」。第一次启动远端 DSH 通常要 1–3 分钟，之后再连接会直接复用，只需几秒。
3. 连接后，窗口里的操作和在浏览器里用 DSH 完全一样。Windows 使用窗口左上角「应用」菜单，Mac 使用屏幕顶部原生菜单，可以切换服务器、打开连接管理、测试通知。Mac 支持 Cmd+C/V/X/A/Z、Cmd+Shift+Z、Cmd+R 等常用快捷键。
4. 关闭主窗口会隐藏窗口，连接和通知继续工作。Windows 从托盘恢复；Mac 从 Dock 或菜单栏的终端图标恢复。Mac 的 Cmd+W 关闭窗口，**Cmd+Q 真正退出应用**；也可从应用菜单或托盘/菜单栏菜单选择「退出」。

### 退出应用时

在每台服务器的「连接设置」里选择：

- **保持远端运行**（默认）：服务器上的 DSH 继续运行，下次打开应用直接接上，正在跑的任务不受影响。
- **停止远端**：正常退出时停止服务器上的 DSH。如果应用被强制结束、崩溃或长时间断网，远端会在约 10 分钟后自行停止。这需要服务器上装有配套插件。选择该策略时，Mac 长时间合盖睡眠也会导致续租中断，约 10 分钟后远端可能停止；需要长时间后台跑任务时选择「保持远端运行」。

## 数据与日志

| 内容 | Windows | macOS |
|---|---|---|
| 数据根目录 | `%APPDATA%\DSH SSH Desktop` | `~/Library/Application Support/DSH SSH Desktop` |
| 服务器列表 | 根目录下 `connections.json` | 根目录下 `connections.json` |
| 各服务器的登录状态（cookie） | 根目录下 `Partitions/` | 根目录下 `Partitions/` |
| 日志 | 根目录下 `logs/main.log` | 根目录下 `logs/main.log` |

日志超过 1 MB 时轮换为 `main.old.log`。

Windows 默认安装位置是 `%LOCALAPPDATA%\Programs\DSH SSH Desktop`，安装程序自己的副本放在 `%LOCALAPPDATA%\DSH SSH Desktop\updater`。0.1.0 用的旧目录 `%APPDATA%\dsh-ssh-desktop` 会在第一次启动时自动搬到新位置。

日志和「连接管理 → 导出诊断」生成的文件都会去掉启动令牌和连接密钥，可以直接附在问题报告里。卸载时这些数据会保留；如果不再需要，退出应用后删除上表对应系统的数据根目录即可。Mac 将应用拖入废纸篓同样会保留这些数据。

## 开发

开发需要 Node.js **22.12.0+**（推荐 24 LTS）和仓库 `packageManager` 指定的 pnpm 10.32.1。可运行 `corepack enable` 后由 Corepack 选择仓库版本，或 `npm install -g pnpm@10.32.1`。

```sh
pnpm install --frozen-lockfile
pnpm start                                      # macOS/Linux/常规 Windows 开发启动
pnpm test                                        # 三个包的全部测试
pnpm package:mac --arch arm64                    # 在 Mac 构建 Apple Silicon DMG + ZIP
pnpm package:mac --arch x64                      # 在 Mac 构建 Intel DMG + ZIP
pnpm package:mac --arch all                      # 在 Mac 依次构建双架构
pnpm package:win                                # Windows x64 NSIS 安装包
pnpm --filter dsh-ssh-desktop run package --help  # 目标/架构/签名参数
pnpm --filter dsh-ssh-desktop run icon           # 重新生成图标（assets/）
```

仓库结构：

- `packages/core`：连接引擎（ssh、远端启动、端口转发、服务器安装），纯 Node，不依赖 Electron
- `packages/desktop`：Electron 桌面端
- `packages/server-plugin`：服务器端配套插件 dsh-desktop-link（握手、租约、任务完成通知、VS Code 按钮）

Mac/Linux 也可运行 `./start-desktop.sh`。Windows 在有完整性级别限制的开发环境中，先运行 `setup-electron-runtime.cmd`，再运行 `start-desktop.cmd`；普通 Mac 环境不需要这些脚本。

所有安装包输出到 `dist/installer/`。macOS 打包需在 Mac 上运行；不会用 Linux/Windows Electron 冒充 Mac 运行时。Apple Silicon 和 Intel 分别构建，不要求安装 Rosetta。

### 签名、公证与验证

Mac 默认构建使用 ad-hoc 签名，适合自行测试。正式分发可使用 `pnpm package:mac --arch arm64 --signed`：在本机或可信 CI secrets 中配置 `CSC_LINK`/`CSC_KEY_PASSWORD`（或钥匙串中的 `CSC_NAME`）以及 Apple 公证凭据，详见脚本 `--help`。不要将证书、密码或 API key 提交到仓库。`--signed` 要求 Developer ID 签名、公证和 hardened runtime；缺少凭据会失败，不会悄悄退回测试签名。

[构建工作流](.github/workflows/build.yml) 分别在 macOS arm64、macOS Intel 和 Windows 上安装锁定依赖、执行测试、打包并校验产物，默认只上传 Actions artifacts。Mac 原生 smoke 覆盖认证、持久化 cookie 和 bridge；实际服务器、通知授权、睡眠恢复等仍需按 [验收清单](docs/macos-adaptation.md#mac-实机验收待执行) 检查。

Linux 无图形环境可通过 `xvfb-run -a pnpm test` 跑 Electron smoke。测试默认保留 Chromium sandbox；仅在受限测试容器无法启用它时显式设置 `DSH_SSH_DESKTOP_ALLOW_NO_SANDBOX=1`，该次结果不验证渲染进程沙箱。CI 通过 `DSH_SSH_DESKTOP_REQUIRE_ELECTRON=1` 禁止缺失 Electron 时跳过 smoke。
