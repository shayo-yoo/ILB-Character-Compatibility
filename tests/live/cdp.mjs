// tests/live/cdp.mjs —— 连本地无头 Chrome 的小工具（真实浏览器验收用）
//
// 这些脚本不属于 `node --test`：它们需要一个已经跑起来的 SillyTavern 和一个
// 带 --remote-debugging-port 的 Chrome。用法见同目录 README.md。
//
// 环境变量：
//   ST_URL     页面地址，默认 http://127.0.0.1:8000/
//   CDP_PORT   调试端口，默认 9222
import { createRequire } from 'node:module';

const ST_URL = process.env.ST_URL ?? 'http://127.0.0.1:8000/';
const CDP_PORT = process.env.CDP_PORT ?? '9222';
const CDP = `http://127.0.0.1:${CDP_PORT}`;

/** SillyTavern 的 node_modules 里有 ws；找不到就报一句人话 */
function loadWs(stDir) {
  try {
    const require = createRequire(`${stDir.replace(/\\/g, '/')}/package.json`);
    return require('ws');
  } catch (error) {
    throw new Error(`找不到 ws 模块：检查 ST_DIR 是否指向 SillyTavern 根目录（当前 ${stDir}）`);
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 新开一个标签页并连上 CDP */
export async function openPage(stDir, url = ST_URL) {
  const WebSocket = loadWs(stDir);
  const res = await fetch(`${CDP}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
  if (!res.ok) throw new Error(`开新标签页失败（${res.status}）：Chrome 是否带 --remote-debugging-port 启动？`);
  const page = await res.json();

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });

  let seq = 0;
  const waiting = new Map();
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.id && waiting.has(msg.id)) {
      waiting.get(msg.id)(msg);
      waiting.delete(msg.id);
    }
  });

  const send = (method, params = {}) => {
    seq += 1;
    ws.send(JSON.stringify({ id: seq, method, params }));
    return new Promise((resolve) => waiting.set(seq, resolve));
  };

  const evaluate = async (expression) => {
    const got = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    const details = got.result?.exceptionDetails;
    if (details) throw new Error(details.exception?.description ?? details.text);
    return got.result?.result?.value;
  };

  return { send, evaluate, close: () => ws.close() };
}

/** 等扩展挂到页面上（最多等 timeoutMs） */
export async function waitForIlb(evaluate, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(1000);
    if (await evaluate('Boolean(globalThis.ILB)')) return true;
  }
  return false;
}

export async function screenshot(send, path, clip) {
  const params = { format: 'png' };
  if (clip) params.clip = clip;
  const shot = await send('Page.captureScreenshot', params);
  const { writeFileSync } = await import('node:fs');
  writeFileSync(path, Buffer.from(shot.result.data, 'base64'));
}
