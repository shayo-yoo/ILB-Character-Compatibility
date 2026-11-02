// st/host.js —— 全项目唯一允许 import 酒馆代码的文件（对应 ILB 的 host.js 做法）
//
// 其余模块一律通过这里拿宿主能力。宿主内部结构一变，只有这个文件要改。
// 第三方扩展的目录深度比内置扩展深一层，所以路径优先按 third-party 的位置猜：
//   getContext / extension_settings → ../../extensions.js
//   eventSource / event_types       → ../../../../script.js
// 猜不到时退到 globalThis.SillyTavern（新版本会挂这个全局）。

const HOST_CANDIDATES = [
  '../../extensions.js',
  '/scripts/extensions.js',
  '../../../../script.js',
  '../../../script.js',
  '/script.js',
];

let loaded = null;

function pick(modules, keys) {
  for (const key of keys) {
    for (const mod of modules) {
      const value = mod?.[key] ?? mod?.default?.[key];
      if (typeof value === 'function') return value;
    }
  }
  return null;
}

function pickValue(modules, keys) {
  for (const key of keys) {
    for (const mod of modules) {
      const value = mod?.[key] ?? mod?.default?.[key];
      if (value && typeof value === 'object') return value;
    }
  }
  return null;
}

function fromModules(modules, via) {
  const getContext = pick(modules, ['getContext']);
  if (!getContext) return null;

  const saveSettingsDebounced = pick(modules, ['saveSettingsDebounced', 'saveSettings']);
  const getRequestHeaders = pick(modules, ['getRequestHeaders']);
  const eventSource = pickValue(modules, ['eventSource']);
  const eventTypes = pickValue(modules, ['event_types']);

  return {
    getContext,
    getEventSource: () => eventSource ?? globalThis.SillyTavern?.eventSource ?? null,
    getEventTypes: () => eventTypes ?? globalThis.SillyTavern?.eventTypes ?? null,
    getRequestHeaders: (opts) => {
      try {
        return getRequestHeaders?.(opts) ?? {};
      } catch {
        return {};
      }
    },
    saveSettings: () => {
      try {
        if (typeof saveSettingsDebounced !== 'function') return false;
        saveSettingsDebounced();
        return true;
      } catch {
        return false;
      }
    },
    via,
  };
}

function fromGlobal() {
  const g = globalThis.SillyTavern;
  if (!g || typeof g.getContext !== 'function') return null;
  return {
    getContext: () => g.getContext(),
    getEventSource: () => g.eventSource ?? null,
    getEventTypes: () => g.eventTypes ?? null,
    getRequestHeaders: (opts) => {
      try {
        return g.getRequestHeaders?.(opts) ?? {};
      } catch {
        return {};
      }
    },
    saveSettings: () => {
      try {
        const fn = g.saveSettingsDebounced ?? g.saveSettings;
        if (typeof fn !== 'function') return false;
        fn();
        return true;
      } catch {
        return false;
      }
    },
    via: 'globalThis.SillyTavern',
  };
}

/**
 * 加载宿主入口。失败时抛错，由 index.js 兜住并给用户看得懂的提示。
 * @returns {Promise<{getContext:Function, getEventSource:Function, getEventTypes:Function, getRequestHeaders:Function, saveSettings:Function, via:string}>}
 */
export async function loadHost() {
  if (loaded) return loaded;

  const modules = [];
  const tried = [];
  for (const path of HOST_CANDIDATES) {
    try {
      const mod = await import(/* @vite-ignore */ path);
      modules.push(mod);
      tried.push(path);
    } catch {
      // 路径不对就试下一个：这是预期内的探测，不是错误
    }
  }

  const host = fromModules(modules, tried.join(' , '));
  if (host) {
    loaded = host;
    return host;
  }
  const globalHost = fromGlobal();
  if (globalHost) {
    loaded = globalHost;
    return globalHost;
  }
  throw new Error('找不到 SillyTavern 的入口（模块与全局两种方式都失败了）。扩展可能装在了错误的目录。');
}

export function peekHost() {
  return loaded;
}

/** 给测试与界面用的轻量封装：当前角色、角色列表、事件名 */
export function createContextAccess(host) {
  function getContext() {
    try {
      return host.getContext() ?? {};
    } catch {
      return {};
    }
  }

  return {
    getContext,
    /** @returns {any[]} */
    characters() {
      const ctx = getContext();
      return Array.isArray(ctx.characters) ? ctx.characters : [];
    },
    /** 当前角色（可能 undefined：没进聊天/群聊） */
    currentCharacter() {
      const ctx = getContext();
      if (ctx.groupId) return undefined;
      const index = ctx.characterId;
      if (index === undefined || index === null || index === '') return undefined;
      return ctx.characters?.[index];
    },
    currentAvatar() {
      const ctx = getContext();
      if (ctx.groupId) return '';
      return ctx.characterId !== undefined && ctx.characterId !== null && ctx.characters?.[ctx.characterId]
        ? String(ctx.characters[ctx.characterId]?.avatar ?? '')
        : '';
    },
    isGroup() {
      return Boolean(getContext().groupId);
    },
    group() {
      const ctx = getContext();
      if (!ctx.groupId) return null;
      const group = Array.isArray(ctx.groups) ? ctx.groups.find((g) => g.id === ctx.groupId) : null;
      if (!group) return { id: ctx.groupId, name: '', members: [] };
      const disabled = new Set(Array.isArray(group.disabled_members) ? group.disabled_members : []);
      const members = (Array.isArray(group.members) ? group.members : [])
        .filter((avatar) => !disabled.has(avatar))
        .map((avatar) => {
          const found = (ctx.characters ?? []).find((c) => c?.avatar === avatar);
          return { avatar, name: String(found?.name ?? avatar.replace(/\.png$/i, '')) };
        });
      return { id: group.id, name: String(group.name ?? ''), members };
    },
    chatId() {
      const ctx = getContext();
      return String(ctx.chatId ?? 'default');
    },
    eventSource: () => host.getEventSource(),
    eventTypes: () => host.getEventTypes(),
    headers: (opts) => host.getRequestHeaders(opts),
  };
}
