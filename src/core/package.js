// package.js —— .ilbchar.json 的格式定义与校验（纯函数，不碰 DOM / 网络 / 宿主）
//
// 格式为什么长这样（审计 §6.5）：
//   - 角色卡用酒馆自己的导出接口拿到的 V2 JSON，**原样**放进去，不裁剪字段；
//     别的扩展写在卡里的元数据、角色的 character_book，都要能跟着包走一圈回来。
//   - 书用 ILB 的 exportBook 完整导出（条目、逻辑、宿主名、稳定 ID 全在 book 里）。
//   - 关联只引用**包内自己的 ref**，不引用导出端的 book_id：导入时书会用新 id 落库，
//     引用旧 id 的关联一定会断。
//
// 版本策略：format_version 只认 1。更高的版本明确拒绝，不猜、不"尽力解析"——
// 静默降级解析会让用户以为数据没丢。

export const PACKAGE_FORMAT = 'ilb-character-package';
export const PACKAGE_VERSION = 1;
export const PACKAGE_EXTENSION = '.ilbchar.json';

/** 一场聊天里关联超过 200 本书基本可以断定是坏包（防止导入超大文件拖死界面） */
export const MAX_PACKAGE_BOOKS = 200;

export const POLICY_VALUES = ['auto', 'on', 'off'];

const MAX_NAME = 200;
const MAX_NOTE = 500;

function text(value, max = MAX_NAME) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** 角色卡上的显示名：V2 卡顶层有 name，V1 卡在 data.name */
export function cardNameOf(card) {
  if (!isPlainObject(card)) return '';
  return text(card.name || card.data?.name || '');
}

/** 文件名里不能出现的字符换掉，避免下载时被浏览器改得面目全非 */
export function safeFileStem(name, fallback = 'character') {
  const base = text(name, 80) || fallback;
  return base
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60) || fallback;
}

/**
 * 组装一个包。调用方负责把角色卡和书都取全；这里只做形状与去重。
 * @param {{identity:{avatar:string,name:string}, card:object, books:Array<{ref:string,name:string,book:object}>, bindings:Array<{bookRef:string,policy:string,note?:string}>, now?:number, generator?:string}} input
 */
export function buildPackage({ identity, card, books = [], bindings = [], now = Date.now(), generator = 'ILB Character Compatibility' }) {
  const usedRefs = new Set();
  const packedBooks = [];
  for (const item of Array.isArray(books) ? books : []) {
    const book = item?.book;
    if (!isPlainObject(book)) continue;
    let ref = text(item.ref || book.book_id, 80);
    if (!ref) ref = `book-${packedBooks.length + 1}`;
    // 同一本书被关联两次时 ref 会撞：加序号，后面按顺序重新指回去
    let unique = ref;
    let suffix = 2;
    while (usedRefs.has(unique)) {
      unique = `${ref}-${suffix}`;
      suffix += 1;
    }
    usedRefs.add(unique);
    packedBooks.push({ ref: unique, name: text(item.name || book.name, MAX_NAME), book });
  }

  const packedBindings = [];
  for (const item of Array.isArray(bindings) ? bindings : []) {
    const bookRef = text(item?.bookRef, 80);
    if (!bookRef || !usedRefs.has(bookRef)) continue;
    const policy = POLICY_VALUES.includes(item?.policy) ? item.policy : 'auto';
    packedBindings.push({ book_ref: bookRef, policy, note: text(item?.note, MAX_NOTE) });
  }

  return {
    format: PACKAGE_FORMAT,
    format_version: PACKAGE_VERSION,
    created_at: Number(now) || Date.now(),
    generator,
    character: {
      identity: {
        avatar: text(identity?.avatar, MAX_NAME),
        name: text(identity?.name, MAX_NAME),
      },
      card,
    },
    worldbooks: packedBooks,
    bindings: packedBindings,
    metadata: {
      book_count: packedBooks.length,
      binding_count: packedBindings.length,
    },
  };
}

function block(code, message, path) {
  return { code, message, path };
}

/**
 * 校验一个已经解析成对象的包。只报"能不能安全导入"，不改数据。
 * @returns {{ok:true, warnings:Array}|{ok:false, code:string, message:string, errors:Array}}
 */
export function validatePackage(input) {
  const errors = [];
  const warnings = [];

  if (!isPlainObject(input)) {
    return { ok: false, code: 'BAD_PAYLOAD', message: '这不是一个 ILB 角色卡包（内容不是对象）', errors: [block('BAD_PAYLOAD', '根节点不是对象', '$')] };
  }
  if (input.format !== PACKAGE_FORMAT) {
    return {
      ok: false,
      code: 'BAD_FORMAT',
      message: `这不是 ILB 角色卡包（format 应为 ${PACKAGE_FORMAT}，实际是 ${String(input.format ?? '空')}）`,
      errors: [block('BAD_FORMAT', 'format 不匹配', '$.format')],
    };
  }

  const version = Number(input.format_version);
  if (!Number.isFinite(version)) {
    return { ok: false, code: 'BAD_PAYLOAD', message: '包里没有可识别的格式版本（format_version）', errors: [block('BAD_PAYLOAD', 'format_version 缺失', '$.format_version')] };
  }
  if (version > PACKAGE_VERSION) {
    return {
      ok: false,
      code: 'UNSUPPORTED_VERSION',
      message: `这个包是更新版本写的（格式 ${version}），当前扩展只认 ${PACKAGE_VERSION}。请先升级扩展，不要强行导入。`,
      errors: [block('UNSUPPORTED_VERSION', `format_version=${version}`, '$.format_version')],
    };
  }
  if (version < 1) {
    return { ok: false, code: 'BAD_PAYLOAD', message: `格式版本 ${version} 不可识别`, errors: [block('BAD_PAYLOAD', 'format_version 非法', '$.format_version')] };
  }

  const card = input.character?.card;
  if (!isPlainObject(card)) {
    errors.push(block('BAD_PAYLOAD', '缺少角色卡（character.card）', '$.character.card'));
  } else if (!cardNameOf(card)) {
    errors.push(block('BAD_PAYLOAD', '角色卡没有名字', '$.character.card.name'));
  }

  const books = Array.isArray(input.worldbooks) ? input.worldbooks : [];
  if (!Array.isArray(input.worldbooks)) {
    errors.push(block('BAD_PAYLOAD', '缺少世界书列表（worldbooks）', '$.worldbooks'));
  }
  if (books.length > MAX_PACKAGE_BOOKS) {
    errors.push(block('BAD_PAYLOAD', `包里有 ${books.length} 本书，超过上限 ${MAX_PACKAGE_BOOKS}`, '$.worldbooks'));
  }

  const refs = new Set();
  books.forEach((item, index) => {
    const at = `$.worldbooks[${index}]`;
    if (!isPlainObject(item)) {
      errors.push(block('BAD_PAYLOAD', '世界书条目不是对象', at));
      return;
    }
    const ref = text(item.ref, 80);
    if (!ref) {
      errors.push(block('BAD_PAYLOAD', '世界书条目缺少 ref', `${at}.ref`));
    } else if (refs.has(ref)) {
      errors.push(block('BAD_PAYLOAD', `世界书 ref 重复：${ref}`, `${at}.ref`));
    } else {
      refs.add(ref);
    }
    if (!isPlainObject(item.book)) {
      errors.push(block('BAD_PAYLOAD', '世界书条目里没有书内容（book）', `${at}.book`));
      return;
    }
    if (!Array.isArray(item.book.entries)) {
      warnings.push(block('BAD_PAYLOAD', `书「${text(item.name || item.book.name)}」没有条目数组`, `${at}.book.entries`));
    }
    const schema = Number(item.book.schema_version);
    if (Number.isFinite(schema) && schema > 2) {
      errors.push(block('UNSUPPORTED_VERSION', `书「${text(item.name || item.book.name)}」的 schema_version=${schema}，比当前 ILB 新`, `${at}.book.schema_version`));
    }
  });

  const bindings = Array.isArray(input.bindings) ? input.bindings : [];
  bindings.forEach((item, index) => {
    const at = `$.bindings[${index}]`;
    if (!isPlainObject(item)) {
      errors.push(block('BAD_PAYLOAD', '关联记录不是对象', at));
      return;
    }
    const ref = text(item.book_ref, 80);
    if (!ref) {
      errors.push(block('BAD_PAYLOAD', '关联记录缺少 book_ref', `${at}.book_ref`));
    } else if (!refs.has(ref)) {
      errors.push(block('BAD_PAYLOAD', `关联指向了包里没有的书：${ref}`, `${at}.book_ref`));
    }
    if (item.policy !== undefined && !POLICY_VALUES.includes(item.policy)) {
      warnings.push(block('BAD_PAYLOAD', `关联策略「${String(item.policy)}」不认识，将按 auto 处理`, `${at}.policy`));
    }
  });

  if (errors.length > 0) {
    const first = errors[0];
    return { ok: false, code: first.code, message: first.message, errors };
  }
  return { ok: true, warnings };
}

/**
 * 把文本或对象解析成包。JSON 坏掉时给一句人话，不抛异常。
 * @returns {{ok:true, pkg:object, warnings:Array}|{ok:false, code:string, message:string, errors:Array}}
 */
export function parsePackage(input) {
  let data = input;
  if (typeof input === 'string') {
    const raw = input.replace(/^\uFEFF/, '').trim();
    if (!raw) return { ok: false, code: 'BAD_PAYLOAD', message: '文件是空的', errors: [] };
    try {
      data = JSON.parse(raw);
    } catch (err) {
      return { ok: false, code: 'BAD_PAYLOAD', message: `文件不是合法的 JSON：${err?.message ?? err}`, errors: [] };
    }
  }
  const result = validatePackage(data);
  if (!result.ok) return result;
  return { ok: true, pkg: data, warnings: result.warnings };
}

/** 给界面看的摘要（不展示整张卡、不展示条目正文） */
export function summarizePackage(pkg) {
  const books = Array.isArray(pkg?.worldbooks) ? pkg.worldbooks : [];
  return {
    formatVersion: Number(pkg?.format_version) || 0,
    createdAt: Number(pkg?.created_at) || 0,
    generator: text(pkg?.generator, 80),
    character: {
      name: cardNameOf(pkg?.character?.card) || text(pkg?.character?.identity?.name),
      avatar: text(pkg?.character?.identity?.avatar, MAX_NAME),
    },
    books: books.map((item) => ({
      ref: text(item?.ref, 80),
      name: text(item?.name || item?.book?.name, MAX_NAME),
      bookId: text(item?.book?.book_id, 80),
      entries: Array.isArray(item?.book?.entries) ? item.book.entries.length : 0,
      schemaVersion: Number(item?.book?.schema_version) || 2,
    })),
    bindings: (Array.isArray(pkg?.bindings) ? pkg.bindings : []).map((item) => ({
      bookRef: text(item?.book_ref, 80),
      policy: POLICY_VALUES.includes(item?.policy) ? item.policy : 'auto',
      note: text(item?.note, MAX_NOTE),
    })),
  };
}

/** 下载用的文件名：角色名 + 日期，不用 avatar（可能是乱码拼音） */
export function packageFileName(name, now = Date.now()) {
  const date = new Date(Number(now) || Date.now());
  const stamp = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`;
  return `${safeFileStem(name)}-${stamp}${PACKAGE_EXTENSION}`;
}
