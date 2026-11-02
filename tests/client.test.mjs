// ILB 客户端层测试：只验证"翻译"是否正确（不连真 ILB）
import test from 'node:test';
import assert from 'node:assert/strict';

import { versionNumber, isCompatible, waitForIlb, createIlbClient, IlbError } from '../src/ilb/client.js';

function fakeApi(overrides = {}) {
  return {
    version: '1.4',
    caps: ['bindings', 'runtime', 'worldbooks'],
    worldbooks: {
      list: async () => ({ ok: true, books: [{ id: 'b1', name: '书一' }], total: 1 }),
      get: async (id) => ({ ok: true, book: { book_id: id } }),
      exportBook: async (id) => ({ ok: true, book: { book_id: id, entries: [] } }),
      importBook: async () => ({ ok: true, id: 'new-1', action: 'created' }),
      deleteBook: async () => ({ ok: true, id: 'b1', removedBindings: 0 }),
    },
    bindings: {
      list: async () => ({ ok: true, bindings: [{ id: 'bind-1', bookId: 'b1', policy: 'on' }] }),
      create: async () => ({ ok: true, binding: { id: 'bind-2' } }),
      update: async () => ({ ok: true, binding: { id: 'bind-1', policy: 'off' } }),
      remove: async () => ({ ok: true, removed: true }),
      renameCharacter: async () => ({ ok: true, updated: 2, merged: 0 }),
    },
    runtime: {
      preview: async () => ({ ok: true, books: [], activeBooks: [] }),
      status: async () => ({ ok: true, ran: false, at: 0, error: null }),
    },
    ...overrides,
  };
}

test('versionNumber 能比较 1.3 / 1.4', () => {
  assert.equal(versionNumber('1.4'), 104);
  assert.ok(versionNumber('1.4') > versionNumber('1.3'));
  assert.equal(versionNumber(''), 0);
  assert.equal(versionNumber('abc'), 0);
});

test('isCompatible 拒绝缺能力的接口', () => {
  const result = isCompatible(fakeApi({ caps: ['bindings', 'worldbooks'] }));
  assert.equal(result.ok, false);
  assert.match(result.reason, /runtime/);
});

test('isCompatible 拒绝 1.3', () => {
  const result = isCompatible(fakeApi({ version: '1.3' }));
  assert.equal(result.ok, false);
  assert.match(result.reason, /1\.4/);
});

test('isCompatible 接受 1.4', () => {
  assert.equal(isCompatible(fakeApi()).ok, true);
});

test('waitForIlb 在已经装好时立即返回', async () => {
  const api = fakeApi();
  const found = await waitForIlb({ global: { ILB: { api } }, timeoutMs: 200 });
  assert.equal(found, api);
});

test('waitForIlb 等 ILB_READY 这个 promise', async () => {
  const api = fakeApi();
  const global = { ILB_READY: Promise.resolve(api) };
  const found = await waitForIlb({ global, timeoutMs: 500 });
  assert.equal(found, api);
});

test('waitForIlb 超时返回 null（由界面提示"没装 ILB"）', async () => {
  const found = await waitForIlb({ global: {}, timeoutMs: 120, pollMs: 40 });
  assert.equal(found, null);
});

test('客户端把 ILB 的 {ok:false} 翻成 IlbError，带原错误码', async () => {
  const api = fakeApi({
    worldbooks: {
      ...fakeApi().worldbooks,
      list: async () => ({ ok: false, error: { code: 'NOT_FOUND', message: '没有这本书' } }),
    },
  });
  const client = createIlbClient(api);
  await assert.rejects(() => client.listBooks(), (err) => err instanceof IlbError && err.code === 'NOT_FOUND' && /没有这本书/.test(err.message));
});

test('客户端：需要用户确认的冲突原样抛出 CONFLICT，不自己决定', async () => {
  const api = fakeApi({
    worldbooks: {
      ...fakeApi().worldbooks,
      importBook: async () => ({ ok: false, error: { code: 'CONFLICT', message: '这本书已经存在', id: 'b1' } }),
    },
  });
  const client = createIlbClient(api);
  await assert.rejects(
    () => client.importBook({ book: {} }, { onConflict: 'ask' }),
    (err) => err.code === 'CONFLICT' && err.detail?.id === 'b1',
  );
});

test('客户端：成功时只返回数据，不把 {ok:true} 泄漏给上层', async () => {
  const client = createIlbClient(fakeApi());
  const books = await client.listBooks();
  assert.deepEqual(books.map((book) => book.id), ['b1']);
  const imported = await client.importBook({ book: {} });
  assert.equal(imported.action, 'created');
  assert.equal((await client.status()).ran, false);
});

test('客户端：没有 API 时构造就失败，且是可读的中文原因', () => {
  assert.throws(() => createIlbClient(null), (err) => err.code === 'NOT_INSTALLED');
  assert.throws(() => createIlbClient(fakeApi({ version: '1.3' })), (err) => err.code === 'NOT_SUPPORTED' && /1\.4/.test(err.message));
});

test('客户端：explain 把常见错误码翻成人话', () => {
  const client = createIlbClient(fakeApi());
  assert.match(client.explain(new IlbError('NOT_INSTALLED', 'x')), /安装/);
  assert.match(client.explain(new IlbError('NOT_FOUND', '没有这本书')), /没有这本书/);
});

test('客户端：listBindings 把 character 放进过滤条件', async () => {
  let seen = null;
  const api = fakeApi({
    bindings: {
      ...fakeApi().bindings,
      list: async (opts) => {
        seen = opts;
        return { ok: true, bindings: [] };
      },
    },
  });
  const client = createIlbClient(api);
  await client.listBindings({ character: 'ali.png' });
  assert.deepEqual(seen, { includeOrphaned: true, character: 'ali.png' });
});
