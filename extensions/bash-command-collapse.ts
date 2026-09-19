/**
 * Bash Command Collapse Extension
 *
 * 把 bash 工具调用里显示的 shell 命令折叠成前 N 个**视觉行** + 一行「被折叠内容有多大」
 * 提示，避免超长命令（heredoc、多行管道、内联脚本）刷屏。纯显示层：发给模型的 tool call
 * 参数、session 记录里的原文完全不变。
 *
 * 提示格式 `… (123 tokens hidden)`，token 为估算值。注意 thinking-collapse.ts 已经
 * 换成滚动窗口、不再输出这个提示（底部 spinner 在数 token），所以这套提示格式现在
 * 只剩 bash 命令折叠在用。
 * ctrl+o（app.tools.expand）展开工具输出时，命令也会完整显示。
 *
 * ## 折叠视图：break-all 硬折行（不提前折行、不用 `…` 截断）
 *
 * 折行规则是 CSS `word-break: break-all` 那一套：按列预算逐个 grapheme 填充，**装满到
 * 恰好放不下为止再断**，断点就在行末，不管它落在单词/路径中间。实现见 `hardWrapToWidth`。
 *
 * 为什么不用 pi-tui 的 `wrapTextWithAnsi`：它是**贪心词折行 + 长词按列断开**，装不进当前行
 * 剩余空间的词会被**整块挑到下一行**再去断 —— 实测 79 列终端上 `$ cp <78 列路径>` 渲染成
 * `$ cp` 单独一行 + 路径从中间断成两截：行尾白白空着几十列（就是“提前折行”那个难看的
 * 样子），命令和它的参数还被拆开。硬折行则把每行填满，`$ ` 后面直接跟命令正文。
 *
 * 中间试过第三条路（commit 9024c26）：不折行、装不下就把行尾截成 `…`。它确实不会提前
 * 折行，但一条长命令只剩一行可见内容、后面全丢，信息量太低 —— 现在改成硬折行后，
 * 同样的预算能装满 3 整行正文，超出部分才走隐藏提示。
 *
 * 行数预算（`limit`，默认 3）按**视觉行**算而不是源行：一条超长单行命令占满整个预算
 * 而不是刷十几行，而短行的多行命令（heredoc 等）仍然显示前 3 条源行 —— 两种情况都不
 * 会失控。超出预算的内容（当前源行的尾巴 + 后面所有源行）计入 `… (N tokens hidden)`。
 * 展开态（ctrl+o）用同一套硬折行规则，只是不限行数 —— 折行规则
 * 必须一致，否则展开态又会出现“提前折行”。
 *
 * ## 输出预览行数（pi 写死 5 行，这里改成 3 行）
 *
 * pi 把 bash 输出的预览行数写死在 `core/tools/renderers/bash.js` 的
 * `const BASH_PREVIEW_LINES = 5`：模块私有常量，既没从包里导出，也不在
 * `BashToolOptions` 里，`docs/settings.md` 里也没有对应设置项 —— **没有全局配置可改**，
 * 只能在扩展里后处理（`withPreviewLimit` / `trimPreviewLines`）。
 *
 * 做法是拿 pi 渲好的组件做后处理而不是重写整个 resultRenderer，这样 pi 的语义
 *（截断页脚剔除、warnings、`Took Xs`、展开态、图片）全部保留，我们只动预览那一段。
 * 两个关键点：① **逐 child 渲染**而不是拿平铺行数组（平铺数组里分不清哪几行是预览）；
 * ② 裁掉的行数必须补进提示行的计数，否则「隐藏了多少行」就谎了 —— pi 给了提示行就
 * 在它那行**原地改数字**（保住 pi 的配色与真实键名），pi 没给（输出刚好 ≤ 5 行）
 * 就自建一行，否则那 1~2 行会静默消失。
 *
 * 展开态（ctrl+o）自动不受影响：那时 pi 用的是 `new Text(...)` 而不是预览组件，
 * 鸭子判定直接跳过，完整输出一行不裁。
 *
 * ## 输出树形 gutter（`│` / `└`）
 *
 * 给输出预览的每一行挂一个字符的缩进：除末行外是 `│ `，末行是 `└ `，对齐 codex
 * 的 bash 输出样式 —— 命令在上、输出挂在一棵树下，层次一眼可辨：
 *
 * ```
 * $ cat text.txt
 * │ ... (7 earlier lines, ctrl+o to expand)
 * │ hello world
 * └ hello world
 *
 *  Took 2.4s
 * ```
 *
 * （`Took Xs` 那行只在执行够久时才画 —— 上面这个例子里命令跑了 2.4s，
 * 见下面「耗时页脚门槛」一节。）
 *
 * 实现挂在 `withPreviewLimit` 里（它本来就要逐 child 找出「哪个子组件是输出」，
 * gutter 用的是同一条判定），细节与三个不能想当然的点见 `prefixTreeLines`。
 * 两个刻意的设计决定：
 *   ① **展开态（ctrl+o）不加 gutter** —— 展开态要的就是原样完整输出。pi 那时用的是
 *     `new Text(...)`（有 `setText`），鸭子判定天然跳过它，所以这条不需要额外分支，
 *     与「展开态不裁预览行」共用同一个机制。
 *   ② **warnings / `Took Xs` 不进树** —— 它们是元信息页脚而不是命令输出，和命令
 *     上方的 `… (N tokens hidden)` 提示一样留在树外（那条提示属于 renderCall 的
 *     块，本来就不在结果组件里）。
 * gutter 占 2 列，所以输出子组件必须按 `width - 2` 渲染（详见 `withPreviewLimit`）。
 * `PI_BASH_TREE=off` 可关；关掉后渲染路径与加 gutter 之前逐行一致。
 *
 * ## 耗时页脚门槛（短命令不画 `Took`）
 *
 * pi 内置的结果渲染器**无条件**在末尾画一行 `Took X.Xs`（`state.startedAt` 有值就画），
 * 而它是个**独占一行**的页脚：对绝大多数几十毫秒的命令来说只是白占一行高度，还额外带进
 * 一行分隔空行（页脚是 `new Text("\n" + …)`，那个前导 `\n` 就是正文与页脚之间的空白行）：
 *
 * ```
 * $ echo hello
 * └ hello
 *
 *  Took 0.1s
 * ```
 *
 * 所以**短命令整条页脚都不画**（连那行分隔空行一起）—— 区块变成「命令行 + 输出 +
 * 下边界空行」，一行都不浪费。门槛默认 2000ms（常量 `DEFAULT_MIN_TIME_FOOTER_MS`），
 * `PI_BASH_MIN_TIME_MS` 启动时可改，`0` = 永远显示（等于关掉这个优化）。
 *
 * 判定用**真实耗时** `endedAt - startedAt`（与 pi 画那个数字用的是同一个量），不去解析
 * 页脚上的文本 —— 文本是 `(ms / 1000).toFixed(1)` 四舍五入过的，拿它判会出现「显示 2.0s
 * 其实只跑了 1.96s」这类边界偏差。门槛 >= 耗时即隐藏，所以能看见的数字必然 >= 2.0s，
 * 不会出现自相矛盾的 `Took 1.9s`。
 *
 * 流式模式（`PI_BASH_STREAM=on`）下执行期中那个 `Elapsed X.Xs` 走同一条判定（同一个页脚，
 * 只是文案跟着 `isPartial` 变）：短命令执行期间不会闪出那一行，跑过 2s 才出现 ——
 * 正好是「值得看一眼」的时刻。非流式（默认）下只在执行结束时判一次，正是用户要的语义。
 *
 * 实现挂在 `withPreviewLimit` 里（它本来就要逐 child 渲染、也本来就把 warnings / `Took`
 * 当「非输出 child」透传），判定见 `isTimeFooterChild`：末位 + 文本形态两条缺一不可。
 *
 * ## bash 命令语法高亮（轻量版）
 *
命令行按 shell 词法上色：命令名 `syntaxFunction`、选项 `-x/--xxx` `syntaxKeyword`、
引号串与路径 `syntaxString`、`$VAR`/`NAME=` 赋值 `syntaxVariable`、`|`/`&&`/重定向
`syntaxOperator`、`#` 注释 `syntaxComment`，`$ ` 前缀用 `toolTitle`（正常色，不用 dim）。配色走主题的 `syntax*`
槽（和 markdown 代码块同一套），所以换主题自动跟着变。默认开，`PI_BASH_HIGHLIGHT=off`
回到改动前的「整行 toolTitle 粗体」—— 刻意**没有** `/bash-highlight` 指令：纯观感开关，
env 一个入口就够，没必要再占一条斜杠指令。

参照 `@sting8k/pi-droid-styling` 的 `tool-tags/bash.ts`：它同样是**手写 shell 分词器**
（`tokenizeShellLinePreservingText` + `colorShellWord`），只在分词失败（引号没闭合）时
才退回 pi 导出的 `highlightCode(line, "bash")`。这里不采它的退回路径 —— `highlightCode`
返回的是**带 ANSI 的整行**，而本扩展的折行是 break-all 硬折行、必须「先折纯文本、
后上色」（反过来会把 SGR 序列从中间切断，见 renderCall 里的注释），带 ANSI 的行没法
再喂给 `hardWrapRows`。所以分词失败就退回单色粗体，而不是换一个高亮器。

对齐办法：token 偏移是**源行**坐标，碎片是**折行后**坐标，`hardWrapRows` 记下每条
碎片对应原文的 `[start, end)` 字符区间，上色时按区间切 token。三条要点：
  ① 一个 token 被折行切成两半时，两半是同一种颜色 —— 视觉上无碍，这就是用户说的
    「有折行所以高亮可能不准，轻一些」的那部分。
  ② 引号状态**跨源行**保留（`openQuote`），所以多行字符串（`git commit -m "…\n…"`）
    的第二行不会被当成命令重新分词。heredoc 正文没有这个待遇（`<<EOF` 不是引号），
    会按命令行上色 —— 无害，只是不准。
  ③ 折叠预算用完就停止分词，被隐藏的尾巴不参与上色（也不参与 token 计数以外的任何
    计算），所以折叠提示里的 token 估算仍然基于纯文本。

## 输出正文的独立颜色（扩展 token `bashOutput`）

pi 的内置 bash 结果渲染器把输出正文写死成 `theme.fg("toolOutput", line)` —— 那是**所有
工具输出共用的槽**（read / grep / ls 的正文、`…` 占位符都吃它），想只调 bash 输出的颜色
就得绕开它。做法是在**委托给内置渲染器的那个同步窗口**里把主题的 `toolOutput` 临时指向
`bashOutput`（`withBashOutputColor()`），于是只有输出正文换色 —— 命令行（`toolTitle` +
自绘语法高亮）、折叠提示（`muted` / `dim`）、树形 gutter（`muted`）、`Took Xs` 页脚
（`muted`）一律不受影响，其他工具的输出也完全不受影响（它们的渲染器不在这个窗口里跑）。

注意**传给 `renderResult` 的那个 theme 参数是没用的**：pi 的 bash 渲染器签名把第二个
theme 参数写成 `_theme` 后根本不用它，输出行是用**模块级 theme 单例**上的色。
那个单例（`Proxy` → `globalThis[Symbol.for("@earendil-works/pi-coding-agent:theme")]`）
与扩展拿到的渲染器参数是同一个对象，所以改它的 `fgColors` 表就是改渲染器看到的色值。

`bashOutput` 是本仓库自造的 token（pi 官方 schema 里没有，与 `toolDiffAddedBg` 那两个
同一条路：TypeBox 校验对未知 key 放行、`createTheme()` 把它们收进前景表）。**主题没定义它
就什么都不做**（探测方式是真调一次 `getFgAnsi()`，pi 对未知 token 抛
`Unknown theme color: …`），所以内置主题与 pi-coder-summer-night / pi-coder-catppuccin 照旧走 `toolOutput`，
目前只有 `pi-coder-ayu.json` 定义了这个 token。展开态（ctrl+o）同样是输出正文，一并生效。

## 染色块的上下边界空行
 *
 * self 模式下 pi 不再套 `Box(1, 1, bgFn)`，所以底色块的上下内边距得自己画回来：
 * 命令行**上面**一行、最后一行（通常是 `Took Xs`）**下面**一行，两行都是染了底色的
 * 空行（Box.applyBg 会把每行补满到 width 再上色，空行也不例外），这样文字不会顶着
 * 染色区的上/下边缘。对齐 pi 默认 shell 的观感（`Box(1, 1)` 就是这个效果），
 * 但**中间**（命令与输出之间）仍然紧贴 —— 那是刻意去掉的，见 renderResult 里的注释。
 *
 * 为什么不能直接给两个 Box 各设 `paddingY: 1`：命令与结果是两个独立的 Box，各自的
 * 垂直 padding 会叠加成「命令与输出之间三行空白」（实测过），所以只在最外侧补：
 * 上边界放在 call 组件的首行，下边界放在 result 组件的末行。命令已出、结果还没到的
 * 中间态（pending）由 call 组件自己补一行下边界，否则那几十毫秒~几十秒里块是
 * 「上留白、下触底」的歪样子。
 *
 * 用法：
 *   /bash-preview             查看输出预览行数
 *   /bash-preview 5           输出预览改成 5 行（1-50）
 *   /bash-preview off         恢复 pi 内置的 5 行预览
 *   /bash-timeout             查看 bash 执行期限（默认 / 上限 / env 覆盖）
 *
 * 折叠固定开启、保留 3 个视觉行（原先的 `/bash-collapse` 指令已删除）；树形缩进与流式
 * 两项只剩启动时的 env 入口：`PI_BASH_TREE=off` / `PI_BASH_STREAM=on`。
 *
 * 附带第五个职责：**短命令不画耗时页脚** —— 默认执行时长 < 2s 就把 `Took 0.1s` 那一行
 *（连它的前导分隔空行）整个去掉，详见上面「耗时页脚门槛」一节。`PI_BASH_MIN_TIME_MS`
 * 可改门槛，`0` = 永远显示。
 *
 * 附带第四个职责：把 bash **输出预览**从 pi 内置的 5 行改成 3 行
 *（`BASH_PREVIEW_LINES` 是 pi 的模块私有常量，没导出也没设置项，只能后处理，
 * 详见下面「输出预览行数」一节）。`/bash-preview` 可改。
 *
 * 附带第三个职责：给每条 bash 命令**强制一个执行期限**（默认 120s、上限 600s，
 * 照抄 Claude Code 的 BASH_DEFAULT_TIMEOUT_MS / BASH_MAX_TIMEOUT_MS 策略，详见下面
 * CLAUDE_CODE_DEFAULT_TIMEOUT_MS 那块的注释）。pi 内置 bash 的 timeout 无默认值，
 * 不注入就会无限期等下去。
 *
 * 附带第二个职责：把 bash 工具调用的屏幕显示改成**非流式**（默认，对齐 opencode / codex）。
 * pi **没有**任何设置项能做到这件事（settings.md 里 Shell 一节只有 shellPath /
 * shellCommandPrefix / npmCommand）。而且这里有**两条独立的流式机制**，必须分别处理：
 *
 * （1）**输出流式**：内置 bash 的 execute 每收到 stdout/stderr 数据就 onUpdate() 一份快照，
 *     节流 100ms（renderers/bash.js 的 BASH_UPDATE_THROTTLE_MS），经 tool_execution_update
 *     事件到 TUI（interactive-mode.js）当 partial 结果重画一遍。
 *     关掉的办法：把 onUpdate 传成 undefined —— execute 里每个更新点都有
 *     `if (!onUpdate) return` 守卫，于是全程零更新。渲染器不受影响：组件在
 *     `tool_execution_start` 就已创建（与更新无关），最终显示走 `tool_execution_end` →
 *     `updateResult(result, isPartial=false)`，所以压掉 partial 只是少了中间帧，
 *     结束那一次照常出（5 行预览 + 展开提示 + 截断提示 + "Took Xs"）。
 *
 * （2）**命令文本流式**：模型生成工具调用时参数是流式的（json 事件里能看到 toolcall_delta
 *     一片一片到：`{"command": "echo a` / `; sleep 0` / `.3; echo` …），pi 每收一片就
 *     updateArgs() → updateDisplay() → 重画一次 renderCall，于是命令一个字一个字冒出来。
 *     这条与（1）**完全无关**，光压 onUpdate 管不到它。
 *
 *     关掉的办法是把两个时间点**分开**处理（对齐 codex / opencode）：
 *       时间点一：命令字符全收完（`context.argsComplete`）→ renderCall 一次性出完整命令；
 *       时间点二：命令执行完 → renderResult 把结果补刷到命令下面。
 *     具体做法：renderCall 在「args 可能还在流」（`!argsComplete && isPartial === true`）时
 *     返回**零行组件**（连占位行都不画）。
 *     注意不能**只**用 isPartial 当阈值：isPartial 要等 final 结果才置 false，单用它会把
 *     命令也压到结果之后，退化成「全等到结果才一次性出」。
 *     （setArgsComplete() 在 assistant message_end 时调，比 tool_execution_start 早 ~60ms，
 *     正好是“命令收完”这个语义点。）
 *     也不能**只**用 argsComplete：它只在实时流里置位，`/resume` 等历史重建路径从不调
 *     setArgsComplete（见 renderCall 里的详细说明），单用它会让恢复出来的 bash 块
 *     只剩输出、命令行整行消失（这就是曾经的 resume bug）。
 *     另外零行组件不会画出空盒子：Box.render 开头有 `childLines.length === 0 → []` 守卫
 *     （paddingY 是在这之后才加的）。
 *
 * 实测证据：
 *   - `pi -p --mode json` 跑真实 pi 数事件，同一条
 *     `echo a; sleep 0.35; echo b; sleep 0.35; echo c`：扩展加载时 `tool_execution_update` = **0**，
 *     `--no-extensions` 跑内置 bash 时 = **4**；两种情况的 tool result 都是 `"a\nb\nc\n"`。
 *   - 直接调包根导出的 createBashToolDefinition 数 onUpdate 次数：传 onUpdate = 4 次
 *     （1 次初始空更新 + 3 份输出快照），传 undefined = 0 次，final result 逐字节相同。
 *   - **执行耗时不受影响**：同一条 `echo a; sleep 0.5; echo b`，流式平均 545ms / 非流式
 *     平均 566ms（各跑 3 次，差 21ms 在噪声内）。所谓“变慢”是非流式的固有代价：
 *     以前第一块输出 ~100ms 就冒出来了，现在整个命令跑完才显示，感知延迟 = 命令全时长。
 *   - `echo hello` 的真实时间线：toolcall_start → toolcall_end 197ms（args 流式，模型侧）、
 *     toolcall_end → tool_execution_start 63ms、tool_execution_start → end 只 31ms。
 *     即“等了一下”的主体是模型在生成 tool call，不是命令执行。
 *
 * 为什么必须放在本扩展里而不是新开一个 bash-stream.ts：跨扩展的同名工具注册是
 * **first registration per name wins**（runner.js getAllRegisteredTools 的注释原文，
 * 按扩展加载顺序即文件名顺序遍历）。本文件排在前面，新开的那个会被**静默忽略**。
 *
 * 非流式的代价（刻意的，别顺手"优化"）：
 *   - 命令收完到执行完之间**没有进度反馈**（只有那行命令，没有输出、没有计时）。
 *     `renderResult` 里的每秒计时器只在 `options.isPartial` 时才起
 *     （`if (state.startedAt !== undefined && options.isPartial && !state.interval)`），
 *     没有 partial 就永远不起，也没有 "Elapsed" 跳动，直到结束才补上
 *     「输出 + Took 12.3s」。命令通常很短所以可接受；真要盯长任务就 `PI_BASH_STREAM=on`。
 *   - 发给模型的内容**完全不变**：onUpdate 只喂显示层（tool_execution_update →
 *     tool-execution.js 的 isPartial），既不进 session 落盘也不进 tool result，
 *     execute 的返回值一字不差；renderCall 也只改显示，tool call 参数与 session 原文不动。
 */

import type { BashToolOptions, ExtensionAPI, ThemeColor, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import { Box, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** 缩略保留的**视觉行**数（硬折行后一条超长单行命令也最多占这么多行）。 */
const DEFAULT_LINES = 3;

/**
 * 输出预览保留的行数（pi 内置是 5，这里改成 3）。
 *
 * pi 把行数写死在 `core/tools/renderers/bash.js` 的 `const BASH_PREVIEW_LINES = 5`：
 * 模块私有常量，既没从包里导出（`index.d.ts` 里没有），也不在 `BashToolOptions`
 * 里，`docs/settings.md` 里也没有任何对应的设置项 —— 所以没有全局配置可改，
 * 只能在扩展里后处理。详见文件头「输出预览行数」一节。
 */
const DEFAULT_OUTPUT_PREVIEW_LINES = 3;

/**
 * 耗时页脚的展示门槛（毫秒）：执行时长**短于**它就不画 `Took 0.1s` 那一行。
 *
 * pi 内置 `renderResult` 无条件在结果末尾画一行 `Took X.Xs`（`state.startedAt` 有值就画），
 * 而它是个独占一行的页脚（外加自己那行前导空行）—— 对几十毫秒的命令来说纯属白占两行。
 * 详见文件头「耗时页脚门槛」一节。
 *
 * `PI_BASH_MIN_TIME_MS` 启动时可改；`0` 是合法值 = 永远显示（等于关掉这个优化）。
 */
const DEFAULT_MIN_TIME_FOOTER_MS = 2000;

/**
 * 第三个职责：给每条 bash 命令**强制一个执行期限**（照抄 Claude Code 的策略）。
 *
 * 为什么必须有：pi 的内置 bash `timeout` 是可选参数且**无默认值**（schema 描述原文
 * "Timeout in seconds (optional, no default timeout)"，settings.md 里也没有任何全局
 * 工具超时项），所以模型不传 timeout 时，一条不退出的命令会让 pi **无限期等下去**。
 * 而本扩展默认非流式（onUpdate 被摘掉），内置渲染器的 `Elapsed` 计时器只在
 * `isPartial` 时才起（renderers/bash.js），于是屏幕上「进程卡死」与「纯粹耗时」
 * 长得一模一样 —— 既不会自己脱困，也看不出该不该等。
 *
 * Claude Code 的做法（从 v2.1.268 二进制里扒出的原文，JS 是内嵌的）：
 *   var xRo=120000, ARo=600000;                       // 默认 2min / 上限 10min
 *   wCe(env)  → BASH_DEFAULT_TIMEOUT_MS 否则 xRo       // 默认
 *   i7e(env)  → Math.max(BASH_MAX_TIMEOUT_MS 否则 ARo, wCe(env))   // 上限=max(配置,默认)
 *   Math.min(z || Xe(), Be())                          // 模型传的 timeout **静默 clamp**
 * 工具描述里还把数字告诉模型："You may specify an optional timeout in milliseconds
 * (up to ${max}ms…). By default, your command will timeout after ${default}ms…"。
 * 注意它的单位是 ms，pi 的 bash 参数是**秒**，所以下面统一除 1000。
 *
 * env 变量名沿用 Claude Code 的（BASH_DEFAULT_TIMEOUT_MS / BASH_MAX_TIMEOUT_MS），
 * 这样两边行为一致、迁移过来的配置直接可用；跟 Claude Code 一样在**调用时**读
 * process.env（不是模块加载时），所以运行时改 env 也生效。
 *
 * 超时后 pi 自己会 `killProcessTree(pid)`（整棵进程树，孙进程一起清）并把
 * "Command timed out after N seconds" 连同已有输出一起返回给模型 —— 这一步不用我们管。
 * 代价（与 Claude Code 同）：合法的长命令（大 build、长跑测试）会被默认期限杀掉，
 * 模型必须自己传更大的 timeout（上限 10min），或者用 env 抬高默认值。
 *
 * **对标审计（对 v2.1.268 二进制逐项核过，别凭文档印象怀疑下面的数值）**：
 * Claude Code 的 env 白名单里只有三个 `BASH_*` 是它自己的 —— `BASH_DEFAULT_TIMEOUT_MS` /
 * `BASH_MAX_TIMEOUT_MS` / `BASH_MAX_OUTPUT_LENGTH`（其余 `BASH_ARGC` / `BASH_SOURCE` 等
 * 都是 bash 自身的内部变量）。前两个就是上面那两个，已对齐；第三个**不采**：它只
 * 控制输出回读窗口（官方原文 "on its own only sizes the read-back window"），而 pi 的
 * 截断是“保留最后 2000 行 / 50KB + 全文写临时文件”，两者机制不同且 pi 的
 * `DEFAULT_MAX_LINES` / `DEFAULT_MAX_BYTES` 是模块常量、扩展改不了。
 * 已知差异（刻意的，不要“顺手对齐”）：
 *   ① **单位**：Claude Code 的 timeout 参数是 ms，pi 是秒 —— 所以 env 读 ms、内部除 1000，
 *     工具描述也用秒（不改 pi 的参数单位，否则会跟它自己的 schema 矛盾）。
 *   ② **非法值**：Claude Code 的 `z || Xe()` 会把**负数**原样透传（负数是 truthy），
 *     我们则把 `<=0` / 非有限值一律归到默认 —— 因为 pi 的 `resolveTimeoutMs` 对 `<=0`
 *     会直接 throw，不归就会把工具调用变成硬报错。NaN 两边行为一致（都落默认）。
 *   ③ **超时语义**：pi 是 throw（tool result 带 isError=true）+ 已积累输出，
 *     Claude Code 是普通结果 + 超时注释 —— 改不了（throw 发生在 `base.execute` 内部）。
 *   ④ Claude Code 的第 2/3 层（`run_in_background` + `BashOutput`/`KillShell`（新名
 *     `TaskOutput`/`TaskStop`）+ `/bashes` + Ctrl+B，以及 `CLAUDE_CODE_AUTO_BACKGROUND_TIMEOUT_MS`
 *     到点不杀、自动转后台）**未实现**：pi 没有对应物，要做得新增三个工具 + 进程登记表。
 *   ⑤ pi 自己的硬上限 `MAX_TIMEOUT_MS = 2_147_483_647`（≈24.8 天）远高于我们 clamp 的
 *     600s，所以不会撞上 pi 的报错。
 */
const CLAUDE_CODE_DEFAULT_TIMEOUT_MS = 120_000;
const CLAUDE_CODE_MAX_TIMEOUT_MS = 600_000;

/** 读 env 里的毫秒值；非正数/非数字一律当未配置（与 Claude Code 的 `!isNaN(r)&&r>0` 一致）。 */
function readTimeoutEnvMs(name: string): number | undefined {
	const raw = process.env[name]?.trim();
	if (!raw) return undefined;
	const value = Number(raw);
	return Number.isFinite(value) && value > 0 ? value : undefined;
}

/** 默认期限（秒）。 */
function defaultTimeoutSeconds(): number {
	return (readTimeoutEnvMs("BASH_DEFAULT_TIMEOUT_MS") ?? CLAUDE_CODE_DEFAULT_TIMEOUT_MS) / 1000;
}

/** 期限上限（秒）：Claude Code 是 `Math.max(配置上限, 默认)`，抬高默认时上限跟着抬。 */
function maxTimeoutSeconds(): number {
	return Math.max(readTimeoutEnvMs("BASH_MAX_TIMEOUT_MS") ?? CLAUDE_CODE_MAX_TIMEOUT_MS, readTimeoutEnvMs("BASH_DEFAULT_TIMEOUT_MS") ?? CLAUDE_CODE_DEFAULT_TIMEOUT_MS) / 1000;
}

/**
 * 算出这次执行的**有效期限（秒）**，即 Claude Code 那句 `Math.min(z || default, max)`：
 *   - 模型没传 / 传了非法值（0、负数、NaN、字符串）→ 落到默认期限；
 *   - 传了超过上限的值 → **静默 clamp 到上限**（不报错；Claude Code 同款行为，
 *     它这个静默 clamp 是已知 issue #83824，这里照抄以保持两边一致）。
 * 顺带避开 pi 的硬报错：内置 resolveTimeoutMs 对 <=0 / 非有限值会直接 throw。
 */
function effectiveTimeoutSeconds(requested: unknown): number {
	const max = maxTimeoutSeconds();
	const requestedSeconds = typeof requested === "number" ? requested : Number(requested);
	if (!Number.isFinite(requestedSeconds) || requestedSeconds <= 0) return Math.min(defaultTimeoutSeconds(), max);
	return Math.min(requestedSeconds, max);
}

/** CJK 等全角字符按 2 列宽度计，保证截出来的行数贴近终端实际行数。 */
function charWidth(code: number): number {
	if (
		(code >= 0x1100 && code <= 0x115f) ||
		(code >= 0x2e80 && code <= 0xa4cf) ||
		(code >= 0xac00 && code <= 0xd7a3) ||
		(code >= 0xf900 && code <= 0xfaff) ||
		(code >= 0xfe30 && code <= 0xfe6f) ||
		(code >= 0xff00 && code <= 0xff60) ||
		(code >= 0xffe0 && code <= 0xffe6) ||
		code >= 0x20000
	) {
		return 2;
	}
	return 1;
}

/** token 估算：宽字符（中日韩等）≈ 1 token/字，其余 ≈ 1 token/4 字符。 */
function estimateTokens(text: string): number {
	let wide = 0;
	let narrow = 0;
	for (const ch of text) {
		if (charWidth(ch.codePointAt(0) ?? 0) === 2) wide++;
		else narrow++;
	}
	return Math.max(1, Math.ceil(wide + narrow / 4));
}

/** 1234 → "1.2k"，避免提示行里出现五位数。 */
function formatCount(n: number): string {
	if (n < 1000) return String(n);
	const k = n / 1000;
	const text = k >= 10 ? k.toFixed(0) : k.toFixed(1);
	return `${text.replace(/\.0$/, "")}k`;
}

/** grapheme 分段器（pi-tui 没导出它自己的实例，所以本地建一个；Node 内置 Intl.Segmenter）。 */
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** 一条折行碎片：`text` 是碎片本身，`start`/`end` 是它在**折行前原文**里的字符偏移。 */
interface WrappedRow {
	text: string;
	start: number;
	end: number;
}

/**
 * **break-all 硬折行**（带偏移）：按列预算逐个 grapheme 填充，装满就断 —— 类似 CSS 的
 * `word-break: break-all`，不管断点是不是单词/路径中间。除了碎片文本还记下它在原文里
 * 的 `[start, end)` 字符区间，命令高亮靠它把「先折行、后上色」接起来 —— token 偏移是
 * **源行**坐标、碎片是**折行后**坐标，没有这个区间就对不上号。
 *
 * 为什么不用 pi-tui 的 `wrapTextWithAnsi`：它是**贪心词折行 + 长词按列断开**，
 * 一个装不进当前行剩余空间的词会被**整块挑到下一行**再去断 —— 实测 79 列终端上
 * `$ cp <78 列路径>` 渲染成 `$ cp` 单独一行 + 路径从中间断成两截，行尾白白空着
 * 几十列，命令和它的参数还被拆开。硬折行则把每行填到恰好装不下为止，断点就在
 * 行末，不会提前折行。
 *
 * 按 grapheme 而不是按列硬切：emoji / 组合字符的 segment 长度 ≠ 1 个字符，
 * 按字符下标切会把它们切成两半。宽字符（CJK 等，2 列）装不进剩下的 1 列时
 * 在它**前面**断行（行尾留 1 列空白）—— 一个 grapheme 不可分。
 *
 * @param firstRowBudget 首行预算（给 timeout 后缀留位置）
 * @param restRowBudget  其余行预算
 */
function hardWrapRows(text: string, firstRowBudget: number, restRowBudget: number): WrappedRow[] {
	const rows: WrappedRow[] = [];
	let row = "";
	let rowWidth = 0;
	let rowStart = 0;
	let budget = Math.max(1, firstRowBudget);
	for (const { segment, index } of graphemeSegmenter.segment(text)) {
		const w = visibleWidth(segment);
		// rowWidth > 0 守卫：单个 grapheme 比整行预算还宽时（极窄终端）也得放下，
		// 否则会产生空行死循环
		if (rowWidth > 0 && rowWidth + w > budget) {
			rows.push({ text: row, start: rowStart, end: index });
			budget = Math.max(1, restRowBudget);
			row = segment;
			rowWidth = w;
			rowStart = index;
		} else {
			// row 为空说明这是本行第一个 grapheme，记下它的原文偏移
			if (row === "") rowStart = index;
			row += segment;
			rowWidth += w;
		}
	}
	rows.push({ text: row, start: rowStart, end: rowStart + row.length });
	return rows;
}

/* -------------------------------------------------------------------------- *
 * bash 命令语法高亮（见文件头「bash 命令语法高亮（轻量版）」一节）
 * -------------------------------------------------------------------------- */

type ShellTokenKind = "space" | "comment" | "operator" | "command" | "flag" | "string" | "path" | "variable" | "word";

/** 一个词法单元；`start`/`end` 是**源行内**的字符偏移（不含 `$ ` 前缀）。 */
interface ShellToken {
	kind: ShellTokenKind;
	start: number;
	end: number;
}

/** token → 主题色槽。`null` = 不上色（空白原样输出）。 */
const SHELL_TOKEN_COLORS: Record<ShellTokenKind, ThemeColor | null> = {
	space: null,
	comment: "syntaxComment",
	operator: "syntaxOperator",
	command: "syntaxFunction",
	flag: "syntaxKeyword",
	string: "syntaxString",
	path: "syntaxString",
	variable: "syntaxVariable",
	word: "syntaxString",
};

/** `$VAR` / `${VAR}`。 */
const SHELL_VAR_PATTERN = /\$\{?[A-Za-z_][A-Za-z0-9_]*\}?/;
/** 赋值：`NAME=`。 */
const SHELL_ASSIGN_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*=/;
/**
 * 操作符，**先长后短**按顺序取第一个匹配。重定向那条带可选的数字 fd，所以
 * `2>&1` 会被切成 `2>&`（操作符）+ `1`（词）而不是把 `2` 当成参数。
 */
const SHELL_OPERATOR_PATTERNS = [/^&&/, /^\|\|/, /^\|&/, /^;;/, /^<<-?/, /^\d*(?:>>|>&|<&|<|>)/, /^[|&;()]/];
/** 能起头的操作符字符（粗筛用，避免对每个字符都跑一遍正则 —— 长命令行下是 O(n²)）。 */
const SHELL_OPERATOR_CHARS = new Set(["|", "&", ";", "(", ")", "<", ">"]);
/** 这些操作符后面接的是新命令（`cmd1 | cmd2`），其余（重定向等）后面接的是参数。 */
const SHELL_COMMAND_NEXT_OPS = new Set(["|", "||", "&&", ";", "&", "|&", "("]);

function stripOuterQuotes(word: string): string {
	const match = /^(['"])([\s\S]*)\1$/.exec(word);
	return match ? match[2]! : word;
}

/** 纯数字后面紧跟 `<`/`>` 才是 fd 重定向（`2>`）；否则 `foo2` 里的 `2` 属于词。 */
function isFdRedirectAt(line: string, pos: number): boolean {
	let j = pos;
	while (j < line.length && line[j]! >= "0" && line[j]! <= "9") j++;
	const next = line[j];
	return next === "<" || next === ">";
}

/** 在 `pos` 处匹配一个操作符；不是操作符返回 null。 */
function matchShellOperatorAt(line: string, pos: number): string | null {
	const char = line[pos]!;
	if (!SHELL_OPERATOR_CHARS.has(char) && !(char >= "0" && char <= "9")) return null;
	const rest = line.slice(pos);
	for (const pattern of SHELL_OPERATOR_PATTERNS) {
		const match = pattern.exec(rest);
		if (match) return match[0];
	}
	return null;
}

/**
 * 词的归类。顺序有意义：赋值 > 引号串 > 选项 > `$VAR` > 路径 > 命令/参数。
 * `"--foo"` 算引号串而不是选项；`$HOME/x` 算变量而不是路径（`$` 优先）。
 */
function classifyShellWord(word: string, commandExpected: boolean): ShellTokenKind {
	const normalized = stripOuterQuotes(word);
	if (SHELL_ASSIGN_PATTERN.test(normalized)) return "variable";
	if (word.startsWith("'") || word.startsWith('"')) return "string";
	if (word.startsWith("-") && word.length > 1) return "flag";
	if (SHELL_VAR_PATTERN.test(normalized)) return "variable";
	// 含 `/` 就是路径；额外的分支覆盖裸的 `.` / `..` / `~`
	if (normalized.includes("/") || /^\.{1,2}(?:\/|$)/.test(normalized) || normalized.startsWith("~/")) return "path";
	return commandExpected ? "command" : "word";
}

/**
 * 给一条源行分词。token **连续覆盖整行**（含空白 token），所以折行碎片可以直接按
 * 偏移切片上色，不用再去猜碎片和 token 的对应关系。
 *
 * `openQuote` 是上一条源行留下的未闭合引号：多行字符串的第二行整段算 string，
 * 不会被当成一条新命令重新分词。分词**不会失败**（不像参照插件那样返回 undefined
 * 退回 highlightCode）—— 引号没闭合就一路吃到行尾并把状态传给下一条源行。
 */
function tokenizeShellLine(line: string, openQuote: string | null): { tokens: ShellToken[]; openQuote: string | null } {
	const tokens: ShellToken[] = [];
	let quote = openQuote;
	let commandExpected = true;
	let i = 0;

	while (i < line.length) {
		const char = line[i]!;

		// 跨行未闭合的引号：吃到本行的闭合引号为止，没有闭合就吃掉整行尾巴
		if (quote) {
			let j = i;
			while (j < line.length) {
				const c = line[j]!;
				if (c === "\\" && quote === '"' && j + 1 < line.length) {
					j += 2;
					continue;
				}
				if (c === quote) break;
				j++;
			}
			if (j >= line.length) {
				tokens.push({ kind: "string", start: i, end: line.length });
				i = line.length;
				continue;
			}
			tokens.push({ kind: "string", start: i, end: j + 1 });
			i = j + 1;
			quote = null;
			continue;
		}

		if (/\s/.test(char)) {
			let j = i;
			while (j < line.length && /\s/.test(line[j]!)) j++;
			tokens.push({ kind: "space", start: i, end: j });
			i = j;
			continue;
		}

		// `#` 只在**词首**才是注释（`foo#bar` 里的 `#` 是普通字符）
		if (char === "#") {
			tokens.push({ kind: "comment", start: i, end: line.length });
			i = line.length;
			continue;
		}

		const operator = matchShellOperatorAt(line, i);
		if (operator !== null) {
			tokens.push({ kind: "operator", start: i, end: i + operator.length });
			commandExpected = SHELL_COMMAND_NEXT_OPS.has(operator);
			i += operator.length;
			continue;
		}

		// 词：吃到空白 / 操作符 / 行尾为止，中途遇到引号就连引号一起吞
		let j = i;
		let wordQuote: string | null = null;
		while (j < line.length) {
			const c = line[j]!;
			if (wordQuote) {
				if (c === "\\" && wordQuote === '"' && j + 1 < line.length) {
					j += 2;
					continue;
				}
				if (c === wordQuote) wordQuote = null;
				j++;
				continue;
			}
			if (/\s/.test(c)) break;
			if (c === "'" || c === '"') {
				wordQuote = c;
				j++;
				continue;
			}
			if (SHELL_OPERATOR_CHARS.has(c)) break;
			if (c >= "0" && c <= "9" && isFdRedirectAt(line, j)) break;
			j++;
		}
		const word = line.slice(i, j);
		tokens.push({ kind: classifyShellWord(word, commandExpected), start: i, end: j });
		// 赋值前缀（`FOO=bar cmd`）后面仍然跟的是命令，其余词都把「该出命令了」清掉
		if (!SHELL_ASSIGN_PATTERN.test(stripOuterQuotes(word))) commandExpected = false;
		i = j;
		if (wordQuote) quote = wordQuote; // 引号没闭合 → 传给下一条源行
	}

	return { tokens, openQuote: quote };
}

/**
 * 给一条折行碎片上色。`prefix` 是这条源行在折行文本里的前缀（第一条源行是 `$ `，
 * 其余为空），`line` 是**不含前缀**的源行原文 —— token 偏移就是按它算的。
 * `tokens` 为 null（高亮关掉）时退回改动前的整行单色粗体 —— 连 `$ ` 也一起粗体，
 * 逐字符和改动前一致。
 */
function styleWrappedRow(row: WrappedRow, prefix: string, line: string, tokens: ShellToken[] | null, theme: any): string {
	if (!tokens) return theme.fg("toolTitle", theme.bold(row.text));
	// `$ ` 前缀不参与分词（否则裸 `$` 会被当成命令名上色），单独用正常色 `toolTitle`
	const prefixEnd = Math.min(row.end, prefix.length);
	let out = row.start < prefixEnd ? theme.fg("toolTitle", row.text.slice(0, prefixEnd - row.start)) : "";
	const from = Math.max(0, row.start - prefix.length);
	const to = Math.max(from, row.end - prefix.length);
	if (to <= from) return out;

	let cursor = from;
	for (const token of tokens) {
		if (token.end <= from) continue;
		if (token.start >= to) break;
		const start = Math.max(token.start, cursor);
		const end = Math.min(token.end, to);
		if (start >= end) continue;
		const text = line.slice(start, end);
		const color = SHELL_TOKEN_COLORS[token.kind];
		// 命令名保留粗体，当作整块的视觉锚点（改动前整行都是粗体）
		out += color === null ? text : theme.fg(color, token.kind === "command" ? theme.bold(text) : text);
		cursor = end;
	}
	// token 连续覆盖整行，所以正常走不到这里；真走到就按老样子兜底，不丢字符
	if (cursor < to) out += theme.fg("toolTitle", theme.bold(line.slice(cursor, to)));
	return out;
}

/**
 * 一条源行 → 折行碎片（带偏移）+ 该行的 token。高亮关掉时不分词，`nextQuote` 原样
 * 透传（此时引号状态没有意义）。
 */
function wrapAndTokenizeLine(
	prefix: string,
	line: string,
	firstRowBudget: number,
	restRowBudget: number,
	openQuote: string | null,
	highlight: boolean,
): { rows: WrappedRow[]; tokens: ShellToken[] | null; nextQuote: string | null } {
	const rows = hardWrapRows(prefix + line, firstRowBudget, restRowBudget);
	if (!highlight) return { rows, tokens: null, nextQuote: openQuote };
	const result = tokenizeShellLine(line, openQuote);
	return { rows, tokens: result.tokens, nextQuote: result.openQuote };
}

/** pi 的 agent 目录（`PI_CODING_AGENT_DIR` 可覆盖，否则 `~/.pi/agent`）。 */
function resolveAgentDir(): string {
	const envDir = process.env.PI_CODING_AGENT_DIR;
	return envDir ? (envDir.startsWith("~") ? join(homedir(), envDir.slice(1)) : envDir) : join(homedir(), ".pi", "agent");
}

/**
 * `app.tools.expand` 的键名文本，给自建的提示行用。
 *
 * 为什么不直接用 pi 导出的 `keyText` / `keyHint`：扩展里 `import` 到的
 * `@earendil-works/pi-coding-agent` / `pi-tui` 是 loader alias 指向的 **npm/dist 副本**，
 * 与 pi 运行时（bundle）用的是两个不同的模块实例。实测（在 `~/.pi/agent/npm` 下直接
 * `node` 跑）：`keyHint("app.tools.expand", "to expand")` **直接抛**
 * `Theme not initialized. Call initTheme() first.`（它读的是副本自己的 theme 单例，
 * 而 pi 只初始化了 bundle 那份），`keyText(...)` 则返回 `""`（副本的 keybindings
 * 表是空的）。而 renderResult 抛异常会被 pi 静默 catch 并退回 `createResultFallback()`，
 * 整个自定义渲染就没了 —— 所以这两个函数绝不能 import，只能读配置文件。
 *
 * 默认值 `ctrl+o` 就是 pi 的默认绑定（`docs/keybindings.md` 的 `app.tools.expand` 行）。
 */
function expandKeyText(): string {
	try {
		const parsed = JSON.parse(readFileSync(join(resolveAgentDir(), "keybindings.json"), "utf8"));
		const bound = parsed?.["app.tools.expand"];
		const keys = Array.isArray(bound) ? bound : [bound];
		const text = keys.filter((k: unknown): k is string => typeof k === "string" && k.trim() !== "").join("/");
		if (text) return text;
	} catch {
		// 没配置文件 / 解析失败 / 没绑这个键，都用默认值
	}
	return "ctrl+o";
}

/**
 * 归一耗时页脚门槛（毫秒）：未设置 / 空串 / 非法值（NaN、负数）一律落到默认 2000；
 * **`0` 是合法值**（永远显示，等于关掉这个优化）—— 所以不能用 `value || DEFAULT` 那种写法。
 * 与 `clampPreviewLines` 一样在扩展注册时读一次。
 */
function resolveMinTimeFooterMs(raw: string | undefined): number {
	if (raw === undefined || raw.trim() === "") return DEFAULT_MIN_TIME_FOOTER_MS;
	const value = Number(raw.trim());
	return Number.isFinite(value) && value >= 0 ? value : DEFAULT_MIN_TIME_FOOTER_MS;
}

/**
 * 把输出预览行数归一到 1-50 的整数；非法值（NaN / <=0 / 小数）一律落到默认 3。
 * 刻意用 Number 而不是 parseInt：parseInt("2.5") 会静默变成 2，而这里是归一到默认。
 */
function clampPreviewLines(value: number): number {
	if (!Number.isFinite(value) || value < 1 || value > 50 || !Number.isInteger(value)) return DEFAULT_OUTPUT_PREVIEW_LINES;
	return value;
}

/**
 * 读 shellPath / shellCommandPrefix 设置，让覆盖后的 bash 工具和内置工具行为一致
 * （内置工具由 AgentSession 用 settings 里的这两个值构造）。
 */
function readShellOptions(): BashToolOptions {
	const paths = [join(resolveAgentDir(), "settings.json"), join(process.cwd(), ".pi", "settings.json")];

	const merged: Record<string, unknown> = {};
	for (const path of paths) {
		try {
			const parsed = JSON.parse(readFileSync(path, "utf8"));
			if (parsed && typeof parsed === "object") Object.assign(merged, parsed);
		} catch {
			// 缺文件 / 解析失败都按默认值处理
		}
	}

	const options: BashToolOptions = {};
	if (typeof merged.shellPath === "string" && merged.shellPath) {
		options.shellPath = merged.shellPath.startsWith("~") ? join(homedir(), merged.shellPath.slice(1)) : merged.shellPath;
	}
	if (typeof merged.shellCommandPrefix === "string") {
		options.commandPrefix = merged.shellCommandPrefix;
	}
	return options;
}

/**
 * 剥掉组件渲染结果的前导空行。
 *
 * 内置 bash 的 renderResult 会在输出前插一个前导空行（`new Text("\n" + styledOutput)`），
 * 在默认 shell 下那是“命令与输出之间的一行间距”；但本扩展走 self 模式，命令与输出是
 * 两个独立的块，这一行会叠上两个 Box 各自的 paddingY，变成三行空白（实测）。
 * 先判 ANSI 再 trim：行里可能带前景色转义序列，直接 trim() 不会为空。
 * 只剥**前导**空行：输出与 "Took" 之间那个空行（也是 `\n` 前缀）刻意保留，
 * 用来分隔正文与耗时页脚。
 */
function stripLeadingBlanks(inner: any) {
	return {
		render(width: number): string[] {
			const lines: string[] = inner.render(width);
			let i = 0;
			while (i < lines.length && lines[i].replace(/\x1b\[[0-9;]*m/g, "").trim() === "") i++;
			return i > 0 ? lines.slice(i) : lines;
		},
		invalidate() {
			inner.invalidate?.();
		},
	};
}

/**
 * 给染色块补一行**下边界**空行（染底色的空行，见文件头「染色块的上下边界空行」）。
 * 空行是作为子组件的行加进去的，所以会走 Box.applyBg —— 补满到 width 再上色，
 * 与 paddingY 画出来的边界行完全同色同宽。
 */
function withBottomBlank(inner: any) {
	return {
		render(width: number): string[] {
			return [...inner.render(width), ""];
		},
		invalidate() {
			inner.invalidate?.();
		},
	};
}

/**
 * 树形 gutter 占的列数（`│ ` / `└ ` = 1 个制表符（box-drawing 竖线 / 拐角，不是 TAB）+ 1 个空格）。
 * 输出子组件必须按 `width - GUTTER_WIDTH` 渲染，否则加上前缀就超宽。
 */
const GUTTER_WIDTH = 2;

/**
 * 给输出行画**树形 gutter**：除末行外每行前面挂 `│ `，末行挂 `└ `（对齐 codex
 * 的 bash 输出样式），让输出与命令行之间的层次关系一眼可辨。
 *
 * 三个不能想当然的点：
 *   ① **前导空行不上前缀**：那是命令与输出之间的分隔行，外层
 *     `stripLeadingBlanks` 还要靠「这一行是空的」把它剥掉 —— 一旦挂上前缀
 *     就变成非空行，剥不掉了（行里还可能带前景色转义序列，所以判空必须先剔
 *     ANSI 再 trim，跟 `stripLeadingBlanks` 的判法一致）。
 *   ② `└` 挂在**最后一个非空行**上而不是数组末行：pi 的输出是 `.trim()` 过的，
 *     正常不会有尾部空行，但万一有，`└ ` 挂在空行上会变成一行只有拐角符。
 *     尾部空行照旧挂 `│ `，竖线保持连续。
 *   ③ 输出**内部的空行也要挂 `│`**（只跳前导那一段），否则竖线断在半路，
 *     看上去不像一棵树。
 * 全是空行时直接原样返回（没内容可挂）。
 */
function prefixTreeLines(lines: string[], theme: any, gutter: boolean): string[] {
	if (!gutter || lines.length === 0) return lines;
	const isBlank = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "").trim() === "";
	let start = 0;
	while (start < lines.length && isBlank(lines[start])) start++;
	if (start >= lines.length) return lines;
	let last = lines.length - 1;
	while (last > start && isBlank(lines[last])) last--;
	return lines.map((line, i) => (i < start ? line : theme.fg("muted", i === last ? "└ " : "│ ") + line));
}

/**
 * 耗时页脚的**纯文本形态**：`Took 0.1s`（执行完）/ `Elapsed 1.2s`（流式执行中，每秒跳）。
 * 小数位数由 pi 的 `formatDuration` 决定（`(ms / 1000).toFixed(1)`，恒为一位）。
 */
const TIME_FOOTER_PATTERN = /^(?:Took|Elapsed) \d+\.\d+s$/;

/** 去掉 SGR 转义序列（页脚那行是 `theme.fg("muted", …)` 包着的，判形态 / 判空都得先剥）。 */
function stripAnsiCodes(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

/**
 * 这个 child 是不是 pi 画的**耗时页脚**（`new Text("\n" + theme.fg("muted", "Took 0.1s"), 0, 0)`）。
 *
 * 两条缺一不可：
 *   ① `setText` 存在 = 是 pi-tui 的 `Text` —— 不能用 `instanceof`，理由与预览组件那条鸭子
 *      判定完全相同（扩展 import 到的 pi-tui 是 loader alias 指向的 npm/dist 副本，与 pi
 *      运行时 bundle 里的 `Text` 不是同一个类对象，`instanceof` 跨实例必然 false）；
 *   ② 剥 ANSI、trim 之后正好是 `Took 0.1s` / `Elapsed 1.2s` 这个形态。
 * 位置条件（**必须是末位 child**）由 `shouldHideTimeFooter` 带着判：pi 的
 * `rebuildBashResultRenderComponent` 按「输出 → warnings → 页脚」的顺序 addChild，
 * 所以页脚恒为末位。两条一起才敢下结论说末位那个就是页脚 —— 只看末位会把「输出正文恰好
 * 是一行 `Took 1.2s`」删掉（展开态下正文就是一个 `Text`），只看形态则会把碰巧长得像的
 * 末位子组件删掉。
 */
function isTimeFooterChild(child: any): boolean {
	if (typeof child?.setText !== "function" || typeof child.text !== "string") return false;
	return TIME_FOOTER_PATTERN.test(stripAnsiCodes(child.text).trim());
}

/**
 * 该不该把耗时页脚整个丢掉：**短于门槛的执行不画那一行**（默认 2000ms，见
 * `DEFAULT_MIN_TIME_FOOTER_MS`）。
 *
 * `elapsedMs === undefined` 表示压根不知道耗时（`state.startedAt` 为空 —— `/resume` 恢复的
 * 历史块不调 `markExecutionStarted`）—— 那种情况下 pi 本来就没有页脚可画，所以一律返回
 * false、不动手：即展开态里「输出正文恰好是一行 `Took 1.2s`」不会被误删。
 * 门槛与耗时比的是**同一个量**（`endedAt - startedAt`，见 renderResult 里的 `elapsedMs`），
 * 不是页脚上那个四舍五入后的数字。
 */
function shouldHideTimeFooter(lastChild: any, elapsedMs: number | undefined, minTimeFooterMs: number): boolean {
	if (elapsedMs === undefined || elapsedMs >= minTimeFooterMs) return false;
	return isTimeFooterChild(lastChild);
}

/**
 * 把 pi 内置 bash 渲染器的**输出预览**从 5 行裁到 `previewLines` 行，给输出
 * 挂上树形 gutter（`gutter` 为 true 时），并在短命令上丢掉耗时页脚。
 *
 * pi 的行数写死在它的 `BASH_PREVIEW_LINES = 5`（模块私有常量，改不了，也没有
 * 设置项），所以只能在拿到它的组件之后做后处理。详见文件头「输出预览行数」一节。
 *
 * 做法：**逐个 child 渲染**而不是拿整个 Container 的平铺行数组 —— 平铺数组里分不清
 * 哪几行属于预览（预览行、warnings 行、Took 行都是纯文本 + 不同前景色，按颜色猜很
 * 脆弱）。child 结构实测过：输出非空时 `children[0]` 就是预览组件，行形状固定是
 * `["", (提示行?), ...预览行]`；后面的 warnings / `Took Xs` 都是 `Text` 实例
 *（各自的 `\n` 前缀渲染成一行空行 + 正文）。
 *
 * 预览组件的判定用**鸭子类型**（`typeof child.setText !== "function"`）而不是
 * `instanceof Text`：扩展 import 到的 pi-tui 是 loader alias 指向的 npm/dist 副本，
 * 与 pi 运行时（bundle）用的 Text 不是同一个类对象，`instanceof` 跨模块实例必然 false。
 *
 * **展开态（ctrl+o）自动不受影响**：那时 pi 用的是 `new Text("\n" + styledOutput)`
 * 而不是预览组件，所以鸭子判定直接跳过它，完整输出一行不裁、**也不挂 gutter**
 * （展开态要的就是原样输出）—— 正是想要的。
 *
 * 耗时页脚的过滤（`shouldHideTimeFooter`）也在这里：末位 child 是 `Took X.Xs` 页脚、
 * 且实际耗时短于门槛时，把它整个跳过（连它那行前导空行一起 —— 那是正文与页脚之间的
 * 分隔行，页脚不画时不该留）。详见文件头「耗时页脚门槛」一节。
 */
function withPreviewLimit(inner: any, previewLines: number, theme: any, gutter: boolean, elapsedMs: () => number | undefined, minTimeFooterMs: number) {
	return {
		render(width: number): string[] {
			const out: string[] = [];
			let trimmed = false;
			// gutter 占 2 列，所以**输出子组件必须按 width - 2 渲染**：pi 的预览行是按
			// 传进去的宽度折行 / 截断的（`truncateToVisualLines` 内部用 `Text.render(width)`），
			// 按整宽渲染再加前缀就会超出终端宽度。其余子组件（warnings / Took）不上
			// 前缀，照旧按整宽渲染。
			const contentWidth = gutter ? Math.max(1, width - GUTTER_WIDTH) : width;
			// 耗时页脚的判定放在 render 里而不是拿组件时就算死：流式模式下 pi 每秒
			// `invalidate()` 一次（内置 renderResult 里那个 setInterval），跨过门槛的
			// 那一刻页脚就能出现，不用等下一次 partial 结果。
			let children: any[] = inner.children ?? [];
			if (shouldHideTimeFooter(children[children.length - 1], elapsedMs(), minTimeFooterMs)) {
				children = children.slice(0, -1);
			}
			for (const child of children) {
				const isOutput = !trimmed && typeof child.setText !== "function";
				const lines: string[] = child.render(isOutput ? contentWidth : width);
				if (!isOutput) {
					out.push(...lines);
					continue;
				}
				trimmed = true;
				out.push(...prefixTreeLines(trimPreviewLines(lines, previewLines, contentWidth, theme), theme, gutter));
			}
			return out;
		},
		invalidate() {
			inner.invalidate?.();
		},
	};
}

/**
 * 裁掉预览行里超出预算的部分（保留**尾部** —— pi 的预览本来就是输出的最后几行），
 * 并把被裁掉的行数补进提示行的计数。
 *
 * 提示行的两种情况：
 *   ① pi 已经给了提示行（输出 > 5 行）—— 就在它那一行**原地改数字**，
 *     这样 pi 的配色与真实键名（`keyHint` 渲出来的 dim 键名 + muted 描述）一字不动，
 *     不用重建样式。正则匹配的是 SGR 包裹里的纯 ASCII 数字与文本，所以直接在
 *     带样式的字符串上替换是安全的。
 *   ② pi 没给提示行（输出刚好 ≤ 5 行，但我们裁到了 3 行）—— 必须自己造一行，
 *     否则那 1~2 行就**静默消失**了。用传进来的 `theme`（pi 运行时真正初始化过的那份）
 *     复刻 pi 的格式与配色，键名读 `keybindings.json`（见 `expandKeyText`）。
 */
function trimPreviewLines(lines: string[], previewLines: number, width: number, theme: any): string[] {
	if (lines.length <= 1) return lines;
	const head = lines[0]; // 前导空行（去留由外层 stripLeadingBlanks 决定）
	let rest = lines.slice(1);
	let hintLine: string | undefined;
	const firstPlain = (rest[0] ?? "").replace(/\x1b\[[0-9;]*m/g, "");
	if (firstPlain.startsWith("... (") && firstPlain.includes("earlier lines")) {
		hintLine = rest[0];
		rest = rest.slice(1);
	}
	if (rest.length <= previewLines) return lines;
	const dropped = rest.length - previewLines;
	const kept = rest.slice(dropped);
	const hint = hintLine
		? hintLine.replace(/(\(\s*)(\d+)(\s*earlier lines)/, (_m, open, count, tail) => `${open}${Number(count) + dropped}${tail}`)
		: truncateToWidth(
				theme.fg("muted", `... (${dropped} earlier lines,`) + " " + theme.fg("dim", expandKeyText()) + theme.fg("muted", " to expand") + theme.fg("muted", ")"),
				width,
				"...",
			);
	return [head, hint, ...kept];
}

/**
 * 按执行状态选整块底色，与 tool-execution.js `updateDisplay()` 里的 bgFn 一致
 * （pending / error / success）。默认 shell 下这个 bgFn 由 pi 套在整个 contentBox 上；
 * 切到 `renderShell: "self"` 后 pi 不再套（selfRenderContainer 是个纯 Container），
 * 所以得自己用 Box + theme.bg 把底色块画回来，否则 bash 输出会失去现在的背景块。
 */
function stateBgFn(theme: any, isPartial: boolean, isError: boolean) {
	if (isPartial) return (text: string) => theme.bg("toolPendingBg", text);
	if (isError) return (text: string) => theme.bg("toolErrorBg", text);
	return (text: string) => theme.bg("toolSuccessBg", text);
}

/**
 * 在**同步窗口**内把主题的 `toolOutput` 临时换成 `bashOutput`，让 pi 内置 bash 结果渲染器
 * 画出来的输出正文用上自己的颜色槽（详见文件头「输出正文的独立颜色」一节）。
 *
 * 为什么必须是「换主题表」而不是「把主题对象换给渲染器」：pi 的 bash 渲染器**根本不看传进去
 * 的那个 theme 参数**（`renderResult(result, options, _theme, context)`），它用的是模块级的
 * `theme` 单例（`Proxy` → `globalThis[Symbol.for("@earendil-works/pi-coding-agent:theme")]`）。
 * 那个单例与传给扩展的渲染器参数**是同一个对象**（单例就是为跨 loader 共用而设计的），
 * 所以直接改它的 `fgColors` 表，渲染器下一次 `theme.fg("toolOutput", line)` 就会命中新色值。
 *
 * 四个要点：
 *   ① **只在同步窗口内换**：`base.renderResult()` 是同步的，输出行（含展开态那份）全部在
 *      这次调用里 `theme.fg("toolOutput", …)` 烘焙成字符串，所以 try/finally 里换进换出
 *      不会有第二个渲染插进来；换颜色也**不会**泄漏给其他工具（read / grep 的输出是它们
 *      自己的渲染器画的，不在这个窗口里）。
 *   ② **主题里没有 `bashOutput` 就什么都不做**（内置主题与 pi-coder-summer-night / pi-coder-catppuccin 都没
 *      这个 token）—— 探测方式是真调一次 `theme.getFgAnsi()`，pi 对未知 token 抛
 *      `Unknown theme color: …`。
 *   ③ `fgColors` 是 pi `Theme` 类的公开字段（`Map<string, string>`，存的是**已解析的
 *      SGR 前缀**）；哪天 pi 把它藏起来/改名，这里就自动退化成原样调用（返回前那个
 *      `typeof … .set` 判定），不会抛异常、只是颜色不生效。
 *   ④ 只动 `toolOutput`：命令标题 / `... (N earlier lines …)` 提示 / `Took Xs` 页脚走的是
 *      `toolTitle` / `muted`，命令行与折叠提示是扩展自绘的，一律不受影响。
 */
function withBashOutputColor<T>(theme: any, render: () => T): T {
	const fgColors = theme?.fgColors;
	if (typeof fgColors?.set !== "function" || typeof fgColors?.get !== "function") return render();
	let override: string;
	try {
		override = theme.getFgAnsi("bashOutput");
	} catch {
		return render();
	}
	const previous = fgColors.get("toolOutput");
	fgColors.set("toolOutput", override);
	try {
		return render();
	} finally {
		if (previous === undefined) fgColors.delete("toolOutput");
		else fgColors.set("toolOutput", previous);
	}
}

export default function (pi: ExtensionAPI) {
	// 折叠固定开启、保留 DEFAULT_LINES 个视觉行（原先的 `/bash-collapse` 指令已删除）。
	// 输出预览行数：pi 内置写死 5（`BASH_PREVIEW_LINES`，模块私有常量 + 无设置项），
	// 所以只能在扩展里后处理。/bash-preview 可改；PI_BASH_PREVIEW 启动时覆盖。
	let previewLines = clampPreviewLines(Number(process.env.PI_BASH_PREVIEW));
	// 输出树形 gutter（`│ ` / `└ `）：默认开（对齐 codex）。PI_BASH_TREE=off 启动时关闭。
	// 与 previewLines 相互独立：`/bash-preview off` 恢复 pi 的 5 行预览后 gutter 照旧生效。
	const treeEnabled = process.env.PI_BASH_TREE?.trim().toLowerCase() !== "off";
	// 流式输出开关：默认关（非流式，对齐 opencode / codex）。PI_BASH_STREAM=on 恢复 pi 原生流式。
	const streaming = process.env.PI_BASH_STREAM?.trim().toLowerCase() === "on";
	// 耗时页脚门槛（毫秒）：短于它的执行不画 `Took X.Xs` 那一行（详见文件头「耗时页脚门槛」）。
	// PI_BASH_MIN_TIME_MS=0 永远显示。与 previewLines / treeEnabled 一样在注册时读一次。
	const minTimeFooterMs = resolveMinTimeFooterMs(process.env.PI_BASH_MIN_TIME_MS);
	// 命令语法高亮开关：默认开。PI_BASH_HIGHLIGHT=off 启动时关闭（回到整行 toolTitle 粗体）。
	// 刻意**不注册 /bash-highlight 指令** —— 这是个纯观感开关，env 一个入口就够，
	// 没必要再占一条斜杠指令（与 /bash-preview / /bash-timeout 那种要随时查看的不同）。
	// 展开态（ctrl+o）与折叠态走同一套分词，所以开关对两边同时生效。
	const highlightEnabled = process.env.PI_BASH_HIGHLIGHT?.trim().toLowerCase() !== "off";

	// cwd 只是兜底：内置 execute 用的是 ctx.cwd（每次调用的当前 session cwd）。
	const base: ToolDefinition<any, any, any> = createBashToolDefinition(process.cwd(), readShellOptions());

	pi.registerTool({
		name: base.name,
		label: base.label,
		// 照抄 Claude Code：把默认期限和上限**写进工具描述**告诉模型，否则模型不知道
		// 可以传 timeout，长命令就会被默认期限杀掉却不知道该调大。
		// （内置描述结尾本来只是 "Optionally provide a timeout in seconds."，没给数字。）
		description: `${base.description} By default, your command will time out after ${defaultTimeoutSeconds()} seconds. You may specify an optional timeout in seconds (up to ${maxTimeoutSeconds()} seconds); larger values are clamped to that maximum.`,
		parameters: base.parameters,
		// prompt 元数据不会从内置工具继承，必须显式带上
		promptSnippet: base.promptSnippet,
		promptGuidelines: base.promptGuidelines,
		constrainedSampling: base.constrainedSampling,
		executionMode: base.executionMode,
		prepareArguments: base.prepareArguments,
		// `renderShell: "self"` 是为了让“流式接命令字符时屏幕上一行都不出”成为可能。
		// 默认 shell 下 ToolExecutionComponent 构造里常驻一个 `Spacer(1)`，而 render() 走
		// `super.render(width)`（Container）会把所有子组件都画出来 —— 所以即使 renderCall
		// 返回零行组件，仍会渲染出那一行空行（实测 `[""]`）。而 `hideComponent` 那条路
		// 走不到：updateDisplay() 里只要 callRenderer 成功返回组件就把 `hasContent` 置 true，
		// 三个分支全都置 true，所以末尾 `if (… && !hasContent …) hideComponent = true` 永远不成立。
		// self 模式下 render() 绕过 super.render()，只画 selfRenderContainer，于是那个 Spacer
		// 根本不会被渲染；且开头有 `contentLines.length === 0 → return []` 守卫，
		// 真正做到“空就什么都不出”。代价是 pi 不再给整块套 bgFn，所以 renderCall /
		// renderResult 两边都自己包一层 Box 把底色块画回来（见 stateBgFn）。
		renderShell: "self",
		// renderResult 委托内置 bash 的实现（输出预览 / 截断提示 / "Took Xs" 都是它画的），
		// 只在外层包一个 Box 把底色块补回来，页脚那行则在 withPreviewLimit 里按门槛滤掉。
		// 注意传给内置的 `lastComponent` 必须是
		// **内层**组件而不是我们的 Box —— 内置实现会 `context.lastComponent ?? new
		// BashResultRenderComponent()` 然后对它 clear() / addChild()，喂个 Box 进去会嵌套错乱。
		// 所以内层组件存在 context.state 里跨次复用（state 本来就用来存 startedAt/endedAt/interval）。
		renderResult(result, options, theme, context) {
			const state = context.state;
			// renderCall 靠这个标记决定要不要自己补下边界空行（结果还没到时才补）。
			// 放在委托内置实现**之前**置位：万一内置实现抛异常，pi 会退回自己的
			// fallback 结果组件，那时下边界已经由它那边负责了。
			state.resultSeen = true;
			// 输出正文换用主题的 `bashOutput` 槽（主题没定义就原样；详见 withBashOutputColor）
			const inner = withBashOutputColor(theme, () =>
				base.renderResult(result, options, theme, { ...context, lastComponent: state.innerComponent }),
			);
			state.innerComponent = inner;
			// isError 必须从 **context** 读，不能从 result 读：pi 调 resultRenderer 时传的是
			// `{ content: this.result.content, details: this.result.details }`，**没有 isError 字段**
			// （tool-execution.js 的 updateDisplay），isError 只在 getRenderContext() 里
			// （`isError: this.result?.isError ?? false`）。读 result.isError 会永远拿到 undefined，
			// 于是失败的命令也会染成 success 底色。
			//
			// paddingY 必须用 0，且要剥掉 inner 的前导空行 —— 否则命令与输出之间会有
			// **三个**空行（实测过）：① callBox 的下 padding、② resultBox 的上 padding、
			// ③ 内置 renderResult 自己的 `new Text("\n" + styledOutput)` 前导空行。
			// 第③行在默认 shell 下是“命令与输出之间的一行间距”（那时两者在同一个
			// contentBox 里，只有这一行），但 self 模式下两者是两个独立的 Box，
			// 各自的 paddingY 会叠加上去，所以这里把三者全部去掉，让输出紧贴命令。
			// 整块的**下边界**空行则由 withBottomBlank 补回来（只补最外侧那一行，
			// 不会落到命令与输出之间）。
			// 耗时页脚门槛判据（见文件头「耗时页脚门槛」）：与 pi 画那行字用的是**同一个量**
			// —— `state.endedAt ?? Date.now()` 减 `state.startedAt`（内置 renderResult 刚在上面
			// 那次调用里补上了 endedAt）。做成**函数**、在 render 时才求值：流式模式下每秒
			// invalidate 一次，跨过门槛的那一刻页脚自然出现，不用等下一次 partial 结果。
			// startedAt 为空 = pi 根本没画页脚（`/resume` 恢复的历史块不调 markExecutionStarted），
			// 这时返回 undefined，过滤逻辑一律不动手。
			const elapsedMs = () => (state.startedAt === undefined ? undefined : (state.endedAt ?? Date.now()) - state.startedAt);
			const box = new Box(1, 0, stateBgFn(theme, options.isPartial, context.isError === true));
			box.addChild(
				withBottomBlank(
					stripLeadingBlanks(withPreviewLimit(inner, Math.max(1, Math.round(previewLines)), theme, treeEnabled, elapsedMs, minTimeFooterMs)),
				),
			);
			return box;
		},

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			// 关流式就是把 onUpdate 摘掉：内置 execute 的每个更新点都有 !onUpdate 守卫，
			// 于是渲染器只会收到最后那次 final 结果。返回值与 details 不受影响。
			//
			// 同时把**有效期限**注进 params：pi 内置 bash 无默认 timeout，不注入的话
			// 一条不退出的命令会无限期挂着。注入只影响这次执行 —— session 里落盘的
			// toolCall.arguments 是模型原样发来的那份，不会被改写。
			const nextParams = { ...params, timeout: effectiveTimeoutSeconds(params?.timeout) };
			return base.execute(toolCallId, nextParams, signal, streaming ? onUpdate : undefined, ctx);
		},

		renderCall(args, theme, context) {
			// 内置 renderCall 靠这里记时（"Took 1.2s"），覆盖后需要自己维护
			const state = context.state;
			if (context.executionStarted && state.startedAt === undefined) {
				state.startedAt = Date.now();
				state.endedAt = undefined;
			}

			// 非流式模式下管住**命令文本的逐字刷新**，但要分两个时间点（对齐 codex / opencode）：
			//   时间点一：命令字符全收完（argsComplete）→ 一次性把完整命令打到屏幕上；
			//   时间点二：命令执行完 → 结果由 renderResult 补刷到命令下面。
			// 两个点必须分开：用 isPartial 做阈值会把命令也压到结果之后才出，变成
			// 「全等到结果才一次性出」，那不是想要的效果。
			//
			// 为什么命令会逐字刷：模型生成 tool call 时参数是流式的（toolcall_delta 一片
			// 一片到），pi 每收一片就 updateArgs() → updateDisplay() → 重画一次 renderCall。
			// 所以收完前返回**零行组件**（连占位行都不画），argsComplete 后才出完整命令。
			// 实测这段时间占大头：`echo hello` 从 toolcall_start 到 tool_execution_end 约 290ms，
			// 其中 args 流式 197ms、toolcall_end→execution_start 63ms、命令执行只 31ms。
			//
			// argsComplete 在 assistant message_end 时置位（setArgsComplete），比
			// tool_execution_start 早 ~60ms，正好是“命令收完”这个语义点。
			// 返回零行组件是安全的：Box.render 开头有 `childLines.length === 0 → []` 守卫
			// （paddingY 是在这之后才加的），所以不会画出空的带底色块。
			// （updateDisplay 每次都传全新的 context，getRenderContext 现拼对象，
			// 所以 argsComplete 读得到实时值。）
			//
			// **但 argsComplete 只在实时流里置位**，所以判定条件是「args 可能还在流」
			// 而不是「args 还没收完」：pi 的 interactive-mode.js 只在 `message_end` 分支调
			// `component.setArgsComplete()`，而 `/resume`（以及 renderInitialMessages /
			// compaction_end / rebuildChatFromMessages）走的 `renderSessionItems` 重建历史时
			// 只 `new ToolExecutionComponent(...)` + `component.updateResult(message)`，
			// **从不调 setArgsComplete / markExecutionStarted** —— 历史块的 argsComplete
			// 永远是 false。若只按 argsComplete 判定，恢复出来的 bash 块就只剩输出、
			// 命令行整行消失（实测过：RESTORE 渲染出 ["", " hello"]，LIVE 渲染出
			// ["", " $ echo hello", " hello", "", " Took 0.0s"]）。
			// isPartial 正好补上这个缺口：构造时默认 true，只有 updateResult(result, false)
			// 会置 false —— 实时流里那必然发生在 argsComplete 之后（tool_execution_end），
			// 历史重建里则发生在第一次渲染之后。两种路径都能出命令，而流式阶段
			// （isPartial 仍为 true）照旧一行都不画。
			// 副作用（可接受）：实时流里按 Esc 中断一个还没收完参数的 tool call 时，
			// message_end(aborted) 会 updateResult(isPartial=false) 而不置 argsComplete，
			// 于是命令行会显示出来（args 不全时是 `$ ...` 占位）—— 能看到被中断的是
			// 什么命令，比只显示一行报错更有用。
			if (!streaming && !context.argsComplete && context.isPartial === true) {
				return {
					render(): string[] {
						return [];
					},
					invalidate() {},
				};
			}

			const rawCommand = args?.command;
			const invalid = rawCommand !== undefined && rawCommand !== null && typeof rawCommand !== "string";
			const command = typeof rawCommand === "string" ? rawCommand : "";
			const timeout = args?.timeout;

			const commandDisplay = invalid ? theme.fg("error", "[invalid arg]") : command ? command : theme.fg("toolOutput", "...");
			const timeoutSuffix = timeout ? theme.fg("muted", ` (timeout ${timeout}s)`) : "";
			const styledFull = theme.fg("toolTitle", theme.bold(`$ ${commandDisplay}`)) + timeoutSuffix;

			// 缓存放在组件闭包里而不是 state：流式阶段 args 会不断变长，
			// 而 state 是整行共享的，按 width 缓存会返回旧命令的行。
			let cachedWidth: number | undefined;
			let cachedExpanded: boolean | undefined;
			let cachedResultSeen: boolean | undefined;
			let cachedLines: string[] | undefined;

			const component = {
				render(width: number): string[] {
					const wrapWidth = Math.max(20, width || 80);
					const limit = DEFAULT_LINES;
					// 缓存键要带上 expanded / resultSeen，否则 ctrl+o 切换或结果到达后已渲染的行不会刷新
					const resultSeen = state.resultSeen === true;
					if (
						cachedLines &&
						cachedWidth === wrapWidth &&
						cachedExpanded === context.expanded &&
						cachedResultSeen === resultSeen
					)
						return cachedLines;

					let result: string[];
					// invalid（args.command 不是字符串）/ 空命令走 pi-tui 折行分支：这两种文本固定是
					// `$ [invalid arg]` / `$ ...`，短到根本不会折行，而那个分支能原样保留
					// 嵌套样式（error 色 / toolOutput 色），不用在硬折分支里重建
					if (!context.expanded && !invalid) {
						// 折叠态：**break-all 硬折行** + 视觉行数预算（`limit`，默认 3 行）。
						// 详见文件头「折叠视图：break-all 硬折行」一节。
						// 先折**纯文本**再逐行上样式：反过来会把 SGR 序列从中间切断。
						const commandLines = (command || "...").split("\n");
						const suffixWidth = visibleWidth(timeoutSuffix);
						// 首行（且仅首行）要给 timeout 后缀留位置，否则长命令会把后缀挤掉
						const firstRowBudget = suffixWidth > 0 ? Math.max(4, wrapWidth - suffixWidth) : wrapWidth;
						const shown: string[] = [];
						const hiddenParts: string[] = [];
						let budgetExhausted = false;
						// 引号状态跨源行保留（多行字符串的第二行不会被当成新命令分词）
						let openQuote: string | null = null;
						for (let i = 0; i < commandLines.length && !budgetExhausted; i++) {
							const line = commandLines[i]!;
							const prefix = i === 0 ? "$ " : "";
							const { rows, tokens, nextQuote } = wrapAndTokenizeLine(prefix, line, i === 0 ? firstRowBudget : wrapWidth, wrapWidth, openQuote, highlightEnabled);
							openQuote = nextQuote;
							for (let r = 0; r < rows.length; r++) {
								if (shown.length >= limit) {
									// 预算用完：本源行剩下的碎片（拼回去就是它的尾巴）
									// + 后续源行全部隐藏。硬折行不丢字符，所以碎片直接
									// join("") 就是原文尾巴（不用像旧代码那样用
									// startsWith 反推截断点）。用的是**纯文本**碎片，所以
									// token 估算不会把 SGR 序列算进去。
									hiddenParts.push(rows.slice(r).map((piece) => piece.text).join(""));
									for (let j = i + 1; j < commandLines.length; j++) hiddenParts.push(commandLines[j]!);
									budgetExhausted = true;
									break;
								}
								shown.push(styleWrappedRow(rows[r]!, prefix, line, tokens, theme) + (i === 0 && r === 0 ? timeoutSuffix : ""));
							}
						}
						result = shown;
						// 只要有任何内容被折掉或被折叠就出提示：一行长命令硬折后可能
						// 刚好装满预算（行数 == limit），靠「行数 > limit」判定会漏
						const hidden = hiddenParts.join("\n");
						if (hidden.trim() !== "") {
							const hint = theme.fg("muted", `… (${formatCount(estimateTokens(hidden))} tokens hidden)`);
							result = [...shown, truncateToWidth(hint, wrapWidth, "…")];
						}
					} else if (invalid || !command) {
						// invalid（args.command 不是字符串）/ 空命令：文本固定是 `$ [invalid arg]`
						// / `$ ...`，短到根本不会折行，而折行分支能原样保留嵌套样式
						//（error 色 / toolOutput 色），不用在硬折分支里重建
						result = wrapTextWithAnsi(styledFull, wrapWidth);
					} else {
						// 展开态（ctrl+o）/ 关闭折叠：要的就是完整命令，**同样用 break-all
						// 硬折行** —— 贪心词折行在这里一样会把长路径整块挪到下一行
						// 再从中间断开（就是用户看到的 `$ ` 后面直接折行），展开态只是
						// 不限行数，折行规则必须一致。
						const commandLines = command.split("\n");
						const suffixWidth = visibleWidth(timeoutSuffix);
						const firstRowBudget = suffixWidth > 0 ? Math.max(4, wrapWidth - suffixWidth) : wrapWidth;
						const rows: string[] = [];
						let openQuote: string | null = null;
						for (let i = 0; i < commandLines.length; i++) {
							const line = commandLines[i]!;
							const prefix = i === 0 ? "$ " : "";
							const { rows: pieces, tokens, nextQuote } = wrapAndTokenizeLine(prefix, line, i === 0 ? firstRowBudget : wrapWidth, wrapWidth, openQuote, highlightEnabled);
							openQuote = nextQuote;
							for (const piece of pieces) rows.push(styleWrappedRow(piece, prefix, line, tokens, theme));
						}
						result = rows.map((row, idx) => row + (idx === 0 ? timeoutSuffix : ""));
					}

					// 染色块的上下边界空行（见文件头「染色块的上下边界空行」）：
					// 上边界永远补；下边界只在结果还没到时补 —— 结果到了之后紧接着就是
					// resultBox，那时补会在命令与输出之间多出一行空白。
					// 判定用 state.resultSeen（renderResult 置位），不用 isPartial：
					// 流式模式下 partial 结果也会调 renderResult，isPartial 仍是 true，
					// 用它会在命令与输出之间留下空白。
					result = ["", ...result, ...(resultSeen ? [] : [""])];

					cachedWidth = wrapWidth;
					cachedExpanded = context.expanded;
					cachedResultSeen = resultSeen;
					cachedLines = result;
					return result;
				},
				invalidate() {
					cachedWidth = undefined;
					cachedExpanded = undefined;
					cachedResultSeen = undefined;
					cachedLines = undefined;
				},
			};

			// self 模式下 pi 不给整块套底色，自己包一层 Box 保持原有的背景块观感。
			// paddingY 用 0：命令与结果是两个独立的 Box，各自的垂直 padding 会叠加成
			// 命令与输出之间的多余空行（详见 renderResult 里那条注释）。
			const box = new Box(1, 0, stateBgFn(theme, context.isPartial === true, context.isError === true));
			box.addChild(component);
			return box;
		},
	});

	pi.registerCommand("bash-preview", {
		description: "bash 输出预览行数：off（pi 内置 5 行）| <行数 1-50>",
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();

			if (arg === "off") {
				previewLines = 5; // pi 的 BASH_PREVIEW_LINES，等于不裁
				ctx.ui.notify("bash 输出预览已恢复 pi 内置的 5 行", "info");
				return;
			}

			if (arg === "") {
				ctx.ui.notify(`当前输出预览：前 ${previewLines} 行（pi 内置是 5 行，超出部分带 earlier lines 提示）`, "info");
				return;
			}

			// 用 Number 而不是 parseInt：parseInt("2.5") 会静默变成 2（与
			// clampPreviewLines 的归一策略一致，小数应当被拒而不是静默截断）
			const parsed = Number(arg);
			const next = clampPreviewLines(parsed);
			if (next !== parsed) {
				ctx.ui.notify("用法：/bash-preview off | <行数 1-50 的整数>", "warning");
				return;
			}

			previewLines = next;
			ctx.ui.notify(`bash 输出预览已改为前 ${previewLines} 行`, "info");
		},
	});

	// 只读查看当前生效的期限：默认值、上限、以及 env 有没有覆盖。
	// 值在 execute 里每次调用时重算，所以这里显示的永远是下一次执行的真实期限。
	pi.registerCommand("bash-timeout", {
		description: "查看 bash 执行期限（默认 / 上限 / env 覆盖）",
		handler: async (_args, ctx) => {
			const override = (name: string) => {
				const value = readTimeoutEnvMs(name);
				return value === undefined ? "未设置" : `${name}=${value}ms`;
			};
			ctx.ui.notify(
				`默认 ${defaultTimeoutSeconds()}s，上限 ${maxTimeoutSeconds()}s；env：${override("BASH_DEFAULT_TIMEOUT_MS")} / ${override("BASH_MAX_TIMEOUT_MS")}（改完需重启 pi）`,
				"info",
			);
		},
	});
}
