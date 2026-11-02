// identity.js —— 角色身份的名字与判据（纯函数）
//
// 为什么要单独一层：酒馆里"角色是谁"有三个容易混的东西——
//   name（显示名，可重复、可改）、avatar（文件名，重命名会变但当下唯一）、index（会变）。
// 本扩展一律用 avatar 当稳定身份（审计 §2），这里集中处理它的读写与展示，
// 免得每个模块各写一套 fallback。

const MAX_NAME = 200;

function text(value, max = MAX_NAME) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

/** 从角色对象里取 avatar。酒馆不同位置叫法不一样（character.avatar / avatar_url） */
export function avatarOf(character) {
  if (!character || typeof character !== 'object') return '';
  return text(character.avatar || character.avatar_url || character.avatarUrl, 512);
}

export function nameOf(character) {
  if (!character || typeof character !== 'object') return '';
  return text(character.name || character.data?.name);
}

/** 统一成 {avatar, name}；nameless 时用 avatar 去掉扩展名兜底显示 */
export function normalizeIdentity(source) {
  const avatar = avatarOf(source);
  let name = nameOf(source);
  if (!name && avatar) name = avatar.replace(/\.png$/i, '');
  return { avatar, name };
}

/** 头像文件名 → 不带扩展名的部分（酒馆的聊天目录名、显示名都用它） */
export function avatarStem(avatar) {
  return text(avatar, 512).replace(/\.png$/i, '');
}

/** 稳定身份是否可用：没有 avatar 就没法关联，必须让用户知道 */
export function identityProblem(identity) {
  if (!identity || typeof identity !== 'object') return '没有读到当前角色';
  if (!avatarOf(identity)) return '当前角色没有 avatar（不是从角色卡进入的聊天？）';
  return '';
}

/**
 * 懒加载模式下角色列表里只有浅数据（name/extensions 等），
 * 直接用会漏掉 description、character_book。这里判断要不要再取一次全量。
 */
export function isShallow(character) {
  if (!character || typeof character !== 'object') return true;
  if (character.shallow === true) return true;
  // 没有 shallow 标记时按字段判断：全量角色卡一定有 description 或 first_mes 键
  return !('description' in character) && !('first_mes' in character) && !('data' in character);
}

/** 两个身份是否指同一个角色（只比 avatar） */
export function sameCharacter(a, b) {
  const left = avatarOf(a);
  const right = avatarOf(b);
  return Boolean(left) && left === right;
}

/** 诊断/历史里显示用：名字 + avatar，名字缺失时只显示 avatar */
export function identityLabel(identity) {
  const { avatar, name } = normalizeIdentity(identity);
  if (!avatar && !name) return '（未知角色）';
  if (!avatar) return name;
  return name && name !== avatarStem(avatar) ? `${name}（${avatar}）` : avatar;
}
