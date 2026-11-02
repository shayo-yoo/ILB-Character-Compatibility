// ilb/client.js —— 全项目唯一碰 ILB 的地方（对应"只走公开 API"这条硬边界）
//
// 为什么不在文件顶部 import ILB 的模块：两个扩展谁先加载不确定，而且 ILB 的内部模块
// 路径随时可能变。ILB 0.27.0 起提供了 ILB.api + ILB_READY + ilb:ready 三件套，这里只用它们。
//
// 约定：ILB 的接口返回 { ok:true, ... } / { ok:false, error:{code,message} }，从不抛异常。
// 本层把它翻译成"成功就返回数据、失败抛 IlbError"，让上层只写 happy path + 一个 catch。

export const REQUIRED_CAPS = ['bindings', 'runtime', 'worldbooks'];
export const MIN_API_VERSION = '1.4';

export class IlbError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'IlbError';
    this.code = code;
    Object.assign(this, extra);
  }
}

/** 把 "1.4" 这类字符串比大小；解析不了视为 0 */
export function versionNumber(version) {
  const parts = String(version ?? '').split('.');
  const major = Number(parts[0]);
  const minor = Number(parts[1]);
  if (!Number.isFinite(major)) return 0;
  return major * 100 + (Number.isFinite(minor) ? minor : 0);
}

export function isCompatible(api) {
  if (!api || typeof api !== 'object') return { ok: false, reason: '没拿到 ILB.api' };
  if (!Array.isArray(api.caps)) return { ok: false, reason: 'ILB.api 没有 caps（版本太旧）' };
  const missing = REQUIRED_CAPS.filter((cap) => !api.caps.includes(cap));
  if (missing.length > 0) return { ok: false, reason: `ILB 接口缺能力：${missing.join('、')}（需要 ${MIN_API_VERSION}）` };
  if (versionNumber(api.version) < versionNumber(MIN_API_VERSION)) {
    return { ok: false, reason: `ILB 接口是 ${api.version}，至少要 ${MIN_API_VERSION}` };
  }
  return { ok: true };
}

const CODE_TEXT = {
  NOT_FOUND: '找不到目标',
  CONFLICT: '有冲突',
  BAD_PAYLOAD: '参数不合法',
  NOT_SUPPORTED: '当前 ILB 不支持这个操作',
  ERROR: 'ILB 报错',
};

function unwrap(result, what) {
  if (!result || typeof result !== 'object') {
    throw new IlbError('BAD_RESPONSE', `ILB 的「${what}」没有返回结果`);
  }
  if (result.ok === false) {
    const code = String(result.error?.code ?? 'ERROR');
    const message = String(result.error?.message ?? CODE_TEXT[code] ?? '未知错误');
    throw new IlbError(code, message, { detail: result.error, api: what });
  }
  return result;
}

/**
 * 等 ILB 就绪。三种情况都覆盖：
 *   1. 已经装好（globalThis.ILB.api）
 *   2. 正在启动（globalThis.ILB_READY 呢 promise）
 *   3. 还没开始（听 ilb:ready 事件 / 轮询）
 * 超时返回 null，由调用方显示"请先安装 ILB"。
 */
export async function waitForIlb({ timeoutMs = 8000, pollMs = 150, global = globalThis } = {}) {
  const existing = global?.ILB?.api;
  if (existing) return existing;

  const started = Date.now();
  let readyPromise = global?.ILB_READY;
  // ILB 在 document 上派发 ilb:ready（不冒泡），detail 里只有 version/caps，
  // 真正的 api 还是要从 globalThis.ILB 拿——所以这里只把它当"可以再查一次"的信号。
  const doc = global?.document;
  if (!readyPromise && doc && typeof doc.addEventListener === 'function') {
    readyPromise = new Promise((resolve) => {
      const onReady = () => {
        doc.removeEventListener('ilb:ready', onReady);
        resolve(global?.ILB?.api ?? null);
      };
      doc.addEventListener('ilb:ready', onReady);
    });
  }

  if (readyPromise) {
    const raced = await Promise.race([
      Promise.resolve(readyPromise).then((api) => api ?? global?.ILB?.api ?? null).catch(() => null),
      new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs)),
    ]);
    if (raced) return raced;
  }

  while (Date.now() - started < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    const api = global?.ILB?.api;
    if (api) return api;
  }
  return null;
}

/**
 * 包一层：所有方法都是 async、成功返回数据、失败抛 IlbError。
 * @param {object} api globalThis.ILB.api
 */
export function createIlbClient(api) {
  if (!api) throw new IlbError('NOT_INSTALLED', '没有找到 ILB（请先安装并启用 Independent Lorebook 扩展）');

  const check = isCompatible(api);
  if (!check.ok) throw new IlbError('NOT_SUPPORTED', check.reason);

  const call = (name, fn, ...args) => {
    try {
      return Promise.resolve(fn(...args)).then((result) => unwrap(result, name));
    } catch (err) {
      if (err instanceof IlbError) throw err;
      throw new IlbError('ERROR', `ILB 的「${name}」抛了异常：${err?.message ?? err}`);
    }
  };

  return {
    api,
    version: String(api.version ?? ''),
    caps: Array.isArray(api.caps) ? api.caps.slice() : [],

    /** 全部书（不含条目正文） */
    async listBooks() {
      const result = await call('worldbooks.list', api.worldbooks.list);
      return Array.isArray(result.books) ? result.books : [];
    },

    async getBook(id) {
      const result = await call('worldbooks.get', api.worldbooks.get, id);
      return result.book ?? null;
    },

    /** 完整导出（条目、逻辑、宿主名都在 book 里） */
    async exportBook(id) {
      const result = await call('worldbooks.exportBook', api.worldbooks.exportBook, id);
      return result.book ?? null;
    },

    /**
     * 导入一本书。返回 { id, action }：action 是 created/skipped/overwritten。
     * onConflict 默认 ask —— 本层把 CONFLICT 翻译成"需要用户确认"，不自己决定。
     */
    async importBook(packageOrBook, { onConflict = 'ask', targetId } = {}) {
      const result = await call('worldbooks.importBook', api.worldbooks.importBook, packageOrBook, { onConflict, targetId });
      return { id: result.id ?? '', action: result.action ?? 'created', skipped: result.skipped === true };
    },

    async deleteBook(id, opts = {}) {
      return call('worldbooks.deleteBook', api.worldbooks.deleteBook, id, opts);
    },

    /** 某角色（avatar）的全部关联，含已孤儿 */
    async listBindings({ character, includeOrphaned = true } = {}) {
      const opts = { includeOrphaned };
      if (character) opts.character = character;
      const result = await call('bindings.list', api.bindings.list, opts);
      return Array.isArray(result.bindings) ? result.bindings : [];
    },

    async createBinding({ avatar, name, bookId, policy = 'auto', note = '' }) {
      const result = await call('bindings.create', api.bindings.create, {
        character: { avatar, name },
        bookId,
        policy,
        note,
      });
      return result.binding ?? null;
    },

    async updateBinding(id, patch) {
      const result = await call('bindings.update', api.bindings.update, id, patch);
      return result.binding ?? null;
    },

    async removeBinding(id) {
      const result = await call('bindings.remove', api.bindings.remove, id);
      return result.removed === true;
    },

    async renameCharacter(fromAvatar, toAvatar, { name } = {}) {
      return call('bindings.renameCharacter', api.bindings.renameCharacter, fromAvatar, toAvatar, name ? { name } : undefined);
    },

    /** 判定预览：这次生成会启用哪些书、为什么 */
    async preview() {
      return call('runtime.preview', api.runtime.preview);
    },

    /** 上一轮真实运行结果（进程内，不持久化） */
    async status() {
      return call('runtime.status', api.runtime.status);
    },

    /** 失败码 → 给用户看的一句话 */
    explain(err) {
      if (!(err instanceof IlbError)) return String(err?.message ?? err ?? '未知错误');
      if (err.code === 'NOT_INSTALLED') return '没有找到 ILB。请先在酒馆的扩展里安装并启用 Independent Lorebook（ILB）。';
      if (err.code === 'NOT_SUPPORTED') return `ILB 版本不够：${err.message}`;
      if (err.code === 'NOT_FOUND') return `ILB 里找不到：${err.message}`;
      if (err.code === 'CONFLICT') return err.message;
      return err.message;
    },
  };
}
