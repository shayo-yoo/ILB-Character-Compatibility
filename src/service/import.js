// service/import.js —— 拆包：先导书、再导卡、最后用真实 id 建关联
//
// 顺序不能反（需求 §6 / 审计 §7）：
//   - 书导入失败还能重试、还能清理；角色卡一导进去就很难"撤销"（酒馆没有回滚接口）。
//   - 关联必须用**导入后真实的 book_id**，不能用包里的 ref。
//
// 冲突默认不静默覆盖：同名/同 id 的书都要在预览里列出来，由人决定怎么处理。

import { cardNameOf, POLICY_VALUES } from '../core/package.js';

export const DEFAULT_ACTIONS = ['create', 'skip', 'overwrite', 'reuse'];

function normalizePolicy(value) {
  return POLICY_VALUES.includes(value) ? value : 'auto';
}

/**
 * @param {{ilb:object, cards:object, now?:()=>number}} deps
 */
export function createImportService({ ilb, cards, now = () => Date.now() }) {
  /**
   * 导入预览：每本书会怎么落库、哪些会冲突、角色卡会不会重名。
   * @param {object} pkg 已通过 parsePackage 校验的包
   */
  async function plan(pkg) {
    const existing = await ilb.listBooks();
    const byId = new Map(existing.map((book) => [String(book.id ?? ''), book]));
    const byName = new Map();
    for (const book of existing) {
      const name = String(book.name ?? '');
      if (!byName.has(name)) byName.set(name, []);
      byName.get(name).push(book);
    }

    const books = (pkg.worldbooks ?? []).map((item) => {
      const bookId = String(item?.book?.book_id ?? '');
      const name = String(item?.name || item?.book?.name || '');
      const sameId = byId.get(bookId) ?? null;
      const sameName = (byName.get(name) ?? []).filter((book) => String(book.id) !== bookId);
      let conflict = null;
      let action = 'create';
      if (sameId) {
        conflict = { kind: 'id', id: String(sameId.id), name: String(sameId.name ?? '') };
        action = 'skip';
      } else if (sameName.length > 0) {
        conflict = { kind: 'name', id: String(sameName[0].id), name: String(sameName[0].name ?? ''), count: sameName.length };
        action = 'create';
      }
      return {
        ref: String(item?.ref ?? ''),
        name,
        entries: Array.isArray(item?.book?.entries) ? item.book.entries.length : 0,
        schemaVersion: Number(item?.book?.schema_version) || 2,
        conflict,
        action,
        options: conflict?.kind === 'id' ? ['skip', 'overwrite', 'create'] : conflict?.kind === 'name' ? ['create', 'reuse'] : ['create'],
      };
    });

    const cardsNamed = cards
      .list()
      .map((character) => String(character?.name ?? ''))
      .filter(Boolean);
    const importName = cardNameOf(pkg.character?.card) || String(pkg.character?.identity?.name ?? '');

    return {
      ok: true,
      character: {
        name: importName,
        sameNameCount: cardsNamed.filter((name) => name === importName).length,
      },
      books,
      bindings: (pkg.bindings ?? []).map((binding) => ({
        bookRef: String(binding?.book_ref ?? ''),
        policy: normalizePolicy(binding?.policy),
        note: String(binding?.note ?? ''),
      })),
      hasConflicts: books.some((book) => Boolean(book.conflict)),
    };
  }

  /**
   * 执行导入。
   * @param {object} pkg
   * @param {{decisions?:Record<string,'create'|'skip'|'overwrite'|'reuse'>, onProgress?:(m:string)=>void}} options
   */
  async function run(pkg, { decisions = {}, onProgress = null } = {}) {
    const report = (message) => {
      try {
        onProgress?.(message);
      } catch {
        /* ignore */
      }
    };
    const preview = await plan(pkg);

    const result = {
      ok: false,
      partial: false,
      at: now(),
      character: { ok: false, avatar: '', name: preview.character.name, error: '' },
      books: { imported: [], skipped: [], reused: [], failed: [], map: {} },
      bindings: { created: [], failed: [] },
      aborted: null,
      cleanup: { bookIds: [] },
    };

    const decisionFor = (book) => {
      const chosen = decisions[book.ref];
      return DEFAULT_ACTIONS.includes(chosen) ? chosen : book.action;
    };

    // 第一步：书
    for (const book of preview.books) {
      const action = decisionFor(book);
      report(`正在导入《${book.name}》…`);
      try {
        if (action === 'reuse') {
          if (!book.conflict?.id) throw new Error('没有可以复用的同名书');
          result.books.reused.push({ ref: book.ref, name: book.name, id: book.conflict.id });
          result.books.map[book.ref] = book.conflict.id;
          continue;
        }
        const packed = (pkg.worldbooks ?? []).find((item) => String(item?.ref) === book.ref);
        if (!packed?.book) throw new Error('包里没有这本书的内容');
        const onConflict = action === 'create' ? 'new' : action;
        const imported = await ilb.importBook({ schema_version: packed.book.schema_version, book: packed.book }, { onConflict });
        result.books.map[book.ref] = imported.id;
        if (imported.action === 'skipped') {
          result.books.skipped.push({ ref: book.ref, name: book.name, id: imported.id });
        } else {
          result.books.imported.push({ ref: book.ref, name: book.name, id: imported.id, action: imported.action });
          if (imported.action === 'created') result.cleanup.bookIds.push(imported.id);
        }
      } catch (err) {
        result.books.failed.push({ ref: book.ref, name: book.name, message: String(err?.message ?? err) });
      }
    }

    // 有书没导进去就停在这里：卡导进去以后没法撤销，关联也会指向不存在的书。
    if (result.books.failed.length > 0) {
      result.aborted = 'books';
      result.partial = result.books.imported.length > 0 || result.books.reused.length > 0;
      return result;
    }

    // 第二步：角色卡
    report('正在导入角色卡…');
    let avatar = '';
    try {
      const imported = await cards.importJson(pkg.character?.card);
      avatar = imported.avatar;
      result.character = { ok: true, avatar, name: preview.character.name, error: '' };
    } catch (err) {
      result.character = { ok: false, avatar: '', name: preview.character.name, error: String(err?.message ?? err) };
      result.aborted = 'character';
      result.partial = result.books.imported.length > 0 || result.books.reused.length > 0;
      return result;
    }

    // 第三步：关联（用真实 book_id）
    report('正在恢复关联…');
    for (const binding of preview.bindings) {
      const bookId = result.books.map[binding.bookRef];
      if (!bookId) {
        result.bindings.failed.push({ bookRef: binding.bookRef, message: '对应的书没有导入成功' });
        continue;
      }
      try {
        const created = await ilb.createBinding({
          avatar,
          name: preview.character.name,
          bookId,
          policy: binding.policy,
          note: binding.note,
        });
        result.bindings.created.push({ bookRef: binding.bookRef, bookId, id: String(created?.id ?? '') });
      } catch (err) {
        result.bindings.failed.push({ bookRef: binding.bookRef, message: String(err?.message ?? err) });
      }
    }

    result.ok = result.bindings.failed.length === 0;
    result.partial = !result.ok;
    return result;
  }

  return { plan, run };
}
