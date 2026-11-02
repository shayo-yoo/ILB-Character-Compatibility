// st/cards.js —— 角色卡的读、导出、导入、删除（唯一碰 /api/characters/* 的地方）
//
// 这里的每个方法都对应一个**酒馆官方 HTTP 接口**，不去调酒馆内部的 importCharacter/exportCharacter：
// 那些函数没有导出，跟着版本走会碎。接口的参数形状是照 ST 1.19.0 的 endpoints/characters.js
// 与 script.js 里的实际调用抄下来的（见 docs/开发前审计与需求理解.md §4）。
//
// 失败一律抛 CardError（带 code 与中文 message），由上层翻译成界面文字。

export class CardError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'CardError';
    this.code = code;
    Object.assign(this, extra);
  }
}

function jsonHeaders(headers) {
  return { ...headers(), 'Content-Type': 'application/json' };
}

async function readJson(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new CardError('BAD_RESPONSE', `酒馆返回了无法解析的内容（HTTP ${response.status}）`);
  }
}

/**
 * @param {{access: ReturnType<import('./host.js').createContextAccess>}} deps
 */
export function createCardGateway({ access }) {
  const headers = (opts) => access.headers(opts);

  return {
    /** 角色列表（可能是浅数据，别直接依赖 description） */
    list() {
      return access.characters();
    },

    /** 当前角色；群聊或没进聊天时返回 undefined */
    current() {
      return access.currentCharacter();
    },

    /**
     * 取一张卡的全量数据。
     * 列表里已经是全量就直接用；否则按 avatar 走 /api/characters/get（懒加载模式必须走这步）。
     */
    async getFull(avatar) {
      const key = String(avatar ?? '').trim();
      if (!key) throw new CardError('NO_AVATAR', '没有 avatar，读不到角色卡');
      const fromList = access.characters().find((c) => c?.avatar === key);
      if (fromList && fromList.shallow !== true && ('description' in fromList || 'first_mes' in fromList || 'data' in fromList)) {
        return fromList;
      }
      const response = await fetch('/api/characters/get', {
        method: 'POST',
        headers: jsonHeaders(headers),
        body: JSON.stringify({ avatar_url: key }),
        cache: 'no-cache',
      });
      if (response.status === 404) throw new CardError('CARD_NOT_FOUND', `找不到角色卡文件：${key}`);
      if (!response.ok) throw new CardError('HTTP_ERROR', `读取角色卡失败（HTTP ${response.status}）`);
      const data = await readJson(response);
      if (!data || typeof data !== 'object') throw new CardError('BAD_RESPONSE', '角色卡内容为空');
      return data;
    },

    /** 用酒馆自己的导出接口拿 V2 JSON（保留未知字段，含 character_book） */
    async exportJson(avatar) {
      const key = String(avatar ?? '').trim();
      if (!key) throw new CardError('NO_AVATAR', '没有 avatar，导不出角色卡');
      const response = await fetch('/api/characters/export', {
        method: 'POST',
        headers: jsonHeaders(headers),
        body: JSON.stringify({ format: 'json', avatar_url: key }),
        cache: 'no-cache',
      });
      if (response.status === 404) throw new CardError('CARD_NOT_FOUND', `找不到角色卡文件：${key}`);
      if (!response.ok) throw new CardError('EXPORT_FAILED', `酒馆导出角色卡失败（HTTP ${response.status}）`);
      const data = await readJson(response);
      if (!data || typeof data !== 'object') throw new CardError('BAD_RESPONSE', '导出的角色卡不是 JSON 对象');
      return data;
    },

    /**
     * 导入一张角色卡，返回酒馆实际落库的 avatar 文件名。
     * 刻意不传 preserved_name：带上它会覆盖同名卡（无法回滚），重名时让酒馆自己加后缀更安全。
     * @param {object} card V2 JSON
     * @returns {Promise<{avatar:string, fileName:string}>}
     */
    async importJson(card) {
      if (!card || typeof card !== 'object') throw new CardError('BAD_PAYLOAD', '角色卡内容不是对象');
      const form = new FormData();
      form.append('avatar', new Blob([JSON.stringify(card)], { type: 'application/json' }), 'ilb-character.json');
      form.append('file_type', 'json');
      form.append('user_name', String(access.getContext()?.name1 ?? 'User'));
      const response = await fetch('/api/characters/import', {
        method: 'POST',
        body: form,
        headers: headers({ omitContentType: true }),
        cache: 'no-cache',
      });
      if (!response.ok) throw new CardError('IMPORT_FAILED', `酒馆导入角色卡失败（HTTP ${response.status}）`);
      const data = await readJson(response);
      if (!data || data.error) throw new CardError('IMPORT_FAILED', '酒馆拒绝了这张角色卡（文件可能损坏或格式不支持）');
      const fileName = String(data.file_name ?? '').trim();
      if (!fileName) throw new CardError('IMPORT_FAILED', '酒馆没有返回新角色卡的文件名');
      return { fileName, avatar: `${fileName}.png` };
    },

    /** 删除角色卡（仅用于探针/清理；正式界面不提供，"卡归酒馆管"） */
    async remove(avatar, { deleteChats = false } = {}) {
      const key = String(avatar ?? '').trim();
      if (!key) throw new CardError('NO_AVATAR', '没有 avatar，无法删除角色卡');
      const response = await fetch('/api/characters/delete', {
        method: 'POST',
        headers: jsonHeaders(headers),
        body: JSON.stringify({ avatar_url: key, delete_chats: deleteChats === true }),
        cache: 'no-cache',
      });
      if (!response.ok) throw new CardError('DELETE_FAILED', `删除角色卡失败（HTTP ${response.status}）`);
      return true;
    },
  };
}
