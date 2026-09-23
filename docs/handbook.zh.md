# Pi Coding Agent 全局配置模板

pi（`@earendil-works/pi-coding-agent`）的全局配置与扩展脚本快照，作为本机 pi 环境的模板标准。
本机装的是 pi **0.87.1** + `pi-web-access` **0.30.0** + `pi-subagents` **0.70.1**。

pi 是接入本网关的第四个客户端：它走 `/v1/messages`（Anthropic Messages API），因此和 Claude Code
一样绑定 **claude 路由**的模型。快照里只有一个自定义 provider `litellm-any`，指向本机 996 端口的
adapter（局域网别的机器用则换成网关主机 LAN IP）。

与 `clients/codex`、`clients/opencode` 那几个 profile skill 不同，这里**没有安装脚本**：
只有文件快照和这份说明，装回本机靠手动 `cp`。

## 目录映射与安装

| 本仓库 | 真实路径 |
| --- | --- |
| `AGENTS.md` | `~/.pi/agent/AGENTS.md`（机器全局行为规则） |
| `config/settings.json` | `~/.pi/agent/settings.json` |
| `config/models.json` | `~/.pi/agent/models.json` |
| `config/mcp.json` | `~/.pi/agent/mcp.json`（MCP 服务器；不装就没有 MCP 工具，`/mcp` 会给出提示） |
| `config/web-search.json` | `~/.pi/agent/web-search.json`（`pi-web-access` 自己的配置） |
| `config/pi-statusline.json` | `~/.pi/agent/pi-statusline.json`（**已失效的遗留配置**：旧 npm statusline 包专用，留着只为随时换回那个包） |
| `extensions/*.ts` | `~/.pi/agent/extensions/` |
| `extensions/<name>/` | 同上（子目录形式：`<目录>/index.ts` 作入口，pi 支持 `extensions/*/index.ts`） |
| `extensions/destructive-guard/` | 同上（`tool_call` 安全闸，见其 `README.md`） |
| `themes/*.json` | `~/.pi/agent/themes/`（pi 全局主题目录） |

在仓库根目录执行：

```bash
cp clients/pi/AGENTS.md                 ~/.pi/agent/AGENTS.md
cp clients/pi/config/settings.json      ~/.pi/agent/settings.json
cp clients/pi/config/models.json        ~/.pi/agent/models.json
cp clients/pi/config/pi-statusline.json ~/.pi/agent/pi-statusline.json   # 可选：只有要回退到 npm statusline 包时才需要
cp clients/pi/config/mcp.json           ~/.pi/agent/mcp.json               # 可选：不装就没有 MCP 工具（见下文）
cp clients/pi/config/web-search.json    ~/.pi/agent/web-search.json
cp clients/pi/extensions/*.ts           ~/.pi/agent/extensions/
cp -R clients/pi/extensions/tool-diff          ~/.pi/agent/extensions/   # tool-diff.ts 的纯排版模块（无 index.ts，不会被当成扩展）
cp -R clients/pi/extensions/prompt-editor     ~/.pi/agent/extensions/   # prompt-editor.ts 的纯逻辑模块（无 index.ts，不会被当成扩展）
cp -R clients/pi/extensions/simple-task        ~/.pi/agent/extensions/   # 兼作 plan-mode 执行期的进度表；plan-mode 静态 import ../simple-task/plan-mirror.ts，两者必须一起装
cp -R clients/pi/extensions/recap              ~/.pi/agent/extensions/   # 依赖上一行的 gap.ts（跨目录相对 import）
cp -R clients/pi/extensions/rewind             ~/.pi/agent/extensions/
cp -R clients/pi/extensions/statusline         ~/.pi/agent/extensions/
cp -R clients/pi/extensions/auto-default-model ~/.pi/agent/extensions/
cp -R clients/pi/extensions/startup-logo       ~/.pi/agent/extensions/
cp -R clients/pi/extensions/ask-user-question  ~/.pi/agent/extensions/
cp -R clients/pi/extensions/subagent-log-guard ~/.pi/agent/extensions/
cp -R clients/pi/extensions/fenceless-code-block ~/.pi/agent/extensions/   # 子目录形式：纯逻辑在 render.ts（不 import pi，可单测）
cp -R clients/pi/extensions/user-message-bar   ~/.pi/agent/extensions/   # 同上：纯逻辑在 bar.ts
cp -R clients/pi/extensions/bash-command-collapse ~/.pi/agent/extensions/  # bash-command-collapse.ts 的端到端渲染测试（无 index.ts，不会被当成扩展）
cp -R clients/pi/extensions/working-indicator  ~/.pi/agent/extensions/
cp -R clients/pi/extensions/mcp                ~/.pi/agent/extensions/   # MCP（纯逻辑模块 + fixtures 一起拷）
cp -R clients/pi/extensions/plan-mode          ~/.pi/agent/extensions/   # Claude Code 式 plan mode（改绑 shift+tab，见下文）
cp -R clients/pi/extensions/destructive-guard  ~/.pi/agent/extensions/   # 删除操作安全闸（tool_call 钩子，见 README）
mkdir -p ~/.pi/agent/themes && cp clients/pi/themes/*.json ~/.pi/agent/themes/

pi install npm:pi-web-access                # 外部包；装完必须配 web-search.json（见下文）
pi install npm:pi-subagents                 # 同上；零配置可用
```

四个容易踩的点：

- 上面几条 `cp` 会**整体覆盖**目标文件，没有脚本帮你合并。目标机器上有要保留的自定义字段
  （别的 provider、别的模型、别的全局规则）就先手动比对再覆盖。
- `~/.pi/agent/themes/` 是按需目录，新机器上不存在，必须先 `mkdir -p`。
- **`extensions/tool-diff/` 里没有 `index.ts`**：pi 只加载 `extensions/<name>.ts` 与
  `extensions/<name>/index.ts`，找不到入口就跳过整目录 —— 所以它不会被误当成扩展。
  但只装 `extensions/*.ts` 而不装这个目录，`tool-diff.ts` 会 import 失败。
- **`recap/` 必须和 `simple-task/` 一起装**：`recap/index.ts` 里
  `import { widgetGaps } from "../simple-task/gap.ts"` —— 跨扩展相对 import 是刻意的取舍
  （两个扩展同仓库、同目录树、一起安装，省掉一份重复实现）。

生效方式：扩展改完在 pi 里执行 `/reload` 即热加载（`~/.pi/agent/extensions/` 是自动发现目录）；
`settings.json` / `models.json` / `AGENTS.md` 需要**重开 pi**（启动时读一次，`/reload` 也不管用）。

## settings.json / models.json 的要紧处

字段的取值和注释直接看那两个文件，这里只记扫不出来、改错了会静默坏掉的东西。

**快照与本机真实配置的已知差异（三处，都是刻意的）**：`models.json` 的 `baseUrl`（快照写
`127.0.0.1` 假定网关在本机，本机那份指向 `192.168.124.1` —— 从局域网别的机器用就换成网关主机
LAN IP）；`settings.json` 的 `defaultModel`（会被 `auto-default-model/` 在换模型时随手改写，
所以真实值只是「上次用的模型」）；以及 `settings.json` 的 `extensions` 字段（见文末）。

**`litellm-any` 登记六个模型**：`qwen3.8-df-qd-claude`、`deepseek-flash`、`qwen3.8-max`、
`qwen3.8-flash`、`deepseek-flash-qd`、`Qwen3.8-Max-DogFooding`。这是**原样快照**：网关的 claude
路由还有三条没登记（`qwen3.8-df-id-claude`、`glm-5.3`、`glm-5.3-flash`），要加别的模型就按同样
形状追加。

- **模型名是路由键**：`model.id` 原样透传给 LiteLLM，必须和 `adapter/adapter.config.json` /
  `gateway/config.yaml` 里注册的名字一致，没有别名或改写。
- **`thinkingLevelMap` 里置 `null` 的档位不会出现在 `/thinking` 选择器里**，值就是发给后端的档位
  字符串。这些档位是**客户端侧声明**：qoder agent 协议忽略 `reasoning_effort`（模板只有
  `is_reasoning: true`），idealab 那条路由则被 `gateway/config.yaml` 的 `extra_body` 覆盖 ——
  所以别照 `~/.zshrc` 里那句 `CLAUDE_CODE_EFFORT_LEVEL=max` 抄成 `max`。目录里没有的档位
  （如 `qwen3.8-flash` 的 `high`）保留只为形状一致，后端忽略、不报错。
- **只有 `qwen3.8-max` / `qwen3.8-flash` / `deepseek-flash-qd` 声明 `input: ["text","image"]`**：
  qoder 目录里 `qmodel_38max` / `qfmodel` / `dfmodel` 三条是 `is_vl: true`，三条都实测过发纯色 PNG
  能被正确识别。注意 `dfmodel` 的识图**依赖网关侧 2026-09-22 的修复**：在那之前 `read` 这类工具返回的图
  会走 tool 消息、被内联成 base64 文本（不是 image part），读进 5 张大图后每次请求都被 qoder 网关
  400 顶回来；修好后 tool 结果的图会另起一条 user 消息按真图片发（详见根目录 `CLAUDE.md` 的
  「tool 结果里的图片」一条）。其余条目别顺手补 image —— idealab 后端吃不下，同一张图发过去是 HTTP 400。
- `settings.json` 的 `modelThinkingLevels` 把 `deepseek-flash` 与 `deepseek-flash-qd` 钉在 `max`
  （这两个的 map 里 `max` 有真值），其余跟随全局 `xhigh`。
- `doubleEscapeAction: "none"` 是**把内置的双击 Esc 动作关掉**，交给 `rewind/` 接管。
  该扩展会**吃掉第二次 Esc**，所以即使写回 `tree` 也不会弹 pi 的 tree；写成 `none` 只是把意图写明。
  要恢复内置行为：删掉 `rewind/` 再改回 `"tree"`。
- `tuiMode: "regular"`（也是 pi 默认值）、`steeringMode`、`markdown.mermaid` 三项写的都是 pi 的默认值，
  本机只是显式写了出来。

### `litellm-any` provider 的两个 compat flag

两个都**只对自定义 provider 能开**（真 Anthropic 会拒绝）：

```jsonc
"compat": {
  "allowEmptySignature": true,     // 上游会发空签名的 thinking 块并要求回放时原样带回；
                                   // 关掉的话 pi 会把这种块降级成纯文本
  "forceAdaptiveThinking": true    // 让 pi 发 thinking.type="adaptive" + output_config.effort，
                                   // 而不是旧的 budget 形状
}
```

### 没有网关别名的两条：`deepseek-flash` 与 `Qwen3.8-Max-DogFooding`

其余四条在 `gateway/config.yaml` 里都是别名（`qwen3.8-max` → `qoder/qmodel_38max`、
`qwen3.8-df-qd-claude` → `qoder/mode-24b28ef…` 这种），名字由网关自己定义。这两条不一样：
**上游认的就是这个名字本身** —— `deepseek-flash` 直连 DeepSeek 自家的 Anthropic API（plain
pass-through），`Qwen3.8-Max-DogFooding` 则对应 `gateway/config.yaml` 里那条刻意只用 litellm
内置设施的对照路由：**不带 `custom_llm_provider`**（即不过 `idealab-openai` 那套自定义 provider，
也就没有 tool_choice 抹除与 `\x01` marker 注入），`adapter/adapter.config.json` 里也**刻意不登记路由**，
于是 `adapterMode` 落回 `pass-through` —— 端到端只是转发，实测 thinking 与工具调用都完整保留
（`thinking` 块 + `tool_use` + `input_json_delta`）。

写这两条时要记住 **`model.id` 会被 pi 原样当成请求体的 `model` 字段发出**（`pi-ai` 的 `buildParams`），
所以 `id` 必须是上游认得的名字，不能起别名；pi 的 `name` 只用于 `--model` 匹配，而 `/model`、
`--list-models` 与 footer 显示的是 `id`。

### 主题文件

`settings.json` 的 `theme` 指向 `~/.pi/agent/themes/<name>.json`，**文件名必须等于 JSON 里的
`name` 字段**（`loadThemeJson()` 拼 `${name}.json` 找文件）—— 改主题名要**同时**改文件名、`name`
和 `settings.json` 的 `theme` 三处，只改一处的话要么选择器显示旧名、要么 `theme` 值落空。

- `pi-coder-catppuccin.json` —— 移植上游 [bacnh85/pi-extensions](https://github.com/bacnh85/pi-extensions)
  的 Catppuccin Mocha 皮肤。与另两套一样全走 `vars`（`bgAnsi()` 对整数会直接发
  `48;5;N`，所以上游遗留的唯一一个 256 色索引 `toolPendingBg: 233` 已先改成 hex 字面量、
  后来按要求整个清空成 `""`，现在三套皮肤都没有整数字面量）。本仓对它的存心 deviation 一处：
  `thinkingXhigh` / `thinkingMax` 不再走调色板的 `blue`，与另两套皮肤统一成中性灰 `#626262`
  （新增 `vars.thinkingGrey`）—— 理由同下面 ayu 的第 2 条。**pi-coder-1337 按你的要求锁到 `#696969`**，
  catppuccin 与 ayu 仍是这个 `#626262`，三套皮肤的最高两档分成了两档：`#626262`（catppuccin / ayu）
  与 `#696969`（1337）。
- `pi-coder-ayu.json` —— 移植 [iodic/pi-ayu-themes](https://github.com/iodic/pi-ayu-themes) 的
  `ayu-dark`（官方 Ayu 调色板），**格式照 `pi-coder-catppuccin.json` 抄**：同样的
  `$schema` / `vars` / `colors` / `export` 四段，`colors` 的 key 与键序照 pi-coder-catppuccin 抄（pi-coder-ayu 多一个
  自定义的 `bashOutput`，所以是 55 个 key），色值全部走 `vars`。上游皮肤已经定义的 51 个 token 里 **48 个逐字节同值** —— 这条可以用代码验：
  用 `loadThemeFromPath()` 同时解析两份文件，对同名 token 比 `getFgAnsi()` / `getBgAnsi()`；
  本仓只补了它没定义的四个：`toolDiffAddedBg` / `toolDiffRemovedBg`（`tool-diff.ts` 要读的行
  底色，上游没有）、`thinkingMax` 与 `bashOutput`（bash 输出正文的独立颜色槽，见下）。自定的
  色值一共五处：两个 diff 行底色、代码字符串的绿、最高两个思考档的边框灰、bash 输出灰（第六处
  原本是按你要求单独调过的 pending 态卡片底色 `toolPendingBg`，现已清空，见下面第 3 条）。两个 diff 行底色是 `#1d241c`（bg 朝 `green` 混 10%）与 `#321d23`（朝 `red` 混 18%）——
  比例是反推出来的：让两侧行底色相对工具盒底色的亮度比都落在 ≈1.15（pi-coder-catppuccin 是 1.15 / 1.14），
  同时 `tool-diff.ts` 那个 30% 行内混色之后正文还有 4.0:1 / 5.6:1。绿侧只能给到 10% 是因为
  Ayu 的绿 `#AAD94C` 很亮，行内混色天然吃掉更多对比度。

  对上游**三条存心 deviation**：

  1. 上游把 `toolDiffAdded`（diff 增加行的前景，行号与 `+` 号跟它同色）与 `syntaxString`
     （代码文本里的字符串）**指向同一个绿 `#AAD94C`**，两边亮得发同一种光；本仓把 `syntaxString`
     拆出去指向自己的 `stringGreen` `#67a567`（更沉的墨绿，差在色相与亮度：代码块底色上 6.2:1，
     原值 `#AAD94C` 是 11.1:1；先定的是 `#73a073`，后按你要求换成 `#67a567` 更纯一点的绿），
     diff 侧保留上游的 `#AAD94C`（行底色上 9.6:1）。副作用：新绿与 `muted`（注释灰 `#6B7385`）
     亮度接近（1.62:1），字符串与注释主要靠色相区分，嫌分不开就往 `#7FAE7F` / `#8CB884` 方向拾一点。
  2. 思考档边框：`thinkingXhigh` 上游是红 `#D95757`，本仓与 `thinkingMax` 一起改成中性灰
     `#626262`（`vars.thinkingGrey`）—— 编辑器边框按当前档位取色，本机 `defaultThinkingLevel`
     正是 xhigh，红边框读着像报错。代价：最高两档不再靠更热的颜色表达，只靠明暗差 —— 这个灰对
     底色 3.12:1，比 `thinkingMinimal` 的 `#6B7385`（4.00:1）暗一档、比 `thinkingOff` 的
     `#515868`（2.67:1）亮一档，与 minimal 相差 1.28:1（看得出但偏淡），要再拉开就继续调深/调浅。
  3. `toolPendingBg`：上游是 `#1b1c1d`（与它的 `userMessageBg` 同一个值），本仓先按你要求改成中性
     `#1f1f1f`、后又调成 `#171717`，**现在三套皮肤统一清空成 `""`**（终端默认底色）—— 只影响 pending 态
     的工具卡片底色，`userMessageBg` / `customMessageBg` 走它们自己那个仍为 `#1b1c1d` 的变量，不受影响；
     它的 `vars` 条目（`#171717` / `#1b1c1d`）与三套皮肤里其他无人引用的变量一起删掉了，文件里已不留痕。

  整体观感是「近黑蓝底 + 高对比亮色」，
  正文在面板上 8.4-9.2:1（pi-coder-catppuccin 12.7）；代价是 Ayu 自己的灰阶偏暗：`muted` `#6B7385`
  在面板上 3.3-3.8:1、`dim` `#515868` 2.2-2.6:1（pi-coder-catppuccin 分别 ≈4.9 / 4.7），注释、
  `Think:` 行、设置页提示因此明显更淡 —— 这是上游皮肤自己的取值（与 `ayu-dark` 逐字节一致），
  嫌淡只需调 `vars.muted` / `vars.dimmed` 两个变量。上游那个包（`iodic/pi-ayu-themes`，自带
  `ayu-dark` / `ayu-mirage` / `ayu-light` 三套变体）**已按你要求卸载**（`pi remove npm:pi-ayu-themes`，
  三份变体文件随之从 `~/.pi/agent/npm/` 消失，`/theme` 里不再有这三个名字），所以本机的 Ayu 皮肤
  只剩本仓这份 `pi-coder-ayu.json` —— 它是同一套 dark 调色板的「可按文件改」版本；要回到上游三套变体只需
  重新 `pi install npm:pi-ayu-themes`。
- `pi-coder-1337.json` —— **当前在用**（`settings.json` 的 `theme` 指向它）。移植 Codex CLI 的**内置语法主题 `1337`**（`~/.codex/config.toml` 的
  `[tui] theme = "1337"` 就是它）。1337 是 Mark Herpich 的 Sublime 配色，被 two-face 打包进
  Codex 二进制的 32 套主题之一。取色方式可复核：从本机那份 codex 可执行文件里解出嵌入的 theme blob
  （`zlib` 解压后是可读的 scope→色值表），再与上游 `1337.tmTheme` 逐条对账 —— 两边 48 个有名 scope
  全部命中，其中 37 个逐字节同值，其余 11 个是 Codex 侧把该 scope 合并成 `None`（不单独着色、
  继承父级）—— 两边都没有出现过「同一 scope 两个不同色值」的情况，所以下面那些值不是「照着观感配的」。
  1337 本身只有**代码语法**一层 —— `background` `#191919` / `foreground` `#f8f8f2` / `caret` `#f8f8f0` /
  `selection` `#515151` / `lineHighlight` `#3D3D3D55` / `invisibles` `#3B3A32`，加 **48 个有名 scope
  条目、28 个不同前景色**，**没有任何 UI 槽位**。所以 pi 那 59 个颜色分两类来源：语法槽位按下表直译，
  UI 槽位在这 28 个色值里挑（挑不到就用 `foreground`），只有 12 个不是 1337 的色（见本节末）。

  语法槽位（`colors` 键 ← 1337 scope，全部取上游字面值；pi 只有 8 个语法槽，所以要合并）：

  | pi 槽位 | 1337 scope | 色值 |
  | --- | --- | --- |
  | `syntaxComment` | `comment` | `#6d6d6d` |
  | `syntaxString` | `string` | `#fbe3bf` |
  | `syntaxNumber` | `constant.numeric` | `#fdb082` |
  | `syntaxVariable` | `variable` | `#e9fdac` |
  | `syntaxKeyword` | `keyword`（`storage` 与 `entity.name.tag` 同值） | `#ff5e5e` |
  | `syntaxFunction`、`syntaxType` | `entity.name.function` / `entity.name.class` / `entity.other.inherited-class`（三者同值） | `#8cdaff` |
  | `syntaxOperator` | **无对应 scope** → 落到 `foreground` | `#f8f8f2` |
  | `syntaxPunctuation` | `punctuation.definition.*` | `#ffffff` |

  两处合并的取舍要交代：① 1337 把「函数名 / 类名 / 继承类」（`#8cdaff`）与 `support.function`
  库函数（`#6699cc`）分成两支，pi 只有一个 `syntaxFunction` —— 取 `#8cdaff`，它是前三者的共同值，
  `syntaxType` 也跟它（在 1337 里类名与函数名本来就同色）；`#6699cc` 没浪费，转手给了 `mdLink`。
  （`support.class` / `support.type` 在 1337 里是另一个米色 `#fbe3bf`，与字符串同值，没有采用 ——
  让 `syntaxType` 跟类名走才合 1337 自己的分工。）② `mdHeading` **没有用** 1337 的 `markup.heading` `#75715e` ——
  那个值在 `#191919` 上只有 3.58:1，而且 pi 的 `mdHeading` 不只画 markdown 标题，还画启动页那批
  `[Skills]` / `[Extensions]` 分组标签（`interactive-mode.js` 的 `addLoadedSection` 默认色），太暗读不清；
  改用 `constant.language` 的橙 `#ff8942`（7.46:1）。

  整体对账（把 `colors` 的值展开 `vars` 后逐一对回 1337 的调色板）：**59 个槽位里 46 个取自 1337、
  12 个不是、1 个是空串** —— 12 个已在本节逐一点名（5 个指定 + 6 个锁死 + 1 个 `error` 统一），
  没有一处「随手拿个相近色」。

  非语法槽位全部从 1337 自己的色板上取（括号里是对 `#191919` 的对比度）：`border` / `selectedBg` ←
  `selection` `#515151`、`borderMuted` ← `invisibles` `#3b3a32`、`warning` ← `constant.numeric` `#fdb082`、
  `success` ← git-gutter 的 `#a6e22e`（1337 自己给「插入」的用色）、`toolTitle` 与
  `syntaxFunction` 共用 `#8cdaff`（11.38:1）、`toolOutput` ← `variable.parameter.function` `#d0d0d0`（11.40:1）、
  `mdListBullet` ← `storage.type` `#fbdfb5`、`bashMode` ← `variable.parameter` `#fc9354`、
  `customMessageLabel` ← PHP 命名空间 `#ffb2f9`。
  思考档走 1337 自己的冷→暖阶梯：`thinkingOff` = `invisibles`、`thinkingMinimal` = `selection`、
  `thinkingLow` ← `support.function` `#6699cc`、`thinkingMedium` ← `entity.other.attribute-name` `#97d8ea`、
  `thinkingHigh` ← `variable.language.*` `#d699ff`，最高两档锁死（见下）。

  **六个锁死槽位是照你指定的值写死的**（不是 1337 的色）：
  `toolDiffAdded` `#8bc391` / `toolDiffRemoved` `#e27878` / `toolDiffAddedBg` `#1c241b` /
  `toolDiffRemovedBg` `#2e1c21`（diff 行前景 + 整行底色四件套）、`thinkingXhigh` / `thinkingMax` `#696969`
  （最高两档思考边框）。锁死时比对过两份 JSON 的解析结果，6/6 全等；现在只剩这份值本身。
  **这里有一个锁死带来的必然后果要交代**：那两个 diff 行底色是**为 `#161616` 卡片挑的**
  （对卡片 1.14 / 1.12:1），换到本皮肤指定的 `#202020` 成功卡片上只剩 **1.02 / 1.01:1** —— 行底色几乎是平的，
  在深色 diff 块里基本看不出来（前景色不受影响，`addedGreen` 对新增行底色仍是 7.83:1）。
  这不是漏改：两侧的锁死要求互相拉扯，行底色要重新可见就得改 `toolSuccessBg` 或这两个底色中的一个。

  另按你要求**把报错色统一到 diff 删除行的前景色**：`error` 不再用 1337 的 `markup.deleted` `#f92672`，
  而是与 `toolDiffRemoved` 共用同一个 `vars.removedRed` `#e27878` —— 共用一个变量而不是两个同值变量，
  这样改一处两边同时变，才叫「统一」。`#f92672`（1337 的 `markup.deleted`）因此彻底退出这份皮肤，
  变量也从 `vars` 里删掉了 —— 连同后面 `mdCode` 换色撤下的 `#ecfdb9`（1337 的 `support.constant`），
  这份皮肤一共放弃了两个 1337 色值。`error` 对 `#191919` 的对比度随之从 4.65:1 变成
  **6.02:1**（在 `toolErrorBg` `#171010` 上是 6.43:1）。新增行侧不动：`toolDiffAdded` / `addedGreen`
  仍是指定值 `#8bc391`。

  四个指定底色：`userMessageBg` / `customMessageBg` `#242424`、`toolSuccessBg` `#202020`、`toolErrorBg` `#171010`、
  `export.cardBg` `#181825`（另配 `export.pageBg` `#111111`，同族推的、比 cardBg 暗一档）；
  `toolPendingBg` 与另三套一样清空成 `""`。
  `accent` / `borderAccent` 按你要求改成了 `#8cdaff` —— 这次**是** 1337 自己的色（函数名 / 类名那个青蓝，
  与 `vars.funcBlue` 同值），但**各立一个 `vars`**（`accent` 与 `funcBlue` 分开，改一个不连带改另一个，
  本仓习惯）—— 所以调 accent 不会顺手把 `syntaxFunction` / `syntaxType` / `toolTitle` 一起改掉。
  对 `#191919` 11.38:1（旧值 `#0d92c1` 是 4.94:1），选中的行 / 光标 / logo 因此明显更亮。

  `mdCode`（行内代码）同时按你要求换成 **`#0d92c1`**，就是 accent 撤下来的那个深青 —— 新开一个
  `vars.mdCodeCyan` 装它，与 accent 解耦。它原来指向的 1337 色 `support.constant` `#ecfdb9` 因此不再被引用，
  变量已从文件里删掉（板页变量表同步换一格，总数仍是 35）。行内代码对 `#191919` 4.94:1
  （代码块底色 `#202020` 上 4.58:1）—— 比注释 / `dim` 的 3.40:1 亮一档、比语法关键字的 5.87:1 弱一档，
  处在语法色阶的下半段，读是够读，嫌淡就往上抬。

  与另三套的一个结构性差别：**它也定义了 `bashOutput`**（`#999999`，bash 输出正文的独立灰 ——
  与它自己的 `muted` 同值但各立一个 `vars`，改一个不连带改另一个），机制同 ayu，catppuccin 没有。

三套皮肤共同的两条硬约束：

- **`colors` 正在引用的 `vars` 变量不能删**：`colors` 的值只要不是 `#` 开头（也不是空串）就会被当变量引用去 `vars` 里查，
  查不到直接抛 `Variable reference not found`，**整个主题加载失败**并回退内置 `dark`。反过来，把某个颜色值清空成
  `""` 之后（三套皮肤的 `toolPendingBg` 都是这个状态），它原来指向的变量变成无人引用，可以留着也可以删，两者都不影响加载。
  **本仓的做法是删**：三套皮肤里的 `vars` 只保留仍被 `colors` / `export` 直接或间接引用的条目（仅 `pi-coder-catppuccin` 的
  `pendingPanel` 按你要求整条保留，留作后续恢复 pending 底色的备选值——它独一无二，未被任何槽位引用）。
  另注意 **空串是合法值**，不是「未定义」：`bgAnsi("")` 发 `\x1b[49m`（终端默认底色）、`fgAnsi("")` 发 `\x1b[39m`，
  token 仍在表里，`theme.bg(token, ...)` 不会报错。
- **缺了主题文件会静默降级**：`initTheme()` 加载失败时是 `catch` 后静默回退内置 `dark`，不报错、
  不启 watcher —— 重装时最容易漏的就是这一行（它不在 `cp config/*.json` 那几行的覆盖范围内）。

三套皮肤里都有 pi 官方 schema 没有的自定义 token：`toolDiffAddedBg` / `toolDiffRemovedBg`
（diff **整行底色**；`toolDiffAdded` / `toolDiffRemoved` / `toolDiffContext` 三个前景色是标准 token），
`bashOutput` 是第三个（ayu / 1337 都有，catppuccin 没有，见下节）。
它们能生效靠三件事凑齐：主题校验实际用的是 TypeBox 的 `Compile().Check()`，**对未知 key 放行**
（`theme-schema.json` 里那句 `additionalProperties: false` 不是执行路径）；`createTheme()` 把不在那 7 个
ThemeBg 名单里的颜色一律收进 `fgColors` 表；而 `getFgAnsi()` 是按 key 查表、不校验 key 是否在联合类型里
—— 拿到前景色 SGR 后把 `38` 换成 `48` 就是合法底色。**pi 一旦改成严格校验，这两个 token 就读不到**，
扩展会静默退回 `toolSuccessBg` / `toolErrorBg`，底色变淡但不报错。

主题文件里的色值选择（pi-coder-catppuccin 的 diff 底色按 OKLab 感知亮度标定、`accent` 取 Macchiato lavender、
`muted` / `toolOutput` / `thinkingText` 指向同一个 `secondaryText`；pi-coder-ayu 的 diff 底色按上面那条
「行内混色 + 两侧行底色亮度比」反推等）都写在 JSON 自己的变量命名与 `tool-diff.ts` 的注释里，
改色时以文件为准。皮肤不会自证对错 —— `toolDiffAddedBg` 之类的自定义 token 写错名字只会静默走兜底，
所以新皮肤落盘后至少用 pi 自己的校验与解析跑一遍：`validateThemeJson()`（`pi-coding-agent/dist/modes/interactive/theme/theme-json.js`）
过 schema、`loadThemeFromPath(path, "truecolor" | "256color")` 后对每个 token 调 `getFgAnsi()` /
`getBgAnsi()`，任一 `vars` 引用不存在都会抛 `Variable reference not found`。移植类皮肤再加一条：
把上游那份皮肤文件一起解析，同名 token 逐个比 ANSI 值 —— 同值才叫「搬运」，不同值要么是漏改，
要么是有意 deviation，得在注释或文档里交代清楚。

### `bashOutput`：bash 输出正文的独立颜色（ayu / 1337 都定义了）

`pi-coder-ayu.json` 多一个 pi 官方 schema 没有的 token `bashOutput`（值 `#6B7385`，与那条
`… (N tokens hidden)` 折叠提示同为 `muted` 灰，但**自己一个 `vars.bashOutput`** —— 改 `muted`
不会连带动它）；`pi-coder-1337.json` 也有一份（`#999999`，等于它的 `muted`，独立 `vars`）。
它买的是「只改 bash 输出正文的颜色，不跟其他颜色混掉」：pi 内置的 bash 渲染器把
输出正文写死成 `toolOutput`，而那是**所有工具输出共用**的槽（read / grep / ls 的正文都吃它），
所以这个 token 只能由 `bash-command-collapse.ts` 生效 —— 机制（在委托给内置渲染器的同步窗口里
临时改主题单例的 `fgColors`）写在该扩展文件头「输出正文的独立颜色」一节。两条行为要知道：

- **别的皮肤不定义它 = 零影响**：扩展先真调一次 `getFgAnsi("bashOutput")` 探测，抛
  `Unknown theme color: …` 就什么都不做，照旧走 `toolOutput`（内置主题与 pi-coder-catppuccin
  现在都是这条路）。反过来，想给某套皮肤也拆出来，就是照 pi-coder-ayu 加一行 `vars` +
  一行 `colors`；删掉那两行等于回到 `toolOutput`，不报错。
- **它不在官方 schema 里，所以不会出现在 `theme-command.ts` 的色卡预览上**：那只预览画的是
  pi 的标准 token 列表。

## 联网检索（`pi-web-access`）

给 pi 加 `pi_web_search` / `fetch_content` / `source_check` / `get_search_content` 四个工具。
**零配置可用**（不填 key 时检索走 Exa MCP），本机就是这种状态。

配置里只有一项，但它是**必须的**：

```json
{ "toolNames": { "webSearch": "pi_web_search" } }
```

pi 默认把该工具注册成 `web_search`，而 litellm 的 Anthropic→OpenAI 转换会按名字把**任何叫
`web_search` 的工具**当成 Anthropic 官方内置的联网检索工具（`_is_web_search_tool`），于是把它从
`tools` 里剔除、换成一个空的 `web_search_options: {}` 参数；qoder 后端不认这个参数，工具就**静默消失**
—— 请求正常返回、没有任何报错，只是模型的 tool schema 里没有它（实测：pi 发 8 个工具，网关日志
`tools=7`；只发 `web_search` 时是 `tools=0`）。改名后同一个请求变成 `tools=8`，检索实测可用。

> 排查这类「工具凭空消失」时不要相信模型的自述（它会照着 system prompt 里残留的 `promptSnippet` 猜），
> 要看网关日志的 `tools=N` 计数：pi 发了几个、网关收到几个，对不上就是中间层吞了。

## 子代理委派（`pi-subagents`）

`scout` / `researcher` / `evidence-auditor` / `worker` / `reviewer` / `oracle` / `delegate` 等内置
agent，加 `workflowScript` 脚本化编排。工具名（`subagent` / `subagent_supervisor` /
`contact_supervisor` / `bg_wait` / `structured_output`）都不撞 litellm 的 `web_search` 特判，
所以**不像 `pi-web-access` 那样需要改名**。

### `tools:` 是严格白名单，但真正决定成败的是「子会话注册表里有没有这个名字」

白名单本身的过滤规则（`child-tool-plan.ts`）：**核心内建名**（`PI_BUILTIN_TOOL_NAMES` =
`read` / `bash` / `powershell` / `edit` / `write` / `grep` / `find` / `ls`）里宿主没有的会被剔除、
并记进 `unavailableHostBuiltins`（后台 run 的 `runner.stderr.log` 里那条
`host runtime tool availability omitted [...]` 警告就是它）；**非核心名原样放行**，交给子会话自己的
工具注册表去校验。

所以扩展工具被丢掉通常不是白名单的锅，而是**名字对不上**：内置 `researcher` 的 frontmatter 写的是
`web_search`，而本机 `web-search.json` 已经把该工具改名成 `pi_web_search`，于是子会话注册表里没有
`web_search`，它就在那里被丢掉 —— 这类「工具凭空消失」不要相信模型自述，看子会话实际拿到的工具表。

另一条独立规则：只有**后台**子代理才加载父进程的环境扩展（`ambientExtensions = host === "runner" && ...`），
`async: false` 的前台子会话跑在父进程内，只加载内置 + runtime 扩展 —— 所以前台子代理没有联网工具，
除非 agent 自己用 `extensions:` 声明（但那样环境扩展整体被关掉，`simple-task` 的 `task_*` 之类不再有）。

`settings.json` 给三个**可写型**内置代理设 `tools: "inherit"`：`researcher`、`delegate`、`worker`。
`inherit` 的实现就是 `delete target.tools`（`applyToolsOverride`）—— 白名单整个删掉，子代理拿回
子会话注册表里的全部工具，上面那类名字对不上的问题也就绕过去了。实测后台子代理拿到 13 个工具，
`researcher` 与 `delegate` 都真的联网成功。
**只读型内置代理（`scout` / `reviewer` / `oracle`）不能设** —— `inherit` 会把 `write` / `edit` / `bash`
一并给出去，破坏只读契约；`evidence-auditor` 的白名单是同一个坏形状，但给它 `inherit` 等于白送写权限，
所以留原样。交互类工具不用手动排除：`ask_user_question` 自己按 `ctx.hasUI` 判断，子会话里自动摘掉。

## MCP 服务器（`mcp/`）

让 pi 用上 Claude Code 那套 MCP 服务器：**每个 MCP 工具直接注册成一个 pi 工具**，名字
`mcp__<server>__<tool>`（Claude Code 同款，skill 与权限规则里的写法可以直接搬过来）。

配置按 Claude Code 的 `.mcp.json` 形状：全局 `~/.pi/agent/mcp.json`，再加上从 cwd 往上找到的
**第一个**项目根 `.mcp.json`（同名 server 项目覆盖全局）。所以 `~/jayli/homework/.mcp.json` 里已有的
`wechat-local` 在 pi 里开箱即用，全局那份则是「在哪个目录都能用」。字段：`command` / `args` / `env` /
`cwd` / `timeout`（毫秒，工具调用用；握手另有 20s 上限）走 stdio；`url` / `headers`（`type: "sse"` 走旧版
HTTP+SSE，否则 streamable HTTP）走远程；字符串值支持 `${VAR}` 与 `${VAR:-默认值}`；`enabled: false` 保留条目但不连。

**动态请求头（`headersCommand`）**是 OAuth 的“便宜档”：很多 SaaS MCP 既支持 OAuth、也支持静态 token（GitHub PAT、
`CONTEXT7_API_KEY`、Sentry/Figma 的 token），所以与其为一个 header 实现整套 OAuth 2.1，不如让命令自己去取：
```json
{ "mcpServers": { "remote": {
  "url": "https://mcp.example.com/mcp",
  "headersCommand": "security find-generic-password -s example-mcp -w"
} } }
```
命令输出三种形状都认：扁 JSON 对象、`{"headers":{...}}` 包装、或 `Name: Value` 行（值里的冒号不会被切开）。
别名 `headersHelper`（Claude Code）与 `http_headers_helper`（Codex）同样可用，从那边拷配置不用改字段名；
`headersCommandTimeout` 默认 10s。语义上有四条要记住：

- **每次连接只跑一次**，结果与静态 `headers` 合并（**动态的赢**，它是更新鲜的凭据）；HTTP 协议头（`content-type`/
  `accept`/`mcp-protocol-version`/`mcp-session-id`）优先级最高，配置改不动它们。
- **401/403 会重跑一次，但只有头真的变了才重试请求**（命令每次都返回同一个 token 就不会白重试一遍）。旧版 SSE
  只重建 POST，不重建 GET 长连接。
- **失败不致命**：命令超时/非零退出/输出不可解析时退回静态 headers 继续连，原因记进诊断；真被拒时错误信息里
  会带上这条原因（否则你只看到 401，以为是 token 过期）。
- **绝不记录头的值**：诊断只输出头的**名字**（`头命令取到 1 个头（Authorization）`），解析失败也不回显命令输出
  —— 输出可能整段都是密钥。`/mcp <server>` 里显示的是命令本身（你自己的配置），不是取回来的值。

没有浏览器弹窗、不写任何凭据存储：token 的生命周期完全归那条命令管（钥匙串、vault、`opencode auth` 都行）。
只支持 OAuth（不接受静态 token）的 server 目前用不了，要支持得上第二档（OAuth 2.1 + PRM + DCR + 回调服务器），
那基本就是 pi-mcp-adapter 的领域。

三个命令入口：`/mcp` 看状态（server / 工具数 / 版本 / 配置来源），`/mcp reload` 改完配置不用重启 pi，
`/mcp <server>` 看单个 server 的详情与最近诊断。不开 pi 想验证配置就 `npm run mcp:probe -- <server> [tool]`
（用的是扩展里同一份客户端，通了 pi 里就通；**本机 Node 22 专用** —— 它直接 import `.ts`，靠 Node 的类型擦除，
与 `npm run usage` 一样不在 Node 20 的路由器上跑）。

改之前的约束：

- **传输是自己实现的**（`protocol.ts` + `client.ts`），**不依赖 `@modelcontextprotocol/sdk`** —— 扩展目录
  里没有 node_modules，引 SDK 就得给 `~/.pi/agent/extensions/mcp/` 铺依赖。协议面只做
  initialize / notifications/initialized / tools/list / tools/call，其余（OAuth、sampling、elicitation、
  progress、`tools/list_changed` 热更新）**刻意不做**；服务端反向请求一律回 `-32601`，不留傻等的对端。
- **诊断输出只进内存环形缓冲**（每个 server 20 行，`/mcp <server>` 看），**不写 stdout/stderr** ——
  interactive pi 里往 stderr 写会直接糊在输入框上（`subagent-log-guard/` 就是为这个存在的）。
- **会话开始时连接、结束时断开**。工具表必须先 `tools/list` 才能注册，所以不能等首次调用才连；
  多个 server 并行握手，单个失败只影响它自己（启动时给一条 warning，不阻塞会话）。
- **工具输出必须截断**：沿用 pi 内建工具的 50KB / 2000 行上限（`tools.ts` 的头截断），图片块不计入、
  也不被截掉。MCP 的 `resource` / `resource_link` / `audio` 会降级成一行文本说明 —— pi 的 tool content
  只认 `text` 与 `image`，原样塞进去会被静默丢掉。
- **工具名有 64 字符硬上限**（Anthropic / OpenAI 的 tool 名限制）：超长时截断工具名并接 FNV-1a 哈希后缀，
  保证截断后仍可区分。改命名规则时 `tools.test.ts` 的哈希稳定性用例会拦住手滑。
- **头命令的设计约束（`headers-command.ts`）**：① 子进程**刻意不 unref** —— 它是我们正在等的结果，unref
  会让 `pi -p` / probe 这类短命进程先退出、promise 永远不 resolve（单测当场拦到过）；② 诊断只能用
  `describeHeaderNames` 输出**头名**，头的值与解析失败的原文一律不打印（命令输出可能整段是 token）；
  ③ 命令失败不当致命错误，退回静态 headers 并把原因带进最终错误信息，否则用户只看到 401 而不知道是命令挂了；
  ④ 401/403 重跑命令后**只在头真的变化时**重试（headless 与交互两种模式行为要一致）。

## 自写扩展：改之前要知道的

每个扩展的完整理由都写在**它自己的文件头注释**里，这里只列「不在文件里、但改错了会静默坏掉」的约束。
除了下文点名的那些，`extensions/` 下还有一批较小的显示层 / 输入层扩展：

| 扩展 | 作用 |
| --- | --- |
| `thinking-collapse.ts` | thinking 块渲染成**一条连续横向滚动的行**（固定 1 行，不注册命令）：所有换行（模型自己折的行、空行分段、列表项、代码围栏内）全部拼进同一条行 —— 上一段结束后下一段直接接续在上一段的结尾，**不另起一行**，Think 区域从头到尾只有一行不间断的 token 流；**段落接缝（空行处）中文 ↔ 中文补一个逗号**（上段末尾已有标点不重复补，英文/混排仍按空格规则，段内折行不补），行首 `Think: ` 标签（顶格，无竖线 gutter），整行超宽时从头部丢掉溢出字符、行首补 `…`，行尾永远是最新 token，不折行；**没有短段回填补满逻辑**（曾有，会打断流动观感，已移除），短 thinking 行尾留白不补 |
| `fenceless-code-block/` | Markdown 代码块去掉开合围栏（连 `lang` 标签一起），代码正文按 pi 的缩进铺开、语法着色保留，**不加底色**（观感来自 npm `@itc-steve/pi-theme`，但只取去围栏这一半）；`render.ts` 是纯逻辑（量度 / 折行 / Markdown 类都注入），入口只接线。`PI_FENCELESS_CODE=off` 关闭 |
| `user-message-bar/` | 用户消息框**每一行**（含上下两条空白内边距行）行首加一条竖线 `▎`（U+258E，左侧四分之一块），**竖线跟着消息底色**（不抠底 —— 它直接坐在 Box 的 `userMessageBg` 里，与底色块连成一片），竖线后空一格（正文共缩进两格），颜色取 **皮肤的强调色 `accent`**（`PI_USER_MESSAGE_BAR_COLOR` 可换槽位，显式指定 `toolDiffAdded` 则拿回原来的 diff 新增行行号色；兜底顺序 `accent` → `selectedBg` → `toolDiffAdded` → `text`）；`UserMessageComponent.prototype.render` 补丁 —— 竖线占原本那一格左内边距，多空的那一格（`BAR_INDENT`）则从**行尾补白**里等量吃回来，所以底色 / 行宽 / 折行位置全不变（pi-tui 对超宽行直接抛错，多一格都不行；`outputPad = 1` 时 Box 只给孩子 `width - 2` 列，所以正文总能留得下那一格，已在 `index.test.ts` 用长正文折行逐行验宽度）。**别再改成「竖线格无底色」**：那需要在竖线前插 `49m`、画完再还原 `48;…m`，而结果是底色块左边缘被抠出一个缺角，实测观感更差（曾这么做过，已回退）；`bar.ts` 是纯逻辑，入口只接线；取色源在 `session_shutdown` 时摘掉、读皮肤再兜一层 try/catch —— 会话替换（`/clear`、`/new`、`/resume`、`/fork`、`/reload`）时 pi 会作废旧 ctx，而旧消息这时还挂在聊天区里，渲染 tick 里抛出的 stale-ctx 异常没人接得住，会直达 pi 的 `uncaughtException` 把进程带走。`PI_USER_MESSAGE_BAR=off` 关闭，`PI_USER_MESSAGE_BAR_COLOR=<槽位名>` 换色（背景槽如 `selectedBg` 会 48→38 转前景） |
| `bash-command-collapse.ts` | bash 工具块的命令 + 树形输出（**用户 2026-09-21 定的形状**）：命令**首行**行首是一颗状态圆点 `•` **加一个空格**（执行中 `dim` / 成功 `toolDiffAdded` / 失败 `toolDiffRemoved`，**只有首行有**，续行、折叠标记与整棵结果树前面没有；这一列与结果侧的缩进共用同一个 `INDENT_WIDTH`，所以 `Run` / `│` / `└` 同在列 2、正文同在列 4），命令以 `Run ` 起头（pi 内置是 `$ `）、最多 **2 个视觉行**，第 2 行溢出多少都只把行尾换成 `…`，命令更长时再补一行 `… +N lines`；两类续行（折行续行、折叠标记）的正文都对齐 `Run ` 的 `n` 列 —— 执行中是两格缩进，命令一执行完就换成 `│ `。结果挂在同一棵树下：`└ ` **整块只出现一次**、在第一行实质输出上（截断提示行挂 `│ `，`└ ` 之下的输出 / warnings / `Took Xs` 只缩进两格不再画竖线），没有输出时补一行 `(no output)`（`└ ` 挂它前面）；`│ ` / `└ ` 取 `muted`（结构符，`Run ` 取 `toolTitle`；两者**各自是一段独立的前景 SGR**，前缀绝不继承后面 token 的颜色 —— 曾经路径那行的 `│` 跟着 path 色飘过）。只有 `Run` **这一个词**加粗（`bold("Run") + " "`，包住整个前缀会把行尾那格间距也变粗），命令正文一律不加粗（原先是命令名加粗）。**命令失败时** pi 把状态当普通输出拼在结果末尾（`appendStatus` 的 `\n\n` + `Command exited with code N` / `timed out after N seconds` / `aborted`，无输出时正文已被 pi 换成了 `(no output)`）—— 那句 `\n\n` 原本渲染成两行**没有前导符**的空行（用户说的“中间断层两层”），现在 `trimPreviewLines` 把状态与其前的空行一起摘下来、空行不画、状态当作预览必占的一行（否则它会被预览裁掉，只剩一条 `│ … (N earlier lines)`），`└ ` **之上**的空行补 `│ `（用户 2026-09-21 定的：栅栏不能断在空行上；来源是 pi 预览窗口开头的空行与失败状态前面的分隔空行），`└ ` **之下**的空行保持空行（树在那里就落地了，下面那截是缩进对齐的续行 —— 更多输出、`[Full output: …]` 之类的 warnings、`Took`，各自成段；挂竖线反而像还没完），最后按 `error` 槽染红（`isError` + `isFailureStatusLine` 两道判定：只看形态会把 `echo "Command exited with code 2"` 这种正常输出也染红）并放回尾部，展开态（ctrl+o）同样染色（不裁行、不挂树）。整块**既不带底色也不留边界空行**（`Box` 不带 bgFn、`paddingY: 0`：命令就是块的第 1 行、结果就是最后一行；左边距由组件自己画 —— 首行是 `• `、其余行两格空格，结果侧挂同宽的那一列。**只去 bash 的**底色，其他工具照旧）。同时保留：非流式（`onUpdate` 摘掉）、break-all 硬折行 + 行首 `Run ` 语法高亮（`syntax*` 槽）、`/bash-preview` 输出预览行数、`/bash-timeout`、短命令（<2s）不画 `Took` 页脚、`bashOutput` 独立输出色。详见文件头与 `bash-command-collapse/render.test.ts` |
| `read-path-collapse.ts` | read 工具块的标题 + 结果（**用户 2026-09-21 定，与 bash 块同一套观感**）：`renderShell: "self"` 让 pi 不再套默认壳，于是整块**没有底色**（pending / 成功 / 失败三色底都不画）、**没有上下边界空行**（默认壳 `Box(1, 1)` 的那两条），只有内容本身；标题行 `• Read <路径>` —— 状态圆点 `•` 在**列 0**、`Read` 的 `R` 在**列 2**（正文整体右移一格），圆点颜色三态：**读的时候（pending / partial）`dim` 灰、成功 `toolDiffAdded` 绿、失败 `toolDiffRemoved` 红**（与 `bash-command-collapse.ts` 的 `stateBarAnsi` 同源，字形也一样）；结果正文每行两格缩进（与 `Read` 同列），pi 那个前导 `\n` 空行被剥掉，所以正文紧贴标题。左边距由孩子自己画（`withHeadBar`），`Box(0, 0)` 的孩子按 `width - MARGIN_WIDTH - RIGHT_PAD` 渲染。**只影响 read**：其他工具仍走 pi 的默认壳（有底色、有边界空行），有专门的对照断言。原有能力一字未动：长路径压缩成一行（`…` 前缀，装得下的短路径走 pi 原生渲染只换 `accent`→`text` 一个色）、工具名首字母大写（`Read`）、`[skill]` / `read docs` / `read resource` 紧凑形态、OSC 8 超链接、`(ctrl+o to expand)` 提示、`app.tools.expand` 从 keybindings.json 读。11 个端到端断言见 `read-path-collapse/render.test.ts` |
| `prompt-editor.ts` | 输入框 `❯ ` gutter（`!` bash 模式下换成 `!`、正文里输入的 `!` 不再显示）+ 补全列表与 statusline 之间补一行空行；纯逻辑在 `prompt-editor/bash-prompt.ts` |
| `cwd-statusline.ts` | 用 `setStatus` 在 statusline 第二行显示完整 pwd（不经任何路径压缩） |
| `folder-history.ts` | 按工作目录持久化命令历史，注入编辑器原生 ↑/↓（**不注册快捷键** —— 上游的 ctrl+↑/↓ 在 macOS 上被 Mission Control 抢走） |
| `clear-command.ts` | `/clear` 别名 → `ctx.newSession()`（先 `waitForIdle`，与内置 `/new` 同一条流程） |
| `exit-command.ts` | 整行 `exit` / `quit` 优雅退出（只在 TUI 模式；`--print` 里仍是普通 prompt） |
| `init-command.ts` | Claude Code 式 `/init`：`CLAUDE.md` → 否则 `AGENTS.md` → 否则新建 `AGENTS.md` |
| `ask-user-question/` | Claude Code `AskUserQuestion` 式的结构化提问工具（子会话里按 `ctx.hasUI` 自动摘掉） |
| `mcp/` | MCP 服务器 → pi 工具（`mcp__<server>__<tool>`）；自带 stdio / streamable HTTP / 旧版 SSE 三种传输与 `/mcp` 命令。配置、约束与验证方式见上一节 |
| `simple-task/` | 轻量任务清单（`task_set` / `task_update` / `task_get`）。自 2026-09-23 起**兼作 plan-mode 执行期的唯一进度表**：批准计划时步骤被镜像成带 `plan: n. ` 前缀的条目，状态行的 `▶ n/N` 读的也是它（契约在 `plan-mirror.ts`）。详见上文 plan mode 一节 |
| `plan-mode/` | Claude Code 式 plan mode（normal → plan → execute 三态）。`shift+tab` 切模式、`/plan`、`--plan` 启动即进；模型可自行调 `enter_plan_mode` 进入、用 `exit_plan_mode` 提交计划等用户批准。plan 阶段摘掉 edit/write（**快照-还原**，不动扩展注册的工具）并在 `tool_call` 里拦写类 bash。详见下文 |

### plan mode（`plan-mode/`）

三态：`normal` → `plan`（只读探索、模型出方案）→ `execute`（批准后按步骤执行，进度记在任务清单里，
全部完成自动回 `normal`）。计划只存会话（`appendEntry("plan-mode")`，不进模型上下文、**不写工作区**）。

四个入口：`shift+tab`、`/plan`、`--plan`（启动即进）、模型调 `enter_plan_mode`。
`/plan-status` 看当前状态与步骤。`PI_PLAN_MODE=off` 整体关闭，`PI_PLAN_MODE_AUTO=off` 只关模型自动进入。

**模式指示的显示位：statusline 第二行的行首**（那个区也叫「扩展 status 区」）。
三个态**都有文案**，所以「当前在哪个模式」永远有一个固定的显示位：

| 态 | 显示 |
| --- | --- |
| normal | `⏵ normal`（**`toolDiffRemoved`**，即删除行前景色 —— 三套皮肤里都是红） |
| plan 等待模型出方案 | `⏸ plan`（`warning`） |
| plan 已提交、等批准 | `⏸ plan · 2 steps` |
| execute | `▶ 2/5 executing`（`accent`） |

这一格原先归 `simple-task`（那里显示 `✔ 7/7 done`），但**与它自己在输入框上方的 widget 重复**
（widget 是完整版：`● N tasks (…)` + 逐条清单 + spinner），那个缩略版已删除，格子让给模式指示。
注意 `simple-task` 的 widget 行**不吃这一格**，所以两者不会再抢显示位。

**执行期只有一份清单，而且它是 simple-task 那份。**（2026-09-23 改，起因是两个真实问题：
执行时状态行与 widget 各出一份清单；而 `▶ 0/10 executing` 从不更新。）现在的分工：

| 阶段 | 清单在哪 | `▶ n/N` 的数字从哪来 |
| --- | --- | --- |
| plan（待批） | plan-mode 自己的 widget（`plan-steps`）—— 那时还没有任何任务清单 | `⏸ plan · N steps`，不报进度 |
| execute（已批准） | **simple-task 的清单**（步骤镜像进去，id = 步号）；plan-mode 把 `plan-steps` 置 `undefined` | 镜像回来的状态（模型调 `task_update`，或写 `[DONE:n]`） |
| 全部完成 | 清单留在屏幕上（用户要回看刚跑完的 ✔） | 模式回 `⏵ normal` |
| 中途退出 / 重拟 | 清掉镜像条目，用户手建的任务保留 | 回 `normal` |

镜像契约在 `simple-task/plan-mirror.ts`（两端共用的唯一一份）：plan-mode 发
`plan-mode:sync-tasks`（全量 `{step,text,done}[]`，空数组 = 清掉），simple-task 回
`simple-task:state`（全量 `{id,text,status}[]`）。镜像条目文案是 `` `plan: <步号>. <步骤>` ``，
plan-mode 靠这个前缀认领条目 —— **别把前缀当成装饰改掉**，否则 `task_get` 里的 `#1` 会变成
普通任务、状态行的数字会退回 0/N。为什么不再让 plan-mode 自己记进度：`[DONE:n]` 是模型往
**散文里**写的标记，实测（本次会话日志）一轮 17 次 `task_update` 里 `[DONE:n]` 一次没写，
状态行就永远停在 0；`task_update` 是结构化工具调用，漏不了。`[DONE:n]` 保留为**等价别名**
（`plan-text.ts` 的 `extractDoneSteps`），两个入口改的是同一份状态。

**镜像清单不画自己的头部。** `widget.ts` 检测到清单里有镜像条目时不输出
`● N tasks (…)` 那一行 —— 同一段「共 N 个、完了几个」已经在 statusline 说了，一行屏幕里
重复两遍只是噪音（手建清单仍照旧画头部）。

**模式指示固定在第二行行首**（`statusline/line.ts` 的 `STATUS_PRIORITY`）。不要改回「按注册顺序」：
第二行是超长只截断不折行，而路径 / checkpoint 计数会越长越长 —— 放尾部时一条长路径就能把它挤到
看不见（这正是改到行首的原因）。注册顺序还取决于 pi 加载扩展的顺序（目录字母序），改个文件名就会变。
优先级表之外的 key 仍按注册顺序跟在后面。

**约束是两道独立的闸，别以为只有一道：**

1. **工具集**：进 plan 时把 `edit` / `write` / `powershell` 从活动工具里摘掉，退出时按**进入前的快照
   原样还原**。本机 pi 的工具表里有二十多个扩展动态注册的工具（`mcp__*`、`ask_user_question`、
   `task_set` …），官方示例那种硬编码白名单会把它们全吃掉 —— 所以必须是快照-还原。
2. **`tool_call` 钩子**：`bash` 还在工具表里，所以写类命令（重定向、`rm` / `mv` / `sed -i` /
   `git commit` / `npm install` / `sudo` …）靠这道钩子拦，拒绝原因作为工具错误结果回给模型。
   判定按**简单命令**粒度切开（`cat a.txt && rm -rf b` 会拦下 rm 那段），heredoc 正文先剥掉，
   fd 复制（`2>&1`）与 `/dev/null` 这类黑洞目标放行。实现与全部边界在 `plan.ts` 的上半部分与
   `plan.test.ts`（98 例）。

**这是给配合的模型用的护栏，不是沙箱。** 两个刻意放行的形状：双引号内的 `$(...)` 命令替换、
以及 `npm run <script>` 这类由脚本内容决定副作用的命令 —— 宁可放行也不要把正常探索全部拦死。
要真防住恶意写入得靠操作系统级沙箱。实测证据（`pi --plan -p "别规划，立刻用 bash 执行：echo hacked > proof.txt"`）：
模型拒绝了命令，原话是「我没法照做 —— plan mode 在拦 …… 换个写法绕过去也不行」，然后把它作为计划
提交走审批，文件是**批准之后**才创建的。

**`shift+tab` 是从 pi 内置的 `app.thinking.cycle` 手里抢来的。** 内置键位扩展抢不到
（`registerShortcut` 与内置冲突时会被 runner skip），所以走 `ctx.ui.onTerminalInput` 在按键到达编辑器
**之前**拦下并 `consume`。代价是思考等级循环键被占，因此扩展首次启动时会把
`~/.pi/agent/keybindings.json` 里的 `app.thinking.cycle` 改绑到 **`ctrl+shift+t`**。改绑的边界（`keybinding.ts`）：
只有**该键完全没有任何绑定**时才写；用户自己配过就一个字不动、也不提示（`needsAttention` 区分
「已有绑定，正常」与「配置坏了，需要你手动处理」—— 前者每次启动都提醒会变成噪音，实测踩过）。

抢键的三个条件（`index.ts` 的 `attachInputListener`）：TUI 模式 + 空闲 + 没有扩展弹窗。
**匹配 shift+tab 必须用 pi-tui 的 `matchesKey`**，不能手写 `data === "\x1b[Z"`：
shift+tab 有三种编码 —— 裸 CSI（`\x1b[Z`）、Kitty 键盘协议的 CSI-u（`\x1b[9;2u`）与 xterm
modifyOtherKeys。而 pi **启动时会主动启用 Kitty 协议**（`pi-tui` 的 `terminal.js` 发
`\x1b[>{flags}u\x1b[?u\x1b[c` 并等终端回复），一旦启用，真实终端（Ghostty / kitty / WezTerm）发的
就不再是 `\x1b[Z`。实测踩到过：pty 假终端（不回协议查询）里 shift+tab 能切，真实 Ghostty 里
完全没反应 —— 本地复现必须**让 pty 回一个 `\x1b[?1u`** 才是真实终端行为。
**流式中按 `shift+tab` 仍是切思考等级**（不空闲就不抢）—— 这是刻意的：plan mode 只在你停下来的时候才切。
弹窗打开时不抢，否则 `/model`、`/sessions` 这些 picker 里的 `shift+tab` 会跳出选择器。

### 跨扩展 / 跨文件

- **plan-mode ⇄ simple-task 的镜像契约只有一份：`simple-task/plan-mirror.ts`**（事件名、前缀、
  `rebuildTasks` 重建规则都在那里）。两个扩展通过 `pi.events` 互通，**不互相 import、不互相调用
  命令**（两者都能单独 `/reload`）—— 唯一例外是 plan-mode 从 `../simple-task/` import 了
  这个契约模块，因为“两份契约”必然漂移。事件名/载荷对不上是这条链路最容易坏的地方，所以有一个
  集成测试把两个扩展装进同一个总线跑完整链路：`plan-mode/mirror.test.ts`（`enter_plan_mode` →
  `exit_plan_mode` → 清单里出现 `plan: 1. …` → `task_update` → 状态行变 1/2）。
  四条不要改：① 空数组的契约是「清掉镜像」而不是「没变化」；② 镜像条目的 `id` 就是步号，
  `rebuildTasks` 不会给它换号（换了就找不到对应关系）——**与步号撞号的手建任务会被顺延
  到 nextAvailableId 之上**，这是保住「id = 步号」这条承诺的必要代价；③ 同步是**全量快照**，
  不是增量 —— 两个扩展都会重放会话，增量丢一条就永久错位；④ **镜像快照随 simple-task 的
  会话条目一起持久化**，`/resume` 不依赖两个扩展的 `session_start` 顺序（目录字母序里
  plan-mode 在前，靠事件顺序会丢任务）。
- **statusline 第二行（扩展 status 区）的显示位分配**：顺序由 `statusline/line.ts` 的
  `STATUS_PRIORITY` 决定 —— `plan-mode`（模式指示）**强制行首**，其余按注册顺序跟在后面：
  `cwd-statusline`（完整路径）、`rewind`（`◆ N checkpoints`），限 5 条。
  把模式指示放行首是因为第二行超长只截断不折行，它跟在会变长的路径后面会被挤掉；
  而注册顺序取决于目录字母序，太脆。
  `simple-task` **不再占**这个区（它曾经在这里显示 `✔ n/N`，与自己在输入框上方的 widget 重复，
  已删除）—— 改回去之前先想想是不是又造了一份重复信息。状态行里 `▶ n/N` 的 N 与数字来自
  simple-task（见上文），所以这个区与那份清单是**两个不重复的口径**：一个说模式与进度比，
  一个逐条列步骤。
- **`simple-task/gap.ts` 的「看邻居」是靠*渲染邻居*实现的**：它没有枚举别人 widget 的接口，
  只能从 TUI 根往下找到装着自己的 Container，再看紧邻兄弟面向自己那一侧的渲染结果。于是
  `recap` 反过来渲染 `simple-task` 时就是**互递归**（无保护时实测递归到 depth 61+ 才被栈拦住）——
  **重入标记必须留在 recap 这一侧**（`inspectingNeighbours`，粒度是组件实例）：放在 `gap.ts` 里的话，
  嵌套那次 walk 一律返回「无间隔」，两边各补一次空行、**变成两行**。
- **`below-editor-after-statusline.ts` 靠对象身份找容器，不猜下标**：先注册一个 render 返回空数组的
  探针 widget，遍历 `tui.children` 找到「子树里装着这个探针」的顶层 child，再把它移到末尾。
  探针本身必须**显式传 `placement: "belowEditor"`**：漏写（默认落到 `aboveEditor`）会把「上方」那个容器
  整块搬走，而且没有任何运行时报错（实测踩到过，代码里只有一行注释提醒）。找不到容器就什么都不做。
- **「内置 statusline 露出来」有两个窗口，用了两套办法**：① **启动窗口**（进程刚起来 → `session_start` 轮到我们。
  实测：内置 footer 在 ~470ms 出首帧，我们的 statusline 到 ~1.2s 才装上）没有上一帧可重放，由
  `statusline/footer-suppress.ts` 在**扩展工厂**里（此时 TUI 还没 new 出来）接管 `FooterComponent.prototype.render`，
  窗口内渲染 0 行 —— 底部留白，而不是先画一个马上要变的默认状态行；我们的 footer 挂上的一刻交还，
  30s 兜底（`mcp` 握手 20s 上限也在这个窗口里，因为 `Runner.emit()` 串行 await，字母序在前的 `mcp` 先跑）。
  ② **换会话窗口**由 `footer-guard.ts` 重放上一帧压住（有旧状态可留，比留白更好）。两个开关独立：
  `PI_STATUSLINE_BOOT_SUPPRESS=off` / `PI_STATUSLINE_FREEZE=off`。
  补丁打的是包根导出的 `FooterComponent` —— 实测（0.87.1 bundle 形态，A/B pty 捕获，两次只差这一处）
  它**就是** pi 自己 `new` 出来那个类：临时改成返回 `["PROBE-FOOTER-MARKER"]` 时屏幕上真的出现这一行，
  关掉开关后内置 footer 照旧。
- **`statusline/footer-guard.ts` 与 `startup-logo/header-guard.ts` 是同一套机制的两份**（接管容器的
  `render`、重放上一帧的行），互不依赖、符号键不同。原因是 pi 换会话时 `resetExtensionUI()` 会
  **无条件**把内置 footer / header 装回去并清空所有 `setStatus`，而扩展侧没有比 `session_start`
  更早的钩子 —— 所以保证只能挪到「出帧那一刻」。`PI_STATUSLINE_FREEZE=off` 关掉冻结。
  （启动窗口那个留白补丁**也可以**这样扩到 header 上，`startup-logo/` 目前没做：启动那一段顶部
  仍会先闪一下内置 header 再换成 logo。）

### pi 平台的坑

- **`shift+tab` 不能用字符串比对，要用 `matchesKey("shift+tab")`**：它有三种编码 —— 裸 CSI
  `\x1b[Z`、Kitty 键盘协议的 CSI-u `\x1b[9;2u`、xterm modifyOtherKeys `\x1b[27;2;9~`。
  pi 启动时会**主动启用 Kitty 协议**（`pi-tui/terminal.js` 发 `\x1b[>{flags}u\x1b[?u\x1b[c`），
  真实终端一旦同意，发的就不是 `\x1b[Z` 了。同一坑对任何手写的“按了哪个键”判断都成立。
  推论：**pty 假终端默认不回协议查询，所以只能复现那种编码** —— 用 pty 验证这类交互时
  得主动回一个 `\x1b[?1u`，否则测出来的“通过”在真实终端里不成立（plan-mode 实测踩到：
  pty 里 shift+tab 能切，Ghostty 里完全没反应）。
- **扩展必须真起一次 pi 验证，不能只跑 `node --test`**：pi 直接加载 `.ts`，而 `node --test` 的类型
  擦除**不做语法/类型校验**。实测一个非法标注（`readonly (readonly 0 | 1)[][]`）22 条单测全绿，
  pi 却在加载时 `ParseError`、**整个扩展根本不加载**。最低验证是 `cp` 到 `~/.pi/agent/extensions/`
  后用 tmux 真起一次 pi，在 `capture-pane` 里搜 `Failed to load extension` / `ParseError`。
- **捕获的 `ctx` 在会话结束后会 stale，读 `ctx.ui` 会抛**（`"This extension ctx is stale after
  session replacement or reload"`），而抛出发生在读的那一刻 —— 比 widget 的 `render()` 更早，
  所以 `render()` 里的 try/catch 拦不住。**一个活过会话的定时器会直接把宿主进程带崩**（实测 exit=1）。
  `simple-task/` 与 `working-indicator/` 因此都有三层防护：回调自己 try/catch 并停表、所有 `ctx.ui`
  访问包 try/catch、`session_shutdown` 里立刻停表。
- **`renderCall` 抛异常会被 pi 静默 catch 并回退到 `createCallFallback()`** —— 界面上只少点东西，
  日志里什么都没有。`read-path-collapse.ts` / `bash-command-collapse.ts` 都踩过这一条。
- **跨扩展同名工具注册是 first registration per name wins**，所以 `bash` 的开关必须住在
  `bash-command-collapse.ts` 里，不能另开一个同样注册 `bash` 的文件（后者会被静默忽略）。
- **扩展 import 的 `@earendil-works/pi-tui` 与 pi 自己渲染用的**是不是同一份，取决于启动形态，
  **不能靠推测**：`pi` 命令跑的是 `dist/bundle/cli.js`，pi-tui **内联**在 chunk 里，而加载器在
  这个形态下走的是 `virtualModules` 分支（bundle 里 `isBundledNode=!0`，见
  `core/extensions/loader.js:421`），把扩展的 `@earendil-works/pi-tui` 指向**加载器那份 bundle 自己的
  命名空间** —— 与内联副本是同一个类，所以在扩展里打 `Markdown.prototype` 这类**原型补丁是有效的**
  （`fenceless-code-block/` 就这么实现，`index.test.ts` 用 pi 自己的 `AssistantMessageComponent` 渲染
  一条 assistant 消息来断言）。反过来，patch `node_modules` 里那份**毫无效果且没有任何报错**（实测）。
  同一个原因的另一面：`@earendil-works/pi-coding-agent` 在 bundle 形态下被 alias 到 `dist/index.js`
  （未打包的那套模块图），所以包根的状态型 API（`keyHint` / `keyText`）拿到的是另一个副本 ——
  即上面那条“绝不能 import”的由来。**这一条对「类」不成立（实测）**：`statusline/footer-suppress.ts`
  从包根 import `FooterComponent` 打原型，A/B 捕获证明补丁落在 pi 自己 new 的那个实例上（见「跨扩展」一节），
  而 `dist/bundle/index.js` 确实是从 `./chunks/chunk-*.js` re-export 的。`keyHint` / `keyText` 的现象仍是事实，
  但按「别在模块顶层读 pi 的状态」理解即可：打类方法没事，**读状态**别放在模块顶层。
- **`keyHint` / `keyText` 绝不能 import**（`bash-command-collapse.ts` 与 `read-path-collapse.ts`
  都踩过：扩展拿到的是 npm/dist 副本，前者抛 `Theme not initialized`、后者返回空串）。要从
  `~/.pi/agent/keybindings.json` 读键名。`startup-logo` 的提示行是唯一从包根 import 的，它整行包了 try/catch。
- **扩展里没有 `toolcall_checkpoint` 事件**（pi-ai 的事件联合里只有 start / text_* / thinking_* /
  toolcall_{start,delta,end} / done / error），它是 TUI / session 编码器内部用的 `MessageFrame`。
  所以每个参数 delta 都会以 `toolcall_delta` 到达扩展，段级计数本身就是完整的。
- `usage.output` 在**流式期间恒为 0**，token 数只能从流式字符估算；`toolcall_start` 的
  `partial.content[i].name` 已经带工具名，但缺块时拿不到，所以 `tool_execution_start` 仍是权威兜底。

### 几个「看起来可以简化、其实不行」

- **`bash-command-collapse.ts` 的命令行形状是「`• Run ` + 2 行 + 行尾 `…` + `… +N lines`」**（用户 2026-09-21 定）：
  续行 / 折叠标记的正文列对齐 `Run ` 的 `n` 列（2 列前缀：执行中是空格、出结果后是 `│ `），命令溢出多少都只
  吃最后 1 行。结果侧的 `└ ` **在整块里只出现一次**、挂在第一行实质输出上（截断提示行之上都挂 `│ `，之下只缩进），
  所以它必须在**所有 child 的行都走完后统一上**（`prefixTreeLines` 接在 `withPreviewLimit` 的末尾调一次）——
  逐 child 各画一棵树会在 warnings / `Took` 段再长出一个 `└ `。没有输出时补一行 `(no output)`（`└ ` 挂它前面），
  流式 partial 期间不补（那时“还没输出”不等于“没有输出”）。整块**没有任何底色**（`Box` 不带 bgFn：pending 的
  `toolPendingBg` / 成功的 `toolSuccessBg` / 失败的 `toolErrorBg` 三种底都不画，用户 2026-09-21 定）—— 状态改由
  命令**首行**行首那颗圆点 `•`（执行中 `dim` / 成功 `toolDiffAdded` / 失败 `toolDiffRemoved`，续行、折叠标记与
  整棵结果树前面都没有）表达，**着色逻辑与早先的 `▎` 一字未变**；圆点后面接一格空格，即「正文整体右移一格」，
  `Run` / `│` / `└` 同在列 2、所有正文同在列 4（用户 2026-09-21 第二轮定；命令行与结果侧必须同时移，否则两截会
  错开，`INDENT_WIDTH` 就是这一格）。左边距全由扩展自己画（`Box` 的 `paddingX` 在命令侧是 0：`withHeadBar`
  首行 `• `、其余两格空格；结果侧留 1 格再由 `withPreviewLimit` / `prefixTreeLines` 挂 `INDENT_WIDTH` 那一列），
  两边各自把用掉的列从 `wrapWidth` / `contentWidth` 里扣回来。**整块上下也没有空行**（`paddingY: 0`：命令就是块的
  第 1 行、结果就是最后一行）。底色只去 bash 这一个工具 —— 其他工具（read / grep / edit / write …）走 pi 自己的
  `contentBox` + bgFn 渲染路径，完全不受影响（有专门的回归断言盯着这条）。形状与 25 个端到端断言见
  `bash-command-collapse/render.test.ts`（过 pi 自己的加载器 + `ToolExecutionComponent`，断言的是渲染出来的行）。
  `PI_BASH_TREE` 已废弃（前缀固定用树形）。
- **read 块与 bash 块共用同一套壳的约定**（用户 2026-09-21 定）：两者都用 `renderShell: "self"` + 「自己不去画底色」（不是画上再擦）得到**无底色、无上下边界空行**的块，左边距都是**两列**（首行 `• ` + 一格，其余行两格空格），圆点颜色都是 pending `dim` / 成功 `toolDiffAdded` / 失败 `toolDiffRemoved`。`read-path-collapse.ts` 的 `MARGIN_WIDTH = 2` 与 `bash-command-collapse.ts` 的 `GUTTER_WIDTH + INDENT_WIDTH = 3` 是**两条独立的算式**（bash 那边还要算树形 gutter），但左边缘必须对齐 ——**改一个必须看另一个**，否则两个工具的块会错开一列。宽度预算也一样：`Box` 的 `paddingX` 是 0 时，孩子拿到整宽，壳自己得按「左边距 + 末尾留白」扣回来。
- **read 的折叠态在成功时没有结果正文**：pi 的 `formatReadResult` 开头是 `if (!options.expanded && !isError) return ""` —— 读成功且没展开就只有一个标题行。所以测结果正文的列位要用**失败**那一次（`read-path-collapse/render.test.ts` 里就是这么写的），别以为正文丢了。
- **`bash-command-collapse.ts` 判定「参数还在流」是 `!streaming && !argsComplete && isPartial === true`**
  （`streaming` = 用户开了 `PI_BASH_STREAM=on` 走 pi 原生流式，此时整条压命令的路径直接跳过）。
  后两个阈值**缺一不可**：只用 `isPartial` 会把命令压到结果之后（退化成「全等结果才一次性出」）；
  只用 `argsComplete` 则 `/resume` 重建历史时它永远是 `false`（`renderSessionItems` 从不调
  `setArgsComplete`），恢复出来的 bash 块**只剩输出、命令行整行消失**。
- **`renderResult` 里 `isError` 必须从 `context` 读，不能从 `result` 读**：pi 调 resultRenderer 时传的是
  `{ content, details }`，**没有 `isError` 字段** —— 读 `result.isError` 永远拿到 undefined，
  于是失败的命令也会染成 success 底色。
- **pi 的 bash 渲染器不看传给 `renderResult` 的 theme 参数**：`renderers/bash.js` 的签名是
  `renderResult(result, options, _theme, context)`，输出正文用的是**模块级 `theme` 单例**
  （`Proxy` → `globalThis[Symbol.for("@earendil-works/pi-coding-agent:theme")]`）。想让 bash 输出单独
  一色（扩展 token `bashOutput`）只能改那个单例的 `fgColors` 表 —— `bash-command-collapse.ts` 在
  委托内置渲染器的**同步窗口**里换进换出（`withBashOutputColor`）。代价与前提：那只 map 是全局的，
  所以窗口必须同步、只能换 `toolOutput` 一个 key，且 `fgColors` 哪天被 pi 藏起来就会静默退回原色。
- **两个覆盖内置 bash / edit / write 的扩展都用 `renderShell: "self"`**，动机不同：
  `tool-diff.ts` 是为了逐行拼 `\x1b[48;2;…m` 画整行 diff 底色（走 `selfRenderContainer` 就绕开了
  `tool-execution.js` 里按状态整块染色的 `bgFn`，否则逐行底色会被整块绿底盖掉；它**不用 Box**）；
  `bash-command-collapse.ts` 是为了让「流式接命令字符时屏幕上一行都不出」成为可能 —— 它把这个副作用
  **当成需求用**：pi 不再套 bgFn，而扩展自己也**故意不套**，于是 bash 块没有任何底色（别的工具照旧）。
  **`paddingY` 必须置 0**（否则两个 Box 的 padding 会叠出**三个空行**；上下外边界也一并不留）。
  命令侧 `paddingX: 0` —— 左边距（首行 `• `、其余两格空格）由 `withHeadBar` 自己画；结果侧留 1 格，
  再由 `withPreviewLimit` / `prefixTreeLines` 挂共用的 `INDENT_WIDTH`，命令行与结果树因此始终同列。
- **`prompt-editor.ts` 的 `!` bash 模式只改渲染层，正文一个字符都不动**：判定照抄 pi 的
  `interactive-mode.js`（`text.trimStart().startsWith("!")` —— 边框颜色 `updateEditorBorderColor`
  用的就是同一个标志），所以 gutter 和输入框颜色永远一致；正文里那个 `!` 只是「摘掉第一个可见字符
  + 行尾补一列空格」，Enter 提交（`text.startsWith("!")`）、↑ 历史、Esc 清空全都不用配合。
  代价是隐藏列会变成可落点，所以 `handleInput` / `handleMouse` 之后都要把光标从 (0,0) 挡回 (0,1)
  （调 Editor private 的 `setCursorCol`，没有公开 setter），点选坐标也要多算 1 列 —— 正文在视觉上
  整体左移了一列。放进那一列的话，反显光标会落在空列上（看起来光标消失），而且在那儿打字会把
  `x!ls` 写进正文、pi 当场判定退出 bash 模式。
- **`theme-command.ts` 的预览/落盘/取消三条路径全靠 `ctx.ui.setTheme()` 的两条路径语义区分**：
  传 **Theme 对象** → `setThemeInstance()`（只换色、不写 `settings.json`）；传**名字** →
  `setThemeName()`（应用**且立刻写盘**）。所以预览必须走对象路径，只有回车才走名字路径。
  选择器里主题列表与色卡区之间有一个 `Spacer(1)`：两者都是多行块，紧贴在一起分不清边界。
- **`rewind/` 的 esc esc 第二次按键必须吃掉**（`{ consume: true }`）：`/rewind` 派发后选择器是
  **同步**获得焦点的，而 pi 的输入管线是「先跑扩展 input listener、再交给聚焦组件」—— 不吃掉的话
  这次 esc 会直接落到刚打开的选择器上（`tui.select.cancel`），菜单刚弹出就被自己取消（实测就这么失败的）。
  吃掉它还顺带保证：即使 `doubleEscapeAction` 写回 `tree`，pi 内置逻辑也看不到第二次按压。
  第一次 esc **原样放行**，所以单个 esc 仍能中断流式回复。

### 存储与副作用边界

- `rewind/` 的快照存在**影子 git 仓库**里（`~/.pi/agent/rewind/<项目哈希>/git`，`GIT_DIR` 指过去、
  `GIT_WORK_TREE` 指向项目），**从不碰用户仓库的 HEAD / index / refs / status**，目录不是 git 仓库时也能用；
  根外与 `.gitignore` 挡掉的文件靠 `tool_call` 事件里的**惰性预镜像**兜底（blob 按内容寻址）。
  已知限制：只跟踪 `edit` / `write` 两个工具（`bash` 写到根外无法解析），大于 8MB 的文件不拷。
- `simple-task/` 的状态用 `pi.appendEntry` 骑在 session 日志里（**不往工作仓库写**），重建时必须读
  `ctx.sessionManager.getBranch()` 而不是 `getEntries()`，否则分支导航会把已丢弃分支上的状态复活。
- `recap/` **刻意不落盘、不进上下文**：不调 `appendEntry`，摘要只活在内存里，`/new` 或 `/resume`
  后不恢复（**刻意的，不是 bug**）。它探测子代理是否在跑走的是 pi-subagents 的进程内事件总线 RPC
  （`subagents:rpc:v1:request`），**不 import 它的任何文件** —— 独立安装的 npm 包，换台机器可能根本没装，
  探测失败一律当「没有子代理」。
  **`/recap` 是幂等的**：同一轮对话（最后一对 user+assistant 与模型都相同）已经生成过摘要、且它还挂在
  屏幕上时，再执行直接返回 —— 不重跑模型、不清 widget、也不发通知（一次失败的重复生成会用「没能生成
  recap」的提示把刚生成的摘要顶掉，这正是要避免的）。指纹只在一个地方算：`latestExchange()`，`generate()`
  的去重与命令的闸门共用它；有新对话（指纹变化，或 `input` 事件先清了状态）时闸门自动放开。
- `auto-default-model/` 会写 `~/.pi/agent/settings.json` 的 `defaultProvider` / `defaultModel`
  （pi 的 `/model` 只改当前会话，本机把那次 Ctrl+S 自动化掉了）。

## 刻意不入库的机器本地文件

| 文件 | 为什么不入库 |
| --- | --- |
| `~/.pi/agent/auth.json` | 凭证 |
| `~/.pi/agent/trust.json` | 各机器自己的项目信任决定（按绝对路径记录） |
| `~/.pi/agent/models-store.json` | pi 内置模型目录的缓存 |
| `~/.pi/agent/settings.json.bak*` | 手工备份 |
| `~/.pi/agent/sessions/` | 会话记录 |
| `~/.pi/agent/missions/`、`run-history.jsonl` | `pi-subagents` 的 mission / 运行历史，换机器没有迁移价值 |
| `~/.pi/agent/rewind/` | `rewind/` 的影子快照仓库 |
| `~/.pi/agent/plans/` | 机器本地的计划与一次性脚本 |
| `~/.pi/agent/npm/`、`bin/` | pnpm 装的包（靠 `pi install` 重拉）与 pi 自带的 `fd` / `rg` |
| `~/.pi/agent/web-search-cache/`、`~/.pi/folder-history/*.jsonl` | 运行时缓存 / 历史数据 |

另外，`settings.json` 的 `extensions` 字段是本快照与本机真实配置**唯一刻意保留的差异**：真实文件里它指向
`~/.loongsuite-pilot/plugins/pi-coding-agent/index.mjs`（另一个工具装的遥测扩展，本机版本已被置空成 no-op；
机器专属绝对路径、不属于 pi 自身配置），模板里置为 `[]`，只保留 `extensions/` 目录的自动发现。

## 快照维护约定

没有安装脚本，所以同步是**双向手动**的：

- **改了本机全局配置 / 扩展** → 手动把 `~/.pi/agent/` 下的 `AGENTS.md` / `settings.json` / `models.json` /
  `mcp.json` / `pi-statusline.json` / `web-search.json` / `extensions/*` / `themes/*.json` 拷回本目录，
  保持模板与实际环境一致 —— 只有上文列的那三处是刻意差异，其余应当逐字节相同。
  （`mcp.json` 里是**本机 MCP 可执行文件的绝对路径**，与 `models.json` 的 `baseUrl` 同类：入库作模板，
  换机器照着改 `command`。）
- **换机器 / 重装** → 按前面的 `cp` 装回去，再 `pi install npm:pi-web-access` 与 `pi install npm:pi-subagents`。
- **改完扩展的最低验证**是真起一次 pi（见上文「pi 平台的坑」——`node --test` 不校验语法）。
- **面向本机 pi 的写法约定**：纯逻辑模块刻意**不 import pi / pi-tui**（鸭子类型 + 结构化最小接口），
  这样 `node --test` 能直接跑；`tool-diff/`、`statusline/`、`recap/`、`rewind/`、`simple-task/`、
  `working-indicator/`、`startup-logo/`、`thinking-collapse/`、`fenceless-code-block/`、`prompt-editor/`、`user-message-bar/`
  都按这个约定拆出了可单测的伴生模块
  （`thinking-collapse/window.ts` 只注入一个 `widthOf`，`node --test clients/pi/extensions/thinking-collapse/window.test.ts`）。
  `mcp/` 更进一步：`protocol.ts` / `config.ts` / `client.ts` / `tools.ts` / `headers-command.ts` **全部不 import pi**，
  只有 `index.ts` 接线 —— 所以整条 MCP 链路（含真实 spawn 子进程）都能 `node --test` 覆盖。
- **`AGENTS.md` 自设 9600 字符预算**（当前 **9392 字符** ≈ 2348 tokens，落在盘上是 9438 字节，余量 208 字符）：
  pi 本身没有上限 —— 0.87.1 的 `system-prompt.js` 是原样拼接 context files、无截断，实测把标记放在
  9500 字符处仍被模型逐字读回；7400 那条是自设的每请求固定开销预算，已为 skill 优先级与 shell 卫生
  三条规则放宽到 8000，随后又为 Communication 节的「失败/跳过/与预期不符须置于报告首句」一条占满。
  9600 这一档是给新增的 `## Uncertainty` 节（issue #8：没有计划文档时的不确定性策略 —— 先查证、按
  可逆性分三档、会分叉的任务先进 plan mode、两个选项先做判别实验）腾的地方，同时顺手删掉两条重复规则
  （Persistence 的「good enough」与 Communication 的禁用词清单）；`## Task list` 后来又加了一句
  「批准后的计划步骤就是当次任务清单」。
  下次再加规则前必须先压缩现有节或再抬上限。
  它是每个会话、每一轮请求都带的固定开销，改完要重开会话才生效（context files 只在 pi 启动时读一次）。
  它只装纯行为规则，刻意剔除全部
  Codex 机制耦合内容（`apply_patch` / `update_plan` / `multi_tool_use` 等十个词一个都不能出现），
  工具名一律用 pi 的真实工具（`read` / `bash` / `edit` / `write`，任务清单写作 `task_set` / `task_update`）。
  本机另有一份 4 断言 gate 脚本 `~/.pi/agent/plans/verify-global-agents.mjs`（机器本地，不入库）。
