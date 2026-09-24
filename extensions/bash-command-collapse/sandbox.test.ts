/**
 * Tests for the seatbelt capability boundary (sandbox.ts) — 纯逻辑单测，不需要 pi。
 *
 * Run with:  node --test clients/pi/extensions/bash-command-collapse/sandbox.test.ts
 *
 * 断言口径（用户 2026-09-24 定，同日收窄到「只管删除」）：
 *   - profile 以 `(deny default)` 打底（fail-closed 的来源）；
 *   - 写入全放行（`file-write*`），删除收窄：`file-write-unlink` 先全局 deny，
 *     再只对可删根 allow —— 可删根 = 项目目录 + /tmp + /private/tmp + /var/folders
 *     + /private/var/folders + 额外路径；
 *   - 读全放行（file-read*）、网络全放行（network*）；
 *   - isPathInWriteBoundary 是白名单判定：cwd 内/子目录、/tmp、$TMPDIR 在内；
 *     $HOME 下的全局文件、/usr/local 等一律在外；
 *   - 拒绝识别只认 EPERM / Operation not permitted，不认 Permission denied（EACCES）；
 *   - 包裹命令用 sandbox-exec -p，profile 与命令都单引号安全转义。
 */

import assert from "node:assert/strict";
import os from "node:os";
import test from "node:test";
import {
	ESCALATION_TITLE,
	MIN_ALLOWLIST_DEPTH,
	TEMP_WRITE_ROOTS,
	buildSeatbeltProfile,
	boundaryFromEnv,
	classifyOutsidePaths,
	componentCount,
	dangerousReasonFor,
	dangerousRoots,
	extractDeniedPaths,
	isPathInWriteBoundary,
	isSafeAllowlistRoot,
	isSandboxEnabled,
	looksLikeSandboxDenial,
	makeBoundary,
	memoryScopeFor,
	memoryScopesFor,
	parseExtraWrites,
	resolveAgainst,
	sessionScopeFor,
	shellQuote,
	wrapWithSandbox,
	writableRoots,
} from "./sandbox.ts";

const CWD = "/Users/someone/project";
const HOME = os.homedir();

test("profile 以 deny default 打底，且放行读写网络与进程能力", () => {
	const profile = buildSeatbeltProfile(makeBoundary(CWD));
	const lines = profile.split("\n");
	assert.equal(lines[0], "(version 1)");
	assert.equal(lines[1], "(deny default)", "fail-closed：没被显式放行的一律拒");
	assert.ok(profile.includes("(allow file-read*)"), "读不限制");
	assert.ok(profile.includes("(allow network*)"), "网络全放行");
	assert.ok(profile.includes("(allow process-fork)"));
	assert.ok(profile.includes("(allow process-exec)"));
	assert.ok(profile.includes("(allow mach-lookup)"));
});

test("profile 写入全放行，删除只对可删根放行（全局 deny + 局部 allow）", () => {
	const profile = buildSeatbeltProfile(makeBoundary(CWD, ["/Users/someone/.pm2"]));
	const lines = profile.split("\n");
	assert.ok(lines.includes("(allow file-write*)"), "写入不限制（用户 2026-09-24 口径）");
	assert.ok(lines.includes("(deny file-write-unlink)"), "删除先全局收回");
	const unlinkAllow = lines.find((l) => l.startsWith("(allow file-write-unlink "));
	assert.ok(unlinkAllow, "删除再对可删根放行");
	// 顺序：deny 必须在 allow 之前，seatbelt 后写的规则覆盖先写的
	assert.ok(
		lines.indexOf("(deny file-write-unlink)") < lines.indexOf(unlinkAllow),
		"deny 在前、allow 在后，否则全局 deny 会被覆盖失效",
	);
	assert.ok(unlinkAllow.includes(`(subpath "${CWD}")`));
	for (const root of TEMP_WRITE_ROOTS) {
		assert.ok(unlinkAllow.includes(`(subpath "${root}")`), `缺少临时根 ${root}`);
	}
	assert.ok(unlinkAllow.includes('(subpath "/Users/someone/.pm2")'), "额外路径要进 unlink 放行名单");
});

test("isPathInWriteBoundary：cwd 内与子目录在边界内", () => {
	const b = makeBoundary(CWD);
	assert.equal(isPathInWriteBoundary(`${CWD}/src/x.ts`, b), true);
	assert.equal(isPathInWriteBoundary(CWD, b), true, "cwd 本身可写");
	assert.equal(isPathInWriteBoundary("src/x.ts", b), true, "相对路径按 cwd 解析");
	assert.equal(isPathInWriteBoundary(`${CWD}/`, b), true, "尾斜杠不影响");
});

test("isPathInWriteBoundary：临时目录在边界内（含 realpath 形式）", () => {
	const b = makeBoundary(CWD);
	assert.equal(isPathInWriteBoundary("/tmp/a", b), true);
	assert.equal(isPathInWriteBoundary("/private/tmp/a", b), true);
	assert.equal(isPathInWriteBoundary("/var/folders/x/y", b), true);
	assert.equal(isPathInWriteBoundary("/private/var/folders/x/y", b), true);
});

test("isPathInWriteBoundary：$HOME 全局文件与系统目录在边界外", () => {
	const b = makeBoundary(CWD);
	assert.equal(isPathInWriteBoundary(`${HOME}/.zshrc`, b), false);
	assert.equal(isPathInWriteBoundary(`${HOME}/.gitconfig`, b), false);
	assert.equal(isPathInWriteBoundary(`${HOME}/.pi/agent/sessions`, b), false);
	assert.equal(isPathInWriteBoundary("/usr/local/bin/tsc", b), false);
	assert.equal(isPathInWriteBoundary("/Users/someone-other/x", b), false, "同名前缀不算子树");
});

test("isPathInWriteBoundary：前缀同名目录不算子树", () => {
	const b = makeBoundary("/Users/someone/project");
	assert.equal(isPathInWriteBoundary("/Users/someone/project-x/f", b), false);
});

test("额外写路径：展开 ~ 与相对路径", () => {
	const b = makeBoundary(CWD, ["~/.pm2", "../shared"]);
	assert.equal(isPathInWriteBoundary(`${HOME}/.pm2/logs/out.log`, b), true);
	assert.equal(isPathInWriteBoundary("/Users/someone/shared/f", b), true);
});

test("parseExtraWrites：冒号分隔、空项丢弃、~ 展开", () => {
	const out = parseExtraWrites("~/.pm2::/opt/data:", CWD);
	assert.deepEqual(out, [`${HOME}/.pm2`, "/opt/data"]);
	assert.deepEqual(parseExtraWrites(undefined, CWD), []);
	assert.deepEqual(parseExtraWrites("", CWD), []);
});

test("resolveAgainst：~ 与 ~/ 展开", () => {
	assert.equal(resolveAgainst("~", CWD), HOME);
	assert.equal(resolveAgainst("~/x", CWD), `${HOME}/x`);
	assert.equal(resolveAgainst("/abs", CWD), "/abs");
	assert.equal(resolveAgainst("rel", CWD), `${CWD}/rel`);
});

test("looksLikeSandboxDenial：只认 EPERM 系，不认 EACCES", () => {
	assert.equal(looksLikeSandboxDenial("rm: /Users/x/.zshrc: Operation not permitted"), true);
	assert.equal(looksLikeSandboxDenial("Error: EPERM: operation not permitted, open '/x'"), true);
	assert.equal(looksLikeSandboxDenial("rm: /x: Permission denied"), false, "EACCES 不是沙箱拒绝");
	assert.equal(looksLikeSandboxDenial("hello world"), false);
	assert.equal(looksLikeSandboxDenial(""), false);
});

test("wrapWithSandbox：sandbox-exec -p 包裹，单引号安全转义", () => {
	const wrapped = wrapWithSandbox("echo 'hi'", "(version 1)", "/bin/bash");
	assert.ok(wrapped.startsWith("sandbox-exec -p '"), "profile 单引号内联，不落盘");
	assert.ok(wrapped.includes("/bin/bash' -c '"));
	// 命令里的单引号必须被 '\'' 转义，不能裸着破坏外层引号
	assert.ok(wrapped.includes("echo '\\''hi'\\''"));
});

test("shellQuote：含单引号的字符串往返安全", () => {
	const tricky = "a'b\"c$d`e";
	assert.equal(shellQuote(tricky), `'a'\\''b"c$d`+"`"+`e'`);
});

test("isSandboxEnabled：PI_SANDBOX=off 关闭；非 darwin 关闭", () => {
	assert.equal(isSandboxEnabled({ PI_SANDBOX: "off" }, "darwin"), false);
	assert.equal(isSandboxEnabled({ PI_SANDBOX: "OFF" }, "darwin"), false);
	assert.equal(isSandboxEnabled({}, "darwin"), true);
	assert.equal(isSandboxEnabled({}, "linux"), false, "没有 sandbox-exec 的平台不开");
});

test("boundaryFromEnv：从 PI_SANDBOX_EXTRA_WRITE 读额外路径", () => {
	const b = boundaryFromEnv(CWD, { PI_SANDBOX_EXTRA_WRITE: "~/.pm2" });
	assert.equal(isPathInWriteBoundary(`${HOME}/.pm2/x`, b), true);
});

test("writableRoots 至少含项目目录与全部临时根", () => {
	const roots = writableRoots(makeBoundary(CWD));
	assert.ok(roots.includes(CWD));
	for (const root of TEMP_WRITE_ROOTS) assert.ok(roots.includes(root));
});

test("ESCALATION_TITLE 是固定文案", () => {
	assert.equal(ESCALATION_TITLE, "沙箱拦截了对边界外文件的删除");
});

/* ------------------------------------------------------------------ *
 * 两层授权（用户 2026-09-24 定）：危险目录会话级必问 + 普通目录持久白名单
 * ------------------------------------------------------------------ */

const env = { home: HOME };

test("dangerousReasonFor：系统根、bin、应用安装目录、包管理器前缀都危险", () => {
	assert.ok(dangerousReasonFor("/usr/local/bin/tsc", env));
	assert.ok(dangerousReasonFor("/opt/homebrew/bin/x", env));
	assert.ok(dangerousReasonFor("/Applications/Foo.app", env));
	assert.ok(dangerousReasonFor("/bin/ls", env));
	assert.ok(dangerousReasonFor("/System/Library/x", env));
	assert.ok(dangerousReasonFor("/private/etc/hosts", env));
	assert.ok(dangerousReasonFor("/Volumes/Backup/x", env));
	assert.ok(dangerousReasonFor("/", env), "根本身");
	assert.ok(dangerousReasonFor("/Users", env), "Users 根");
});

test("dangerousReasonFor：$HOME 本身与配置类目录危险，但普通子目录不危险", () => {
	assert.ok(dangerousReasonFor(HOME, env), "$HOME 本身危险");
	assert.ok(dangerousReasonFor(`${HOME}/.ssh/id_rsa`, env));
	assert.ok(dangerousReasonFor(`${HOME}/.config/foo`, env));
	assert.ok(dangerousReasonFor(`${HOME}/.pi/agent/extensions`, env), "自保护：守卫自己的目录");
	assert.ok(dangerousReasonFor(`${HOME}/.claude/x`, env));
	assert.equal(dangerousReasonFor(`${HOME}/Downloads`, env), undefined, "普通目录不危险");
	assert.equal(dangerousReasonFor(`${HOME}/projects/foo`, env), undefined);
});

test("dangerousReasonFor：$HOME 一级的 shell/VCS 配置文件危险，二级的不危险", () => {
	assert.ok(dangerousReasonFor(`${HOME}/.zshrc`, env), "第二次事故删的就是它");
	assert.ok(dangerousReasonFor(`${HOME}/.gitconfig`, env));
	assert.ok(dangerousReasonFor(`${HOME}/.zprofile`, env));
	assert.equal(dangerousReasonFor(`${HOME}/projects/.zshrc`, env), undefined, "项目里的 .zshrc 不是全局配置");
});

test("dangerousReasonFor：路径里任何一级是 .git/.hg/.svn 都危险", () => {
	assert.ok(dangerousReasonFor(`${HOME}/projects/x/.git`, env));
	assert.ok(dangerousReasonFor(`${HOME}/projects/x/.git/objects`, env));
	assert.ok(dangerousReasonFor(`/tmp/whatever/.svn/entries`, env), "在临时目录里也算（形状规则优先）");
	assert.equal(dangerousReasonFor(`${HOME}/projects/x/gitignore`, env), undefined, "名字相似但不是 VCS 目录");
});

test("dangerousReasonFor：realpath 能看见符号链接逃逸", () => {
	// ~/link → /etc：词法形态在 home 下（不危险），realpath 形态是 /etc/passwd（危险）。
	// 仿真实 realpathSync：整条路径的前缀被替换，而不是只认链接本身。
	const withRealpath = {
		home: HOME,
		realpath: (p: string) => (p === `${HOME}/link` || p.startsWith(`${HOME}/link/`) ? p.replace(`${HOME}/link`, "/etc") : undefined),
	};
	assert.ok(dangerousReasonFor(`${HOME}/link/passwd`, withRealpath));
	assert.equal(dangerousReasonFor(`${HOME}/link/passwd`, env), undefined, "不给 realpath 就只能词法判（已知缺口）");
});

test("dangerousRoots：分 subtree / exact 两档，$HOME 在 exact 档", () => {
	const tables = dangerousRoots(env);
	assert.ok(tables.exact.includes(HOME), "$HOME 仅自身危险（否则 ~/Downloads 也成危险，白名单就废了）");
	assert.ok(tables.exact.includes("/"));
	assert.ok(tables.exact.includes("/Users"));
	assert.ok(tables.subtree.includes(`${HOME}/.ssh`));
	assert.ok(tables.subtree.includes(`${HOME}/.zshrc`));
	assert.ok(tables.subtree.includes("/usr"));
	assert.ok(!tables.subtree.includes(HOME), "$HOME 不在子树档");
});

test("memoryScopeFor：文件记父目录，目录记自身", () => {
	const withDir = { home: HOME, isDirectory: (p: string) => p === `${HOME}/Downloads` };
	assert.equal(memoryScopeFor(`${HOME}/Downloads/old.zip`, withDir, CWD), `${HOME}/Downloads`);
	assert.equal(memoryScopeFor(`${HOME}/Downloads`, withDir, CWD), `${HOME}/Downloads`, "目标是目录 → 记自身");
});

test("memoryScopeFor：父目录危险/太浅时降级为精确路径", () => {
	// ~/.zshrc.bak 的父目录是 $HOME（危险根）→ 只能记这个文件本身
	assert.equal(memoryScopeFor(`${HOME}/.zshrc.bak`, env, CWD), `${HOME}/.zshrc.bak`);
	// /Users/x 的父目录是 /Users（危险根），自身又只有 2 层 → 什么都记不了（逐次批准）
	assert.equal(memoryScopeFor("/Users/x", env, CWD), undefined);
	// 目标本身是危险根 → 什么都记不了（只能走会话级豁免）
	assert.equal(memoryScopeFor(`${HOME}/.ssh`, env, CWD), undefined);
	assert.equal(memoryScopeFor("/", env, CWD), undefined);
});

test("memoryScopeFor：MIN_ALLOWLIST_DEPTH 挡住浅目录", () => {
	assert.equal(componentCount("/Users/bachi"), 2);
	assert.equal(componentCount("/Users/bachi/Downloads"), 3);
	assert.ok(MIN_ALLOWLIST_DEPTH >= 3, "卡 3 层：记父目录永远退不到 $HOME");
	// /Users/bachi/Downloads 的父目录 /Users/bachi 只有 2 层 → 降级记精确路径
	assert.equal(memoryScopeFor("/Users/bachi/Downloads", env, CWD), "/Users/bachi/Downloads");
});

test("isSafeAllowlistRoot：拒 `/`、危险根、危险根的祖先", () => {
	assert.equal(isSafeAllowlistRoot("/", env), false);
	assert.equal(isSafeAllowlistRoot(HOME, env), false, "$HOME 是危险根");
	assert.equal(isSafeAllowlistRoot(`${HOME}/.ssh`, env), false);
	assert.equal(isSafeAllowlistRoot(`${HOME}/Downloads`, env), true);
	assert.equal(isSafeAllowlistRoot("/Users", env), false, "组件数不够");
	assert.equal(isSafeAllowlistRoot("/Users/bachi", env), false, "是 $HOME 危险根的祖先（且组件数不够）");
});

test("sessionScopeFor：危险根之下可以会话豁免，危险根本身不行", () => {
	// ~/.config/foo/bar 的父目录 ~/.config/foo 在危险根 ~/.config 之下但自身不是危险根 → 可以
	assert.equal(sessionScopeFor(`${HOME}/.config/foo/bar`, env, CWD), `${HOME}/.config/foo`);
	// ~/.zshrc 的父目录是 $HOME（危险根）→ 退回精确路径
	assert.equal(sessionScopeFor(`${HOME}/.zshrc`, env, CWD), `${HOME}/.zshrc`);
	// ~/.ssh 本身是危险根 → 退回精确路径（只豁免这一个目标）
	assert.equal(sessionScopeFor(`${HOME}/.ssh`, env, CWD), `${HOME}/.ssh`);
});

test("extractDeniedPaths：BSD rm/rmdir 形状", () => {
	assert.deepEqual(extractDeniedPaths("rm: /Users/x/.sbx-probe: Operation not permitted"), ["/Users/x/.sbx-probe"]);
	assert.deepEqual(extractDeniedPaths("rmdir: /Users/x/dir: Operation not permitted"), ["/Users/x/dir"]);
});

test("extractDeniedPaths：GNU 引号形状", () => {
	assert.deepEqual(extractDeniedPaths("rm: cannot remove '/Users/x/a': Operation not permitted"), ["/Users/x/a"]);
});

test("extractDeniedPaths：rename 形状取源（mv / sed -i / git 落 ref）", () => {
	assert.deepEqual(extractDeniedPaths("mv: rename /Users/x/a to /Users/x/b: Operation not permitted"), ["/Users/x/a"]);
	assert.deepEqual(extractDeniedPaths("sed: rename(/Users/x/.conf.sedXXXX to /Users/x/.conf): Operation not permitted"), ["/Users/x/.conf.sedXXXX"]);
});

test("extractDeniedPaths：多个目标、去重", () => {
	const out = extractDeniedPaths(
		[
			"rm: /Users/x/a: Operation not permitted",
			"rm: /Users/x/b: Operation not permitted",
			"rm: /Users/x/a: Operation not permitted",
		].join("\n"),
	);
	assert.deepEqual(out, ["/Users/x/a", "/Users/x/b"], "去重且保序");
	assert.deepEqual(extractDeniedPaths("hello world"), []);
	assert.deepEqual(extractDeniedPaths(""), []);
	// 含特征串但没有绝对路径 token 的行：兜底扫描也抽不出东西
	assert.deepEqual(extractDeniedPaths("grep: Operation not permitted 只是普通文本"), []);
});

test("extractDeniedPaths：相对路径与无路径行返回空（退回按命令确认）", () => {
	assert.deepEqual(extractDeniedPaths("rm: foo.txt: Operation not permitted"), [], "相对路径不认（猜不出绝对目标）");
	assert.deepEqual(extractDeniedPaths("Operation not permitted"), []);
});

test("classifyOutsidePaths：边界内 / 已授权 / 危险 / 普通四档互斥", () => {
	const b = makeBoundary(CWD);
	const result = classifyOutsidePaths(
		[
			`${CWD}/src/x.ts`, // 边界内
			`${HOME}/Downloads/a.txt`, // 已授权（allowedRoots 里有 ~/Downloads）
			`${HOME}/Downloads/b.txt`, // 已授权（同目录）
			`${HOME}/.zshrc`, // 危险
			`${HOME}/projects/foo/y.txt`, // 普通
		],
		{ boundary: b, allowedRoots: [`${HOME}/Downloads`], sessionRoots: [], env },
	);
	assert.deepEqual(result.inside, [`${CWD}/src/x.ts`]);
	assert.deepEqual(result.covered, [`${HOME}/Downloads/a.txt`, `${HOME}/Downloads/b.txt`]);
	assert.deepEqual(result.dangerous.map((d) => d.path), [`${HOME}/.zshrc`]);
	assert.deepEqual(result.ordinary, [`${HOME}/projects/foo/y.txt`]);
});

test("classifyOutsidePaths：会话豁免优先于危险判定", () => {
	const b = makeBoundary(CWD);
	const result = classifyOutsidePaths([`${HOME}/.config/foo/bar`], {
		boundary: b,
		allowedRoots: [],
		sessionRoots: [`${HOME}/.config/foo`],
		env,
	});
	assert.deepEqual(result.covered, [`${HOME}/.config/foo/bar`], "本会话豁免过就不再问");
	assert.equal(result.dangerous.length, 0);
});

test("classifyOutsidePaths：边界内优先 —— /private/tmp 在 /private 下但不危险", () => {
	const b = makeBoundary(CWD);
	const result = classifyOutsidePaths(["/private/tmp/x"], { boundary: b, allowedRoots: [], sessionRoots: [], env });
	assert.deepEqual(result.inside, ["/private/tmp/x"], "先判边界：临时根直接放行");
	assert.equal(result.dangerous.length, 0);
});

test("classifyOutsidePaths：去重", () => {
	const b = makeBoundary(CWD);
	const result = classifyOutsidePaths([`${HOME}/projects/a`, `${HOME}/projects/a/`, `${HOME}/projects/a`], {
		boundary: b,
		allowedRoots: [],
		sessionRoots: [],
		env,
	});
	assert.deepEqual(result.ordinary, [`${HOME}/projects/a`]);
});

test("memoryScopesFor：一批目标折算出去重的范围", () => {
	assert.deepEqual(memoryScopesFor([`${HOME}/Downloads/a`, `${HOME}/Downloads/b`], env, CWD), [`${HOME}/Downloads`]);
});

test("buildSeatbeltProfile：extraUnlinkRoots 并进同一行 allow，顺序不变", () => {
	const profile = buildSeatbeltProfile(makeBoundary(CWD), [`${HOME}/Downloads`, `${HOME}/Downloads`]);
	const lines = profile.split("\n");
	const unlinkAllow = lines.find((l) => l.startsWith("(allow file-write-unlink "));
	assert.ok(unlinkAllow, "仍只有一行 unlink allow");
	assert.ok(unlinkAllow!.includes(`(subpath "${HOME}/Downloads")`), "白名单根进了放行名单");
	assert.equal(unlinkAllow!.split(`(subpath "${HOME}/Downloads")`).length - 1, 1, "去重");
	assert.ok(
		lines.indexOf("(deny file-write-unlink)") < lines.indexOf(unlinkAllow!),
		"全局 deny 仍在 allow 之前（seatbelt 后写覆盖先写）",
	);
});
