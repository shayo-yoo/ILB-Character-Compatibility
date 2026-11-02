// service/bindings.js —— 当前角色 ↔ 书的关联管理（只做翻译与组合，数据在 ILB）
//
// 硬边界：关联**只存 ILB**，本扩展不另存副本。界面上的"书是否存在""是否孤儿"
// 全部是每次现查 ILB，不用缓存糊弄——缓存一旧，用户就会看到一张假状态。

import { avatarOf, normalizeIdentity } from '../core/identity.js';

/**
 * @param {{ilb: object}} deps
 */
export function createBindingService({ ilb }) {
  /** 书列表按 id 建索引，供关联行显示书名 */
  async function bookIndex() {
    const books = await ilb.listBooks();
    const index = new Map();
    for (const book of books) index.set(String(book.id ?? ''), book);
    return index;
  }

  /**
   * 当前角色的关联行（按书的创建顺序，稳定）。
   * @param {{avatar?:string,name?:string}} character
   */
  async function listForCharacter(character) {
    const identity = normalizeIdentity(character);
    if (!avatarOf(identity)) {
      return { ok: false, code: 'NO_AVATAR', message: '当前没有角色（群聊或未进入聊天），先打开一张角色卡', rows: [] };
    }
    const [bindings, books] = await Promise.all([ilb.listBindings({ character: identity.avatar }), bookIndex()]);
    const rows = bindings.map((binding) => {
      const book = books.get(String(binding.bookId ?? ''));
      return {
        id: String(binding.id ?? ''),
        bookId: String(binding.bookId ?? ''),
        bookName: String(book?.name ?? '（书已不存在）'),
        bookExists: Boolean(book),
        policy: ['auto', 'on', 'off'].includes(binding.policy) ? binding.policy : 'auto',
        note: String(binding.note ?? ''),
        orphaned: Boolean(binding.orphanedAt),
        createdAt: Number(binding.createdAt) || 0,
        updatedAt: Number(binding.updatedAt) || 0,
      };
    });
    rows.sort((a, b) => a.createdAt - b.createdAt || a.bookName.localeCompare(b.bookName, 'zh-Hans-CN'));
    return { ok: true, rows, identity, missing: rows.filter((row) => !row.bookExists).length };
  }

  /** 加关联；同书已关联时给一句人话，不算异常流程 */
  async function add({ character, bookId, policy = 'auto', note = '' }) {
    const identity = normalizeIdentity(character);
    if (!avatarOf(identity)) throw new Error('当前没有角色，无法建立关联');
    const binding = await ilb.createBinding({ avatar: identity.avatar, name: identity.name, bookId, policy, note });
    return binding;
  }

  async function setPolicy(id, policy) {
    return ilb.updateBinding(id, { policy });
  }

  async function setNote(id, note) {
    return ilb.updateBinding(id, { note });
  }

  async function remove(id) {
    return ilb.removeBinding(id);
  }

  /** 导出用：当前角色关联的所有 bookId（去重、保持顺序） */
  async function bookIdsFor(character) {
    const identity = normalizeIdentity(character);
    if (!avatarOf(identity)) return [];
    const bindings = await ilb.listBindings({ character: identity.avatar });
    const seen = new Set();
    const ids = [];
    for (const binding of bindings) {
      if (binding.orphanedAt) continue;
      const id = String(binding.bookId ?? '');
      if (!id || seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
    }
    return ids;
  }

  return { listForCharacter, add, setPolicy, setNote, remove, bookIdsFor, bookIndex };
}
