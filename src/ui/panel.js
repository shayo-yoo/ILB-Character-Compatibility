// ui/panel.js —— 独立入口：设置页里的一张卡片 + 一个 <dialog> 面板（三个页签）
//
// 为什么不把按钮塞进酒馆原生的角色卡界面：需求 §3.1 明确要求"独立入口、不改原生按钮"。
// 用 <dialog> + showModal 是因为手机上浮层会被酒馆的布局盖住（ILB 踩过这个坑）。
//
// 面板只负责"壳"与页签切换；三个页签各自在 view-*.js 里，互不知道对方存在。

import { el, clear, badge } from './dom.js';

const TABS = [
  { key: 'bindings', label: '关联' },
  { key: 'package', label: '导入导出' },
  { key: 'diagnostics', label: '诊断' },
];

export function createPanel({ app }) {
  let dialog = null;
  let body = null;
  let tabBar = null;
  let statusNode = null;
  let active = 'bindings';
  let rendering = false;
  let pending = false;

  function tabButton(key, label) {
    const button = el('button', {
      class: 'ilbcc-tab',
      type: 'button',
      text: label,
      dataset: { tab: key },
      onclick: () => setTab(key),
    });
    return button;
  }

  function highlight() {
    if (!tabBar) return;
    for (const button of tabBar.querySelectorAll('.ilbcc-tab')) {
      button.classList.toggle('active', button.dataset.tab === active);
    }
  }

  async function renderActive() {
    if (!body) return;
    if (rendering) {
      pending = true;
      return;
    }
    rendering = true;
    try {
      highlight();
      const view = app.views[active];
      clear(body);
      if (!view) {
        body.append(el('p', { class: 'ilbcc-error', text: `没有这个页签：${active}` }));
      } else {
        await view.render(body);
      }
    } catch (err) {
      clear(body).append(el('p', { class: 'ilbcc-error', text: `这个页签渲染失败：${err?.message ?? err}` }));
      console.error('[ILBCC] 页签渲染失败', err);
    } finally {
      rendering = false;
      if (pending) {
        pending = false;
        void renderActive();
      }
    }
  }

  function setTab(key) {
    if (!TABS.some((tab) => tab.key === key)) key = 'bindings';
    active = key;
    void renderActive();
  }

  function build() {
    dialog = el('dialog', { class: 'ilbcc-dialog' });
    const head = el('div', { class: 'ilbcc-head' });
    head.append(el('div', { class: 'ilbcc-title', text: 'ILB 角色卡兼容' }));
    const close = el('button', {
      class: 'ilbcc-icon-btn',
      type: 'button',
      text: '✕',
      title: '关闭',
      onclick: () => closePanel(),
    });
    head.append(close);

    tabBar = el('div', { class: 'ilbcc-tabs' });
    for (const tab of TABS) tabBar.append(tabButton(tab.key, tab.label));

    body = el('div', { class: 'ilbcc-body' });
    dialog.append(head, tabBar, body);
    dialog.addEventListener('close', () => {
      // 关闭后不销毁，下次打开直接复用（页签状态也保留）
    });
    return dialog;
  }

  function openPanel(tab) {
    if (!dialog) build();
    if (dialog.parentElement !== document.body) document.body.append(dialog);
    if (tab) active = tab;
    try {
      if (!dialog.open) dialog.showModal();
    } catch {
      dialog.setAttribute('open', '');
    }
    void renderActive();
  }

  function closePanel() {
    try {
      dialog?.close();
    } catch {
      dialog?.removeAttribute('open');
    }
  }

  function statusText() {
    const state = app.ilbState();
    return state.ok ? `ILB ${state.version} 已连接` : 'ILB 未就绪';
  }

  function updateStatus() {
    if (!statusNode) return;
    const state = app.ilbState();
    clear(statusNode);
    statusNode.append(badge(statusText(), state.ok ? 'ok' : 'warn'));
  }

  /** 设置页里的小卡片：一行状态 + 一个按钮 */
  function mountCard(container) {
    const card = el('div', { class: 'ilbcc-card' });
    const title = el('div', { class: 'ilbcc-card-title', text: 'ILB 角色卡兼容' });
    const desc = el('div', {
      class: 'ilbcc-card-desc',
      text: '把角色卡和它要用的 ILB 世界书打成一个包，换台机器/换个存档也能原样搬过去。',
    });
    statusNode = el('div', { class: 'ilbcc-card-status' });
    const openBtn = el('button', {
      class: 'ilbcc-btn primary',
      type: 'button',
      text: '打开',
      onclick: () => openPanel(),
    });
    card.append(title, desc, statusNode, el('div', { class: 'ilbcc-actions' }, openBtn));
    container.append(card);
    updateStatus();
    return card;
  }

  return {
    get activeTab() {
      return active;
    },
    mountCard,
    open: openPanel,
    close: closePanel,
    setTab,
    renderActive,
    updateStatus,
    isOpen: () => Boolean(dialog?.open),
  };
}
