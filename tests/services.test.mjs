// 服务层单元测试：用假 ILB / 假酒馆验证编排逻辑（不连网络、不碰 DOM）
import test from 'node:test';
import assert from 'node:assert/strict';

import { createBindingService } from '../src/service/bindings.js';
import { createExportService } from '../src/service/export.js';
import { createImportService } from '../src/service/import.js';
import { pushRecord, HISTORY_LIMIT, createHistoryService } from '../src/service/history.js';
import { buildPackage } from '../src/core/package.js';

const CARD = { name: '阿离', description: '测试角色', data: { name: '阿离' } };
const BOOK = (id, name, entries = 2) => ({ schema_version: 2, book_id: id, name, entries: Array.from({ length: entries }, (_, i) => ({ id: `${id}-e${i}`, content: `条目 ${i}` })), logic: [] });

function makeIlb({ books = [], bindings = [], importBook } = {}) {
  const state = { books: books.slice(), bindings: bindings.slice() };
  let counter = 0;
  const client = {
    async listBooks() {
      return state.books.map((book) => ({ id: book.book_id, name: book.name, entries: book.entries.length }));
    },
    async exportBook(id) {
      return state.books.find((book) => book.book_id === id) ?? null;
    },
    async importBook(payload, { onConflict = 'ask' } = {}) {
      if (importBook) return importBook(payload, { onConflict, state });
      const incoming = payload.book;
      const existing = state.books.find((book) => book.book_id === incoming.book_id);
      if (existing && onConflict === 'skip') return { id: existing.book_id, action: 'skipped' };
      if (existing && onConflict === 'ask') {
        const err = new Error('这本书已经存在');
        err.code = 'CONFLICT';
        throw err;
      }
      if (existing && onConflict === 'overwrite') {
        Object.assign(existing, incoming);
        return { id: existing.book_id, action: 'overwritten' };
      }
      const id = existing ? `new-${++counter}` : incoming.book_id;
      state.books.push({ ...incoming, book_id: id });
      return { id, action: 'created' };
    },
    async listBindings({ character } = {}) {
      return state.bindings.filter((binding) => !character || binding.character.avatar === character);
    },
    async createBinding({ avatar, name, bookId, policy, note }) {
      const existing = state.bindings.find((binding) => binding.character.avatar === avatar && binding.bookId === bookId);
      if (existing) {
        const err = new Error('这个角色已经关联过这本书了');
        err.code = 'CONFLICT';
        throw err;
      }
      const binding = { id: `bind-${state.bindings.length + 1}`, character: { avatar, name }, bookId, policy, note, createdAt: state.bindings.length + 1, updatedAt: state.bindings.length + 1, orphanedAt: null };
      state.bindings.push(binding);
      return binding;
    },
    async updateBinding(id, patch) {
      const binding = state.bindings.find((item) => item.id === id);
      if (!binding) return null;
      Object.assign(binding, patch);
      return binding;
    },
    async removeBinding(id) {
      const at = state.bindings.findIndex((item) => item.id === id);
      if (at < 0) return false;
      state.bindings.splice(at, 1);
      return true;
    },
    state,
  };
  return client;
}

function makeCards({ full = CARD, importResult = { fileName: 'ali', avatar: 'ali.png' }, failImport = false } = {}) {
  return {
    list: () => [{ name: '阿离', avatar: 'ali.png' }],
    async getFull() {
      return full;
    },
    async exportJson() {
      return CARD;
    },
    async importJson() {
      if (failImport) throw new Error('酒馆拒绝了这张卡');
      return importResult;
    },
    async remove() {
      return true;
    },
  };
}

test('关联服务：列出当前角色的关联，并把已删除的书标出来', async () => {
  const ilb = makeIlb({
    books: [BOOK('b1', '共享书')],
    bindings: [
      { id: 'bind-1', character: { avatar: 'ali.png', name: '阿离' }, bookId: 'b1', policy: 'on', note: '', createdAt: 1, updatedAt: 1, orphanedAt: null },
      { id: 'bind-2', character: { avatar: 'ali.png', name: '阿离' }, bookId: 'gone', policy: 'auto', note: '', createdAt: 2, updatedAt: 2, orphanedAt: null },
      { id: 'bind-3', character: { avatar: 'other.png', name: '别人' }, bookId: 'b1', policy: 'off', note: '', createdAt: 3, updatedAt: 3, orphanedAt: null },
    ],
  });
  const service = createBindingService({ ilb });
  const result = await service.listForCharacter({ avatar: 'ali.png', name: '阿离' });
  assert.equal(result.ok, true);
  assert.equal(result.rows.length, 2);
  assert.equal(result.rows[0].bookName, '共享书');
  assert.equal(result.rows[1].bookExists, false);
  assert.equal(result.missing, 1);
});

test('关联服务：没有 avatar 时返回失败而不是抛异常', async () => {
  const service = createBindingService({ ilb: makeIlb() });
  const result = await service.listForCharacter({ name: '群聊' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'NO_AVATAR');
});

test('关联服务：bookIdsFor 跳过孤儿、去重、保持顺序', async () => {
  const ilb = makeIlb({
    bindings: [
      { id: '1', character: { avatar: 'a.png' }, bookId: 'b1', createdAt: 1 },
      { id: '2', character: { avatar: 'a.png' }, bookId: 'b2', createdAt: 2 },
      { id: '3', character: { avatar: 'a.png' }, bookId: 'b1', createdAt: 3 },
      { id: '4', character: { avatar: 'a.png' }, bookId: 'b3', createdAt: 4, orphanedAt: 9 },
    ],
  });
  const service = createBindingService({ ilb });
  assert.deepEqual(await service.bookIdsFor({ avatar: 'a.png' }), ['b1', 'b2']);
});

test('导出：把角色卡、书、关联组装成一个包，关联用包内 ref', async () => {
  const ilb = makeIlb({
    books: [BOOK('b1', '共享书'), BOOK('b2', '专属书')],
    bindings: [
      { id: '1', character: { avatar: 'ali.png', name: '阿离' }, bookId: 'b1', policy: 'auto', note: '', createdAt: 1 },
      { id: '2', character: { avatar: 'ali.png', name: '阿离' }, bookId: 'b2', policy: 'on', note: '必开', createdAt: 2 },
    ],
  });
  const cards = makeCards();
  const exporter = createExportService({ ilb, cards, bindings: createBindingService({ ilb }), now: () => 1000 });
  const result = await exporter.run({ avatar: 'ali.png' });
  assert.equal(result.ok, true);
  assert.equal(result.bookCount, 2);
  assert.equal(result.bindingCount, 2);
  assert.deepEqual(result.package.bindings.map((b) => b.book_ref), ['b1', 'b2']);
  assert.equal(result.package.character.card.name, '阿离');
  assert.match(result.fileName, /阿离.*\.ilbchar\.json$/);
  assert.equal(JSON.parse(result.text).format, 'ilb-character-package');
});

test('导出：任一本书导出失败就不出半成品包', async () => {
  const ilb = makeIlb({
    books: [BOOK('b1', '共享书')],
    bindings: [{ id: '1', character: { avatar: 'ali.png' }, bookId: 'b1', createdAt: 1 }],
  });
  ilb.exportBook = async (id) => {
    if (id === 'b1') throw new Error('磁盘读不出来');
    return null;
  };
  const exporter = createExportService({ ilb, cards: makeCards(), bindings: createBindingService({ ilb }) });
  const result = await exporter.run({ avatar: 'ali.png' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'EXPORT_FAILED');
  assert.equal(result.failures.length, 1);
  assert.equal(result.package, undefined);
});

test('导出：只勾选部分书时，包里只有勾选的那些关联', async () => {
  const ilb = makeIlb({
    books: [BOOK('b1', '共享书'), BOOK('b2', '专属书')],
    bindings: [
      { id: '1', character: { avatar: 'ali.png' }, bookId: 'b1', policy: 'auto', createdAt: 1 },
      { id: '2', character: { avatar: 'ali.png' }, bookId: 'b2', policy: 'on', createdAt: 2 },
    ],
  });
  const exporter = createExportService({ ilb, cards: makeCards(), bindings: createBindingService({ ilb }) });
  const result = await exporter.run({ avatar: 'ali.png', bookIds: ['b2'] });
  assert.equal(result.ok, true);
  assert.equal(result.package.worldbooks.length, 1);
  assert.equal(result.package.bindings.length, 1);
  assert.equal(result.package.bindings[0].policy, 'on');
});

function packageWith({ books, bindings }) {
  return buildPackage({
    identity: { avatar: 'src.png', name: '阿离' },
    card: CARD,
    books,
    bindings,
    now: 1700000000000,
  });
}

test('导入：先导书再导卡，最后用新 id 建关联', async () => {
  const ilb = makeIlb();
  const cards = makeCards();
  const importer = createImportService({ ilb, cards });
  const pkg = packageWith({ books: [{ ref: 'b1', name: '共享书', book: BOOK('b1', '共享书') }], bindings: [{ bookRef: 'b1', policy: 'on', note: '' }] });
  const result = await importer.run(pkg);
  assert.equal(result.ok, true);
  assert.equal(result.character.avatar, 'ali.png');
  assert.equal(result.books.imported.length, 1);
  assert.equal(result.bindings.created.length, 1);
  assert.equal(ilb.state.bindings.length, 1);
  assert.equal(ilb.state.bindings[0].bookId, 'b1');
  assert.equal(ilb.state.bindings[0].character.avatar, 'ali.png');
});

test('导入：同 id 的书默认用已有的（skip），并把关联指到已有 id', async () => {
  const ilb = makeIlb({ books: [BOOK('b1', '共享书', 3)] });
  const importer = createImportService({ ilb, cards: makeCards() });
  const pkg = packageWith({ books: [{ ref: 'b1', name: '共享书', book: BOOK('b1', '共享书', 1) }], bindings: [{ bookRef: 'b1', policy: 'auto' }] });
  const preview = await importer.plan(pkg);
  assert.equal(preview.books[0].action, 'skip');
  assert.equal(preview.books[0].conflict.kind, 'id');

  const result = await importer.run(pkg);
  assert.equal(result.ok, true);
  assert.equal(result.books.skipped.length, 1);
  assert.equal(ilb.state.books.length, 1, '不该多出一本');
  assert.equal(ilb.state.bindings[0].bookId, 'b1');
});

test('导入：同名不同 id 时默认新建，也可以选择复用已有书', async () => {
  const ilb = makeIlb({ books: [BOOK('old', '共享书')] });
  const importer = createImportService({ ilb, cards: makeCards() });
  const pkg = packageWith({ books: [{ ref: 'b1', name: '共享书', book: BOOK('b1', '共享书') }], bindings: [{ bookRef: 'b1', policy: 'auto' }] });

  const preview = await importer.plan(pkg);
  assert.equal(preview.books[0].conflict.kind, 'name');
  assert.deepEqual(preview.books[0].options, ['create', 'reuse']);

  const reuse = await importer.run(pkg, { decisions: { b1: 'reuse' } });
  assert.equal(reuse.ok, true);
  assert.equal(reuse.books.reused.length, 1);
  assert.equal(ilb.state.books.length, 1);
  assert.equal(ilb.state.bindings[0].bookId, 'old');
});

test('导入：一本书失败就停止，不导入角色卡（卡导进去撤不回来）', async () => {
  const ilb = makeIlb({
    importBook: async () => {
      throw new Error('书的内容坏了');
    },
  });
  let importedCard = false;
  const cards = { ...makeCards(), async importJson() { importedCard = true; return { avatar: 'x.png', fileName: 'x' }; } };
  const importer = createImportService({ ilb, cards });
  const pkg = packageWith({ books: [{ ref: 'b1', name: '共享书', book: BOOK('b1', '共享书') }], bindings: [{ bookRef: 'b1', policy: 'auto' }] });
  const result = await importer.run(pkg);
  assert.equal(result.ok, false);
  assert.equal(result.aborted, 'books');
  assert.equal(importedCard, false);
  assert.equal(result.books.failed.length, 1);
});

test('导入：角色卡失败时，书保留下来并说明可以清理', async () => {
  const ilb = makeIlb();
  const importer = createImportService({ ilb, cards: makeCards({ failImport: true }) });
  const pkg = packageWith({ books: [{ ref: 'b1', name: '共享书', book: BOOK('b1', '共享书') }], bindings: [{ bookRef: 'b1', policy: 'auto' }] });
  const result = await importer.run(pkg);
  assert.equal(result.ok, false);
  assert.equal(result.aborted, 'character');
  assert.equal(result.books.imported.length, 1);
  assert.equal(result.cleanup.bookIds.length, 1);
  assert.match(result.character.error, /拒绝/);
});

test('导入：关联建失败时不能报整体成功', async () => {
  const ilb = makeIlb();
  ilb.createBinding = async () => {
    throw new Error('关联写不进去');
  };
  const importer = createImportService({ ilb, cards: makeCards() });
  const pkg = packageWith({ books: [{ ref: 'b1', name: '共享书', book: BOOK('b1', '共享书') }], bindings: [{ bookRef: 'b1', policy: 'auto' }] });
  const result = await importer.run(pkg);
  assert.equal(result.ok, false);
  assert.equal(result.partial, true);
  assert.equal(result.bindings.failed.length, 1);
});

test('导入：预览能发现酒馆里的同名角色卡', async () => {
  const ilb = makeIlb();
  const importer = createImportService({ ilb, cards: makeCards() });
  const pkg = packageWith({ books: [], bindings: [] });
  const preview = await importer.plan(pkg);
  assert.equal(preview.character.name, '阿离');
  assert.equal(preview.character.sameNameCount, 1);
});

test('历史：只保留最近 20 条', () => {
  let list = [];
  for (let i = 0; i < 25; i += 1) list = pushRecord(list, { at: i });
  assert.equal(list.length, HISTORY_LIMIT);
  assert.equal(list[0].at, 24);
});

test('历史：坏记录被规范成 failed，不把奇怪的状态写进界面', () => {
  const settings = { extensionSettings: {} };
  const host = {
    getContext: () => settings,
    saveSettings: () => true,
  };
  const service = createHistoryService({ host });
  const record = service.record({ kind: 'import', character: { avatar: 'a.png' }, summary: 'x', result: 'weird' });
  assert.equal(record.result, 'failed');
  assert.equal(record.kind, 'import');
  assert.equal(service.list().length, 1);
});
