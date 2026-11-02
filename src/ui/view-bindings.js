// ui/view-bindings.js —— 「关联」页签：当前角色关联了哪些书、用的是哪种策略
//
// 这一页只做三件事：看、加、改/删。所有数据都现查 ILB（关联的唯一来源），
// 不在这里保存任何副本，避免"界面显示关联了、实际 ILB 里没有"这种假状态。

import { el, hint, clear, option } from './dom.js';
import { identityLabel } from '../core/identity.js';

const POLICY_LABEL = { auto: '跟随书设置（auto）', on: '强制启用', off: '强制停用' };

export function createBindingsView({ app }) {
  let busy = false;

  async function loadModel() {
    const character = app.currentCharacter();
    const [books, listed] = await Promise.all([
      app.ilb.listBooks().catch(() => []),
      app.bindings.listForCharacter(character).catch((err) => ({ ok: false, code: 'ERROR', message: err?.message ?? String(err), rows: [] })),
    ]);
    return { character, books, listed };
  }

  function bookPicker(books, rows, onAdd) {
    const bound = new Set(rows.map((row) => row.bookId));
    const candidates = books.filter((book) => !bound.has(String(book.id)));
    if (candidates.length === 0) return hint('ILB 里没有别的书可以关联了（或者还没有书）。');

    const select = el('select', { class: 'ilbcc-select' });
    for (const book of candidates) {
      select.append(option(String(book.id), `${book.name}${Number(book.entries) ? `（${book.entries} 条）` : ''}`));
    }
    const policy = el('select', { class: 'ilbcc-select' }, option('auto', POLICY_LABEL.auto, true), option('on', POLICY_LABEL.on), option('off', POLICY_LABEL.off));
    const add = el('button', {
      class: 'ilbcc-btn primary',
      type: 'button',
      text: '添加关联',
      disabled: busy,
      onclick: async () => {
        if (busy) return;
        busy = true;
        try {
          await onAdd(select.value, policy.value);
          app.notify('关联已添加', 'success');
        } catch (err) {
          app.notify(err?.message ?? '添加失败', 'error');
        } finally {
          busy = false;
          await app.refreshViews();
        }
      },
    });
    return el('div', { class: 'ilbcc-add-row' }, select, policy, add);
  }

  function rowView(bookByIndex, row) {
    const title = el('div', { class: 'ilbcc-row-title' }, el('strong', { text: row.bookName }));
    if (!row.bookExists) title.append(el('span', { class: 'ilbcc-badge warn', text: '书已删除' }));
    if (row.orphaned) title.append(el('span', { class: 'ilbcc-badge warn', text: '角色已改名或删除' }));

    const policy = el(
      'select',
      {
        class: 'ilbcc-select',
        title: '关联策略：决定这本书在这个角色下是否启用',
        onchange: async (event) => {
          const value = event.target.value;
          try {
            await app.bindings.setPolicy(row.id, value);
            app.notify('策略已更新', 'success');
          } catch (err) {
            app.notify(err?.message ?? '更新失败', 'error');
            event.target.value = row.policy;
          }
          await app.refreshViews();
        },
      },
      option('auto', POLICY_LABEL.auto, row.policy === 'auto'),
      option('on', POLICY_LABEL.on, row.policy === 'on'),
      option('off', POLICY_LABEL.off, row.policy === 'off'),
    );

    const note = el('input', {
      class: 'ilbcc-input',
      type: 'text',
      maxlength: 500,
      value: row.note,
      placeholder: '备注（可选）',
      onchange: async (event) => {
        try {
          await app.bindings.setNote(row.id, event.target.value);
        } catch (err) {
          app.notify(err?.message ?? '备注没存上', 'error');
        }
      },
    });

    const remove = el('button', {
      class: 'ilbcc-btn danger',
      type: 'button',
      text: '解除',
      onclick: async () => {
        if (!globalThis.confirm?.(`解除「${row.bookName}」和当前角色的关联？书本身不会被删。`)) return;
        try {
          await app.bindings.remove(row.id);
          app.notify('关联已解除', 'success');
        } catch (err) {
          app.notify(err?.message ?? '解除失败', 'error');
        }
        await app.refreshViews();
      },
    });

    return el('div', { class: 'ilbcc-row' }, title, policy, note, remove);
  }

  return {
    name: 'bindings',
    async render(root) {
      clear(root);
      root.append(el('div', { class: 'ilbcc-loading', text: '正在读关联…' }));

      let model;
      try {
        model = await loadModel();
      } catch (err) {
        clear(root).append(el('p', { class: 'ilbcc-error', text: `读取关联失败：${err?.message ?? err}` }));
        return;
      }
      clear(root);

      const { character, books, listed } = model;
      const header = el('div', { class: 'ilbcc-section' });
      header.append(el('div', { class: 'ilbcc-section-title', text: '当前角色' }));
      if (listed.ok) {
        header.append(el('div', { class: 'ilbcc-identity', text: identityLabel(character) }));
      } else {
        header.append(el('p', { class: 'ilbcc-hint', text: listed.message ?? '没有读到角色' }));
      }
      header.append(
        el(
          'div',
          { class: 'ilbcc-actions' },
          el('button', {
            class: 'ilbcc-btn',
            type: 'button',
            text: '刷新',
            onclick: () => app.refreshViews(),
          }),
          el('button', {
            class: 'ilbcc-btn',
            type: 'button',
            text: '打开 ILB',
            onclick: () => app.openIlb(),
          }),
        ),
      );
      // 上面这些（当前角色 + 关联列表）放进独立的滚动区，添加栏单独占一块。
      // v0.1.2：书多的时候列表会把添加栏推到屏幕外，用户得先滚到底才能加关联。
      // 做法不是给添加栏加 sticky（内容短的时候它会浮在中间），而是让整页变成
      // 「上面滚动、下面固定」的两段式：列表再长也只在自己的区域里滚。
      const list = el('div', { class: 'ilbcc-section' });
      list.append(el('div', { class: 'ilbcc-section-title', text: `关联的书（${listed.rows.length}）` }));
      if (listed.rows.length === 0) {
        list.append(
          hint(
            listed.ok
              ? '这个角色还没有关联任何书。在下面选一本书加进来，然后把它设为「强制启用」或「跟随书设置」。'
              : '关联列表没读出来，先看诊断页里的 ILB 状态。',
          ),
        );
      } else {
        const index = new Map();
        for (const row of listed.rows) index.set(row.id, row);
        for (const row of listed.rows) list.append(rowView(index, row));
      }

      // 上面这些（当前角色 + 关联列表）放进独立的滚动区，添加栏单独占一块。
      // v0.1.2：书多的时候列表会把添加栏推到屏幕外，用户得先滚到底才能加关联。
      // 做法不是给添加栏加 sticky（内容短的时候它会浮在中间），而是让整页变成
      // 「上面滚动、下面固定」的两段式：列表再长也只在自己的区域里滚。
      root.append(el('div', { class: 'ilbcc-bind-scroll' }, header, list));

      const add = el('div', { class: 'ilbcc-add-bar' });
      root.classList.add('ilbcc-has-add-bar');
      add.append(el('div', { class: 'ilbcc-section-title', text: '添加关联' }));
      add.append(bookPicker(books, listed.rows, (bookId, policy) => app.bindings.add({ character, bookId, policy })));
      add.append(hint('「跟随书设置」= 书自己的策略说了算；「强制启用/停用」= 只要这个角色在，就以这里为准。'));
      root.append(add);
    },
  };
}
