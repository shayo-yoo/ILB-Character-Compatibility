// ui/dom.js —— 极小的建 DOM 工具。不引框架：扩展只有三个页签，手写反而更可控。

/**
 * el('div', {class:'x', onclick: fn, dataset:{...}}, child1, '文本', [数组])
 * 文本与数组都会被扁平化；null/undefined/false 直接丢掉。
 */
export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = String(value);
    else if (key === 'text') node.textContent = String(value);
    else if (key === 'html') node.innerHTML = String(value); // 只用于我们自己拼的静态结构
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key in node && key !== 'list' && typeof value !== 'object') node[key] = value;
    else node.setAttribute(key, String(value));
  }
  append(node, children);
  return node;
}

export function append(node, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false || child === '') continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

export function option(value, label, selected = false) {
  const node = el('option', { value, text: label });
  if (selected) node.selected = true;
  return node;
}

export function hint(text) {
  return el('p', { class: 'ilbcc-hint', text });
}

export function badge(text, kind = '') {
  return el('span', { class: `ilbcc-badge ${kind}`.trim(), text });
}

export function fmtTime(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return '—';
  const date = new Date(n);
  const pad = (v) => String(v).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 下载一段文本为文件（Blob + a[download]，不经过服务器） */
export function downloadText(fileName, text, mime = 'application/json') {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
  // 立刻 revoke 在部分浏览器会把下载掐掉，延后一点更稳
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
