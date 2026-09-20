# Pi Coding Agent 全局配置模板

pi（`@earendil-works/pi-coding-agent`）的全局配置与扩展脚本快照，作为本机 pi 环境的模板标准。
本机装的是 pi **0.85.1** + `pi-web-access` **0.29.0** + `pi-subagents` **0.68.0**。

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
cp -R clients/pi/extensions/simple-task        ~/.pi/agent/extensions/
cp -R clients/pi/extensions/recap              ~/.pi/agent/extensions/   # 依赖上一行的 gap.ts（跨目录相对 import）
cp -R clients/pi/extensions/rewind             ~/.pi/agent/extensions/
cp -R clients/pi/extensions/statusline         ~/.pi/agent/extensions/
cp -R clients/pi/extensions/auto-default-model ~/.pi/agent/extensions/
cp -R clients/pi/extensions/startup-logo       ~/.pi/agent/extensions/
cp -R clients/pi/extensions/ask-user-question  ~/.pi/agent/extensions/
cp -R clients/pi/extensions/subagent-log-guard ~/.pi/agent/extensions/
cp -R clients/pi/extensions/fenceless-code-block ~/.pi/agent/extensions/   # 子目录形式：纯逻辑在 render.ts（不 import pi，可单测）
cp -R clients/pi/extensions/user-message-bar   ~/.pi/agent/extensions/   # 同上：纯逻辑在 bar.ts
cp -R clients/pi/extensions/working-indicator  ~/.pi/agent/extensions/
cp -R clients/pi/extensions/mcp                ~/.pi/agent/extensions/   # MCP（纯逻辑模块 + fixtures 一起拷）
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
  qoder 目录里 `qmodel_38max` / `qfmodel` / `dfmodel` 三条是 `is_vl: true`，前两条实测发纯色 PNG
  能被正确识别。其余条目别顺手补 image —— idealab 后端吃不下，同一张图发过去是 HTTP 400。
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

- `pi-coder-summer-night.json` —— 本机自写皮肤，**当前在用**。调色板以 [iceberg.vim](https://github.com/cocopon/iceberg.vim)
  （cocopon，`colors/iceberg.vim` 里 `&background == 'dark'` 那一段 + 它末尾 `terminal_ansi_colors` 的 16 个色值）为底，
  39 个 `vars` 分三类：**26 个是那里的字面值**（折 21 个不同色值，5 组同值：`magenta` / `moonLilac` = `#a093c7`、
  `cyan` / `sky` = `#95c4ce`、`ayuThinking` / `dimText` = `#6b7089`、`bashOutput` / `ui` = `#818596`、
  `comment` / `frame` = `#515e97`）；**1 个是按前者算出来的** —— `commentBright`（`comment` 的 HSL 饱和度与亮度各 ×1.3 =
  `#6e7dc0`；这条规则能逐字复现上一版的 `#565f89` → `#707cb2`，所以照用了），只给 `syntaxComment` 用；
  **12 个是上一版留下的底色、按要求一个没动** —— `night` / `panel` / `select` 三个主底色、`find`（上一版从 VS Code
  `editor.findMatchBackground` `#3d59a166` 压出来的实色等价物），以及下面这几类：
  `addedLine` `#1c241b` / `removedLine` `#2e1c21` **取自 `pi-coder-catppuccin.json`**（就是 catppuccin 里同名 token 指向的
  `diffAddedBg` / `diffRemovedBg`，本仓只喂 `toolDiffAddedBg` / `toolDiffRemovedBg` 这两项）；
  `pendingCard` / `successCard` / `errorCard` 是**暗化卡片底色**（上一版按 `#1a1b26` / `#1d2631` / `#291f29` 统一乘 0.6，
  感知亮度 L\* 降约 50%），也就是所有工具调用色块（Read / bash / task_set / Edit / Write … 的 pending、ok、error 三态）的背景；
  `ayuUserBg` `#1b1c1d` 是**从 `pi-coder-ayu.json` 搬回来的**（ayu 的 `userMessageBg`，给 `userMessageBg` —— 比它之前的藏蓝 `#1e202e` 略暗、去蓝）；
  再加上 `thinkingGrey` `#626262`（只给 `thinkingXhigh` / `thinkingMax`，两档同色）。**这一轮改的只是前景与线条**，
  变量名仍沿用 Tokyo Night 的旧名（`teal` 里装的是青、`moonLilac` 里装的是另一个青、`ayuThinking` 里装的是 iceberg 的灰），
  改色时以文件为准。灰阶对位：正文 `fg` `#c6c8d1` = `Normal`；`ui`（muted）`#818596` = `StatusLine` 前景、
  `ghost`（thinkingLow）`#686f9a` = `Folded` 前景、`comment`（thinkingMinimal 与滚动条拇指）`#515e97` = `SpecialKey`、
  `ayuThinking` / `dimText` `#6b7089` = `Comment`（按你要求 dim 与 Think 同色；两个变量同值但**各立一个 `vars`** ——
  这仓的习惯是「改一个不连带改另一个」）、`markdown`（工具输出正文）`#a3adcb` = `TSFunction`、`brace`（标点与列表点）`#cdd1e6` = `CursorLineNr` 前景、
  `white` `#d2d4de` = 它的亮白 15。线条按「越实越亮」排：`hairline`（borderMuted）`#2a3158` < `slate`（代码块边框 / thinkingOff）`#3e445e`
  < `quote`（引用条）`#444b71` < `frame`（border）与 `comment` `#515e97` < `separator`（mdHr）`#5b6389`
  —— 这五个的来源依次是 `CursorLineNr` 底色、`MatchParen` / `StatusLineNC` 底色、`LineNr` / `SignColumn` / `FoldColumn` 前景、
  `SpecialKey`、`PmenuSel` 底色（`comment` 与 `frame` 同值，因为滚动条拇指/最低档思考边框与编辑器外框本来就是一个亮度）。彩色一律取 iceberg 的终端色：
  `red` `#e27878` / `green` `#b4be82` / `yellow` `#e2a478` / `magenta` `#a093c7` 是它第 1 / 2 / 3 / 5 号，
  `orange` `#e9b189`、`cyan` `#95c4ce`、`sky`（accent、borderAccent、syntaxType）、`operator`（mdHeading、syntaxOperator）`#91acd1`
  是亮色号，`blue` `#84a0c6` 是它的 `Function` / `Statement` / `Type` / `Operator`，`teal` `#89b8c2` 是它的 `String` / `Identifier`，
  `moonLilac` / `magenta` `#a093c7` 是它的 `Constant`（第 5 号紫）。
  **四条存心 deviation**，加一条范围说明：

  1. **`syntaxKeyword` 与 `mdCode` 走 `moonLilac` 紫 `#a093c7`**（= iceberg 的 `Constant`，上一版是旧 summer-night 传下来的深青 `#0d92c1`），不是 iceberg 的 `Statement` 蓝 ——
     保住「关键字与行内代码同色」的形状；之所以拿紫不拿青：iceberg 的青只有一档 `#89b8c2`，已经给了 `teal`（成功 / 链接 / diff 新增），
     关键字再占它的话 markdown 里**行内代码会与链接同色**、代码里关键字与 `syntaxType` 只差一档亮度（1.14:1）；
     紫与函数蓝（`#84a0c6`，|ΔL| 1.04:1）、类型青（`#95c4ce`，1.48:1）亮度也接近，但色相分得很开。
  2. **`syntaxString` 走绿 `#b4be82`**，而 iceberg 的 `String` 其实是青 `#89b8c2` —— 沿用「字符串=绿」的分工。
  3. **最高两档思考档仍是中性灰 `#626262`**（不是 iceberg 的蓝灰）—— 同 pi-coder-ayu 那节第 2 条：彩色边框读着像报错。
  4. **`commentBright` 是算出来的**（见上），不是字面值。
  5. **12 个底色没变**（见上），这一轮只换前景与线条。
  当前层级（相对终端底色 `#040404`）：工具卡片 1.08-1.14:1 < 用户消息 1.201:1 < diff 行 1.273-1.286:1 —— 因为卡片被暗化过、
  而 catppuccin 的 diff 底色本身很含蓄，diff 行现在只比它所在的卡片亮 1.9-2.1×（catppuccin 自己的卡片是 2.6-3.5×）。
  对比度（相对 `night` `#1a1b26`，括号里是上一版同项）：正文 10.24（8.10）、muted 4.66（4.18）、dim 3.50（3.59）、
  代码注释 4.36（4.24）、关键字 6.10（4.80）、函数 6.37（6.79）、类型 9.01（8.11）、字符串 8.65（9.35）、数字 9.05（8.40）、
  标点 11.28（8.93）、错误 5.85（6.46）—— 整体比上一版亮一档、艳度降一档（iceberg 的色偏灰）。
  `colors` 里没有一个字面量色值（全引用 `vars`；`text` 指向 `fg` `#c6c8d1`，不是 `""` 的终端默认前景）。
  注意 **`toolDiffAdded` 用 `teal` `#89b8c2`（iceberg 的 6 号青），不用 `green` `#b4be82`** ——
  后者在这套皮肤里是字符串色。想要传统“绿 add”只需把这一个 token 改指 `green`。
- `pi-coder-catppuccin.json` —— 移植上游 [bacnh85/pi-extensions](https://github.com/bacnh85/pi-extensions)
  的 Catppuccin Mocha 皮肤。与 `pi-coder-summer-night` 一样全走 `vars`（`bgAnsi()` 对整数会直接发
  `48;5;N`，所以上游遗留的唯一一个 256 色索引 `toolPendingBg: 233` 已改成 hex
  `#140e1e`，现在三份皮肤都没有整数字面量）。
- `pi-coder-ayu.json` —— 移植 [iodic/pi-ayu-themes](https://github.com/iodic/pi-ayu-themes) 的
  `ayu-dark`（官方 Ayu 调色板），**格式照 `pi-coder-catppuccin.json` 抄**：同样的
  `$schema` / `vars` / `colors` / `export` 四段，`colors` 的 key 与键序照 pi-coder-catppuccin 抄（pi-coder-ayu 多一个
  自定义的 `bashOutput`，所以是 55 个 key），色值全部走 `vars`。上游皮肤已经定义的 51 个 token 里 **48 个逐字节同值** —— 这条可以用代码验：
  用 `loadThemeFromPath()` 同时解析两份文件，对同名 token 比 `getFgAnsi()` / `getBgAnsi()`；
  本仓只补了它没定义的四个：`toolDiffAddedBg` / `toolDiffRemovedBg`（`tool-diff.ts` 要读的行
  底色，上游没有）、`thinkingMax` 与 `bashOutput`（bash 输出正文的独立颜色槽，见下）。自定的
  色值一共六处：两个 diff 行底色、代码字符串的绿、最高两个思考档的边框灰、bash 输出灰，以及按你要求
  单独调过的 pending 态卡片底色 `toolPendingBg` `#1f1f1f`（上游是 `#1b1c1d`）。两个 diff 行底色是 `#1d241c`（bg 朝 `green` 混 10%）与 `#321d23`（朝 `red` 混 18%）——
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
  3. `toolPendingBg`：上游是 `#1b1c1d`（与它的 `userMessageBg` 同一个值），本仓按你要求改成中性
     `#1f1f1f` —— 只影响 pending 态的工具卡片底色（`toolPendingBg` 这个 token 独占一个 `vars`，
     `userMessageBg` / `customMessageBg` 走它们自己那个仍为 `#1b1c1d` 的变量，不受影响）。
     底色变亮一点点的代价是卡内文字对比度都掉 0.1-0.3：正文 8.77:1（原 9.08）、`muted` 3.47:1
     （原 3.59）、`dim` 2.31:1（原 2.39）。

  整体观感是「近黑蓝底 + 高对比亮色」，
  正文在面板上 8.4-9.2:1（pi-coder-catppuccin 12.7）；代价是 Ayu 自己的灰阶偏暗：`muted` `#6B7385`
  在面板上 3.3-3.8:1、`dim` `#515868` 2.2-2.6:1（pi-coder-catppuccin 分别 ≈4.9 / 4.7），注释、
  `Think:` 行、设置页提示因此明显更淡 —— 这是上游皮肤自己的取值（与 `ayu-dark` 逐字节一致），
  嫌淡只需调 `vars.muted` / `vars.dimmed` 两个变量。上游那个包（`iodic/pi-ayu-themes`，自带
  `ayu-dark` / `ayu-mirage` / `ayu-light` 三套变体）**已按你要求卸载**（`pi remove npm:pi-ayu-themes`，
  三份变体文件随之从 `~/.pi/agent/npm/` 消失，`/theme` 里不再有这三个名字），所以本机的 Ayu 皮肤
  只剩本仓这份 `pi-coder-ayu.json` —— 它是同一套 dark 调色板的「可按文件改」版本；要回到上游三套变体只需
  重新 `pi install npm:pi-ayu-themes`。

三份皮肤共同的两条硬约束：

- **`vars` 里的变量不能删**：`colors` 的值只要不是 `#` 开头就会被当变量引用去 `vars` 里查，查不到
  直接抛 `Variable reference not found`，**整个主题加载失败**并回退内置 `dark`。
- **缺了主题文件会静默降级**：`initTheme()` 加载失败时是 `catch` 后静默回退内置 `dark`，不报错、
  不启 watcher —— 重装时最容易漏的就是这一行（它不在 `cp config/*.json` 那几行的覆盖范围内）。

三份皮肤里都有 pi 官方 schema 没有的自定义 token：`toolDiffAddedBg` / `toolDiffRemovedBg`
（diff **整行底色**；`toolDiffAdded` / `toolDiffRemoved` / `toolDiffContext` 三个前景色是标准 token），
pi-coder-ayu 另有第三个 `bashOutput`（见下节）。
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

### `bashOutput`：bash 输出正文的独立颜色（pi-coder-ayu 与 pi-coder-summer-night 都定义了）

`pi-coder-ayu.json` 多一个 pi 官方 schema 没有的 token `bashOutput`（值 `#6B7385`，与那条
`… (N tokens hidden)` 折叠提示同为 `muted` 灰，但**自己一个 `vars.bashOutput`** —— 改 `muted`
不会连带动它）；`pi-coder-summer-night.json` 后来照同样形状加了一个（`#818596`，等于它自己的
`muted`/`ui`，同样是独立 `vars`）。它买的是「只改 bash 输出正文的颜色，不跟其他颜色混掉」：pi 内置的 bash 渲染器把
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
| `user-message-bar/` | 用户消息框**每一行**（含上下两条空白内边距行）行首加一条竖线 `▏`，颜色取 **diff 新增行行号色** `toolDiffAdded`（pi 内置 diff 与 `tool-diff.ts` 给 add 行行号用的同一个槽位）；`UserMessageComponent.prototype.render` 补丁，**吃掉原本那一格左内边距**换竖线，所以底色 / 行宽 / 折行位置全不变（pi-tui 对超宽行直接抛错，多一格都不行）；`bar.ts` 是纯逻辑，入口只接线。`PI_USER_MESSAGE_BAR=off` 关闭，`PI_USER_MESSAGE_BAR_COLOR=<槽位名>` 换色（背景槽如 `selectedBg` 会 48→38 转前景） |
| `prompt-editor.ts` | 输入框 `❯ ` gutter（`!` bash 模式下换成 `!`、正文里输入的 `!` 不再显示）+ 补全列表与 statusline 之间补一行空行；纯逻辑在 `prompt-editor/bash-prompt.ts` |
| `cwd-statusline.ts` | 用 `setStatus` 在 statusline 第二行显示完整 pwd（不经任何路径压缩） |
| `folder-history.ts` | 按工作目录持久化命令历史，注入编辑器原生 ↑/↓（**不注册快捷键** —— 上游的 ctrl+↑/↓ 在 macOS 上被 Mission Control 抢走） |
| `clear-command.ts` | `/clear` 别名 → `ctx.newSession()`（先 `waitForIdle`，与内置 `/new` 同一条流程） |
| `exit-command.ts` | 整行 `exit` / `quit` 优雅退出（只在 TUI 模式；`--print` 里仍是普通 prompt） |
| `init-command.ts` | Claude Code 式 `/init`：`CLAUDE.md` → 否则 `AGENTS.md` → 否则新建 `AGENTS.md` |
| `ask-user-question/` | Claude Code `AskUserQuestion` 式的结构化提问工具（子会话里按 `ctx.hasUI` 自动摘掉） |
| `mcp/` | MCP 服务器 → pi 工具（`mcp__<server>__<tool>`）；自带 stdio / streamable HTTP / 旧版 SSE 三种传输与 `/mcp` 命令。配置、约束与验证方式见上一节 |

### 跨扩展 / 跨文件

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
  补丁打的是包根导出的 `FooterComponent` —— 实测（0.85.1 bundle 形态，A/B pty 捕获，两次只差这一处）
  它**就是** pi 自己 `new` 出来那个类：临时改成返回 `["PROBE-FOOTER-MARKER"]` 时屏幕上真的出现这一行，
  关掉开关后内置 footer 照旧。
- **`statusline/footer-guard.ts` 与 `startup-logo/header-guard.ts` 是同一套机制的两份**（接管容器的
  `render`、重放上一帧的行），互不依赖、符号键不同。原因是 pi 换会话时 `resetExtensionUI()` 会
  **无条件**把内置 footer / header 装回去并清空所有 `setStatus`，而扩展侧没有比 `session_start`
  更早的钩子 —— 所以保证只能挪到「出帧那一刻」。`PI_STATUSLINE_FREEZE=off` 关掉冻结。
  （启动窗口那个留白补丁**也可以**这样扩到 header 上，`startup-logo/` 目前没做：启动那一段顶部
  仍会先闪一下内置 header 再换成 logo。）

### pi 平台的坑

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
  `bash-command-collapse.ts` 是为了让「流式接命令字符时屏幕上一行都不出」成为可能 —— 代价是
  pi 不再套 bgFn，底色得自己用 `Box(1,0, theme.bg(…))` 画，且 **`paddingY` 必须置 0**
  （否则两个 Box 的 padding 会叠出**三个空行**，上下边界空行改为只在最外侧补）。
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
- **`AGENTS.md` 自设 8000 字符预算**（当前 **7996 字符** ≈ 1999 tokens，落在盘上是 8028 字节，余量仅 4 字符）：
  pi 本身没有上限 —— 0.85.1 的 `system-prompt.js` 是原样拼接 context files、无截断，实测把标记放在
  9500 字符处仍被模型逐字读回；7400 那条是自设的每请求固定开销预算，已为 skill 优先级与 shell 卫生
  三条规则放宽到 8000，随后又为 Communication 节的「失败/跳过/与预期不符须置于报告首句」一条占满。
  下次再加规则前必须先压缩现有节或再抬上限。
  它是每个会话、每一轮请求都带的固定开销，改完要重开会话才生效（context files 只在 pi 启动时读一次）。
  它只装纯行为规则，刻意剔除全部
  Codex 机制耦合内容（`apply_patch` / `update_plan` / `multi_tool_use` 等十个词一个都不能出现），
  工具名一律用 pi 的真实工具（`read` / `bash` / `edit` / `write`，任务清单写作 `task_set` / `task_update`）。
  本机另有一份 4 断言 gate 脚本 `~/.pi/agent/plans/verify-global-agents.mjs`（机器本地，不入库）。
