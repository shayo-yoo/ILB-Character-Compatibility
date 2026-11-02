// index.js —— 装配层：把宿主、ILB、三个页签接起来。不含业务判断。
//
// 启动顺序刻意这样安排：
//   1. 先拿宿主（拿不到就什么都别做，给一句人话）
//   2. 再等 ILB（ILB 可能比本扩展晚加载；等不到也要把界面挂出来，诊断页要能说清"没装 ILB"）
//   3. 最后挂卡片与面板
// 任何一步失败都不能静默：用户必须能在界面上看到原因（需求 §6.3 / §8）。

import { loadHost, createContextAccess } from './src/st/host.js';
import { createCardGateway } from './src/st/cards.js';
import { waitForIlb, createIlbClient, isCompatible, IlbError } from './src/ilb/client.js';
import { createBindingService } from './src/service/bindings.js';
import { createExportService } from './src/service/export.js';
import { createImportService } from './src/service/import.js';
import { createHistoryService } from './src/service/history.js';
import { createPanel } from './src/ui/panel.js';
import { createBindingsView } from './src/ui/view-bindings.js';
import { createPackageView } from './src/ui/view-package.js';
import { createDiagnosticsView } from './src/ui/view-diagnostics.js';

export const VERSION = '0.1.0';
const LABEL = 'ILB 角色卡兼容';

function notify(message, kind = 'info') {
  try {
    const toastr = globalThis.toastr;
    if (toastr && typeof toastr[kind] === 'function') toastr[kind](message, LABEL);
  } catch {
    /* toastr 坏了不影响功能 */
  }
  console.info(`[ILBCC] ${message}`);
}

/** 等一个选择器出现（宿主是异步渲染设置页的） */
function waitFor(selector, attempts = 20, interval = 500) {
  return new Promise((resolve) => {
    let left = attempts;
    const tick = () => {
      const node = document.querySelector(selector);
      if (node) return resolve(node);
      left -= 1;
      if (left <= 0) return resolve(null);
      setTimeout(tick, interval);
    };
    tick();
  });
}

/** ILB 没连上时用的占位客户端：每个方法都抛同一句人话，界面不需要到处判空 */
function offlineIlbClient(message) {
  const fail = () => {
    throw new IlbError('NOT_INSTALLED', message);
  };
  return {
    version: '',
    caps: [],
    listBooks: fail,
    getBook: fail,
    exportBook: fail,
    importBook: fail,
    deleteBook: fail,
    listBindings: fail,
    createBinding: fail,
    updateBinding: fail,
    removeBinding: fail,
    renameCharacter: fail,
    preview: fail,
    status: fail,
    explain: (err) => String(err?.message ?? err),
  };
}

async function boot() {
  if (globalThis.__ILBCC_BOOTED === true) return globalThis.ILBCC;

  let host;
  try {
    host = await loadHost();
  } catch (err) {
    console.error('[ILBCC] 启动失败', err);
    notify(`启动失败：${err?.message ?? err}`, 'error');
    return null;
  }

  const access = createContextAccess(host);
  const cards = createCardGateway({ access });
  const history = createHistoryService({ host });

  const state = {
    ilb: { ok: false, version: '', caps: [], message: '还没连上 ILB' },
    client: null,
  };

  function ilbClient() {
    return state.client ?? offlineIlbClient(state.ilb.message || '没有找到 ILB');
  }

  function connect(api) {
    const check = isCompatible(api);
    if (!check.ok) {
      state.ilb = { ok: false, version: String(api?.version ?? ''), caps: [], message: check.reason };
      state.client = null;
      return false;
    }
    try {
      state.client = createIlbClient(api);
      state.ilb = { ok: true, version: String(api.version ?? ''), caps: Array.isArray(api.caps) ? api.caps.slice() : [], message: '' };
      return true;
    } catch (err) {
      state.ilb = { ok: false, version: String(api?.version ?? ''), caps: [], message: String(err?.message ?? err) };
      state.client = null;
      return false;
    }
  }

  // 服务层都拿"当前客户端"，这样 ILB 晚到/重连都不需要重建它们
  const bindings = createBindingService({ ilb: { listBooks: (...a) => ilbClient().listBooks(...a), listBindings: (...a) => ilbClient().listBindings(...a), createBinding: (...a) => ilbClient().createBinding(...a), updateBinding: (...a) => ilbClient().updateBinding(...a), removeBinding: (...a) => ilbClient().removeBinding(...a) } });
  const exporter = createExportService({ ilb: { exportBook: (...a) => ilbClient().exportBook(...a) }, cards, bindings });
  const importer = createImportService({ ilb: { listBooks: (...a) => ilbClient().listBooks(...a), importBook: (...a) => ilbClient().importBook(...a), createBinding: (...a) => ilbClient().createBinding(...a) }, cards });

  const views = {};
  const app = {
    host,
    access,
    cards,
    history,
    bindings,
    exporter,
    importer,
    views,
    ilbState: () => state.ilb,
    get ilb() {
      return ilbClient();
    },
    currentCharacter() {
      try {
        return access.currentCharacter() ?? null;
      } catch {
        return null;
      }
    },
    groupInfo: () => access.group(),
    chatId: () => access.chatId(),
    hostVia: () => host.via,
    notify,
    openIlb() {
      try {
        const api = globalThis.ILB?.api;
        if (api?.ui?.openPanel) {
          api.ui.openPanel();
          return true;
        }
      } catch {
        /* 落到下面的提示 */
      }
      notify('没有找到 ILB 的界面入口（ILB 可能没装或版本太旧）', 'warn');
      return false;
    },
    refreshViews() {
      panel?.renderActive?.();
      panel?.updateStatus?.();
    },
    async reconnectIlb() {
      const api = await waitForIlb({ timeoutMs: 1500 });
      if (api && connect(api)) {
        panel.updateStatus();
        return true;
      }
      return false;
    },
  };

  const panel = createPanel({ app });
  views.bindings = createBindingsView({ app });
  views.package = createPackageView({ app });
  views.diagnostics = createDiagnosticsView({ app });

  // 挂入口卡片（设置页）。挂不上也不能让功能消失：用控制台提示 + 全局对象兜底。
  const settingsHost = await waitFor('#extensions_settings');
  if (settingsHost) {
    panel.mountCard(settingsHost);
  } else {
    console.warn('[ILBCC] 等不到扩展设置区，卡片没挂上；可在控制台执行 ILBCC.open()');
  }

  // 连 ILB（可以晚到，连不上也有诊断页）
  const api = await waitForIlb({ timeoutMs: 6000 });
  if (api) {
    if (!connect(api)) notify(state.ilb.message, 'warn');
  } else {
    state.ilb = { ok: false, version: '', caps: [], message: '没有找到 ILB：请先安装并启用 Independent Lorebook（需要接口 1.4）' };
    console.warn('[ILBCC] 没等到 ILB.api');
  }
  panel.updateStatus();

  // 上下文/关联变化时刷新界面。正确性不依赖这里——ILB 每次生成前会自己重算；
  // 这里只保证"界面显示的是刚刚的状态"。
  let timer = null;
  function scheduleRefresh() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      panel.renderActive();
    }, 160);
  }

  try {
    const eventTypes = host.getEventTypes() ?? {};
    const source = host.getEventSource();
    const names = ['CHAT_CHANGED', 'CHARACTER_RENAMED', 'CHARACTER_EDITED', 'CHARACTER_DELETED', 'CHARACTER_DUPLICATED', 'GROUP_UPDATED', 'GROUP_CHAT_DELETED', 'PERSONA_CHANGED'];
    if (source && typeof source.on === 'function') {
      for (const key of names) {
        const name = eventTypes[key] ?? key.toLowerCase();
        try {
          source.on(name, scheduleRefresh);
        } catch {
          /* 某些事件在旧版本里不存在，跳过 */
        }
      }
    }
    if (typeof document?.addEventListener === 'function') {
      document.addEventListener('ilb:change', scheduleRefresh);
      document.addEventListener('ilb:ready', () => {
        void app.reconnectIlb().then(() => scheduleRefresh());
      });
    }
  } catch (err) {
    console.warn('[ILBCC] 订阅事件失败（不影响导入导出）', err);
  }

  const facade = {
    version: VERSION,
    app,
    panel,
    open: (tab) => panel.open(tab),
    close: () => panel.close(),
    refresh: () => panel.renderActive(),
    state: () => ({ ...state.ilb }),
  };

  globalThis.ILBCC = facade;
  globalThis.__ILBCC_BOOTED = true;
  console.info(`[ILBCC] 已启动 v${VERSION}（ILB：${state.ilb.ok ? state.ilb.version : '未连接'}；宿主：${host.via}）`);
  return facade;
}

export const READY = boot().catch((err) => {
  console.error('[ILBCC] 启动时出现未捕获错误', err);
  notify(`启动失败：${err?.message ?? err}`, 'error');
  return null;
});

try {
  globalThis.ILBCC_READY = READY;
} catch {
  /* 没有全局对象就算了 */
}
