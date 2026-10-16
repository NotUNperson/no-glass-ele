# no-glass-ele —— 给 Electron / Tauri 应用生成「去毛玻璃」启动脚本

干掉桌面应用页面内的**背景模糊 / 毛玻璃**。

原理等同于你在浏览器里用 Stylus 的这条规则：

```css
* { -webkit-backdrop-filter: none !important;
    backdrop-filter: none !important; }
```

区别是：**不用装扩展、不改应用任何文件**，全部通过 Chrome DevTools Protocol 在运行时注入。
退出应用后不留痕迹，也不影响自动更新。

支持两种运行时，`probe` 会自动识别：

| | Electron | Tauri（WebView2）|
|---|---|---|
| 开调试端口 | 命令行 `--remote-debugging-port=N` | **环境变量** `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` |
| 页面协议 | `app://` / `file://` | `http://tauri.localhost/` 或应用自己的后端地址 |
| 主进程调试 | `--inspect` | 无（Rust 主进程，没有 JS 可调） |
| `--native` | 可用 | 不适用 |

因为每个应用的脾气都不一样（fuse 加固程度、窗口层玻璃、单实例锁、自带端口占用、
后台启动标志……），本工具不写死任何一个应用：
**读一次目标的静态特征，生成一套双击即用的启动脚本 + 一份该应用专属的说明**。

两种用法：**命令行**（`gen.js`）或**图形界面**（双击 `ui/ui.cmd`）。

---

## 安装

```bash
git clone <这个仓库>
cd no-glass-ele
setup.cmd          # 检查依赖，缺什么会告诉你（可选的会问你要不要装）
```

`setup.cmd` 只做检查，唯一的写操作是**在你同意后**执行 `pip install pywebview`。
也可以先不装，直接 `node gen.js env` 看环境自检。

### 需要什么

| 组件 | 必需？ | 用途 | 怎么来 |
|---|---|---|---|
| **Node.js 18+** | **必需** | CLI 与注入器完全靠它 | [nodejs.org](https://nodejs.org) |
| **Windows PowerShell** | **必需** | 探测运行中的进程、管理自启动项 | Windows 自带 5.1 即可 |
| Python 3 | 可选 | 只有图形界面需要 | [python.org](https://python.org) |
| pywebview | 可选 | 图形界面的依赖 | `pip install pywebview` |
| Dark Reader 引擎 | 可选 | 深色模式功能 | 已随仓库提供（`vendor/`）|

**只想要命令行？那只需要 Node + Windows**，Python 和 pywebview 都可以不装。

```bash
node gen.js env      # 任何时候都能用它自检环境
```

> **为什么不做成单个 exe？** 试过算过：Node 的 SEA（单文件可执行）基础体积
> 就有 ~86MB（node.exe 本身），而整个源码才 1MB 出头。为了省掉「装 Node」这一步
> 付出 86MB 和一套构建流程，不划算。UI 侧还得再打一个 PyInstaller 包。
> 而且 PowerShell 无法打包（好在系统自带）。所以选择「零依赖源码 + 自检脚本」。

---

## 快速开始

```bash
# 1. 探测一个应用（只读，不启动它）
node gen.js probe "D:\path\to\App.exe" --deep

# 2. 生成 profile（会带上探测结果）
node gen.js new myapp --exe "D:\path\to\App.exe"

# 3. 补齐 profile 里的人工字段（端口、注意事项），然后生成启动脚本
node gen.js build myapp

# 4. 校验
node gen.js doctor
```

生成物在 `apps/myapp/`，双击 `start.cmd` 即可。

---

## 图形界面（可选）

双击 `ui/ui.cmd`，会开一个桌面窗口：

```
┌─ no-glass-ele ───────────────────────────────────────────────┐
│ 应用              │ MyApp               │ 输出                │
│ ─────────────     │ ───────────────     │ ─────────────────   │
│ MyApp     9401    │ Electron 35.7.5     │ $ node injector...  │
│ OtherApp  9411    │ native 可用         │ 调试端口已就绪       │
│                   │ 页面玻璃 ✓          │ 已注入 ✓ 模糊元素: 0 │
│ + 新建            │ [启动] [停止]        │ 进入 watch 模式      │
└──────────────────────────────────────────────────────────────┘
```

能做的事：

| 功能 | 说明 |
|---|---|
| 查看与编辑 profile | 端口、隔离变量、urlFilter、注意事项都能改，不用手编 JSON |
| 运行探测与生成 | 点按钮跑 probe / build / doctor，输出实时显示在**「任务」标签**里 |
| 多会话监控 | 右栏顶部是标签栏：最左边是常驻的「任务」标签（工具输出），右边是各注入会话。**每个都有独立的日志缓冲**：切走再切回，历史完整保留 |
| 启动注入 + 实时日志 | 拉起注入器并滚动显示日志，一键停止（**不会关掉应用**） |
| **深色模式** | 选模式（跟随系统/强制深色/关闭）+ 引擎 + 亮度对比度，点「保存并立即生效」直接推给运行中的注入器，**不用重启应用** |
| 自定义 CSS | 内置编辑器写 `css/<name>.custom.css`，保存后注入器自动重新注入，不用重启应用 |
| 新建应用向导 | 选 exe（文件框，或从运行中的进程里挑）→ 自动探测 → 填字段 → 生成 |
| 界面主题 | 顶栏可切「跟随系统 / 深色 / 浅色」，选择会记住 |

**依赖**：Python 3 + `pywebview`。界面本身零额外依赖（无框架、无 CDN、离线可用）。
如果没有 pywebview：`pip install pywebview`。

> **界面里的一条语义**：点「停止」只结束注入器。目标应用是用 detached 方式启动的，
> **不会被关掉** —— 你正在用的窗口不受影响。

> **「停止」按钮停的是哪个**：「启动注入」卡片里的停止按钮，停的是**左侧当前
> 选中的那个应用**的注入会话 —— 与它的禁用条件（该应用有没有在跑）一致。
> 想停某个会话，先在左边选中它。右侧标签上的 ✕ 才是「停这一个」。
> 两者都不影响目标应用本身。

> **「任务」标签是干什么的**：probe / build / doctor 的输出走的是独立的
> 后端通道（不属于任何注入会话），所以给它一个常驻标签。点「校验全部」或
> 「重新生成启动器」时会自动切过去 —— 否则你会看不到任何反应。
> 它排在最左边，位置固定，不随会话增减移动。

> **灰色「残留」标签**：硬关机（或强杀进程）时注入器来不及清理自己的注册项，
> 于是磁盘上留下一条"pid 还在但心跳早停了"的记录。这类标签显示为灰色并标
> 「残留」，**不算运行中**。点它的 ✕ 是**清理那条残留记录**，不会对任何进程
> 发 kill —— 因为那个 pid 可能已经被系统复用给无关进程了。
> 判定用心跳：`lastTick` 超过 90 秒没更新且启动已过 60 秒宽限期。
> 阈值偏保守是有意的（宁可晚一点标记，也不误标正在运行的会话）。

> **日志为什么按会话隔离**：每个会话有自己的一份行缓冲（上限 4000 行，与后端对齐）
> 和**独立游标**。切换标签时直接从缓冲重渲染，所以切回来能立刻看到完整历史。
>
> 你没在看的那几个会话不会产生额外请求（不为它们轮询）；切过去时按各自游标
> **补拉**一次，把离开期间攒下的输出补齐。补拉范围受后端 4000 行缓冲限制 ——
> 离开太久且输出极多的会话，早期行会滚出窗口（这是有意的：避免为后台会话
> 持续付请求成本）。
>
> 会话结束后缓冲会保留到你切走为止，方便回看它为什么失败。

> **深色模式卡片为什么能"立即生效"**：它不重启注入器，而是直接对已连接的
> CDP 端口推一次 Dark Reader 注入（复用 `tools/darkreader.js`，已实测的通道）。
> 重启注入器 = 重启目标应用 = 打断你正在做的事，没必要为改个样式付这个代价。

### 界面里的两条护栏

1. **路径穿越防护。** profile 名只允许字母数字点下划线连字符。
2. **命令注入防护。** 额外参数只按数组传递，不拼字符串。

### 性能设计（改 UI 前请先读）

界面曾经有过一个严重缺陷：把「进程表查询」放在了 300ms 的轮询路径上。
每次查询要起一个 PowerShell（实测 1-2 秒），调用严重重叠 →
**实测派生 25+ 个 powershell、CPU 100%、内存掉到 583MB**。

现在的约束：

| 规则 | 原因 |
|---|---|
| 进程表查询只在**后台线程**按固定间隔（8 秒）做，结果缓存 | 它是昂贵操作，不能放在轮询路径上 |
| 存活检查用 `OpenProcess` **系统调用**，不调 `tasklist` | 毫秒级 vs 起一个进程的几十毫秒 |
| `get_overview`（跑两个 node）带 5 秒 TTL 缓存 | 实测每次 1.7 秒，高频调用会持续派生进程 |
| 前端分层轮询：日志 300ms、状态 2 秒，各有防重入标志 | 上一轮没回来就不发下一轮，避免堆积 |
| 所有 `subprocess` 调用带 `CREATE_NO_WINDOW` | 否则 UI 启动的子进程会闪出终端窗口 |

实测结果（UI 常开 60 秒）：**powershell 恒为 1 个、内存稳定 120MB 不增长、CPU 约 1%**。
改这些代码前请重跑 `ui/smoke_test.py` 并复测资源占用。

---

## 命令

| 命令 | 作用 |
|---|---|
| `probe <exe> [--deep]` | 只读探测：Electron 版本、fuse 表、行为标记。输出可粘贴的 profile 片段 |
| `new <name> --exe <path>` | probe + 模板 → `profiles/<name>.json` |
| `build <name> \| --all [--bundle]` | 渲染 `apps/<name>/` 下的启动器与 README |
| `list` | 列出 profiles 与探测状态 |
| `doctor` | 校验：exe 存在性、端口冲突、fuse 与预设矛盾、产物是否过期 |
| `ps` | 列出运行中的注入会话（含**外部启动**的），并把「残留会话」单独列出 |
| `stop <id\|profile\|pid>` | 请求停止（优雅退出，**不关目标应用**）；`--force` 可强停外部注入器 |
| `logs <id\|profile\|pid> [-n N]` | 查看某会话的日志 |
| `prune` | 清理残留注册项（进程已退出的 + 硬关机留下的僵尸项）|
| `autostart on\|off\|list [name]` | 管理开机自启动项（见下）|

加 `--json` 可让 `probe` / `list` / `doctor` / `ps` 输出 JSON（供 UI 调用；人类可读输出不变）。

---

## 后台会话管理

注入器启动时会把自己登记到 `run/sessions/`，日志写到 `run/logs/`。
所以**不管是谁启动的**（UI / 启动脚本 / 自启动项），都能统一管理：

```bash
node gen.js ps              # 现在有哪些注入在跑
node gen.js logs myapp      # 看某个的日志
node gen.js stop myapp      # 停止它
```

`ps` 还能发现**没有登记**的旧版注入器（通过进程表扫描），
它们会标为「外部」并提示无法优雅停止。

**残留会话**（硬关机留下的注册项）会单独列出来。它们的特征是
「pid 还在，但心跳早停了」—— 注入器靠 `process.on('exit')` 和
SIGINT/SIGTERM 清理注册项，而 Windows 关机**不派发信号**，所以清理
没机会执行；开机后那个 pid 可能被复用给别的进程，于是单看 pid 会
误以为它还活着（UI 上表现为「点停止没反应」的标签）。

判定用心跳：`lastTick` 超过 90 秒没更新、且启动已过 60 秒宽限期。
清理它们**不会对任何 pid 发 kill** —— 那个 pid 可能已经是无关进程了：

```bash
node gen.js prune           # 清掉残留注册项（含僵尸项）
```

### 停止语义（重要）

停止是**协作式**的：请求方放一个 `run/sessions/<id>.stop` 文件，
注入器在 1 秒内发现并自己退出（清理注册项、关闭日志），
**目标应用保持运行** —— 你正在用的窗口不会因为停止注入而关闭。

> 早期版本用 `taskkill /PID <注入器> /T /F`，`/T` 会顺着进程树
> 把注入器启动的应用一起杀掉。虽然注入器是用 detached 启动应用的，
> 但 Windows 进程表里仍记录父子关系，`/T` 会一路杀下去。
> 现已改为停止文件机制；兜底强停也**不带 `/T`**。

### 应用退出时自动收尾

目标应用被关掉后，注入器会自己退出，不留空转的后台进程。
两个信号：浏览器级 CDP 连接断开（主）、进程名存活检查（兜底，每 5 次巡检一次）。

### 开机自启

让某个应用的「去玻璃 + 深色」在开机后自动生效，不用手动点启动脚本。

```bash
node gen.js autostart on myapp     # 创建启动项
node gen.js autostart off myapp    # 删除
node gen.js autostart list         # 查看本工具创建的项
```

> **只能走命令行** —— 界面上没有这个入口（有意为之：自启动是低频操作，
> 改错了会影响开机体验，用命令行多一层确认）。

#### 它到底做了什么

在**用户启动文件夹**放一个快捷方式：

```
%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\no-glass · <profile>.lnk
      ↓ 指向
pythonw.exe  "<项目>/ui/app.py" --headless --start <profile>
      ↓
node.exe  injector/noglass.js --profile ... --launch --watch
      ↓ detached 启动
<目标应用>.exe  --remote-debugging-port=<port>
```

**为什么要绕一层 Python，不直接让 .lnk 指向 node.exe：**

`node.exe` 是控制台子系统程序。快捷方式直接指向它，Windows 会分配一个
控制台窗口——开机后你会看到一个常驻的黑终端，关掉它注入器就死了。
`pythonw.exe` 是 GUI 子系统程序、没有控制台，它再用 `CREATE_NO_WINDOW`
启动 node，全程无窗口。

**为什么 pythonw 退出后注入还活着：** 注入器是 `detached` 启动的（stdio
接 DEVNULL 并脱离父进程）。父进程退出不影响它；它也**不能**接管道——
读端一关，注入器下次写日志就会 EPIPE 崩溃。

所以：开机 → 快捷方式拉起 pythonw → pythonw 起注入器后立刻退出 →
注入器常驻并把自己登记到 `run/sessions/` → 打开 UI 就能在会话列表里
看到并管理它（`gen.js ps` 里来源标记为 `autostart`）。

#### 单实例锁冲突（最重要的一条）

`autostart on` 会先查三个地方，看这个应用**自己**有没有自启动项：

| 检查范围 | 匹配方式 |
|---|---|
| 用户启动文件夹（`.lnk`）| 文件名含 exe 名 |
| `HKCU\...\CurrentVersion\Run` | 值里含 exe 名或路径 |
| `HKLM\...\CurrentVersion\Run` | 同上 |

（本工具自己创建的项以 `no-glass · ` 开头，会被排除，不算冲突。）

**为什么必须查**：如果应用自己就开机启动，那么开机后会有两种情况叠加 ——
应用自己先起来了，我们的注入器又启动一次，**第二次会撞单实例锁直接退出**，
调试端口开不起来，注入静默失败（你会以为配置没生效）。

发现冲突时命令会**中止并列出**找到的项，让你决定：

```
! 检测到该应用**已经**有自启动项：

    HKCU\Software\Microsoft\Windows\CurrentVersion\Run  <项名>  (值匹配)
```

**两条路，选一条：**

1. **保留应用自己的自启动**（这时的做法是「手动注入」）。但要注意一个硬限制：
   应用自己启动时**没有调试端口**，注入器无法接管已运行的实例。
   所以要么每次手动重启一次应用，要么接受它没有注入效果。
   （`gen.js ps` 看不到它，因为没登记、也没端口。）

2. **关掉应用自己的自启动，改用本工具代理**（推荐）。删掉那一项，然后：

   ```bash
   node gen.js autostart on myapp --force
   ```

   `--force` 跳过冲突检查。此后由本工具负责启动应用——它是**带调试端口**
   启动的，注入才有效。

#### 其它开关

```bash
node gen.js autostart on <profile> --isolate   # 用独立数据目录启动
```

隔离启动意味着每次开机是一个干净实例（不读你平时用的数据）。除非你明确
需要，一般不要加。

#### 验证它真的生效

```bash
node gen.js autostart list      # 确认项已创建
node gen.js ps                  # 重启后应有来源为 autostart 的会话
```

想立即测试（不必真重启电脑）：直接跑快捷方式指向的那条命令，或从启动
文件夹双击那个 `.lnk`。效果等价。

#### 卸载

```bash
node gen.js autostart off <profile>     # 删这一项
```

或直接删启动文件夹里的 `no-glass · *.lnk` —— 两者等价，不会留注册表残留
（本工具只写启动文件夹，不写 Run 键）。

---

## 自定义样式与深色模式

内置样式表只做一件事：去掉模糊。想改外观就写自定义片段：

```
css/<profile名>.custom.css
```

存在即生效，追加在内置样式表之后。注入器**监听该文件**，改完保存即自动重新注入，
**不需要重启应用**。

### 先探测：这个应用需要深色模式吗

```bash
node gen.js probe <exe> --deep     # 看 prefersColorScheme 这一项
```

探测会扫 asar 里的 `prefers-color-scheme` 标记，据此分三种情况：

| 探测结果 | 该怎么做 |
|---|---|
| `true`（自带深色模式）| 只需 `{"emulateColorScheme":"dark"}`，让它跟随系统 |
| `false`（没有深色模式）| 用 `{"darkreader":"auto"}`；不够满意再手写 CSS |
| `null`（没扫到 asar）| 先试模拟，无效再试 Dark Reader |

> 实测多数应用已经自带深色模式（扫 asar 里的 `prefers-color-scheme` 命中
> 几处到几十处不等）。这套东西的定位不是"通用深色方案"，而是**兜底** ——
> 给「既不支持深色、又不值得为它手写几百行 CSS」的应用一个一行配置的解法。
> 覆盖率低不代表没价值，它省掉的是最费事的那条路。

### 顺序一：模拟（应用自带深色模式时）

如果应用**已经写了** `@media (prefers-color-scheme: dark)`，只差系统没告诉它：

```json
{ "emulateColorScheme": "dark" }
```

> **诚实提醒**：这个开关只改「页面以为系统处于什么模式」。
> 如果应用桌面版 CSS 里**根本没有**那段媒体查询，模拟不会产生任何变化。

### 顺序二：借 Dark Reader 的引擎（没有深色模式时，推荐先试这个）

**不用写 CSS、不用读源码、自动跟随系统深浅色、自动覆盖新弹窗。** 用的是
Dark Reader 的 API 构建（npm 包 `darkreader`，MIT），它不是扩展、不依赖任何
`chrome.*` API —— 它自己会给 `chrome.runtime` 打桩，所以能整份注入页面跑。

**接进注入器（推荐）** —— 在 profile 里写一行，之后启动即生效：

```json
{ "darkreader": "auto" }
```

新开的窗口/弹窗会被自动覆盖（走 `addScriptToEvaluateOnNewDocument` 注册，
实测新文档诞生后 1.5 秒内已带深色）。也可以用命令行临时切：

```bash
node injector/noglass.js --profile profiles/x.json --launch --watch --darkreader auto
```

**单独调用**（不启注入器，对已运行的应用临时生效）：

```bash
node tools/darkreader.js <调试端口> auto     # 跟随系统（推荐）
node tools/darkreader.js <调试端口> dark     # 强制深色
node tools/darkreader.js <调试端口> light    # 强制浅色
node tools/darkreader.js <调试端口> off      # 卸载还原

# 可选参数（图形界面的滑块走这里）
node tools/darkreader.js <端口> dark --engine dynamicTheme --brightness 110 --contrast 95
```

引擎在 `vendor/darkreader.js`（缺失时脚本会尝试自动下载）。

#### 引擎选择：为什么"颜色丢失"

Dark Reader 有四种引擎，通过 `theme.engine` 选：

| 引擎 | 做法 | 效果 |
|---|---|---|
| `dynamicTheme` | 解析页面样式表，逐条改写颜色 | **最好，保留品牌色。默认锁这个** |
| `staticTheme` | 预生成固定规则，不看页面实际样式 | 快但糙 |
| `cssFilter` | 整页 `filter: invert()` 反色 | **彩色图标/标签一起被反掉** |
| `svgFilter` | 同上，用 SVG 滤镜 | 同上 |

「标签颜色都丢了」就是落到了 filter 类引擎的症状。本工具的默认值是
`dynamicTheme`（引擎里唯一的非 filter 选择），想换可用
`--darkreader-engine` 或 profile 的 `darkreaderTheme.engine`。

> 注：纯 JS 版**不会自己降级**到 filter —— 引擎里 `cssFilter` 只对硬编码的
> 少数网站（Office / Google Docs / SharePoint / OneDrive）启用。
> 扩展版才有"自动降级"行为。所以这里的颜色异常另有原因，见下。

#### 别和手写深色 CSS 同时用（实测踩过）

**两份深色方案会互相干扰。** Dark Reader 的 `createDynamicStyleOverrides`
会读**页面上所有样式表** —— 包括 `css/<name>.custom.css` 里手写的那份 ——
把已经调暗的颜色再算一遍，结果彩色标签被压平。

同一页面实测：

| 方案 | 彩色元素 | 不同色相 |
|---|---|---|
| 手写 CSS + Dark Reader 同时开 | 1 个 | 1 种 |
| 只用 Dark Reader | **34 个** | **6 种**（青/橙/紫/黄/绿/蓝）|

所以给同一个应用选**一种**方案。本工具不会替你禁止叠加，但建议二选一。

**为什么不能用真正的浏览器扩展**（这是实测结论，不是猜测）：

| 做法 | 结果 |
|---|---|
| `session.loadExtension(目录)` | ✓ 加载成功，拿到扩展 id |
| 内容脚本在 `file://` 页面 | ✓ 注入成功，`chrome.storage` 读写正常 |
| 内容脚本在 `app://` 页面 | ✗ **完全不注入** |
| manifest 里声明 `app://` 权限 | ✗ 校验期即拒：`Invalid scheme` |
| 用 `<all_urls>` 覆盖 | ✗ 不覆盖自定义协议 |
| `--load-extension` 启动参数 | ✗ Electron 未实现该 Chromium 开关 |

结论：扩展路线的适用性**取决于应用给页面用什么协议**。
`file://` 可以，`app://` 不行 —— 而且卡在 manifest 校验那一关，绕不过去。
Dark Reader 的纯 JS 引擎没有这个限制。

**它跟手写 CSS 的差别**（同一页面、同一套审计标准实测）：

| | 手写 CSS | Dark Reader |
|---|---|---|
| 体量 | 数百行，逐选择器覆盖 | 数十条规则 + 运行时改写 |
| 跟随系统 | 需自己写媒体查询 | ✓ 自动 |
| 维护成本 | 应用升级要重跑工具链 | 无需维护 |

机制不同：手写是**逐个选择器覆盖**（所以要读源码、要采集运行时类名）；
Dark Reader 是**在运行时反过来改写样式表**（解析原 CSS，算出反色后的等价
CSS，用 CSS 变量注入）。后者对"没见过的运行时 scoped 样式"同样有效，
因为它处理的是样式表本身，不依赖预先知道类名。

> **代价**：Dark Reader 会反色图片、降饱和。若要保留图片原色，
> 需要在页面里给图片加 `data-darkreader-inline-*` 之类的标记，或用
> `DarkReader.enable({ ... })` 后自行插入修复规则。

#### 跟随 Windows 深浅色的原理

设成 `auto` 后，Dark Reader 读的是
`matchMedia("(prefers-color-scheme: dark)")` 并监听其变化 —— 也就是
**Electron 已经把它转达过来的系统偏好**。所以 Windows 一切换主题，
应用立即跟着变，不需要轮询。

要单独验证这条链路而不改真实系统设置（改系统主题会让所有软件重绘），
用 CDP 媒体模拟即可，只影响目标页面：

```js
await cdp.send('Emulation.setEmulatedMedia', {
  media: '',
  features: [{ name: 'prefers-color-scheme', value: 'dark' }],
});
```

### 想要完全可控：手写深色

如果不想引入第三方引擎，或者需要精确到品牌色的控制，就手写。

**不要靠"跑起来看哪里不对再补"** —— 那样很慢而且容易漏。
正确做法是**先读源码，再生成覆盖**：

```bash
# 0. 给分析脚本指定目标应用的 asar（三种方式任选）
#    命令行参数 / NOGLASS_ASAR 环境变量 / local/tools-config.json
export NOGLASS_ASAR="D:/path/to/App/resources/app.asar"

# 1. 把应用自己的颜色规则导出来（排除 node_modules）
node tools/dump-app-css.js
#    -> 含颜色声明的规则 N 条；其中浅色背景 M 条、深色文字 K 条

# 2. 看具体有哪些（分类列出）
node tools/dump-app-css.js --light-bg     # 浅色背景的规则
node tools/dump-app-css.js --dark-text    # 深色文字的规则（品牌色已排除）

# 3. 自动生成覆盖（按类名前缀聚合，短且抗改名）
node tools/gen-dark-css.js --write <文件>

# 4. 组装 head（变量）+ generated（自动）+ tail（手工精修）
node tools/build-dark-css.js <profile名>

# 5. 验证：列出所有亮底元素与对比度不足处，迭代到干净
node tools/audit-dark.js <调试端口>
```

#### 一个必须知道的坑

**`color` 是继承属性，子元素自己声明的值赢过祖先。**
实测溯源（`tools/why-color.js`）：

```
.title[data-v-xxxxxxxx] { color: #000 }        ← 标题发黑的根源
.todo-list-item         { color: var(--t-text) !important }  ← 写在祖先上，无效
```

所以覆盖必须同时做两件事：① 用前缀通配把**叶子元素**一起压住；
② 再把该保留的强调色（品牌色、分类色）**还原回来**。
这也是为什么生成的 CSS 里有一段专门的"还原段"。

#### 静态提取的盲区（重要，决定了这套方案的边界）

只扫 `.css` 文件**盖不全**。原因是 **Vue 会把 scoped 样式在运行时动态注入
`<style>`** —— 这类规则不在任何 `.css` 文件里。

实测漏过的例子：某个悬浮小窗口的
`.tomato[data-v-45545968] { background-color: #fff }`
是一块 4750px² 的白底，既不在 `index.css` 也不在 `widget.css`。

所以要**两条腿走路**：

| 手段 | 覆盖什么 | 工具 |
|---|---|---|
| 静态：扫 asar 里的 CSS | 编译期样式（绝大多数） | `dump-app-css.js` → `gen-dark-css.js` |
| 动态：读运行时的计算样式 | 运行时注入的 scoped 样式、独立窗口 | `harvest-selectors.js` |

动态采集的类名存进 `local/dark/harvested-selectors.json`（本机数据，不进版本库），生成时会精确合并进去。

```bash
# 应用跑起来之后（有独立窗口就打开它），采集漏网的类名
node tools/harvest-selectors.js <调试端口> "" 800
# 把输出的类名填进 local/dark/harvested-selectors.json
# 重新生成
node tools/build-dark-css.js <profile名>
```

#### 覆盖范围的现实预期

**这套方案能盖住主界面，但不保证 100%。** 要盖全需要把每个窗口、每个弹窗
都打开采集一遍，而且**应用升级后可能新增组件**。

所以建议的策略是：**主界面优先，发现问题再补** —— 遇到漏网时按上面的流程补一条即可，
热重载会自动生效，不用重启应用。

#### 其它排查工具

| 工具 | 用途 |
|---|---|
| `tools/why-color.js <port> <sel>` | **权威溯源**：问浏览器这条 color 是哪条规则给的 |
| `tools/audit-dark.js <port> [面积] [url关键词]` | 全面审计：亮底 + WCAG 对比度（可按窗口筛）|
| `tools/harvest-selectors.js <port>` | 运行时采集漏网类名 |
| `tools/list-targets.js <port>` | 列出所有窗口及其注入状态 |
| `tools/inspect-main.js <主进程端口>` | **问主进程**要窗口清单（权威）|
| `tools/find-bright.js <port>` | 列出仍偏亮的大元素 |
| `tools/trace-color.js <port> <sel>` | 查颜色继承链 |
| `tools/extract-rules.js <关键词>` | 从 asar 提取指定选择器的规则 |
| `tools/grep-asar.js <关键词>` | 在 asar 里全局搜 |
| `tools/find-ipc-windows.js` | 找"开新窗口"的 IPC 通道 |
| `tools/trigger-window.js <port>` | 触发独立窗口（走应用自己的 IPC）|
| `tools/list-routes.js` | 列出应用所有路由（知道有哪些页面）|
| `tools/nav.js <port> <路由>` | 切视图（客户端跳转，不重载不登出）|
| `tools/inspect-page.js <port>` | 读页面计算样式概览 |
| `tools/verify-selectors.js <port>` | 用隐藏元素验证选择器命中 |
| `tools/darkreader.js <port> <mode>` | 借 Dark Reader 引擎上深色（见上节）|
| `tools/assess-portability.js <asar>` | 评估迁到 Rust + WebView 的可行度 |

> 上表里读 asar 的脚本都需要知道目标路径。给法有三种，优先级从高到低：
> 命令行参数、`NOGLASS_ASAR` 环境变量、`local/tools-config.json` 的 `asar` 字段。
> 三者都没有时会报错并说明怎么配（不会静默失败）。

### 传给应用的启动参数

有些效果靠 Chromium 的启动开关，例如强制灰度抗锯齿（配合 MacType）：

```json
{ "appArgs": ["--disable-lcd-text", "--font-render-hinting=none"] }
```

命令行临时试（不必改 profile）：

```bash
node injector/noglass.js --profile profiles/myapp.json --launch --watch \
     --app-arg=--disable-lcd-text
```

这些参数传给**目标应用**（Chromium 只在启动时读），不是给注入器的。
未知的 `--xxx` 参数会自动当作应用参数处理，不会再让注入器崩掉。

### 生成的启动器预设

| 文件 | 参数 | 何时生成 |
|---|---|---|
| `start.cmd` | `--launch --watch` | 总是 |
| `start-debug.cmd` | `--launch --list` | 总是 |
| `start-isolated.cmd` | `--isolate --watch` | 能隔离时（应用没写死 userData，或 profile 提供了隔离开关）|
| `start-native.cmd` | `--native --launch --watch` | **仅当 fuse 允许 `--inspect`** |

最后一条是探测结果的直接应用：加固过的应用上 `--native` 必然失败，
所以**不生成**那个脚本，而不是让你双击后吃一串报错。

所有预设都支持追加参数（后者覆盖前者）：

```bat
start.cmd --port 9500
```

每个启动器第一件事是 `chcp 65001`（切到 UTF-8 代码页）—— 见下文「`.cmd` 编码坑」。

---

## Tauri / WebView2 应用

`probe` 会自动识别运行时，不需要你手工指定。

### 怎么识别的

Tauri 的 exe 里**没有** `Edg/x.y.z` 或 `Chrome/x.y.z` 版本串（实测三个 exe 全零命中）
—— WebView2 的版本只在运行时 UA 里。所以静态识别靠 Tauri 自己的痕迹：

| 标记 | 说明 |
|---|---|
| `tauri.localhost` | 最强信号，19 字节字面量，近乎零误报 |
| `__TAURI` | Tauri 注入的全局对象（实测几十到上百次命中）|
| `wry-<ver>` | Tauri 底层的 webview 库，可提取版本 |
| `tauri-<ver>` | cargo 路径，能读出精确框架版本（不一定有）|

判定顺序：先看有没有 Electron fuse 哨兵（比 UA 串可靠），没有再看 Tauri 标记。

### 启动方式不同（关键）

```bash
# Electron
<app>.exe --remote-debugging-port=9333 --inspect=9334

# Tauri / WebView2 —— 靠环境变量
WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9333 <app>.exe
```

传错方式端口不会开。注入器按 profile 的 `runtime` 字段自动选，这个字段由 `probe` 填。

**隔离**也走不同路径：Electron 用 `--user-data-dir=`，Tauri 用 `WEBVIEW2_USER_DATA_FOLDER`。

### 玻璃证据是分栏列出的，不下结论

Tauri 的前端位置不统一（可能打进 exe，也可能是同级目录），
所以 `--deep` 会两边都扫。但**`backdrop-filter` 这个字符串在非玻璃的地方也大量出现**：

实测某个 Tauri 应用报了 19 处，逐条查证后**只有 3 条是真 CSS**：

| 误报来源 | 例子 |
|---|---|
| Shiki / VSCode 的 CSS 属性数据表 | `{name:"backdrop-filter",syntax:"none \| <filter-function-list>",…}` |
| floating-ui 的特性检测 | `CSS.supports("-webkit-backdrop-filter","none")` |
| SVG 里序列化的 computed-style | `backdrop-filter: none;` |

所以 probe 把命中按**文件类型**分栏：

- **`.css` 文件里的命中** → 大概率是真样式（可信）
- **`.js` / exe 里的命中** → 可能是上面那些误报，需人工看片段

两栏都给出具体片段，由你判断。刻意不自动下"有玻璃/没玻璃"的结论。

### 实测受益面

Tauri 应用用 `backdrop-filter` 的比 Electron 少得多 —— 扫过一批本机 Tauri 应用，
能定位到 exe 的里面**只有少数有真玻璃**，多数是 0 处。所以这个支持的价值是
**覆盖面补全**，而不是解决一批新问题。

---

## 应用自己的启动参数（为什么注入器启动会弹窗）

**问题**：应用自己启动时会带私有标志，我们启动时没带。

实测例子：

| 应用 | 自己的启动命令行 | 效果 |
|---|---|---|
| 某清单应用 | `"App.exe" --hidden` | 静默到托盘 |
| 某待办应用 | `App.exe -hide` | 同上 |
| 某启动器 | `App.exe --minimize` | 最小化启动 |

不带这个标志，本该静默的应用会**弹窗** —— 因为应用的启动逻辑就是靠
`process.argv.includes("--hidden")` 这类检查决定是否显示窗口。

**本工具的做法**：`probe` 会去读应用**自己**的自启动项（注册表 Run 键的值 +
启动文件夹 `.lnk` 的 Target/Arguments），把里面的私有参数提取出来建议给你：

```bash
node gen.js probe "D:/path/to/App.exe"
# → 发现私有启动参数：--hidden
#   建议填进 profile 的 appArgs
```

界面上会在「启动注入」卡片里显示一个「填入上方参数框」按钮，一键采用。

`doctor` 也会检查：**如果应用自启动带了参数、而 profile 的 appArgs 里没有**，
就报出来 —— 这正是"注入器启动时应用弹窗"的直接原因。

> **注意**：这些参数是传给**目标应用**的，不是给注入器的。
> 用 `--app-arg=<flag>` 也能临时试，不用改 profile。

---

## 设计约束

### 1. 只读静态探测，绝不启动应用

`probe` 的全部结论来自读文件字节：

- **fuse 表**：Electron 二进制里有一段固定哨兵字符串 `dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX`，
  紧跟 1 字节 schema 版本、1 字节 fuse 个数、然后每 fuse 1 字节状态
  （`0x30`=`0`=关、`0x31`=`1`=开、`0x72`=`r`=已移除、`0x90`=INHERIT）。
- **Electron 版本**：exe 里的 UA 字符串。
- **行为标记**（需 `--deep`）：在 `resources/*.asar` 里搜代码标记
  （`requestSingleInstanceLock`、`setPath("userData")`、`transparent:`、`vibrancy`、
  `backgroundMaterial`、`setTitleBarOverlay`、`backdrop-filter`……）。

**为什么扫 asar 而不是解包**：asar 是简单拼接格式，内容以明文存在，直接搜字符串就够了，
不需要解包（也就不会产生任何文件）。

**测不出的东西不假装知道**。以下三项静态探测无能为力，会被明确标为「需人工确认」：

- 运行时端口占用
- 运行时是否真的启用了单实例锁（只看到代码里有调用）
- 页面上到底有没有毛玻璃（代码里有 `backdrop-filter` 不等于界面上一定看得见）

### 2. 绝不遍历文件系统

git bash 下对大目录做递归遍历在 Windows 上极耗 CPU（每个 stat 一次系统调用）。
所以：

- exe 用**分块流式扫描**（8MB 一块），命中哨兵即停 —— 打包版 exe 常有 300MB+，不整个读进内存。
- 只读**被点名的那个文件**。唯一的目录读取是 `readdirSync` 单个父目录：
  - `resources/` 下有多个 asar 时挑最大的那个（见下文「asar 陷阱」）；
  - `exeGlob` 版本化安装路径（如 `app-*\App.exe`）取最高版本。
- **不递归、不扫盘、不依赖 Everything**。

---

## 为什么 fuse 拦不住这个工具

Electron 的 `nodeCliInspect` fuse 会禁掉 `--inspect`（以及 `NODE_OPTIONS`、`ELECTRON_RUN_AS_NODE`）。

但 **`--remote-debugging-port` 不在它的管辖范围内** —— 前者走 Node 的 inspector 体系，
后者走 Chromium 的调试体系。Electron 源码里那张「调试参数黑名单」
（`shell/common/node_bindings.cc` 的 `debug_options`）只列了 `--inspect` 系列，
`--remote-debugging-port` 根本不在其中。

**结论**：页面注入对所有 Electron 应用都可用，包括加固过的。
受影响的只有 `--native`（它依赖 `--inspect`）。

已实测：Obsidian 关闭了 `RunAsNode`、`NodeOptions`、`NodeCliInspect` 三项
（均非默认值），页面注入依然成功、模糊元素清零。

---

## 已知的坑

### asar 陷阱

有些应用把 `resources/app.asar` 当**加载器存根**，真实代码在旁边的另一个 asar 里
（Obsidian 的 `app.asar` 只有 71KB，主体是 22MB 的 `obsidian.asar`）。

只扫 `app.asar` 会得出「这个应用没有毛玻璃」的**假阴性**。
本工具的做法：`readdirSync` 一次 `resources/`，在候选 asar 里挑**最大的**那个，
并在挑中的不是 `app.asar` 时明确告知。

### `.cmd` 编码坑

生成的启动器**刻意保持纯 ASCII + CRLF**，并在第一行之后立刻 `chcp 65001`。

中文版 Windows 的 cmd 默认按 GBK(936) 解析；若 `.cmd` 存成 UTF-8 且含中文，
字节被错读后会产生 `&`、`|` 之类的分隔符，把 `rem` 注释行撕成一条条"命令"，
报出 `'xxx' 不是内部或外部命令` 这种莫名其妙的错误。

所以：**中文说明一律留在 README，启动器里只有英文注释**。
另外 Node 的输出是 UTF-8，路径也可能含中文，所以脚本先 `chcp 65001`
把控制台切到 UTF-8 —— 否则日志和路径在中文系统上都是乱码。

`.gitattributes` 里已锁死 `*.cmd text eol=crlf`
（若本机 `core.autocrlf` 未设置，不显式锁的话，一次 clone 就可能把 CRLF 变成 LF）。
`lib/render.js` 里还有一道 `assertAscii()` 断言，生成时就会拦下非 ASCII 字符。

### 单实例锁

目标应用若已有实例在跑，第二次带参数启动会走 `second-instance` 把 argv 转给老实例然后自己退出
—— 端口永远不会开。通用解法是 `--user-data-dir=<临时目录>`（Electron 的单实例锁绑在 userData 上）。

但如果应用在代码里 `setPath('userData')` 覆盖过路径，这招会失效，就得用它自己的开关
（很多应用都有类似的"允许第二个实例"环境变量）。这类开关填进 profile 的 `isolateEnv`。
探测会自动发现 `setPath("userData")` 并提醒你。

---

## 目录结构

```
no-glass-ele/
  gen.js                生成器 CLI（probe/new/build/list/doctor/ps/stop/logs/autostart）
  lib/
    probe.js            只读静态探测（exe 字节 + asar 标记）
    render.js           由 profile 渲染 .cmd 与 per-app README
    sessions.js         会话注册表读写 + 停止请求（与 ui/sessions.py 同一契约）
    autostart.js        开机自启动项管理（启动文件夹快捷方式）
  injector/
    noglass.js          通用注入内核（CDP 连接、会话管理、热重载、自感知退出）
  css/
    no-glass.css        共享样式表（只有去模糊一条规则）
    <name>.custom.css   每个应用的自定义片段（可选，存在即生效）
  vendor/
    darkreader.js       Dark Reader 引擎（MIT，供 tools/darkreader.js 用）
  ui/                   图形界面（可选，Python + pywebview）
    ui.cmd              双击启动
    app.py              宿主 + API + 本地静态服务 + 日志流 + 护栏
    sessions.py         会话读取（带缓存，见下）
    smoke_test.py       界面冒烟测试（真开窗口）
    web/
      index.html
      style.css         深/浅两套主题变量
      app.js
  profiles/             每个应用的配置（**不进版本库**，见下）
    _template.json      带注释的空白骨架（唯一随仓库走的一个）
    <name>.json         你自己的应用配置
  apps/                 生成产物（不进版本库）
    <name>/
      start*.cmd
      README.md
  run/                  运行时状态（自动创建，可安全删除；不进版本库）
    sessions/<id>.json  会话注册项
    sessions/<id>.stop  停止请求
    logs/<id>.log       会话日志
  local/                本机配置与开发记录（不进版本库）
    tools-config.json   分析脚本的 asar 路径
    profiles-config.js  make-profiles.js 的应用清单
    dark/               深色相关的本机数据：手工精修段（head/tail）、
                        运行时采集的类名 —— 都只对生成它的应用有意义
  tools/
    local-paths.js      asar 路径解析（命令行 → 环境变量 → local/ 配置）
    make-profiles.js    批量重建 profile（按本机清单，现算探测结果）
    assess-portability.js  评估迁到 Rust + WebView 的可行度（只读）
  setup.cmd             依赖检查（Node / Python / pywebview / PowerShell）
```

### 哪些内容不进版本库，为什么

| 路径 | 理由 |
|---|---|
| `profiles/*.json` | 含本机 exe 绝对路径，且端口/启动参数是「我这台机器上怎么跑」的个人配置；`_template.json` 是骨架所以例外 |
| `apps/` | 可再生产物（`node gen.js build --all` 即可重建），且带着各人的 exe 路径与探测快照 |
| `run/` | 运行时状态：会话注册项、停止请求、日志 |
| `local/` | 本机配置（分析脚本的 asar 路径、应用清单）与开发记录 |
| `README-local.md` | 完整版 README，含本机实测数据；公开仓库只保留这份通用文档 |

所以 clone 下来后 `profiles/` 里只有 `_template.json`，`local/` 不存在 —— 这是**预期状态**。
建第一个 profile：`node gen.js new myapp --exe "D:\path\to\App.exe"`。

### 界面为什么不重新实现判断逻辑

profile 的状态（是否生成、是否过期、有什么问题）全部来自 `node gen.js --json`。

在 Python 里重写一遍会造出**两个真相源** —— 而"产物是否过期"依赖 Node 侧的内容指纹算法
（`lib/render.js` 的 `fingerprint`）。所以 UI 只做展示与编辑，判断一律问 Node。

同理，`gen.js list --json` 与终端上的 `gen.js list` 共用同一个数据采集函数，
保证界面看到的与终端看到的一致。

### 共享内核 vs 自包含

默认：`apps/<name>/start.cmd` 调用根目录的 `injector/noglass.js`，
把 profile 路径传进去。**修 bug 只改内核一处，所有应用同时受益。**

需要单独拷走某个应用时，用 `--bundle`：

```bash
node gen.js build myapp --bundle
```

输出 `apps/myapp-bundle/`，配置与样式内联进 `noglass.js`，整个目录可独立运行。

---

## profile 字段

**客观事实**（`detected` 块）由 probe 自动填充，勿手改，重跑 probe 会覆盖。
**人工决策**必须你来定，工具测不出来：

| 字段 | 说明 |
|---|---|
| `exe` / `exeGlob` | 主程序路径。安装目录带版本号时用 `exeGlob`（如 `app-*\App.exe`），自动取最高版本 |
| `processName` | Windows 进程名，用于探测运行状态和 `--restart` |
| `styleId` | 注入的 `<style>` 元素 id，多应用同时注入时靠它区分 |
| `defaultPort` | CDP 端口，必须与其他 profile 不同（`doctor` 会检查）|
| `runtime` | `electron` / `tauri` / `unknown` —— 决定"怎么开调试端口"（probe 自动填）|
| `reservedPorts` | 该应用自身占用的端口，避免 `defaultPort` 落进来 |
| `isolateEnv` | 让 `--isolate` 生效所需的私有环境变量 |
| `dataDirEnv` | 指定数据目录用的私有环境变量名 |
| `urlFilter` | 只注入匹配此正则的页面，放过第三方网页 |
| `cssExtra` | 追加的 CSS 片段（默认自动找 `css/<name>.custom.css`）|
| `emulateColorScheme` | `dark` / `light`，改「页面以为系统处于什么模式」|
| `darkreader` | `auto` / `dark` / `light` / `off`，借 Dark Reader 上深色（见上一节）|
| `darkreaderTheme.engine` | 引擎选择，默认 `dynamicTheme`（效果最好）|
| `darkreaderTheme.brightness` | 亮度，默认 100 |
| `darkreaderTheme.contrast` | 对比度，默认 100 |
| `native.*` | `--native` 的窗口实色底与标题栏颜色 |
| `notes.*` | 会写进生成的 README（`watchRequired` / `portConflict` / `extra`）|

改完 profile 记得重新 `build`；`doctor` 会检查产物指纹是否与 profile 一致。
**指纹覆盖了上面所有会影响产物的字段**（包括 `darkreader` / `cssExtra` /
`appArgs`）—— 改了它们而没重新 build，`doctor` 会明确报出来。

---

## 注入内核参数

```bash
node injector/noglass.js --profile profiles/myapp.json --launch --watch
```

| 参数 | 说明 |
|---|---|
| `--profile <path>` | profile JSON（命令行参数可覆盖其中字段）|
| `--launch` | 带调试端口启动应用后注入 |
| `--restart` | 先结束正在运行的应用再启动（会打断当前会话）|
| `--native` | 连主进程：移除系统亚克力 + 把系统标题栏改成实色 |
| `--watch` | 常驻；刷新、新开窗口都会自动重新注入 |
| `--list` | 只列出可注入页面 |
| `--isolate` | 用独立数据目录启动，互不干扰 |
| `--port <n>` | CDP 端口（默认取 profile）|
| `--inspect-port <n>` | 主进程调试端口，`--native` 用，默认 `port+1` |
| `--exe <path>` | 目标 exe 路径 |
| `--css <path>` | 自定义样式表 |
| `--data-dir <path>` | 指定配置/数据目录 |
| `--timeout <ms>` | 等待调试端口超时（默认 45000）|
| `--process-name <n>` | 进程名（用于探测/结束进程）|
| `--style-id <id>` | 注入的 `<style>` 元素 id |
| `--name <name>` | 日志中显示的应用名 |

---

## 评估：这个应用能不能迁到 Rust + WebView

`tools/assess-portability.js` 回答一个独立于本工具的问题：
**某个 Electron 应用的前端代码，能不能原样搬进 Tauri 的 webview？**

```bash
node tools/assess-portability.js "D:/path/to/App/resources/app.asar"
```

它只读 asar（不解包、不启动应用），输出三部分：代码构成、前端对 Node/Electron
的耦合点、以及 IPC 架构。**这不是"能不能转"的判定器** —— 没有那种转换器，
实际做法永远是「前端留下，壳层重写」。它量的是壳层重写的工作量。

判读要点，都是实测出来的：

**1. 前端体量大 ≠ 难迁移。** 前端 bundle 是纯 Web 代码（Vue + fetch +
localStorage），可以直接搬走；真正要重写的是主进程。

**2. 决定成本的是 IPC 架构，不是调用点数量。** 两种形态实测过，差一个量级：

| | 逐个直连型 | 单入口分发型 |
|---|---|---|
| 前端调法 | `ipcRenderer.invoke("chan:call", …)` 逐个直连 | `window.bridge.invoke(cmd, args)` 单一入口 |
| 前端调用点 | 数百处 / 上百个频道 | 几处 |
| 主进程注册 | 上百个 | 数百个分支 |
| 前端要不要改 | **要**，逐个调用点换 | **不用**，桥同名同签名即可 |
| 成本集中处 | 散落各处 | 一个 dispatcher 的分支 |

单入口分发（preload 只暴露一个 `invoke`）对迁移最友好 —— 前端几乎零改动。
脚本会自己读 `exposeInMainWorld` 认出桥名，读不到再从前端引用里推断
（有些应用的桥是运行时挂载的，只能靠后者）。

**3. 依赖里的原生模块才是硬骨头。** `better-sqlite3-multiple-ciphers`
这种要整体换成 rusqlite，`express` 要换 axum/actix。脚本按"包名相同或以
`匹配名-` 开头"匹配，因为生态里全是变体（这条例外是实测漏报后补的）。

**4. 应用自己写没写"脱离 Electron 的分支"是最强信号。**
若前端有 `typeof window<"u"&&!!window.<bridge>` 这类降级判断，
说明作者已经抽象过一层，它本来就能在纯浏览器里跑。

诚实边界：静态分析看不到运行时才决定的事（动态拼接的频道名、asar 外的加载器、
原生的 Node 插件）。脚本会在**完全没找到前端 bundle 时明确报警**，而不是输出
一排"✓ 无" —— 那种假阴性比漏报更危险（有过把 HTML 在 `dist/` 子目录、用相对路径
引用的应用误判成"无前端"的先例）。

---

## 限制

**1. 必须"带参数启动"一次。**
Electron 的 `--remote-debugging-port` 只能在启动时传入，所以注入需要重启应用一次。
目标应用自己硬编码的调试端口通常被 `!isPackaged` 挡住（打包版不生效），靠不住。

**2. 注入有一小段延迟。**
调试端口是"事后注入"：先发现页面 → 连上 → 注入。
脚本已改为**事件驱动**（订阅 `Target.targetCreated`），并把兜底巡检降到 20 秒一次，
常驻开销实测约 0.2% 单核；但严格零延迟做不到。

**3. 不加 `--watch` 时刷新会失效。**
调试注入依赖长连接：`--watch` 保持连接，所以刷新后依然生效；
不加 `--watch` 时连接随即关闭，刷新后样式会消失。

**4. 窗口层玻璃 CSS 管不到。**
`backgroundMaterial`（Windows 亚克力）/ `vibrancy`（macOS）由主进程建窗时设定。
用 `--native` 处理，或去系统设置关「透明效果」（设置 → 辅助功能 → 视觉效果），
后者一次对所有应用生效。

**5. 知情接受的代价。**
去掉模糊后，原本靠「半透明底 + 模糊」保证对比度的地方，文字可读性会下降。
这不在当前需求范围内。

---

## 卸载

删除 `apps/<name>/` 即取消该应用的使用。删除整个目录即完全卸载。

**本工具不改动目标应用的任何文件** —— 全部通过调试协议在运行时注入，
退出应用后不留痕迹，也不影响自动更新。

---

## 依赖

零第三方依赖：CLI 与注入器只用 Node 内置模块；界面只用 Python 标准库
+ 已安装的 pywebview。`vendor/darkreader.js` 是 Dark Reader 的 MIT 构建
（许可证见 `vendor/darkreader.LICENSE`）。
