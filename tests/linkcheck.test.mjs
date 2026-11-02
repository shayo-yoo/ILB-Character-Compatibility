// linkcheck —— 把项目里所有模块都 import 一遍，抓"改完这里忘了那里"的语法/引用错误。
// index.js 单独跳过：它有启动副作用（会去找宿主），放到真机探针里验。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'tests' || name.startsWith('.')) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (name.endsWith('.js')) out.push(full);
  }
  return out;
}

test('所有模块都能被 Node 解析并 import', async () => {
  // index.js 有启动副作用（会去找酒馆宿主），静态 import 会打一堆日志；它由真机探针覆盖。
  const files = walk(ROOT)
    .filter((file) => file !== join(ROOT, 'index.js'))
    .sort();
  assert.ok(files.length >= 10, `模块太少：${files.length}`);
  const failed = [];
  for (const file of files) {
    try {
      await import(pathToFileURL(file).href);
    } catch (err) {
      failed.push(`${relative(ROOT, file)}: ${err?.message ?? err}`);
    }
  }
  assert.deepEqual(failed, []);
});

test('index.js 作为入口存在，且 manifest 指向它', async () => {
  const { readFileSync, existsSync } = await import('node:fs');
  assert.ok(existsSync(join(ROOT, 'index.js')));
  const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));
  assert.equal(manifest.js, 'index.js');
  assert.equal(manifest.css, 'style.css');
  assert.ok(Array.isArray(manifest.requires));
});
