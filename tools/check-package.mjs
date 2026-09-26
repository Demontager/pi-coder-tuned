/** Load all package entries with Pi, without a provider request or real user config. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

if (!process.env.PI_TEST_PI_ENTRY) throw new Error('Set PI_TEST_PI_ENTRY to an installed pi-coding-agent/dist/index.js');
const { DefaultResourceLoader } = await import(pathToFileURL(process.env.PI_TEST_PI_ENTRY).href);
const root = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-tuned-load-'));
try {
  fs.writeFileSync(path.join(scratch, 'settings.json'), JSON.stringify({ packages: [root] }));
  const loader = new DefaultResourceLoader({ cwd: scratch, agentDir: scratch, noSkills: true, noContextFiles: true, noPromptTemplates: true });
  await loader.reload();
  const result = loader.getExtensions();
  assert.deepEqual(result.errors, []);
  assert.equal(result.extensions.length, 30);
  assert.equal(result.extensions.filter(e => path.basename(e.path) === 'stop-hook.ts').length, 1);
  const commands = result.extensions.flatMap(e => [...e.commands.keys()]);
  const tools = result.extensions.flatMap(e => [...e.tools.keys()]);
  assert.equal(new Set(commands).size, commands.length);
  assert.equal(new Set(tools).size, tools.length);
  assert.equal(commands.filter(name => name === 'recap').length, 1);
  console.log(`Loaded ${result.extensions.length} extensions: ${commands.length} unique commands, ${tools.length} unique tools.`);
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
