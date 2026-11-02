// 包格式与身份判据的单元测试（纯函数，不碰 DOM）
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PACKAGE_FORMAT,
  PACKAGE_VERSION,
  buildPackage,
  parsePackage,
  validatePackage,
  summarizePackage,
  packageFileName,
  cardNameOf,
  safeFileStem,
} from '../src/core/package.js';
import { avatarOf, nameOf, normalizeIdentity, avatarStem, identityProblem, isShallow, sameCharacter, identityLabel } from '../src/core/identity.js';

const CARD = { name: '阿离', description: '测试角色', data: { name: '阿离', extensions: { keep: true } } };
const BOOK = { schema_version: 2, book_id: 'b1', name: '共享书', entries: [{ id: 'e1' }], logic: [] };

function samplePackage(overrides = {}) {
  return {
    format: PACKAGE_FORMAT,
    format_version: PACKAGE_VERSION,
    created_at: 1_700_000_000_000,
    generator: 'test',
    character: { identity: { avatar: 'ali.png', name: '阿离' }, card: CARD },
    worldbooks: [{ ref: 'b1', name: '共享书', book: BOOK }],
    bindings: [{ book_ref: 'b1', policy: 'on', note: '常用' }],
    metadata: { book_count: 1, binding_count: 1 },
    ...overrides,
  };
}

test('buildPackage 保留角色卡未知字段，并按包内 ref 记关联', () => {
  const pkg = buildPackage({
    identity: { avatar: 'ali.png', name: '阿离' },
    card: CARD,
    books: [{ ref: 'b1', name: '共享书', book: BOOK }],
    bindings: [{ bookRef: 'b1', policy: 'on', note: '常用' }],
    now: 123,
  });
  assert.equal(pkg.format, PACKAGE_FORMAT);
  assert.equal(pkg.format_version, 1);
  assert.equal(pkg.character.card.data.extensions.keep, true);
  assert.deepEqual(pkg.bindings, [{ book_ref: 'b1', policy: 'on', note: '常用' }]);
  assert.equal(pkg.metadata.book_count, 1);
});

test('buildPackage 丢弃指向未知书的关联，而不是留一个断链', () => {
  const pkg = buildPackage({
    identity: { avatar: 'a.png' },
    card: CARD,
    books: [{ ref: 'b1', book: BOOK }],
    bindings: [{ bookRef: 'missing', policy: 'on' }],
  });
  assert.equal(pkg.bindings.length, 0);
});

test('buildPackage 对重复 ref 自动加序号，避免两本书撞名', () => {
  const pkg = buildPackage({
    identity: { avatar: 'a.png' },
    card: CARD,
    books: [
      { ref: 'b1', book: BOOK },
      { ref: 'b1', book: { ...BOOK, book_id: 'b2', name: '第二本' } },
    ],
  });
  assert.deepEqual(pkg.worldbooks.map((b) => b.ref), ['b1', 'b1-2']);
});

test('validatePackage 满足格式但缺角色卡时拒绝', () => {
  const result = validatePackage(samplePackage({ character: { identity: {}, card: null } }));
  assert.equal(result.ok, false);
  assert.match(result.message, /角色卡/);
});

test('validatePackage 拒绝更新的格式版本，而不是猜着读', () => {
  const result = validatePackage(samplePackage({ format_version: 2 }));
  assert.equal(result.ok, false);
  assert.equal(result.code, 'UNSUPPORTED_VERSION');
  assert.match(result.message, /升级/);
});

test('validatePackage 拒绝不认识的 format', () => {
  const result = validatePackage(samplePackage({ format: 'something-else' }));
  assert.equal(result.ok, false);
  assert.equal(result.code, 'BAD_FORMAT');
});

test('validatePackage 拒绝指向包里不存在的书的关联', () => {
  const result = validatePackage(samplePackage({ bindings: [{ book_ref: 'nope', policy: 'auto' }] }));
  assert.equal(result.ok, false);
  assert.match(result.message, /book_ref|关联/);
});

test('validatePackage 拒绝比当前 ILB 新的书（schema_version>2）', () => {
  const result = validatePackage(samplePackage({ worldbooks: [{ ref: 'b1', book: { ...BOOK, schema_version: 3 } }] }));
  assert.equal(result.ok, false);
  assert.equal(result.code, 'UNSUPPORTED_VERSION');
});

test('validatePackage 对不认识的策略只警告，不拦下整个包', () => {
  const result = validatePackage(samplePackage({ bindings: [{ book_ref: 'b1', policy: 'weird' }] }));
  assert.equal(result.ok, true);
  assert.equal(result.warnings.length, 1);
});

test('parsePackage 对坏 JSON 给出人话而不是抛异常', () => {
  const result = parsePackage('{ not json');
  assert.equal(result.ok, false);
  assert.match(result.message, /JSON/);
});

test('parsePackage 容忍 BOM 与首尾空白', () => {
  const text = `\uFEFF\n  ${JSON.stringify(samplePackage())}\n`;
  const result = parsePackage(text);
  assert.equal(result.ok, true);
});

test('summarizePackage 只给数量与名字，不带条目正文', () => {
  const summary = summarizePackage(samplePackage());
  assert.equal(summary.character.name, '阿离');
  assert.equal(summary.books[0].entries, 1);
  assert.equal(summary.bindings[0].policy, 'on');
  assert.equal(JSON.stringify(summary).includes('e1'), false);
});

test('packageFileName 用角色名与日期，不用 avatar', () => {
  const name = packageFileName('阿离', new Date('2026-11-02T10:00:00').getTime());
  assert.equal(name, '阿离-20261102.ilbchar.json');
});

test('safeFileStem 去掉文件名里的非法字符', () => {
  assert.equal(safeFileStem('a/b:c*?'), 'a_b_c__');
  assert.equal(safeFileStem('   '), 'character');
});

test('cardNameOf 兼容 V2 顶层 name 与 V1 data.name', () => {
  assert.equal(cardNameOf({ name: '顶层' }), '顶层');
  assert.equal(cardNameOf({ data: { name: '内层' } }), '内层');
  assert.equal(cardNameOf(null), '');
});

test('身份：avatar 优先，name 缺失时退回 avatar 去扩展名', () => {
  assert.equal(avatarOf({ avatar: 'a.png', avatar_url: 'b.png' }), 'a.png');
  assert.equal(avatarOf({ avatar_url: 'b.png' }), 'b.png');
  assert.deepEqual(normalizeIdentity({ avatar: 'x.png' }), { avatar: 'x.png', name: 'x' });
  assert.equal(nameOf({ name: '名字' }), '名字');
  assert.equal(avatarStem('x.png'), 'x');
});

test('identityProblem 在没有 avatar 时出声', () => {
  assert.match(identityProblem({}), /avatar/);
  assert.equal(identityProblem({ avatar: 'a.png' }), '');
});

test('isShallow 能认出懒加载的浅数据', () => {
  assert.equal(isShallow({ name: 'a', shallow: true }), true);
  assert.equal(isShallow({ name: 'a' }), true);
  assert.equal(isShallow({ name: 'a', description: '' }), false);
  assert.equal(isShallow({ name: 'a', data: {} }), false);
});

test('sameCharacter 只比 avatar', () => {
  assert.equal(sameCharacter({ avatar: 'a.png' }, { avatar: 'a.png', name: '另一名字' }), true);
  assert.equal(sameCharacter({ avatar: 'a.png' }, { avatar: 'b.png' }), false);
  assert.equal(sameCharacter({}, {}), false);
});

test('identityLabel 名字与 avatar 相同时不重复显示', () => {
  assert.equal(identityLabel({ avatar: 'ali.png', name: 'ali' }), 'ali.png');
  assert.match(identityLabel({ avatar: 'ali.png', name: '阿离' }), /阿离/);
  assert.equal(identityLabel(null), '（未知角色）');
});
