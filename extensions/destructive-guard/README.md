# destructive-guard

在工具调用**执行前**拦住危险的删除。这是 2026-09-23 那次 `rm -rf /` 事故的直接对策。

## 为什么需要它

事故的成因是一行代码：

```js
fs.rmSync(path.dirname(s.log[0]?.x ?? "/tmp"), { recursive: true, force: true })
```

三个环节叠起来：`s.log[0].x` 不存在 → `?? "/tmp"` 兜底成一个看着人畜无害的默认值 →
`path.dirname("/tmp")` 得到 `"/"`。以本机用户权限跑了约 2.5 分钟。root 拥有的树靠权限
活了下来，`bachi` 可写的部分（`/usr/local` 大半、`/Library` 部分、`~/Music`、`~/.vim`
…）没了，**且任何地方都没有第二份** —— 当时 Time Machine 没有配置，APFS 快照数为 0。

`AGENTS.md` 的 `## Destructive actions` 在事故前两小时就写好了，没拦住。原因是那份纪律
约束的是"我"，而事故发生在"我写的脚本在运行时做了什么"。**文字约束不了我控制之外的执行。**

这个扩展补的就是那一段：挂在 pi 的 `tool_call` 钩子上，在**执行前**看参数。它是确定性
代码判定，不依赖模型自觉，也绕不过去。

## 两道闸

**闸一：删除类命令**（`bash` / `powershell`）

抽出删除目标，套 `AGENTS.md` 那套断言。认这些命令：

| 命令 | 提取的目标 |
| --- | --- |
| `rm` / `unlink` / `shred` / `truncate` | 非开关参数（`--` 之后一律算目标） |
| `find … -delete` / `find … -exec rm` | `find` 之后、第一个开关之前的路径 |
| `git clean -fdx` | 当前目录 |
| `rsync --delete` | 目的地 |
| PowerShell `Remove-Item` | 判目标是不是字面量 |

判定分三档：

- **block** —— 少于两段路径（`/`、`/etc`、`/tmp/..`）；等于受保护的根（`/System`、
  `/Library`、`/Applications`、`/Users`、`/usr`、`/bin`、`/sbin`、`/etc`、`/opt`、
  `/private`、`$HOME`）；是它们的**上级**；等于 `$HOME`。
- **confirm** —— 在系统树里（`/System`、`/Library`、`/usr/local/Cellar`、`/private/etc`
  …）；是 VCS 存储根（`.git` / `.hg` / `.svn`）；目标带兜底值（`??` / `||` / `${X:-y}`）；
  目标是算出来的（`dirname()` / `$(…)` / 变量）。
- **ok** —— 其余。`/Users/bachi/x/dist`、`/tmp/scratch`、`/usr/local/bin/tsc` 都放行。

**闸二：写入内容里的删除代码**（`write` / `edit` / `multiedit` / `apply_patch`）

检查**要写进去的内容**。事故的危险代码是更早写进文件的，"运行脚本"那一步看起来完全无害
（`node verify-a.mjs`）—— 闸一看不见它。Claude Code 的分类器有对应规则（`WRITTEN FILE
EXECUTION`："写本身就是一次动作，按执行时判"），这道闸是同一个意思。

认这些形态：删除 API 那行带兜底值 / 目标来自路径运算 / 目标是裸根或 `..` 上跳 / shell
变量目标 / PowerShell 递归删除且目标非字面量。注释行不算（它们不执行）。

## 行为

`block` 直接拒绝，理由作为工具错误结果回给模型。`confirm` 在 TUI 里弹一次选择；**非交互
环境一律拒绝**（fail closed，同 Claude Code 分类器 `automode-unavailable` 的语义）。

## 开关

| `PI_DESTRUCTIVE_GUARD` | 行为 |
| --- | --- |
| 不设 / `on` | 默认：block 档直接拒，confirm 档弹窗问 |
| `block` | 连 confirm 也直接拒（更严） |
| `notify` | 只通知不拦 —— **建议先跑一段这个**，收集误报 |
| `off` | 完全不管 |

`/destructive-guard` 看当前模式与本会话统计（检查次数 / 拒绝 / 确认放行 / 放行 / 仅通知）。

如果第一次用，建议先 `PI_DESTRUCTIVE_GUARD=notify` 跑一天，看它会不会误报再切成默认。

## 文件

| 文件 | 内容 |
| --- | --- |
| `targets.ts` / `targets.test.ts` | 闸一的纯逻辑：目标抽取 + 词法解析 + 判定（无 IO、无 pi 依赖） |
| `writes.ts` / `writes.test.ts` | 闸二的纯逻辑：写入内容里的危险删除形态 |
| `index.ts` / `index.test.ts` | 接线：`tool_call` 钩子、模式开关、`/destructive-guard` |

## 测试

```bash
node --test clients/pi/extensions/destructive-guard/targets.test.ts \
            clients/pi/extensions/destructive-guard/writes.test.ts \
            clients/pi/extensions/destructive-guard/index.test.ts
```

81 个用例。`index.test.ts` 用 pi 自己的加载器真实加载扩展，不是造假的 pi 对象。
`targets.test.ts` 里"必拦"与"必放行"两组同样重要 —— 一个总在弹窗的守卫等于没有守卫。

## 已知边界

- **词法解析，不跟符号链接。** 要跟就得访问磁盘，而这里要的是确定性、可测、零副作用。
  macOS 上 `/etc` → `/private/etc`，两条路径都在保护表里，所以不吃亏。
- **不做完整数据流分析。** 目标是抓得住真形态、少误报，不是证明安全性。跨函数传递的
  目标（`const t = compute(); rmSync(t)`）认不出来 —— 那种情况靠 `AGENTS.md` 的纪律兜。
- **拦的是"危险写法"，不是"不许删"。** 正常清理（仓库内的 `dist`、`node_modules`、
  `/tmp` 下的临时目录）一律放行。
