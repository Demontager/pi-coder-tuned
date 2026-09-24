# destructive-guard

在工具调用**执行前**拦住危险的删除。这是 2026-09-23 两次误删事故的直接对策。

## 为什么需要它

**第一次**（当天早些时候）的成因是一行代码：

```js
fs.rmSync(path.dirname(s.log[0]?.x ?? "/tmp"), { recursive: true, force: true })
```

三个环节叠起来：`s.log[0].x` 不存在 → `?? "/tmp"` 兜底成一个看着人畜无害的默认值 →
`path.dirname("/tmp")` 得到 `"/"`。以本机用户权限跑了约 2.5 分钟。root 拥有的树靠权限
活了下来，`bachi` 可写的部分（`/usr/local` 大半、`/Library` 部分、`~/Music`、`~/.vim`
…）没了，**且任何地方都没有第二份** —— 当时 Time Machine 没有配置，APFS 快照数为 0。

`AGENTS.md` 的 `## Destructive actions` 在事故前两小时就写好了，没拦住。原因是那份纪律
约束的是"我"，而事故发生在"我写的脚本在运行时做了什么"。**文字约束不了我控制之外的执行。**

**第二次**（同一天晚上，肇事会话 `01a0ceb9`）发生在**给这个扩展加闸三的过程中**：
`~/.zshrc`、`~/.gitconfig`、`~/.zprofile`、`~/.pi/agent/sessions/` 全部消失。事后用守卫
自己的代码回放，当时那两道闸对**每一个**被删目标都是放行：

```
放行 <= rm -rf ~/.pi/agent/sessions      放行 <= rm -f ~/.zshrc
放行 <= rm -f ~/.gitconfig               放行 <= rm -f ~/.zprofile
放行 <= rm -rf ~/.pi/agent
```

三个结构性原因：保护表只护**根**本身（`/`、`$HOME`、`/Users`），根**里面**的东西一律不拦；
`AGENTS.md` 写了"工作目录之外要先确认"，代码里却从未实现（`evaluateTarget` 收了 `cwd`
只用来拼相对路径）；`git reset --hard` 这类毁掉未提交工作的命令也不在认读范围里 ——
那次正是它把刚写好的闸三回滚掉了。

这个扩展补的就是那一段：挂在 pi 的 `tool_call` 钩子上，在**执行前**看参数。它是确定性
代码判定，不依赖模型自觉，也绕不过去。

## 三道闸

**闸一：删除类命令**（`bash` / `powershell`）

抽出删除目标，套 `AGENTS.md` 那套断言。认这些命令：

| 命令 | 提取的目标 |
| --- | --- |
| `rm` / `unlink` / `shred` / `truncate` | 非开关参数（`--` 之后一律算目标） |
| `find … -delete` / `find … -exec rm` | `find` 之后、第一个开关之前的路径 |
| `git clean -fdx` | 当前目录 |
| `git reset --hard` / `checkout --` / `restore` / `stash drop\|clear` / `branch -D` | 无路径目标，整段命令记为 `vcs-history-loss` |
| `rsync --delete` | 目的地 |
| PowerShell `Remove-Item` | 判目标是不是字面量 |

判定分四档：

- **block** —— 少于两段路径（`/`、`/etc`、`/tmp/..`）；等于受保护的根（`/System`、
  `/Library`、`/Applications`、`/Users`、`/usr`、`/bin`、`/sbin`、`/etc`、`/opt`、
  `/private`、`$HOME`）；是它们的**上级**；等于 `$HOME`；**守卫自己**（见下）。
- **confirm** —— 在系统树里（`/System`、`/Library`、`/usr/local/Cellar`、`/private/etc`
  …）；是 VCS 存储根（`.git` / `.hg` / `.svn`）；目标带兜底值（`??` / `||` / `${X:-y}`）；
  目标是算出来的（`dirname()` / `$(…)` / 变量）；**在工作目录之外**（见下）。
- **ok** —— 其余。`/Users/bachi/x/dist`、`/tmp/scratch`、`/usr/local/bin/tsc` 都放行。

闸一还会**下钻**：命令首部的包装（`sudo` / `doas` / `env` / `nice` / `xargs` …）被跳过去，
命令里的**内联代码**（`node -e '…'` / `sh -c '…'` / `python3 -c '…'`）与**从 stdin 喂给
解释器的 heredoc 正文**（`sh - <<EOF … EOF`）会被当子命令再判一次（最多两层）。第一次
事故的形态就在那里 —— 危险不在命令词上。

**工作目录之外要确认**（`outside-workdir`，第二次事故补的）

`AGENTS.md` 的第三条断言："在工作目录之外、且不是本会话创建的路径 → 先确认"。"本会话
创建的"静态判不出来，**临时目录是它唯一可靠的近似**（`/tmp`、`/private/tmp`、
`/var/folders`），所以判定是：解析后落在 `$HOME` 子树内、不在 `cwd` 子树内、也不在临时
目录里 → confirm。只在主目录子树内触发：两次事故的全部损失面都在 `$HOME` 里，而
`/usr/local/bin/tsc` 这类包管理器地盘每次确认只是噪音（`AGENTS.md` 也明说它可删）。

**守卫必须保护自己**（`self-protection`，block）

第二次事故里 `rm -rf ~/.pi/agent/extensions/destructive-guard` 与 `rm -f ~/.pi/agent/AGENTS.md`
都是放行的 —— 守卫看不见自己，也看不见定义它的那份纪律。删前者等于当场解除武装，删后者
等于抹掉判定口径的出处，所以这一档是 block 而不是 confirm。覆盖：任何
`…/extensions/destructive-guard`（仓库副本与 live 安装都算）、`~/.pi/agent/AGENTS.md`、
以及 `~/.pi/agent` 下的 `extensions` / `sessions` / `rewind` 三棵子树（那里是扩展、会话
记录与 rewind 快照 —— 删掉会同时毁掉门禁和它的恢复手段）。

**git 破坏性命令**（`vcs-history-loss`，confirm）

它们丢的不是文件系统上的某个路径，而是工作区 / 暂存区 / stash 里**只此一份**的内容，所以
单独成一个提取器（不硬塞进 target 模型）。认：`git reset --hard`、`git checkout -- <path>`、
`git restore`、`git stash drop|clear`、`git branch -D`。不认：`git checkout <branch>`、
`git checkout -b`、`git reset --soft|--mixed`、`git stash push|list`、`git branch -d`、
`git clean -n`（dry run）—— 切分支和软重置不丢东西，误报会让守卫变成噪音。

**闸二：写入内容里的删除代码**（`write` / `edit` / `multiedit` / `apply_patch`）

检查**要写进去的内容**。事故的危险代码是更早写进文件的，"运行脚本"那一步看起来完全无害
（`node verify-a.mjs`）—— 闸一看不见它。Claude Code 的分类器有对应规则（`WRITTEN FILE
EXECUTION`："写本身就是一次动作，按执行时判"），这道闸是同一个意思。

认这些形态：删除 API 那行带兜底值 / 目标来自路径运算 / 目标是裸根或 `..` 上跳 / shell
变量目标 / PowerShell 递归删除且目标非字面量。注释行不算（它们不执行）。字面量目标
（`fs.rmSync("/Users")`）交给闸一注入的保护根表判 —— `writes.ts` 自己不知道哪些目录受保护。

**闸三：运行脚本前把文件读进来判**（第二次事故补的）

`node verify-a.mjs` / `bash deploy.sh` / `./x.mjs` 这类命令，在执行前把**那个文件读进来**
跑闸一 + 闸二同一套判据。这是第一次事故那一行的**唯一有效拦截点** —— "运行一个脚本"在
命令词上看不出任何危险，危险在文件内容里。

三种形态都认：解释器 + 文件、直接执行的脚本（`./x.sh` / `/abs/x.mjs`）、以及**内联代码里
的**同名调用（`sh -c 'node a.mjs'`）。只认**字面路径**：变量拼出来的路径读不了，也不该猜。
读不到就放行并计数（`runtimeSkipped`）—— 这是护栏不是沙箱，对一个不存在的路径弹窗只会
变成噪音。体积上限 64 KiB（`SCRIPT_READ_LIMIT_BYTES`）。

## 行为

`block` 直接拒绝，理由作为工具错误结果回给模型。`confirm` 在 TUI 里弹一次选择；**非交互
环境一律拒绝**（fail closed，同 Claude Code 分类器 `automode-unavailable` 的语义）。

confirm 档的弹框是**给人看的**，不是把整条命令原样贴出来：

- 标题固定为“这条命令里有删除动作，执行前需要你确认”，正文只列命中项。
- 每个命中显示四行：**要删**（目标原文）、**实际路径**（能解析时）、**所在命令**（仅链式
  命令才显示，单段命令不重复）、**为什么拦**（一句人话，不带 `[rule]` 标签）。
- 命令替换 / 变量展开（`$(dirname …)` / `${VAR}` / 反引号）在切词时**整体算一个词**，
  不会被空格切碎成 `$(dirname` + `"$LOG")` 这种不是路径的碎片。
- 弹框**不滚动**（pi 的 `ExtensionSelectorComponent` 无滚动条，且 pi-tui 只画最后
  `terminal.rows` 行，超高时切掉的是顶部），所以命中超过 3 条就折叠成一行“还有 N 处”。
- 选项有三个：**取消**（默认，不删任何东西）、**先预览要删什么**（拦下并让模型先用只读
  命令把要删的路径列出来）、**确认删除**。

## 开关

| `PI_DESTRUCTIVE_GUARD` | 行为 |
| --- | --- |
| 不设 / `on` | 默认：block 档直接拒，confirm 档弹窗问 |
| `block` | 连 confirm 也直接拒（更严） |
| `notify` | 只通知不拦 —— **建议先跑一段这个**，收集误报 |
| `off` | 完全不管 |

`/destructive-guard` 看当前模式与本会话统计（检查次数 / 拒绝 / 要求先预览 / 确认后放行 / 放行 / 仅通知）。

如果第一次用，建议先 `PI_DESTRUCTIVE_GUARD=notify` 跑一天，看它会不会误报再切成默认。

## 文件

| 文件 | 内容 |
| --- | --- |
| `targets.ts` / `targets.test.ts` | 闸一的纯逻辑：目标抽取 + 词法解析 + 判定 + 内联代码/heredoc 下钻 + git 破坏性命令 + 工作目录外/自保护规则（无 IO、无 pi 依赖） |
| `writes.ts` / `writes.test.ts` | 闸二的纯逻辑：写入内容里的危险删除形态（字面量目标经注入的判定器判） |
| `index.ts` / `index.test.ts` | 接线：`tool_call` 钩子、三道闸、闸三的脚本读取、模式开关、`/destructive-guard` |

## 测试

```bash
node --test clients/pi/extensions/destructive-guard/targets.test.ts \
            clients/pi/extensions/destructive-guard/writes.test.ts \
            clients/pi/extensions/destructive-guard/index.test.ts
```

109 个用例。`index.test.ts` 用 pi 自己的加载器真实加载扩展，不是造假的 pi 对象；其中一组
专门钉弹框文案（目标不显示成碎片、能解析的目标显示实际路径、单段命令不重复“所在命令”、
超限折叠、重复命中去重），另有闸三端到端（事故脚本拦 / 干净脚本放 / 读不到不拦 /
`sh -c` 嵌套）、git 破坏性命令必拦与不误伤、本次事故全部损失面命中 `outside-workdir`、
守卫自己命中 `self-protection` 四组。`targets.test.ts` 里“必拦”与“必放行”两组同样重要 ——
一个总在弹窗的守卫等于没有守卫。

## 已知边界

- **词法解析，不跟符号链接。** 要跟就得访问磁盘，而这里要的是确定性、可测、零副作用。
  macOS 上 `/etc` → `/private/etc`，两条路径都在保护表里，所以不吃亏。
- **不做完整数据流分析。** 目标是抓得住真形态、少误报，不是证明安全性。跨函数传递的
  目标（`const t = compute(); rmSync(t)`）认不出来 —— 那种情况靠 `AGENTS.md` 的纪律兜。
- **拦的是"危险写法"，不是"不许删"。** 正常清理（仓库内的 `dist`、`node_modules`、
  `/tmp` 下的临时目录）一律放行。
- **`outside-workdir` 用临时目录近似"本会话创建"。** 静态判不出一个路径是不是本会话
  刚建的，`/tmp` / `/private/tmp` / `/var/folders` 是唯一可靠的近似。代价：主目录里、
  工作目录外的**真实**临时文件也会问一句 —— 这正是第二次事故的损失面，问一句是值的。
- **闸三读不到的脚本放行。** 不存在 / 超过 64 KiB / 不是字面路径的脚本只计数不拦：
  这是护栏不是沙箱。真正的能力边界要靠 OS 级沙箱（Codex 的 seatbelt/landlock 路线），
  词法门禁永远有枚举之外的洞 —— 这两次事故就是两个洞。
- **黑名单天然 fail open。** 本扩展枚举"坏的形状"，枚举之外一律放行。它降低概率，
  不提供证明。`$HOME` 内的全局文件要真正免疫，靠的是备份（Time Machine / APFS 快照 /
  dotfiles 仓库），不是任何门禁。
