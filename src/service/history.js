// service/history.js —— 最近 20 次导入/导出记录（存在本扩展自己的 extension_settings 下）
//
// 只记"发生了什么"，不记书内容、不记聊天内容、不记角色卡正文——历史是给人看排障的，
// 不是第二份数据。关联数据永远以 ILB 为准，这里不存副本。

export const SETTINGS_KEY = 'ilb_character_compatibility';
export const HISTORY_LIMIT = 20;

/** 纯函数：把一条记录放到最前面，并裁到上限（单独导出便于测试） */
export function pushRecord(list, entry, limit = HISTORY_LIMIT) {
  const next = [entry, ...(Array.isArray(list) ? list : [])];
  return next.slice(0, Math.max(1, limit));
}

export function createHistoryService({ host }) {
  function bucket() {
    try {
      const ctx = host.getContext();
      if (!ctx.extensionSettings) ctx.extensionSettings = {};
      const current = ctx.extensionSettings[SETTINGS_KEY];
      if (!current || typeof current !== 'object') ctx.extensionSettings[SETTINGS_KEY] = { history: [] };
      const store = ctx.extensionSettings[SETTINGS_KEY];
      if (!Array.isArray(store.history)) store.history = [];
      return store;
    } catch {
      return { history: [] };
    }
  }

  return {
    list() {
      return bucket().history.slice();
    },
    /**
     * @param {{kind:'export'|'import', character:{avatar:string,name:string}, summary:string, result:'ok'|'partial'|'failed', detail?:string}} entry
     */
    record(entry) {
      const store = bucket();
      const record = {
        at: Date.now(),
        kind: entry.kind === 'import' ? 'import' : 'export',
        character: { avatar: String(entry.character?.avatar ?? ''), name: String(entry.character?.name ?? '') },
        summary: String(entry.summary ?? '').slice(0, 300),
        result: ['ok', 'partial', 'failed'].includes(entry.result) ? entry.result : 'failed',
        detail: String(entry.detail ?? '').slice(0, 300),
      };
      store.history = pushRecord(store.history, record);
      try {
        host.saveSettings();
      } catch {
        /* 存不进磁盘只影响历史，不影响这次操作 */
      }
      return record;
    },
    clear() {
      const store = bucket();
      store.history = [];
      try {
        host.saveSettings();
      } catch {
        /* 同上 */
      }
    },
  };
}
