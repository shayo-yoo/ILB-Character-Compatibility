// ui/view-package.js —— 「导入导出」页签
//
// 导出：勾书 → 组装 → 下载（不写回任何东西）。
// 导入：选文件 → 检查并预览（冲突逐本列出来）→ 确认 → 先书后卡 → 报结果。
// 失败一定要说清楚：哪本书、哪一步、还能不能重试，绝不"整体成功"糊过去。

import { el, hint, clear, option, downloadText, fmtTime } from './dom.js';
import { identityLabel } from '../core/identity.js';
import { parsePackage, summarizePackage } from '../core/package.js';

const ACTION_LABEL = {
  create: '新建一本（可能与现有书重名）',
  skip: '用已有的这本，不导入',
  overwrite: '覆盖已有的这本',
  reuse: '不导入，直接关联已有的同名书',
};

export function createPackageView({ app }) {
  let exportModel = null; // {character, books:[...]}
  let exportBusy = false;
  let importState = null; // {pkg, preview, decisions:{}}
  let importBusy = false;

  // ---------- 导出 ----------

  function renderExport(root) {
    const section = el('div', { class: 'ilbcc-section' });
    section.append(el('div', { class: 'ilbcc-section-title', text: '导出角色卡包' }));

    if (!exportModel) {
      section.append(el('div', { class: 'ilbcc-loading', text: '正在读取当前角色的关联…' }));
      return section;
    }
    if (!exportModel.ok) {
      section.append(el('p', { class: 'ilbcc-hint', text: exportModel.message ?? '当前没有可导出的角色' }));
      return section;
    }

    section.append(el('div', { class: 'ilbcc-identity', text: identityLabel(exportModel.character) }));

    if (exportModel.books.length === 0) {
      section.append(hint('这个角色还没有关联任何书。先去「关联」页签加书，再来导出。'));
      section.append(
        el('button', { class: 'ilbcc-btn', type: 'button', text: '刷新', onclick: () => reloadExport() }),
      );
      return section;
    }

    const boxes = [];
    const list = el('div', { class: 'ilbcc-check-list' });
    for (const book of exportModel.books) {
      const box = el('input', {
        type: 'checkbox',
        checked: book.exists,
        disabled: !book.exists,
        onchange: () => updateCount(),
      });
      boxes.push({ book, box });
      list.append(
        el(
          'label',
          { class: 'ilbcc-check-row' },
          box,
          el('span', { class: 'ilbcc-check-name', text: book.name }),
          el('span', { class: 'ilbcc-check-meta', text: book.exists ? `${book.policy === 'on' ? '强制启用' : book.policy === 'off' ? '强制停用' : '跟随书设置'}` : '书已删除' }),
        ),
      );
    }
    section.append(list);

    const countLine = el('div', { class: 'ilbcc-hint' });
    const updateCount = () => {
      const n = boxes.filter((item) => item.box.checked && !item.box.disabled).length;
      countLine.textContent = `将导出 ${n} 本书`;
      exportButton.disabled = n === 0 || exportBusy;
    };

    const resultBox = el('div', { class: 'ilbcc-result' });
    const exportButton = el('button', {
      class: 'ilbcc-btn primary',
      type: 'button',
      text: '导出并下载',
      onclick: async () => {
        if (exportBusy) return;
        exportBusy = true;
        exportButton.disabled = true;
        clear(resultBox).append(el('div', { class: 'ilbcc-loading', text: '正在导出…' }));
        const ids = boxes.filter((item) => item.box.checked && !item.box.disabled).map((item) => item.book.bookId);
        try {
          const result = await app.exporter.run({
            avatar: exportModel.character.avatar,
            bookIds: ids,
            onProgress: (message) => clear(resultBox).append(el('div', { class: 'ilbcc-loading', text: message })),
          });
          if (!result.ok) {
            clear(resultBox).append(
              el('p', { class: 'ilbcc-error', text: result.message }),
              ...(result.failures ?? []).map((failure) => el('div', { class: 'ilbcc-hint', text: `· ${failure.name}：${failure.message}` })),
            );
            app.history.record({
              kind: 'export',
              character: exportModel.character,
              summary: `导出失败：${result.message}`,
              result: 'failed',
            });
          } else {
            downloadText(result.fileName, result.text);
            clear(resultBox).append(
              el('p', { class: 'ilbcc-ok', text: `已生成 ${result.fileName}（${result.bookCount} 本书，${result.bindingCount} 条关联）` }),
            );
            app.history.record({
              kind: 'export',
              character: exportModel.character,
              summary: `导出 ${result.bookCount} 本书 / ${result.bindingCount} 条关联`,
              result: 'ok',
            });
            app.notify('角色卡包已导出', 'success');
          }
        } catch (err) {
          clear(resultBox).append(el('p', { class: 'ilbcc-error', text: `导出失败：${err?.message ?? err}` }));
          app.notify('导出失败', 'error');
        } finally {
          exportBusy = false;
          updateCount();
        }
      },
    });
    section.append(el('div', { class: 'ilbcc-actions' }, countLine, exportButton));
    section.append(resultBox);
    updateCount();
    return section;
  }

  async function reloadExport() {
    exportModel = null;
    await app.refreshViews();
  }

  /** 第一次打开（或点了刷新）时，把导出清单读出来 */
  async function ensureExportModel() {
    if (exportModel) return;
    const character = app.currentCharacter();
    if (!character?.avatar) {
      exportModel = { ok: false, message: '当前没有角色（群聊或未进入聊天），先打开一张角色卡再导出。' };
      return;
    }
    try {
      exportModel = await app.exporter.plan(character.avatar);
    } catch (err) {
      exportModel = { ok: false, message: `读取关联失败：${err?.message ?? err}` };
    }
  }

  // ---------- 导入 ----------

  function renderImport(root) {
    const section = el('div', { class: 'ilbcc-section' });
    section.append(el('div', { class: 'ilbcc-section-title', text: '导入角色卡包' }));

    const fileInput = el('input', {
      type: 'file',
      accept: '.json,.ilbchar.json,application/json',
      class: 'ilbcc-file',
      onchange: async (event) => {
        const file = event.target.files?.[0];
        if (!file) return;
        await inspect(file);
      },
    });
    section.append(el('div', { class: 'ilbcc-actions' }, fileInput));

    if (!importState) {
      section.append(hint('选一个 .ilbchar.json 文件。会先检查格式与书，再让你确认，最后才真的导入。'));
      return section;
    }

    if (importState.error) {
      section.append(el('p', { class: 'ilbcc-error', text: importState.error }));
      return section;
    }

    const { pkg, preview } = importState;
    const summary = summarizePackage(pkg);
    section.append(
      el(
        'div',
        { class: 'ilbcc-summary' },
        el('div', { text: `角色卡：${summary.character.name || '（没有名字）'}` }),
        el('div', { text: `书：${summary.books.length} 本 ／ 关联：${summary.bindings.length} 条 ／ 生成于 ${fmtTime(summary.createdAt)}` }),
        preview.character.sameNameCount > 0
          ? el('div', { class: 'ilbcc-hint', text: `酒馆里已经有 ${preview.character.sameNameCount} 张同名角色卡；导入会新建一张（不会覆盖现有的）。` })
          : null,
      ),
    );

    const bookList = el('div', { class: 'ilbcc-check-list' });
    for (const book of preview.books) {
      const row = el('div', { class: 'ilbcc-check-row' });
      row.append(el('span', { class: 'ilbcc-check-name', text: book.name }));
      row.append(el('span', { class: 'ilbcc-check-meta', text: `${book.entries} 条` }));
      if (book.conflict) {
        const select = el('select', { class: 'ilbcc-select' });
        for (const action of book.options) select.append(option(action, ACTION_LABEL[action], action === book.action));
        select.addEventListener('change', () => {
          importState.decisions[book.ref] = select.value;
        });
        row.append(select);
        row.append(
          el('span', {
            class: 'ilbcc-badge warn',
            text: book.conflict.kind === 'id' ? 'ILB 里已有同一本书' : 'ILB 里有同名书',
          }),
        );
      } else {
        row.append(el('span', { class: 'ilbcc-badge', text: '新增' }));
      }
      bookList.append(row);
    }
    section.append(bookList);

    const resultBox = el('div', { class: 'ilbcc-result' });
    const runButton = el('button', {
      class: 'ilbcc-btn primary',
      type: 'button',
      text: '开始导入',
      disabled: importBusy,
      onclick: async () => {
        if (importBusy) return;
        const ok = globalThis.confirm?.(
          `将导入角色卡「${preview.character.name}」和 ${preview.books.length} 本书。\n\n书的导入先做，角色卡最后导入。确定继续？`,
        );
        if (ok === false) return;
        importBusy = true;
        runButton.disabled = true;
        clear(resultBox).append(el('div', { class: 'ilbcc-loading', text: '正在导入…' }));
        try {
          const result = await app.importer.run(pkg, {
            decisions: importState.decisions,
            onProgress: (message) => clear(resultBox).append(el('div', { class: 'ilbcc-loading', text: message })),
          });
          renderImportResult(resultBox, result);
          app.history.record({
            kind: 'import',
            character: { avatar: result.character.avatar, name: result.character.name },
            summary: result.ok
              ? `导入成功：${result.books.imported.length} 本书，${result.bindings.created.length} 条关联`
              : `导入${result.partial ? '部分完成' : '失败'}：${result.books.failed.length} 本书失败，${result.bindings.failed.length} 条关联失败`,
            result: result.ok ? 'ok' : result.partial ? 'partial' : 'failed',
          });
          if (result.ok) app.notify('角色卡包已导入', 'success');
          else app.notify(result.aborted ? `导入中断：${result.aborted === 'books' ? '书没导完' : '角色卡导入失败'}` : '导入部分完成，请看结果', 'warn');
        } catch (err) {
          clear(resultBox).append(el('p', { class: 'ilbcc-error', text: `导入失败：${err?.message ?? err}` }));
          app.notify('导入失败', 'error');
        } finally {
          importBusy = false;
          runButton.disabled = false;
          await app.refreshViews();
        }
      },
    });
    section.append(el('div', { class: 'ilbcc-actions' }, runButton));
    section.append(resultBox);
    return section;
  }

  function renderImportResult(box, result) {
    clear(box);
    if (result.ok) {
      box.append(el('p', { class: 'ilbcc-ok', text: `导入完成：角色卡「${result.character.name}」已导入，恢复 ${result.bindings.created.length} 条关联。` }));
    } else if (result.aborted === 'books') {
      box.append(el('p', { class: 'ilbcc-error', text: '有书没能导入，已停止，没有导入角色卡（可以修好后重试）。' }));
    } else if (result.aborted === 'character') {
      box.append(el('p', { class: 'ilbcc-error', text: `角色卡导入失败：${result.character.error}` }));
      box.append(hint('书已经导入成功了；可以在 ILB 里删掉它们，或者留着以后手动关联。'));
    } else {
      box.append(el('p', { class: 'ilbcc-error', text: '导入完成了，但有关联没建上。' }));
    }

    for (const item of result.books.imported) box.append(el('div', { class: 'ilbcc-hint', text: `✓ 书《${item.name}》→ ${item.id}` }));
    for (const item of result.books.skipped) box.append(el('div', { class: 'ilbcc-hint', text: `↷ 书《${item.name}》用已有的（${item.id}）` }));
    for (const item of result.books.reused) box.append(el('div', { class: 'ilbcc-hint', text: `↷ 书《${item.name}》复用了同名书（${item.id}）` }));
    for (const item of result.books.failed) box.append(el('div', { class: 'ilbcc-error', text: `✗ 书《${item.name}》：${item.message}` }));
    for (const item of result.bindings.failed) box.append(el('div', { class: 'ilbcc-error', text: `✗ 关联 ${item.bookRef}：${item.message}` }));

    if (result.cleanup.bookIds.length > 0 && !result.ok) {
      box.append(hint(`这次新导入的书：${result.cleanup.bookIds.join('、')}（可在 ILB 书架里删掉）`));
    }
  }

  async function inspect(file) {
    importState = { pkg: null, preview: null, decisions: {}, error: '' };
    try {
      const text = await file.text();
      const parsed = parsePackage(text);
      if (!parsed.ok) {
        importState.error = parsed.message;
      } else {
        const preview = await app.importer.plan(parsed.pkg);
        importState = { pkg: parsed.pkg, preview, decisions: {}, error: '', warnings: parsed.warnings };
      }
    } catch (err) {
      importState.error = `读文件失败：${err?.message ?? err}`;
    }
    await app.refreshViews();
  }

  return {
    name: 'package',
    async render(root) {
      clear(root);
      await ensureExportModel();
      root.append(renderExport(root));
      root.append(renderImport(root));
    },
  };
}
