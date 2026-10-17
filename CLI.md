# 只用命令行（CLI-only）使用指南

这份是给**不想装 Python / 不要图形界面**的人看的。
只要 Node.js 18+ 和 Windows 自带的 PowerShell，**其余什么都不用装**。

> 图形界面（`ui/ui.cmd`）是**可选**的。它需要 Python 3 + pywebview，
> 但所有功能在命令行里都有对应做法 —— 本文就是那份对照。

---

## 一、最快上手（四条命令）

```bash
cd <你放 no-glass-ele 的目录>

# 1. 探测一个应用（只读，不启动它）
node gen.js probe "D:\path\to\App.exe" --deep

# 2. 生成 profile
node gen.js new myapp --exe "D:\path\to\App.exe"

# 3. 生成启动脚本
node gen.js build myapp

# 4. 双击 apps\myapp\start.cmd
```

**第 3 步之后，日常用 `apps\myapp\start.cmd`** —— 双击就行，不用记命令。
它内部就是调用注入器（`node injector\noglass.js ... --launch --watch`）。

> `start.cmd` **不依赖 Python**，它只用 `node`。所以纯 CLI 用户完全够用。

---

## 二、安装与自检

```bash
git clone https://github.com/NotUNperson/no-glass-ele && cd no-glass-ele
node gen.js env          # 环境自检：Node / PowerShell / 项目文件 / 模块
```

`env` 会把每项标成必需或可选。纯 CLI 用户**只关心 Node 和 PowerShell 两项**，
Python 那两行显示 ✗ 也完全没关系。

---

## 三、命令速查

| 命令 | 作用 |
|---|---|
| `probe <exe> [--deep]` | 只读探测：Electron 版本、fuse 表、行为标记、应用自己的启动参数 |
| `new <name> --exe <path>` | 生成 `profiles/<name>.json`（带上探测结果）|
| `build <name>` / `build --all` | 渲染 `apps/<name>/` 下的启动器与说明 |
| `build <name> --bundle` | 同上，但打成**自包含**目录（可单独拷走）|
| `list` | 列出 profiles 与状态 |
| `doctor` | 校验：exe 存在性、端口冲突、fuse 与预设矛盾、产物是否过期 |
| `ps` | 列出运行中的注入会话（含外部启动的、残留的）|
| `stop <id\|profile\|pid>` | 请求停止（优雅退出，**不关目标应用**）|
| `logs <id\|profile\|pid> [-n N]` | 看某个会话的日志 |
| `prune` | 清理残留注册项（硬关机留下的）|
| `autostart on\|off\|list` | 管理开机自启动项（**需要 Python**，见第六节）|
| `env` | 环境自检 |

加 `--json` 可让 `probe` / `list` / `doctor` / `ps` / `logs` / `prune` 输出 JSON
（脚本化用；`stop` 没有这个开关）。

---

## 四、日常三条命令

```bash
node gen.js ps              # 现在有哪些注入在跑
node gen.js logs myapp      # 看它的日志（-n 50 只看最后 50 行）
node gen.js stop myapp      # 停止它（目标应用继续运行）
```

`ps` 会标出来源：`ui`（图形界面启的）/ `autostart`（开机启的）/ `cli`（命令行启的）/
`external`（旧版注入器，没登记）。

---

## 五、调整配置（不用图形界面）

profile 是纯 JSON，直接编辑即可：

```bash
notepad profiles\myapp.json
```

常用字段：

| 字段 | 说明 |
|---|---|
| `defaultPort` | CDP 端口（必须与其他 profile 不同，`doctor` 会查）|
| `appArgs` | 传给**目标应用**的启动参数，如 `["--disable-lcd-text"]` |
| `darkreader` | `"auto"` / `"dark"` / `"light"` / `"off"` —— 借 Dark Reader 上深色 |
| `isolateEnv` | 该应用私有的"允许多开"环境变量（让 `--isolate` 生效）|
| `urlFilter` | 只注入匹配此正则的页面 |

改完记得重新生成并校验：

```bash
node gen.js build myapp
node gen.js doctor
```

**自定义 CSS**：在 `css/` 下建 `<profile名>.custom.css`，存在即生效。
注入器监听该文件，改完保存会自动重新注入（不用重启应用）。

---

## 六、开机自启动（需要 Python）

**先说清楚**：开机自启需要一个 `pythonw.exe`（GUI 子系统程序，不会留黑窗口）。
所以这一项**需要装 Python**（pywebview 不需要 —— 无窗口模式不加载界面）。
不装 Python 的话，见本节末尾的三个替代办法。

### 它是怎么工作的

启动文件夹里只有**一个**快捷方式（不是每个应用一个）：

```
no-glass · autostart.lnk  →  pythonw ui/app.py --autostart-all
```

登录后它会：扫描 `profiles/*.json` → 找出 `autostart.enabled` 为真的 →
**按名字母序逐个**拉起（中间有间隔）→ 自己退出。

为什么不一次全起来：开机瞬间系统在抢磁盘，同时起多个应用会明显拖慢开机。
默认初始等 8 秒、逐条间隔 6 秒。

### 常用命令

```bash
node gen.js autostart on myapp       # 让 myapp 参与
node gen.js autostart off myapp      # 不参与
node gen.js autostart list           # 看谁启用了、中转器在不在
node gen.js autostart run --dry-run  # 只打印会启动哪些（先确认再真跑）
node gen.js autostart run            # 手动跑一次（等价于开机时做的事）
node gen.js autostart log            # 看日志
node gen.js autostart log -n 300     # 看更多行
node gen.js autostart config         # 看延迟/运行器设置
node gen.js autostart cleanup        # 删中转器快捷方式
```

### 给开机单独设置参数

想要"开机静默、手动启动显示窗口"，把参数写在 profile 的 `autostart.appArgs`
里，而不是顶层的 `appArgs`：

```json
{
  "appArgs": [],
  "autostart": {
    "enabled": true,
    "appArgs": ["--hidden"]
  }
}
```

| `autostart.appArgs` | 开机时实际收到 |
|---|---|
| 缺失 / `null` | 沿用顶层 `appArgs` |
| `[]` | 明确无参数（覆盖顶层）|
| `["--hidden"]` | 用它 |

顶层 `appArgs` 仍然**无条件**用于手动启动 —— 所以两者可以不同。

### 改启动节奏

```bash
node gen.js autostart config --set initialDelayMs=8000   # 初始延迟（毫秒）
node gen.js autostart config --set delayMs=6000          # 逐条间隔（毫秒）
```

或者直接编辑 `local/autostart.json`（文件不存在时用默认值）。

### 运行器（pythonw）出问题怎么办

```bash
node gen.js autostart config --set pythonw=auto              # 自动检测（默认）
node gen.js autostart config --set pythonw="C:\...\pythonw.exe"  # 手动指定
node gen.js autostart config --set pythonw=""                # 明确不用
```

自动模式会 `where pythonw` 拿全部候选、**逐个实测**能不能跑，第一个能跑的胜出。
界面的「开机自启」弹窗里有「检测」按钮，会列出所有候选和版本。

> **Python 换版本/换位置后**，已存在的 `.lnk` 会指向失效路径，开机时**静默失败**。
> `node gen.js doctor` 会检查这一点（运行器路径不存在就报），
> 提示你重新 `autostart on` 或重新检测。

### 三个替代办法（不装 Python）

如果实在不想装 Python：

**办法 1：自己放快捷方式**（会闪窗口）

右键 `apps\myapp\start.cmd` → 发送到桌面快捷方式 → 拖进启动文件夹
（`Win+R` → `shell:startup`）。缺点：会短暂闪出控制台窗口。

**办法 2：任务计划程序**（可完全无窗口，最接近原效果）

1. `Win+R` → `taskschd.msc` → 创建基本任务
2. 触发器：当我登录时
3. 操作：启动程序
   - 程序：`node.exe` 的完整路径（用 `where node` 查）
   - 参数：`"<仓库路径>\injector\noglass.js" --profile "<仓库路径>\profiles\myapp.json" --launch --watch --source autostart`
   - 起始于：`<仓库路径>`

**办法 3：装 Python 但不装 pywebview**（最省事，推荐）

只要 Python 本体即可，`pip install pywebview` 可以跳过 ——
无窗口模式不加载界面。然后正常用 `gen.js autostart on`。

> **冲突检测**：如果应用**自己**就有自启动项，开机后它先起来、我们的注入器再启动
> 会撞单实例锁，注入静默失败。`autostart on` 会检查并中止（`--force` 跳过）。
> 纯 CLI 用手动方式的话要自己注意：先在「任务管理器 → 启动」里禁用应用自己那一项。

## 七、常见问题

**Q: `probe` 说找不到 asar，是不是坏了？**
不是。有些应用的 `resources/app.asar` 只是加载器存根（真实代码在旁边的另一个 asar），
或者应用没打包。`probe` 会挑最大的那个 asar，挑中的不是 `app.asar` 时会明确告知。
`--deep` 才扫 asar，不加就是纯 exe 字节扫描。

**Q: 注入没效果？**
依次检查：
1. `node gen.js ps` —— 会话在跑吗？
2. `node gen.js logs <profile>` —— 日志里有没有「已注入 ✓」？
3. 应用是**带调试端口**启动的吗？直接从任务栏打开的不行 ——
   必须走 `start.cmd` 或 `autostart` 的方式。
4. `node gen.js doctor` —— 有没有报产物过期（改了 profile 没重新 build）？

**Q: 端口冲突怎么办？**
`doctor` 会报出来。改 profile 的 `defaultPort` 即可。注意它不能与其他 profile
重复，也不能落在自己的 `reservedPorts` 范围里。

**Q: 想换深色但效果不对？**
确认没同时用手写 CSS 和 Dark Reader（两者会互相干扰，实测彩色标签会被压平）。
二选一。Dark Reader 的引擎保持默认 `dynamicTheme`。

**Q: 停止注入会不会关掉我的应用？**
不会。停止是协作式的（写一个 `.stop` 文件，注入器自己退出），
目标应用是 detached 启动的，不受影响。

---

## 八、纯 CLI 与图形界面的能力对照

| 功能 | 命令行 | 图形界面 |
|---|---|---|
| 探测 / 生成 profile | ✅ | ✅ |
| 生成启动脚本 | ✅ | ✅ |
| 看会话与日志 | ✅ | ✅（多标签、实时流）|
| 启动 / 停止注入 | ✅ 双击 `start.cmd` | ✅ 一键 |
| 编辑 profile | ✅ 直接改 JSON | ✅ 表单 |
| 自定义 CSS | ✅ 直接写文件（热重载）| ✅ 内置编辑器 |
| 深色模式 | ✅ 改 profile / 命令行开关 | ✅ 滑块 + 立即生效 |
| 开机自启 | ⚠️ 需 Python（或手动放快捷方式）| ⚠️ 同一套机制 |
| 实时日志流 | ⚠️ `logs` 是快照 | ✅ 300ms 轮询 |

**结论**：除了「开机自启」这一项要绕一下，纯 CLI 能做完所有事。
如果你不用开机自启，那 Python 完全不必装。
