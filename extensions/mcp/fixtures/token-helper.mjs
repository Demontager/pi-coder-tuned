/**
 * token-helper.mjs — headers-command 测试用的假"取 token 命令"。
 *
 * 三种模式（用来覆盖真实场景里头的三种行为）：
 *   --file <路径> 每次运行取下一个 token（`token-1`、`token-2`…），计数写在文件里
 *                 → 模拟"刷新后 token 会变"（能验证 401 后重试）
 *   --fixed <值> 每次运行都返回同一个 token → 模拟"命令没取到新 token"（不该重试）
 *   --fail        非零退出并往 stderr 写一行 → 模拟命令坏了
 *   --lines       用 `Key: Value` 行格式输出（而不是 JSON）
 *
 * 输出严格照契约：一行 JSON 对象，或一行 `Name: Value`。
 */

import { readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const flag = (name) => {
	const index = args.indexOf(name);
	return index === -1 ? undefined : args[index + 1];
};

if (args.includes("--fail")) {
	process.stderr.write("token 服务连不上\n");
	process.exit(3);
}

const fixed = flag("--fixed");
const counterFile = flag("--file");

let token;
if (fixed !== undefined) {
	token = fixed;
} else if (counterFile) {
	let counter = 0;
	try {
		counter = Number.parseInt(readFileSync(counterFile, "utf8").trim(), 10) || 0;
	} catch {
		counter = 0;
	}
	counter += 1;
	writeFileSync(counterFile, String(counter));
	token = `token-${counter}`;
} else {
	token = "token-fixed";
}

if (args.includes("--lines")) {
	process.stdout.write(`Authorization: Bearer ${token}\nX-Tenant: acme\n`);
} else {
	process.stdout.write(`${JSON.stringify({ Authorization: `Bearer ${token}` })}\n`);
}
