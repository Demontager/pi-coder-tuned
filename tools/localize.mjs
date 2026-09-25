/** Maintainer tool: translate known upstream literals after merging upstream changes. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argument = (name) => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined;
const catalogPath = path.join(root, "tools/english-catalog.json");
const imported = argument("--import-catalog");
const catalog = JSON.parse(fs.readFileSync(imported ?? catalogPath, "utf8"));
if (imported) fs.writeFileSync(catalogPath, JSON.stringify(catalog, null, 2) + "\n");
const write = process.argv.includes("--write");
const retained = new Set(["(?:summary|prompt summary|recap|title|label|摘要|总结|概括|简述|一句话摘要)"]);
const missing = [];
let count = 0;

function walk(dir) {
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, item.name);
    if (item.isDirectory()) { walk(file); continue; }
    if (!file.endsWith(".ts")) continue;
    const test = file.endsWith(".test.ts");
    const source = fs.readFileSync(file, "utf8");
    const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    const edits = [];
    function visit(node) {
      const string = ts.isStringLiteral(node);
      const template = ts.isNoSubstitutionTemplateLiteral(node) || [ts.SyntaxKind.TemplateHead, ts.SyntaxKind.TemplateMiddle, ts.SyntaxKind.TemplateTail].includes(node.kind);
      if ((string || template) && /\p{Script=Han}/u.test(node.text) && !retained.has(node.text)) {
        const translation = catalog[node.text];
        if (translation === undefined) {
          if (!test) missing.push({ file: path.relative(root, file), line: tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1, text: node.text });
        } else {
          let replacement;
          if (string) replacement = JSON.stringify(translation);
          else {
            const escaped = translation.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
            const start = node.kind === ts.SyntaxKind.TemplateMiddle || node.kind === ts.SyntaxKind.TemplateTail ? "}" : "`";
            const end = node.kind === ts.SyntaxKind.TemplateHead || node.kind === ts.SyntaxKind.TemplateMiddle ? "${" : "`";
            replacement = start + escaped + end;
          }
          edits.push({ start: node.getStart(tree), end: node.end, replacement });
          if (!test) count++;
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(tree);
    if (write && edits.length) {
      let output = source;
      for (const edit of edits.sort((a, b) => b.start - a.start)) output = output.slice(0, edit.start) + edit.replacement + output.slice(edit.end);
      const parsed = ts.createSourceFile(file, output, ts.ScriptTarget.Latest, true);
      if (parsed.parseDiagnostics.length) throw new Error(`Invalid translated TypeScript: ${file}`);
      fs.writeFileSync(file, output);
    }
  }
}
walk(path.join(root, "extensions"));
if (missing.length) console.error(JSON.stringify({ untranslated: missing }, null, 2));
console.log(`${write ? "Translated" : "Unapplied translations"}: ${count}; unknown production literals: ${missing.length}`);
process.exitCode = missing.length || (!write && count) ? 1 : 0;
