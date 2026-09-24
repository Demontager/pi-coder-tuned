/**
 * Seatbelt（`sandbox-exec`）能力边界 —— 纯逻辑，无 IO、无 pi 依赖。
 *
 * ## 为什么是能力边界而不是黑名单
 *
 * 2026-09-23 的两次误删事故证明：枚举"坏的形状"（`rm -rf /`、`path.dirname(x ?? "/tmp")`）
 * 永远有漏网之鱼，因为坏形状是无穷的。Codex 从不弹确认框也从不误删全局文件，靠的不是
 * 更长的黑名单，而是**把强制点交给操作系统**：每条命令都在 seatbelt / landlock 沙箱里跑。
 * 本实现把强制点收窄到**删除**上（两次事故的损失面全是删除）：边界外的 `unlink` 被内核
 * 直接 `EPERM` 拒绝，写入则不限制（见下面「边界」一节）。
 *
 * 于是"确认"只在该出现的时候出现：正常操作（边界内删除、任何写入）→ 一次都不弹；
 * 越界删除 → 命令先失败，用户明确批准后才在沙箱外重跑。这是 fail-closed ——
 * 枚举之外的洞不存在，因为根本不枚举。
 *
 * 本模块只负责**生成 profile 与判定边界**，真正执行在 `bash-command-collapse.ts`。
 *
 * ## 边界（用户 2026-09-24 定，同日收窄到「只管删除」）
 *
 * - **写入**：不限制。`echo x > ~/.zshrc` 这类边界外的写直接放行、不弹框 ——
 *   用户定的口径是「写入目标在可写边界之外不需要提醒」。
 * - **删除**：只有项目目录（`cwd`）+ 临时目录（`/tmp`、`/private/tmp`、`/var/folders`）
 *   + `PI_SANDBOX_EXTRA_WRITE` 里显式列出的路径**之内**才放行；边界外的 `unlink` 被内核
 *   `EPERM` 拒绝，然后才弹一次确认。两次事故的损失面（`~/.zshrc`、`~/.pi/agent/sessions`、
 *   `~/.claude`）全是**删除**造成的，所以强制点就落在删除上。
 * - **读**：不限制。Codex 的 `workspace-write` 同样只管写不管读；限制读会打断
 *   `cat ~/.zshrc` 这类完全正常的排查动作。
 * - **网络**：全放行。本机的 npm / git / 网关流量都依赖出站，而风险面是文件删除不是网络。
 *
 * ## 两层授权（用户 2026-09-24 定）
 *
 * 边界外的删除不再一律「按命令问一次」，而是按**目标路径**分两档：
 *
 * - **危险路径**（`DANGEROUS_ROOTS` + home 下的配置类 + 任何一级是 `.git`/`.hg`/`.svn`）：
 *   每次删除都问，只支持**会话级**豁免（重启 pi 后恢复）。这是 unix 系统根、
 *   bin、应用程序安装目录与配置项目录 —— 2026-09-23 第二次事故的损失面
 *   （`~/.zshrc`、`~/.gitconfig`、`~/.zprofile`、`~/.pi/agent/sessions`）全在这一档。
 * - **普通路径**（边界外但不在危险名单里）：问一次，同意后把**目录范围**写进
 *   `~/.pi/agent/sandbox-allowlist.json`，以后（含 headless）都不再问。
 *
 * 记住一个目录 = 把它加进 profile 的 `(allow file-write-unlink (subpath …))`，
 * 所以删除在沙箱**内**就成功了，命令的其余部分仍被沙箱管着 —— 授权范围恰好等于
 * 「这个目录的删除能力」，一分不多。这也是为什么常见路径**零弹框零重跑**：
 * profile 在命令执行前就已经带上了白名单根。
 *
 * ## 一个必须知道的代价：rename 也走 unlink
 *
 * seatbelt **没有** `file-write-rename` 这个操作（实测 `(allow file-write-rename)` 报
 * `unbound variable`），`rename(2)` 在沙箱眼里就是对源路径的一次 `file-write-unlink`。
 * 所以边界外这些操作会一并被拦，尽管它们的意图是「写」而不是「删」：
 *
 * - `sed -i '' 's/a/b/' ~/.some.conf` —— 原子替换 = 写临时文件 + rename 覆盖原文件
 * - `mv ~/.a ~/.b` —— 源在边界外
 * - 在边界外的仓库里 `git init` / `git commit` —— git 靠 `*.lock` + rename 落盘
 *
 * 这不是漏洞而是删除语义的必然：原子替换确实会让原来那个 inode 消失。相比改动前
 * （边界外**所有**写都被拦）这是严格放宽，没有任何操作从「能用」变成「不能用」。
 *
 * `sandbox-exec` 被 Apple 标记为 deprecated，但在 macOS 26.5.1 上实测可用
 * （边界外 `echo >` 成功、边界外 `rm` 得到 `Operation not permitted` 且文件仍在、
 * 边界内 `rm` 正常删除、`curl` 出站 200）。
 */

import { homedir } from "node:os";
import { isAbsolute, resolve as resolvePath } from "node:path";

/**
 * 可写根集合构成的边界。`cwd` 与 `extraWrites` 都应是已解析的绝对路径。
 *
 * 名字里的 "write" 是历史沿用：自 2026-09-24 起这道边界**只约束删除**
 * （seatbelt 的 `file-write-unlink`），写入本身不限制。
 */
export interface WriteBoundary {
	readonly cwd: string;
	readonly extraWrites: readonly string[];
}

/**
 * 临时目录根。系统托管、自动清理、不含用户数据，所以算"安全沙箱目录"的一部分。
 *
 * `/var/folders` 是 macOS 真正的 `$TMPDIR`：node / git / npm / python3 都往那里写临时文件，
 * 不放行会让大量正常命令失败。`/private/...` 是它们的 realpath 形式，两种拼写都要在表里
 * （与 `destructive-guard` 的 `TEMP_ROOTS` 同一套理由）。
 */
export const TEMP_WRITE_ROOTS: readonly string[] = [
	"/tmp",
	"/private/tmp",
	"/var/folders",
	"/private/var/folders",
];

/**
 * 危险路径：每次删除都必问，只支持会话级豁免。
 *
 * 口径（用户 2026-09-24 选的「窄枚举」）：unix 重要系统根目录 + bin +
 * 应用程序安装目录 + 与配置项有关的目录。`/usr/local` 与 `/opt/homebrew` 是
 * 包管理器前缀（`brew uninstall` / `npm -g` 的地盘），单列出来是因为它们比
 * `/usr` 更常被正常操作碰到，但删错了同样难恢复。
 *
 * `/private/...` 是 macOS 的 realpath 形式（`/etc` → `/private/etc`），两种拼写都要在表里 ——
 * 与 `TEMP_WRITE_ROOTS` 同一套理由。注意 `/private/tmp` 与 `/private/var/folders`
 * 虽然在 `/private` 下，但它们在**可删边界内**，根本走不到危险判定这一步
 * （`classifyOutsidePaths` 先判边界）。
 *
 * ## 子树危险 vs 仅自身危险
 *
 * 这两张表的区分是整个名单的关键，弄反了功能就废了：
 *
 * - **子树危险**（`DANGEROUS_ROOTS` + `DANGEROUS_HOME_DIRS`）：它**与它下面的一切**都危险。
 *   `/usr/local/bin/tsc` 危险，因为 `/usr` 在表里。
 * - **仅自身危险**（`DANGEROUS_EXACT` + `DANGEROUS_HOME_FILES`）：只有这个路径本身危险，
 *   它的子路径要**单独判**。`$HOME` 在这一档 —— 删掉整个 home 是灾难，但
 *   `~/Downloads` 是普通目录，该走「问一次就记住」那一档。把 `$HOME` 放进子树表
 *   会让 home 下**所有**路径都变成危险，普通目录白名单就永远不会生效了。
 *   `/Users` 同理（否则别人的 home 也算危险，而自己的 home 已由 `$HOME` 单独管）。
 */
export const DANGEROUS_ROOTS: readonly string[] = [
	"/System",
	"/Library",
	"/Applications",
	"/bin",
	"/sbin",
	"/usr",
	"/opt",
	"/etc",
	"/private",
	"/var",
	"/Volumes",
	"/cores",
	"/dev",
];

/**
 * 仅**自身**危险的根：删掉它是灾难，但它的子路径要单独判。
 *
 * `/` 在这里而不是在 `DANGEROUS_ROOTS` 里，是因为子树语义对 `/` 没有意义
 * （所有绝对路径都在它下面）；`/Users` 在这里是因为子树语义会把每个用户的 home
 * 都判成危险，而自己的 home 已经由 `$HOME`（运行时注入）单独管了。
 */
export const DANGEROUS_EXACT: readonly string[] = ["/", "/Users"];

/**
 * `$HOME` 下「与配置项有关」的目录：删掉等于丢掉凭据 / 会话 / 全局规则。
 *
 * 这一档是**子树**语义：`~/.ssh/id_rsa`、`~/.config/foo/bar` 都危险。
 * `~/.pi` 在名单里顺带完成了**自保护** —— 守卫自己的扩展目录、`AGENTS.md`、
 * `sessions/`、`rewind/`、以及白名单文件本身全在它下面。删掉它们等于当场解除武装
 * 并毁掉自己的恢复手段，这是 `destructive-guard` 时代用事故换来的教训。
 * `~/Library` 是 macOS 应用偏好与 Application Support 的所在，同样属于配置类。
 *
 * 注意 `~/.cache`、`~/.npm`、`~/Downloads`、`~/projects` 这类**不在**名单里 ——
 * 它们是用户选的「窄枚举」口径下的普通目录，问一次就记住。
 */
export const DANGEROUS_HOME_DIRS: readonly string[] = [
	".ssh",
	".gnupg",
	".config",
	".pi",
	".claude",
	".codex",
	".aws",
	".kube",
	".docker",
	"Library",
];

/**
 * `$HOME` 一级的配置文件：shell 启动项与 VCS / 凭据配置。
 *
 * 只列**一级**（`~/.zshrc`），不递归 —— `~/projects/.zshrc` 是项目文件，不该按危险处理。
 * 2026-09-23 第二次事故删掉的正是 `~/.zshrc`、`~/.gitconfig`、`~/.zprofile`。
 *
 * 这一档天然是「仅自身」语义（它们是文件），但实现上走子树判定也无害：
 * `~/.zshrc` 下面不会有子路径。
 */
export const DANGEROUS_HOME_FILES: readonly string[] = [
	".zshrc",
	".zprofile",
	".zshenv",
	".zlogin",
	".bashrc",
	".bash_profile",
	".profile",
	".gitconfig",
	".netrc",
	".npmrc",
];

/** 版本控制存储的目录名：路径里**任何一级**是它就算危险（删掉是丢只此一份的历史）。 */
export const VCS_DIR_NAMES: readonly string[] = [".git", ".hg", ".svn"];

/**
 * 允许写进白名单的最浅深度（绝对路径的组件数）。
 *
 * `/` = 0、`/Users` = 1、`/Users/bachi` = 2、`/Users/bachi/Downloads` = 3。
 * 卡 3 是为了让「记父目录」这个动作**永远不可能**退化成记下 `$HOME` 或更浅的东西 ——
 * `$HOME`（`/Users/bachi`，2 个组件）本身就在危险名单里，这里是第二道保险
 * （名单将来被改动时仍然成立）。而 `$HOME` 的直接子目录（`~/Downloads`，3 个组件）
 * 刚好过闸 —— 这正是「删 ~/Downloads/x 记住 ~/Downloads」这个核心用例需要的宽度。
 */
export const MIN_ALLOWLIST_DEPTH = 3;

/**
 * 沙箱拒绝删除时，命令输出里的特征串。
 *
 * seatbelt 的拒绝是 `EPERM`（`Operation not permitted`）。刻意**不**匹配
 * `Permission denied` —— 那是 `EACCES`，来自文件权限位而不是沙箱，拿它当升级信号
 * 会把"这个文件本来就没权限"误报成"沙箱拦的"。
 */
const SANDBOX_DENIAL_PATTERNS: readonly RegExp[] = [/Operation not permitted/i, /\bEPERM\b/];

/** 升级确认框的固定标题（与 `destructive-guard` 一样，标题不随命令变化）。 */
export const ESCALATION_TITLE = "沙箱拦截了对边界外文件的删除";

/**
 * 命令输出是否像"被沙箱拒绝删除"。
 *
 * 只在命令**已经失败**的前提下调用才有意义：成功命令的输出里出现这些字样
 * （比如 `grep "Operation not permitted"`）不该触发升级。
 */
export function looksLikeSandboxDenial(output: string): boolean {
	if (!output) return false;
	return SANDBOX_DENIAL_PATTERNS.some((re) => re.test(output));
}

/**
 * 解析 `PI_SANDBOX_EXTRA_WRITE`：冒号分隔（同 `PATH`），逐项展开 `~` 并解析成绝对路径。
 *
 * 空项与纯空白项丢掉。相对路径按 `cwd` 解析 —— 配置里写 `../shared` 是合理的意图，
 * 不该被静默忽略。
 */
export function parseExtraWrites(raw: string | undefined, cwd: string): string[] {
	if (!raw) return [];
	const out: string[] = [];
	for (const item of raw.split(":")) {
		const trimmed = item.trim();
		if (!trimmed) continue;
		out.push(resolveAgainst(trimmed, cwd));
	}
	return out;
}

/** 展开 `~` 并把相对路径按 `cwd` 解析成绝对路径。 */
export function resolveAgainst(target: string, cwd: string): string {
	if (target === "~") return homedir();
	if (target.startsWith("~/")) return resolvePath(homedir(), target.slice(2));
	if (isAbsolute(target)) return resolvePath(target);
	return resolvePath(cwd, target);
}

/** 构造边界对象。`extraWrites` 会被解析成绝对路径。 */
export function makeBoundary(cwd: string, extraWrites: readonly string[] = []): WriteBoundary {
	const resolvedCwd = resolvePath(cwd || process.cwd());
	return {
		cwd: resolvedCwd,
		extraWrites: extraWrites.map((p) => resolveAgainst(p, resolvedCwd)),
	};
}

/** 全部可写根：项目目录 + 临时目录 + 显式额外路径。 */
export function writableRoots(boundary: WriteBoundary): string[] {
	return [boundary.cwd, ...TEMP_WRITE_ROOTS, ...boundary.extraWrites];
}

/**
 * 目标路径是否落在边界内（`target` 等于某个可写根，或在其子树下）。
 *
 * 边界内 = 可以直接删除；边界外 = 删除需要确认（bash 侧由内核 EPERM 强制）。
 *
 * 这是**白名单**判定：不在名单里就是外面，不需要枚举任何"危险路径"。
 * 比较前把两边都解析成绝对路径并去掉尾斜杠，避免 `/tmp/` 与 `/tmp` 判成两处。
 */
export function isPathInWriteBoundary(target: string, boundary: WriteBoundary): boolean {
	return isUnderRoots(target, writableRoots(boundary), boundary.cwd);
}

/** `target` 是否等于 `roots` 里的某一个，或在其子树下。两边都解析成绝对路径并去尾斜杠。 */
export function isUnderRoots(target: string, roots: readonly string[], cwd: string): boolean {
	const resolved = stripTrailingSlash(resolveAgainst(target, cwd));
	return roots.some((root) => {
		const r = stripTrailingSlash(resolvePath(root));
		return resolved === r || resolved.startsWith(r + "/");
	});
}

/** 路径分类需要的环境。`realpath` / `isDirectory` 是 IO，由调用方注入，本模块保持纯逻辑。 */
export interface PathEnv {
	readonly home: string;
	/** 解析符号链接。不传则只做词法判定（`~/link → /etc` 这类逃逸就看不见）。 */
	readonly realpath?: (path: string) => string | undefined;
	/** 目标是不是目录。不传则一律按文件处理（记父目录，范围更宽但受深度/危险规则约束）。 */
	readonly isDirectory?: (path: string) => boolean;
}

/**
 * 当前环境下的危险路径，分两档（见 `DANGEROUS_ROOTS` 文件头那段说明）。
 *
 * - `subtree`：它**与它下面的一切**都危险。
 * - `exact`：只有它自己危险，子路径要单独判（`$HOME`、`/`、`/Users`）。
 */
export interface DangerousTables {
	readonly subtree: readonly string[];
	readonly exact: readonly string[];
}

export function dangerousRoots(env: PathEnv): DangerousTables {
	const home = stripTrailingSlash(resolvePath(env.home));
	return {
		subtree: [
			...DANGEROUS_ROOTS,
			...DANGEROUS_HOME_DIRS.map((name) => `${home}/${name}`),
			...DANGEROUS_HOME_FILES.map((name) => `${home}/${name}`),
		].map((p) => stripTrailingSlash(resolvePath(p))),
		exact: [...DANGEROUS_EXACT, home].map((p) => stripTrailingSlash(resolvePath(p))),
	};
}

/**
 * 目标为什么危险；不危险返回 `undefined`。
 *
 * 三类命中：
 * 1. 等于某个危险根，或在其子树下（`/usr/local/bin/tsc` → `/usr/local`）；
 * 2. 路径里**任何一级**是 `.git` / `.hg` / `.svn`（`~/projects/x/.git` 在哪个目录都危险）；
 * 3. 传了 `realpath` 时，符号链接解析后的形态命中 1 或 2（`~/link → /etc`）。
 *
 * 词法形态与 realpath 形态**都判**，取更危险的那个结论 —— 只判词法会漏掉链接逃逸，
 * 只判 realpath 会在目标已被删掉（realpath 失败）时漏掉。
 */
export function dangerousReasonFor(target: string, env: PathEnv): string | undefined {
	const tables = dangerousRoots(env);
	const forms = [stripTrailingSlash(resolvePath(target))];
	const real = env.realpath?.(target);
	if (real) {
		const resolvedReal = stripTrailingSlash(resolvePath(real));
		if (!forms.includes(resolvedReal)) forms.push(resolvedReal);
	}

	for (const form of forms) {
		for (const root of tables.exact) {
			if (form === root) return `${form} 本身就是受保护的危险路径`;
		}
		for (const root of tables.subtree) {
			if (form === root) return `${form} 本身就是受保护的危险路径`;
			if (form.startsWith(root + "/")) return `${form} 在危险路径 ${root} 下`;
		}
		const segments = form.split("/").filter(Boolean);
		const vcs = segments.find((s) => VCS_DIR_NAMES.includes(s));
		if (vcs) return `${form} 含版本控制存储 ${vcs}（删掉是丢只此一份的历史）`;
	}
	return undefined;
}

/**
 * 这个路径能不能作为白名单根持久化。
 *
 * 三道闸：组件数 ≥ `MIN_ALLOWLIST_DEPTH`、自身不危险、且**不是任何危险路径的祖先**
 * （记下 `$HOME` 就等于把 `~/.ssh` 一起交出去）。加载白名单时也跑这一遍，
 * 手改或损坏的 JSON 塞不进 `/`。
 */
export function isSafeAllowlistRoot(path: string, env: PathEnv): boolean {
	const resolved = stripTrailingSlash(resolvePath(path));
	if (componentCount(resolved) < MIN_ALLOWLIST_DEPTH) return false;
	if (dangerousReasonFor(resolved, env)) return false;
	// 不能是任何危险路径的**祖先**：记下 `$HOME` 就等于把 `~/.ssh` 一起交出去。
	const tables = dangerousRoots(env);
	const all = [...tables.subtree, ...tables.exact];
	return !all.some((root) => root !== resolved && root.startsWith(resolved + "/"));
}

/** 绝对路径的组件数：`/` = 0，`/Users` = 1，`/Users/bachi` = 2。 */
export function componentCount(resolved: string): number {
	return resolved.split("/").filter(Boolean).length;
}

/**
 * 「记住这个删除」应该记多大范围。
 *
 * 目标是目录 → 记它自己（用户说的「这个目录是安全的」就是它）；
 * 目标是文件 → 记父目录（否则同目录删第二个文件还要再问一次，功能就白做了）。
 *
 * 但算出来的范围必须过 `isSafeAllowlistRoot`：过不了就**降级为只记精确路径**，
 * 精确路径也过不了就返回 `undefined`（什么都不记，只能走会话级豁免）。
 * 于是确认删 `~/.zshrc.bak` 只会记住那一个文件，绝不会记住 `$HOME`。
 */
export function memoryScopeFor(target: string, env: PathEnv, cwd = process.cwd()): string | undefined {
	const resolved = stripTrailingSlash(resolveAgainst(target, cwd));
	const isDir = env.isDirectory?.(resolved) ?? false;
	const preferred = isDir ? resolved : parentOf(resolved);
	if (preferred && isSafeAllowlistRoot(preferred, env)) return preferred;
	if (isSafeAllowlistRoot(resolved, env)) return resolved;
	return undefined;
}

function parentOf(resolved: string): string | undefined {
	const idx = resolved.lastIndexOf("/");
	if (idx <= 0) return undefined;
	return resolved.slice(0, idx);
}

/**
 * 「本会话不再询问」应该豁免多大范围。
 *
 * 与 `memoryScopeFor` 的区别：会话豁免**不落盘**、重启即失效，所以可以比持久白名单宽 ——
 * 允许落在危险子树根**之下**（比如 `~/.config/foo`），这样用户豁免一次后，同一子目录里的
 * 兄弟文件本会话不再反复问（用户口径：「当前会话就不再弹框确认」）。但仍有一道硬闸：
 *
 * - 范围不能**本身是**某个危险根（豁免了 `~/.config` 就等于把整个配置目录交出去）；
 * - 范围不能是某个危险根的**祖先**（豁免了 `$HOME` 就等于把 `~/.ssh` 一起交出去）；
 * - 组件数 ≥ `MIN_ALLOWLIST_DEPTH`。
 *
 * 三条都过不了就退回**精确路径**（只豁免这一个目标）。于是豁免删 `~/.config/foo/bar`
 * 会记下 `~/.config/foo`，但豁免删 `~/.zshrc`（父目录是 `$HOME`，是危险根的祖先）只会
 * 记下 `~/.zshrc` 这一个文件。
 */
export function sessionScopeFor(target: string, env: PathEnv, cwd = process.cwd()): string {
	const resolved = stripTrailingSlash(resolveAgainst(target, cwd));
	const isDir = env.isDirectory?.(resolved) ?? false;
	const preferred = isDir ? resolved : parentOf(resolved);
	if (preferred && isSafeSessionRoot(preferred, env)) return preferred;
	return resolved;
}

/**
 * 会话豁免范围能不能用：深度够、自身不是危险根、也不是任何危险根的祖先。
 *
 * 与持久白名单不同，这里**允许**落在危险子树根之下（`~/.config/foo` 在 `~/.config` 下）——
 * 会话豁免不落盘、重启即失效，宽一点是安全的，而且这正是「本会话不再询问」的语义：
 * 豁免一次后同子目录的兄弟文件不再反复问。
 *
 * 深度闸与持久白名单同宽：`$HOME` 的直接子目录（`~/Downloads`，2 个组件）放行，
 * 其余卡 `MIN_ALLOWLIST_DEPTH`。
 */
function isSafeSessionRoot(path: string, env: PathEnv): boolean {
	const resolved = stripTrailingSlash(resolvePath(path));
	if (componentCount(resolved) < MIN_ALLOWLIST_DEPTH) return false;
	const tables = dangerousRoots(env);
	const all = [...tables.subtree, ...tables.exact];
	for (const root of all) {
		if (resolved === root) return false; // 自身是危险根（豁免了 ~/.config 就等于交出整个配置目录）
		if (root.startsWith(resolved + "/")) return false; // 是危险根的祖先（豁免了 $HOME 就等于交出 ~/.ssh）
	}
	return true;
}

/**
 * 从**已失败**命令的输出里抽出被沙箱拦下的路径。
 *
 * 内核只给 `EPERM`，不会告诉你是谁拦的 —— 按目录记忆的前提就是能从 stderr 里认出路径。
 * 只扫含 `Operation not permitted` / `EPERM` 的行（成功命令的输出里出现这些字样不该触发），
 * 依次尝试：
 *
 * - `mv: rename A to B: …` / `sed: rename(A to B): …` → 取**源** A（unlink 落在源上）
 * - GNU 的 `rm: cannot remove 'X': …` / `unlink: cannot unlink 'X': …` → 取引号里的 X
 * - BSD 的 `rm: X: …` / `rmdir: X: …` → 取程序名后面那个 token
 * - 兜底：行里所有看起来像绝对路径的 token
 *
 * **抽不出任何路径时返回空数组**，调用方必须退回「按整条命令、会话级问一次」的旧行为 ——
 * 猜不出目标就不许进记忆逻辑，这是 `AGENTS.md` 「Never derive a delete target」的同一口径。
 *
 * 抽错了也不会静默放行：弹框会把这些路径原样列给用户看，确认之前不会落盘。
 */
export function extractDeniedPaths(output: string): string[] {
	if (!output) return [];
	const found: string[] = [];
	const push = (candidate: string | undefined) => {
		const cleaned = cleanExtractedPath(candidate);
		if (cleaned && !found.includes(cleaned)) found.push(cleaned);
	};

	for (const rawLine of output.split("\n")) {
		const line = rawLine.trim();
		if (!SANDBOX_DENIAL_PATTERNS.some((re) => re.test(line))) continue;

		// rename A to B —— mv / sed -i / git 落 ref 都是这个形状，unlink 在源上
		const rename = /rename[\s(]+(.+?)\s+to\s+(.+?)[\s)]*[:：]?\s*(?:Operation not permitted|EPERM)/i.exec(line);
		if (rename?.[1]) {
			push(rename[1]);
			continue;
		}

		// GNU: cannot remove '/path': …
		const quoted = /cannot\s+\w+\s+'([^']+)'/.exec(line);
		if (quoted?.[1]) {
			push(quoted[1]);
			continue;
		}

		// BSD: prog: /path: Operation not permitted
		const bsd = /^[\w.+-]+:\s*(.+?)\s*[:：]\s*(?:Operation not permitted|EPERM)/i.exec(line);
		if (bsd?.[1]) {
			push(bsd[1]);
			continue;
		}

		// 兜底：行里所有绝对路径 token
		for (const token of line.split(/\s+/)) push(token);
	}
	return found;
}

/** 去掉包裹的引号与尾部标点，只留下以 `/` 开头、长度 > 1 的绝对路径。 */
function cleanExtractedPath(candidate: string | undefined): string | undefined {
	if (!candidate) return undefined;
	let value = candidate.trim().replace(/^['"]+|['"]+$/g, "");
	value = value.replace(/[,;:]+$/, "");
	if (!value.startsWith("/") || value.length <= 1) return undefined;
	return stripTrailingSlash(value);
}

/** `classifyOutsidePaths` 的结果：三档互斥，调用方据此决定弹不弹、弹哪种。 */
export interface PathClassification {
	/** 已被持久白名单或会话豁免覆盖 → 静默放行，不弹框。 */
	readonly covered: string[];
	/** 危险 → 每次必问，只能会话级豁免。带命中原因，弹框里要给人看。 */
	readonly dangerous: ReadonlyArray<{ path: string; reason: string }>;
	/** 普通边界外 → 问一次，同意后可永久记住。 */
	readonly ordinary: string[];
	/** 边界内 → 本来就能删，不该弹框（列出来只为让调用方能断言）。 */
	readonly inside: string[];
}

/**
 * 把一批删除目标分成四档。这是 bash 与 `apply_patch` 两条路线**共用**的判定核心，
 * 所以两边的口径不会漂移。
 *
 * 顺序很重要：**先判边界**（边界内直接放行，连危险名单都不看 —— `/private/tmp` 在
 * `/private` 下但它在边界内），再判已授权，最后才分危险 / 普通。
 *
 * 自动放行的口径是「**全部**命中」而不是「任一命中」：调用方只有在 `dangerous` 与
 * `ordinary` 都为空时才能不弹框。否则 `rm 已授权目录 未授权目录` 会因为前者被静默
 * 放行、后者跟着裸跑。
 */
export function classifyOutsidePaths(
	paths: readonly string[],
	opts: {
		readonly boundary: WriteBoundary;
		/** 持久白名单根（`sandbox-allowlist.json`）。 */
		readonly allowedRoots: readonly string[];
		/** 会话级豁免根（危险目录的「本会话不再询问」）。 */
		readonly sessionRoots: readonly string[];
		readonly env: PathEnv;
	},
): PathClassification {
	const covered: string[] = [];
	const dangerous: Array<{ path: string; reason: string }> = [];
	const ordinary: string[] = [];
	const inside: string[] = [];
	const seen = new Set<string>();

	for (const raw of paths) {
		const resolved = stripTrailingSlash(resolveAgainst(raw, opts.boundary.cwd));
		if (seen.has(resolved)) continue;
		seen.add(resolved);

		if (isPathInWriteBoundary(resolved, opts.boundary)) {
			inside.push(resolved);
			continue;
		}
		// 会话豁免优先于危险判定：用户已经在本会话里明确说过「不再问」。
		if (isUnderRoots(resolved, opts.sessionRoots, opts.boundary.cwd)) {
			covered.push(resolved);
			continue;
		}
		if (isUnderRoots(resolved, opts.allowedRoots, opts.boundary.cwd)) {
			covered.push(resolved);
			continue;
		}
		const reason = dangerousReasonFor(resolved, opts.env);
		if (reason) dangerous.push({ path: resolved, reason });
		else ordinary.push(resolved);
	}

	return { covered, dangerous, ordinary, inside };
}

/** 把一批目标折算成要记住的目录范围（去重、丢掉算不出安全范围的）。 */
export function memoryScopesFor(paths: readonly string[], env: PathEnv, cwd = process.cwd()): string[] {
	const out: string[] = [];
	for (const p of paths) {
		const scope = memoryScopeFor(p, env, cwd);
		if (scope && !out.includes(scope)) out.push(scope);
	}
	return out;
}

/**
 * 生成 seatbelt profile。
 *
 * 形状是 `deny default` 打底，再逐项放行 —— 顺序很重要：seatbelt 里**后写的规则覆盖先写的**，
 * 所以「全局放行 → 局部收回」这个顺序就是本 profile 的全部技巧。
 *
 * 放行的能力：
 * - `file-read*` 全放行（读不限制）
 * - `network*` 全放行（出站不限制）
 * - `process-fork` / `process-exec` / `signal`：跑子命令、`kill` 自己的进程组
 * - `sysctl-read` / `mach-lookup` / `ipc-posix*`：几乎所有程序启动都要
 * - `file-write*` **全放行**（写不限制 —— 用户 2026-09-24 定的口径）
 *
 * 收回的能力只有一项：
 * - `file-write-unlink` 先全局 `deny`，再只对可写根 `allow`。于是边界外的 `rm` / `rmdir`
 *   （以及一切 rename，见文件头）拿到 `EPERM`，边界内照常删除。
 *
 * `extraUnlinkRoots` 是两层授权的注入点：持久白名单与会话豁免的目录在这里并进
 * 同一行 `(allow file-write-unlink …)` —— 记住一个目录 = 加宽这一行，删除在沙箱内
 * 直接成功，命令的其余部分仍被沙箱管着。顺序仍是「全局 deny 在前、allow 在后」
 * （seatbelt 后写的规则覆盖先写的，现有测试钉住了这个顺序）。
 *
 * 设备文件（`/dev/null` 等）的 `file-write-data` / `file-write-mode` 已被全局 `file-write*`
 * 覆盖，不再单列；`file-ioctl` 不属于 `file-write*`，仍需显式放行（tty 操作要用）。
 */
export function buildSeatbeltProfile(boundary: WriteBoundary, extraUnlinkRoots: readonly string[] = []): string {
	const unlinkSubpaths = [...writableRoots(boundary), ...extraUnlinkRoots]
		.map((root) => stripTrailingSlash(resolvePath(root)))
		.filter((root, index, all) => all.indexOf(root) === index)
		.map((root) => `(subpath ${quoteSb(root)})`);

	const deviceLiterals = ["/dev/null", "/dev/zero", "/dev/tty", "/dev/urandom", "/dev/random", "/dev/dtracehelper"]
		.map((dev) => `(literal ${quoteSb(dev)})`)
		.join("");

	return [
		"(version 1)",
		"(deny default)",
		"(allow process-fork)",
		"(allow process-exec)",
		"(allow signal)",
		"(allow sysctl-read)",
		"(allow mach-lookup)",
		"(allow ipc-posix*)",
		"(allow file-read*)",
		"(allow network*)",
		"(allow file-write*)",
		"(deny file-write-unlink)",
		`(allow file-write-unlink ${unlinkSubpaths.join("")})`,
		`(allow file-ioctl ${deviceLiterals})`,
	].join("\n");
}

/**
 * 把命令包进沙箱。
 *
 * profile 通过 `-p` 内联传入（不落盘）：临时文件会引入"谁来清理""清理时删哪里"的新问题，
 * 而那正是本扩展要消灭的那类问题。命令与 profile 都用单引号安全转义。
 */
export function wrapWithSandbox(command: string, profile: string, shellPath = "/bin/bash"): string {
	return `sandbox-exec -p ${shellQuote(profile)} ${shellQuote(shellPath)} -c ${shellQuote(command)}`;
}

/** seatbelt profile 里的字符串字面量：双引号包裹，转义 `\` 与 `"`。 */
function quoteSb(value: string): string {
	return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** shell 单引号包裹：内部的 `'` 换成 `'\''`（POSIX 标准做法，不依赖反斜杠转义）。 */
export function shellQuote(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}

function stripTrailingSlash(p: string): string {
	return p.length > 1 && p.endsWith("/") ? p.slice(0, -1) : p;
}

/**
 * 沙箱是否可用（平台 + 开关）。
 *
 * `PI_SANDBOX=off` 整体关闭。非 darwin 平台没有 `sandbox-exec`，也关闭 ——
 * 宁可没有这层保护，也不要让命令在 Linux 上因为找不到二进制而全部失败。
 */
export function isSandboxEnabled(env: NodeJS.ProcessEnv = process.env, platform = process.platform): boolean {
	if (env.PI_SANDBOX?.trim().toLowerCase() === "off") return false;
	return platform === "darwin";
}

/** 从环境构造边界（`PI_SANDBOX_EXTRA_WRITE` + cwd）。 */
export function boundaryFromEnv(cwd: string, env: NodeJS.ProcessEnv = process.env): WriteBoundary {
	return makeBoundary(cwd, parseExtraWrites(env.PI_SANDBOX_EXTRA_WRITE, cwd));
}
