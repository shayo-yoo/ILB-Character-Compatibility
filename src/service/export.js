// service/export.js —— 把一个角色卡 + 它的书 + 关联组装成 .ilbchar.json
//
// 流程（需求 §5 / 审计 §7）：选卡 → 取全量卡 → 查关联书 → 勾选 → 逐本导出 → 拿原生 V2 JSON → 组装。
// 两条硬规则：
//   1. 任何一本书导出失败，就**不出半成品包**——用户拿到一个缺书的包，比拿到报错更糟。
//   2. 给包里的书/关联用包内自己的 ref，不引用导出端的 book_id（导入会换 id）。

import { buildPackage, packageFileName } from '../core/package.js';
import { normalizeIdentity } from '../core/identity.js';

/**
 * @param {{ilb:object, cards:object, bindings:object, now?:()=>number}} deps
 */
export function createExportService({ ilb, cards, bindings, now = () => Date.now() }) {
  /**
   * 导出前的清单：当前角色关联了哪些书、哪些已经失效。
   * @param {string} avatar
   */
  async function plan(avatar) {
    const full = await cards.getFull(avatar);
    const identity = normalizeIdentity({ avatar, name: full?.name });
    const listed = await bindings.listForCharacter(identity);
    if (!listed.ok) return { ok: false, code: listed.code, message: listed.message };

    const books = listed.rows.map((row) => ({
      bookId: row.bookId,
      name: row.bookName,
      exists: row.bookExists,
      policy: row.policy,
      note: row.note,
      bindingId: row.id,
    }));
    return {
      ok: true,
      character: identity,
      books,
      exportable: books.filter((book) => book.exists).length,
      missing: books.filter((book) => !book.exists).length,
      warnings: books.filter((book) => !book.exists).map((book) => `「${book.name}」已经不在 ILB 里了，导出时会跳过`),
    };
  }

  /**
   * 真正导出。bookIds 为空时导出全部可用的关联书。
   * @param {{avatar:string, bookIds?:string[]}} input
   * @returns {Promise<{ok:true, package:object, fileName:string, text:string, bookCount:number, bindingCount:number, skipped:string[]}|{ok:false, code:string, message:string, failures:Array}>}
   */
  async function run({ avatar, bookIds = null, onProgress = null }) {
    const report = (message) => {
      try {
        onProgress?.(message);
      } catch {
        /* 进度回调坏了不影响导出 */
      }
    };

    const planResult = await plan(avatar);
    if (!planResult.ok) return { ok: false, code: planResult.code, message: planResult.message, failures: [] };

    const wanted = new Set(Array.isArray(bookIds) && bookIds.length > 0 ? bookIds.map(String) : []);
    const chosen = planResult.books.filter((book) => book.exists && (wanted.size === 0 || wanted.has(book.bookId)));
    if (chosen.length === 0 && planResult.books.length > 0) {
      return { ok: false, code: 'NO_BOOKS', message: '没有勾选任何可导出的书', failures: [] };
    }

    const packed = [];
    const failures = [];
    for (const book of chosen) {
      report(`正在导出《${book.name}》…`);
      try {
        const exported = await ilb.exportBook(book.bookId);
        if (!exported) throw new Error('ILB 没有返回这本书的内容');
        packed.push({ ref: book.bookId, name: book.name, book: exported });
      } catch (err) {
        failures.push({ bookId: book.bookId, name: book.name, message: String(err?.message ?? err) });
      }
    }
    if (failures.length > 0) {
      return {
        ok: false,
        code: 'EXPORT_FAILED',
        message: `有 ${failures.length} 本书没能导出，为了不给你半成品包，这次导出取消了`,
        failures,
      };
    }

    report('正在读取角色卡…');
    let card;
    try {
      card = await cards.exportJson(avatar);
    } catch (err) {
      return { ok: false, code: err?.code ?? 'CARD_EXPORT_FAILED', message: `导出角色卡失败：${err?.message ?? err}`, failures: [] };
    }

    const bindingList = chosen.map((book) => ({ bookRef: book.bookId, policy: book.policy, note: book.note }));
    const pkg = buildPackage({
      identity: planResult.character,
      card,
      books: packed,
      bindings: bindingList,
      now: now(),
    });

    return {
      ok: true,
      package: pkg,
      fileName: packageFileName(planResult.character.name || pkg.character.identity.name, now()),
      text: JSON.stringify(pkg, null, 2),
      bookCount: packed.length,
      bindingCount: bindingList.length,
      skipped: planResult.books.filter((book) => !book.exists).map((book) => book.name),
    };
  }

  return { plan, run };
}
