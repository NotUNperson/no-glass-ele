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
git clone <仓库> && cd no-glass-ele
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

## 六、开机自启动（这一项需要 Python）

**先说清楚**：`gen.js autostart` 会在启动文件夹放一个 `.lnk`，
它指向 `pythonw.exe "...\ui\app.py" --headless --start <profile>`。
**所以这条命令需要装 Python**（pywebview 不需要，无窗口模式不加载界面）。

纯 CLI 用户想要开机自启，有三个办法：

### 办法 1：装 Python（最省事）

只需要 Python 本身，**不需要** pywebview：

```bash
node gen.js autostart on myapp      # 创建
node gen.js autostart list          # 查看
node gen.js autostart off myapp     # 删除
```

为什么绕一层 Python：`node.exe` 是控制台程序，快捷方式直接指向它会留下一个
常驻黑窗口。`pythonw.exe` 没有控制台，它再用 `CREATE_NO_WINDOW` 起 node，
全程无窗口。

### 办法 2：自己放一个快捷方式（不需要 Python，但会闪窗口）

1. 右键 `apps\myapp\start.cmd` → 发送到 → 桌面快捷方式
2. 把快捷方式拖进启动文件夹：`Win+R` → 输入 `shell:startup` → 回车
3. 缺点：会短暂闪出一个控制台窗口（`start.cmd` 是控制台脚本）

### 办法 3：任务计划程序（不需要 Python，可以完全无窗口）

1. `Win+R` → `taskschd.msc`
2. 创建基本任务 → 触发器选「当我登录时」
3. 操作选「启动程序」：
   - 程序：`node.exe` 的完整路径（`where node` 查）
   - 参数：`"<仓库路径>\injector\noglass.js" --profile "<仓库路径>\profiles\myapp.json" --launch --watch --source autostart`
   - 起始于：`<仓库路径>`
4. 在任务属性里勾「不管用户是否登录都要运行」可避免窗口（或用「隐藏」选项）

办法 3 最接近 `gen.js autostart` 的效果，代价是要手填三个路径。

> **冲突检测**：如果应用**自己**就有自启动项，开机后它先起来、我们的注入器再启动
> 会撞单实例锁，注入静默失败。`autostart on` 会检查并中止（用 `--force` 跳过）。
> 纯 CLI 用手动方式的话，**要自己注意这一点** —— 先在「任务管理器 → 启动」里
> 禁用应用自己那一项。

---

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
