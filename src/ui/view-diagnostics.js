// ui/view-diagnostics.js —— 「诊断」页签：出问题时先看这里
//
// 原则：默认只显示人话结论，技术细节折叠；每条结论都要能回答"谁、什么状态、为什么"。

import { el, hint, clear, fmtTime } from './dom.js';
import { identityLabel } from '../core/identity.js';

function statusLine(label, ok, detail) {
  return el(
    'div',
    { class: 'ilbcc-diag-line' },
    el('span', { class: `ilbcc-dot ${ok ? 'ok' : 'bad'}` }),
    el('span', { class: 'ilbcc-diag-label', text: label }),
    el('span', { class: 'ilbcc-diag-detail', text: detail }),
  );
}

export function createDiagnosticsView({ app }) {
  return {
    name: 'diagnostics',
    async render(root) {
      clear(root);
      root.append(el('div', { class: 'ilbcc-loading', text: '正在检查…' }));

      const lines = [];
      const technical = [];

      // ILB
      const ilb = app.ilbState();
      if (ilb.ok) {
        lines.push(statusLine('ILB', true, `已连接，接口 ${ilb.version}（caps：${ilb.caps.join('、')}）`));
      } else {
        lines.push(statusLine('ILB', false, ilb.message));
      }

      // 当前上下文
      const character = app.currentCharacter();
      const group = app.groupInfo();
      if (group) {
        const names = group.members.map((m) => m.name).join('、');
        lines.push(statusLine('上下文', true, `群聊「${group.name || group.id}」，成员：${names || '（没有可用成员）'}`));
      } else if (character?.avatar) {
        lines.push(statusLine('上下文', true, `角色卡：${identityLabel(character)}`));
      } else {
        lines.push(statusLine('上下文', false, '没有进入角色聊天（或群聊里没有可用成员）。关联合集需要在角色卡聊天里操作。'));
      }
      technical.push(`聊天：${app.chatId()}　宿主入口：${app.hostVia()}`);

      // 书与关联
      let books = [];
      try {
        books = await app.ilb.listBooks();
      } catch (err) {
        technical.push(`读书列表失败：${err?.message ?? err}`);
      }
      const listed = character?.avatar
        ? await app.bindings.listForCharacter(character).catch((err) => ({ ok: false, rows: [], message: err?.message ?? String(err) }))
        : { ok: true, rows: [] };
      lines.push(statusLine('世界书', books.length > 0, `ILB 里有 ${books.length} 本书`));
      if (listed.ok) {
        const orphans = listed.rows.filter((row) => row.orphaned).length;
        const missing = listed.rows.filter((row) => !row.bookExists).length;
        lines.push(
          statusLine(
            '关联',
            missing === 0 && orphans === 0,
            `当前角色 ${listed.rows.length} 条关联${missing ? `，其中 ${missing} 条指向已删除的书` : ''}${orphans ? `，${orphans} 条已孤儿` : ''}`,
          ),
        );
      } else {
        lines.push(statusLine('关联', false, listed.message ?? '读取失败'));
      }

      // 上一轮运行
      try {
        const status = await app.ilb.status();
        if (status.ran) {
          const active = Array.isArray(status.activeBooks) ? status.activeBooks : [];
          lines.push(statusLine('运行态', true, `上一轮实际启用 ${active.length} 本书（${fmtTime(status.at)}）`));
          technical.push(`activeBooks：${active.join('、') || '（无）'}`);
        } else {
          lines.push(statusLine('运行态', false, '这个聊天还没跑过判定。发一条消息后回来看。'));
        }
      } catch (err) {
        lines.push(statusLine('运行态', false, `读不到运行态：${err?.message ?? err}`));
      }

      // 历史
      const history = app.history.list();
      const historyBox = el('div', { class: 'ilbcc-history' });
      if (history.length === 0) {
        historyBox.append(hint('还没有导入/导出记录。'));
      } else {
        for (const record of history.slice(0, 8)) {
          historyBox.append(
            el(
              'div',
              { class: 'ilbcc-history-row' },
              el('span', { class: `ilbcc-badge ${record.result === 'ok' ? '' : 'warn'}`, text: record.kind === 'export' ? '导出' : '导入' }),
              el('span', { class: 'ilbcc-history-text', text: `${fmtTime(record.at)}　${record.character.name || '（无角色）'}　${record.summary}` }),
            ),
          );
        }
      }

      clear(root);
      const section = el('div', { class: 'ilbcc-section' });
      section.append(el('div', { class: 'ilbcc-section-title', text: '检查结果' }));
      for (const line of lines) section.append(line);
      root.append(section);

      const actions = el(
        'div',
        { class: 'ilbcc-actions' },
        el('button', { class: 'ilbcc-btn', type: 'button', text: '重新检查', onclick: () => app.refreshViews() }),
        el('button', { class: 'ilbcc-btn', type: 'button', text: '打开 ILB', onclick: () => app.openIlb() }),
        el('button', {
          class: 'ilbcc-btn danger',
          type: 'button',
          text: '清空历史',
          onclick: () => {
            app.history.clear();
            app.refreshViews();
          },
        }),
      );
      root.append(actions);

      const historySection = el('div', { class: 'ilbcc-section' });
      historySection.append(el('div', { class: 'ilbcc-section-title', text: '最近导入导出' }));
      historySection.append(historyBox);
      root.append(historySection);

      const details = el('details', { class: 'ilbcc-tech' });
      details.append(el('summary', { text: '技术信息（排障用）' }));
      const pre = el('pre', { class: 'ilbcc-pre' });
      pre.textContent = technical.join('\n');
      details.append(pre);
      root.append(details);
    },
  };
}
