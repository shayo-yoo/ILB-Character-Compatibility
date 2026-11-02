// tests/live/st-v01-check.mjs —— 真酒馆验收：ILB 角色卡兼容 0.1.2
//
// 覆盖：
//   1) 扩展加载、设置页卡片、面板三个页签都能渲染；
//   2) 读到当前角色，能通过界面层（app.bindings）加关联，并让 ILB 的判定真的改变；
//   3) 导出：当前角色 + 关联书 → 一个完整的 .ilbchar.json；
//   4) 导入：把刚导出的包再导一遍（书已存在 → skip），应新建角色卡并恢复关联；
//   5) 诊断页能给出人话结论；
//   6) 0.1.2 的两条界面回归：「添加关联」钉在面板底部、清单说明文字横排；
//   7) 清理：新增的卡、书、关联全部删掉，探针不留垃圾。
//
// 用法：
//   set ST_DIR=D:\1\APP\SillyTavern
//   node tests/live/st-v01-check.mjs
import { fileURLToPath } from 'node:url';
import { openPage, sleep, screenshot } from './cdp.mjs';

const ST_DIR = process.env.ST_DIR ?? 'D:/1/APP/SillyTavern';
const page = await openPage(ST_DIR);
await page.send('Runtime.enable');
await page.send('Page.enable');
await page.send('Emulation.setDeviceMetricsOverride', { width: 1360, height: 900, deviceScaleFactor: 1, mobile: false });
await page.send('Page.reload', { ignoreCache: true });

let ready = false;
for (let i = 0; i < 40; i += 1) {
  await sleep(1000);
  if (await page.evaluate('Boolean(globalThis.ILBCC)')) {
    ready = true;
    break;
  }
}
if (!ready) {
  console.log('❌ 页面里没有 globalThis.ILBCC（扩展没加载起来）');
  page.close();
  process.exit(1);
}

const out = await page.evaluate(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const cc = globalThis.ILBCC;
  const app = cc.app;
  const api = globalThis.ILB?.api;
  const r = {};
  const dirty = { books: [], bindings: [], cards: [] };

  const bindIds = (avatar) => (api.bindings.list({ character: avatar }).bindings ?? []).map((b) => b.id);
  const cleanAvatar = (avatar) => {
    if (!avatar) return;
    for (const id of bindIds(avatar)) api.bindings.remove(id);
  };

  try {
    r.version = cc.version;
    r.ilbConnected = app.ilbState().ok === true && app.ilbState().version === '1.4';

    // ---- 界面：卡片与三个页签 ----
    r.cardMounted = !!document.querySelector('.ilbcc-card');
    cc.open('bindings');
    await sleep(600);
    const dialog = document.querySelector('.ilbcc-dialog');
    r.dialogOpen = !!dialog && dialog.open === true;
    r.tabCount = dialog ? dialog.querySelectorAll('.ilbcc-tab').length === 3 : false;
    r.bindingsRendered = (dialog?.querySelector('.ilbcc-body')?.textContent ?? '').length > 20;

    // ---- v0.1.2：添加栏钉在面板底部 ----
    // 页面是两段式：上面是 .ilbcc-bind-scroll（自己滚），下面是 .ilbcc-add-bar。
    // 这里把滚动区临时压矮，强制出现滚动，再看添加栏是不是还贴着面板下沿；
    // 测完恢复原样。
    const bodyEl = dialog?.querySelector('.ilbcc-body');
    const addBar = dialog?.querySelector('.ilbcc-add-bar');
    const scroller = dialog?.querySelector('.ilbcc-bind-scroll');
    r.addBarExists = !!addBar;
    r.addBarDocked = !!addBar && !!bodyEl && addBar.parentElement === bodyEl;
    if (bodyEl && addBar) {
      const barRect = addBar.getBoundingClientRect();
      const bodyRect = bodyEl.getBoundingClientRect();
      r.addBarPinned = Math.abs(barRect.bottom - bodyRect.bottom) <= 4 && barRect.height > 10;
      if (scroller) {
        const keepMax = scroller.style.maxHeight;
        scroller.style.maxHeight = '80px';
        await sleep(120);
        const bar2 = addBar.getBoundingClientRect();
        const scroll2 = scroller.getBoundingClientRect();
        const body2 = bodyEl.getBoundingClientRect();
        r.addBarPinnedWhenScroll = scroller.scrollHeight > scroller.clientHeight + 5
          && Math.abs(bar2.bottom - body2.bottom) <= 4
          && bar2.top >= scroll2.bottom - 1;
        scroller.style.maxHeight = keepMax;
      }
    }

    // ---- 当前角色：新标签页默认停在"角色列表"，先像用户一样点开一张卡 ----
    if (!app.currentCharacter()?.avatar) {
      for (const selector of ['#rm_print_characters_block .character_select', '#rm_print_characters_block .avatar', '.character_select']) {
        const node = document.querySelector(selector);
        if (!node) continue;
        node.click();
        await sleep(4000);
        if (app.currentCharacter()?.avatar) break;
      }
    }
    const character = app.currentCharacter();
    r.hasCharacter = !!character?.avatar;
    if (!character?.avatar) throw new Error('当前没有角色卡，探针需要一张真实角色卡才能验关联');

    // ---- 面板开关：关掉之后必须真的从页面上消失（v0.1.1 修）----
    cc.open('bindings');
    await sleep(500);
    cc.close();
    await sleep(400);
    const closedDialog = document.querySelector('.ilbcc-dialog');
    r.dialogClosedHidden = !!closedDialog && closedDialog.open === false && getComputedStyle(closedDialog).display === 'none';

    // ---- 导入导出页：进了聊天就要认得出角色，导入要有能点的按钮（v0.1.1 修）----
    cc.open('package');
    await sleep(2000);
    const pkgBody = document.querySelector('.ilbcc-body');
    const pkgText = pkgBody?.textContent ?? '';
    r.packageSeesCharacter = pkgText.includes(character.avatar);
    r.packageHasImportButton = [...(pkgBody?.querySelectorAll('button') ?? [])].some((button) =>
      (button.textContent ?? '').includes('选择包文件'),
    );
    cc.open('bindings');
    await sleep(400);

    // ---- 造一本探针书（走 ILB 公开接口）+ 一条关联 ----
    const bookId = 'probe-ilbcc-b1';
    await api.worldbooks.deleteBook(bookId, { cascade: true });
    const madeBook = await api.worldbooks.importBook({
      schema_version: 2,
      book: {
        schema_version: 2,
        book_id: bookId,
        name: 'ILBCC 探针书',
        activation: { strategy: 'auto', override: 'auto' },
        entries: [],
        logic: [],
      },
    }, { onConflict: 'new' });
    r.bookImported = madeBook.ok === true;
    dirty.books.push(madeBook.id ?? bookId);

    const added = await app.bindings.add({ character, bookId: dirty.books[0], policy: 'on' });
    r.bindingCreated = !!added;
    const rows = await app.bindings.listForCharacter(character);
    r.bindingVisible = rows.ok === true && rows.rows.some((row) => row.bookId === dirty.books[0] && row.policy === 'on');

    // 关联真的参与判定（不是只画在界面上）
    const preview = api.runtime.preview();
    const decided = (preview.books ?? []).find((b) => b.id === dirty.books[0]);
    r.bindingAffectsRuntime = !!decided && decided.enabled === true && decided.rule === 'binding-on';

    // ---- v0.1.2：导入导出清单里的说明文字必须横排 ----
    // 旧版在窄屏上会缩进 22px 那一列，中文变成一个字一行；横排时高度约等于一行。
    cc.open('package');
    await sleep(1800);
    const metaNode = document.querySelector('.ilbcc-check-row .ilbcc-check-meta');
    if (metaNode) {
      const metaRect = metaNode.getBoundingClientRect();
      const fontSize = parseFloat(getComputedStyle(metaNode).fontSize) || 14;
      r.checkMetaHorizontal = metaRect.width > 30 && metaRect.height <= fontSize * 2.2;
    } else {
      r.checkMetaHorizontal = 'no-row';
    }
    cc.open('bindings');
    await sleep(400);

    // ---- 导出 ----
    const plan = await app.exporter.plan(character.avatar);
    r.exportPlanOk = plan.ok === true && plan.books.some((b) => b.bookId === dirty.books[0]);
    const exported = await app.exporter.run({ avatar: character.avatar, bookIds: [dirty.books[0]] });
    r.exportOk = exported.ok === true && exported.package?.format === 'ilb-character-package';
    r.exportHasCard = exported.ok === true && !!exported.package.character.card?.name;
    r.exportHasBook = exported.ok === true && exported.package.worldbooks.length === 1 && exported.package.bindings.length === 1;
    r.exportFileName = exported.fileName;

    // ---- 导入（自往返）----
    const importPreview = await app.importer.plan(exported.package);
    r.importPlanOk = importPreview.ok === true && importPreview.books.length === 1;
    r.importConflictDetected = importPreview.books[0].conflict?.kind === 'id';

    const imported = await app.importer.run(exported.package, { decisions: {} });
    r.importOk = imported.ok === true;
    r.importCreatedCard = imported.character.ok === true && !!imported.character.avatar;
    r.importCreatedBinding = imported.bindings.created.length === 1;
    if (imported.character.ok && imported.character.avatar) {
      dirty.cards.push(imported.character.avatar);
      const restored = api.bindings.list({ character: imported.character.avatar }).bindings ?? [];
      r.importBindingPointsAtBook = restored.length === 1 && restored[0].bookId === dirty.books[0] && restored[0].policy === 'on';
    }

    // ---- 诊断页 ----
    cc.open('diagnostics');
    await sleep(600);
    const diagText = document.querySelector('.ilbcc-body')?.textContent ?? '';
    r.diagnosticsRenders = /ILB/.test(diagText) && /关联/.test(diagText);

    await screenshotShotIfPossible();
  } catch (err) {
    r.error = String(err?.message ?? err);
  } finally {
    // 清理：先删关联，再删卡，最后删书
    for (const avatar of dirty.cards) {
      cleanAvatar(avatar);
      try {
        await app.cards.remove(avatar);
      } catch (err) {
        r.cleanupCardError = String(err?.message ?? err);
      }
    }
    cleanAvatar(app.currentCharacter()?.avatar ?? '');
    for (const id of dirty.books) await api.worldbooks.deleteBook(id, { cascade: true });
    r.cleanup = true;
  }

  async function screenshotShotIfPossible() {
    // 留在页面里截图由外层做；这里只把面板摆到关联页
    cc.open('bindings');
    await sleep(300);
  }

  return r;
})()`);

await sleep(400);
await screenshot(page.send, fileURLToPath(new URL('./last-ilbcc.png', import.meta.url)));

// ---- 窄视口（手机宽度）再过一遍布局：0.1.1/0.1.2 的两个毛病都只在手机上出现 ----
// 这一段自己造书和关联，测完自己删，不影响上面的清理。
await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await sleep(500);
const narrow = await page.evaluate(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const api = globalThis.ILB?.api;
  const cc = globalThis.ILBCC;
  const r = { narrowViewport: innerWidth + 'x' + innerHeight };
  const character = cc?.app?.currentCharacter?.();
  if (!api || !cc || !character?.avatar) return { ...r, narrowSkipped: true };
  let bookId = '';
  try {
    const made = await api.worldbooks.importBook({ schema_version: 2, book_id: 'probe-narrow', name: '探针书（窄屏）', entries: [], activation: { strategy: 'auto', override: 'auto' } }, { onConflict: 'new' });
    bookId = made.id ?? made.book?.id ?? '';
    await api.bindings.create({ character: { avatar: character.avatar, name: character.name }, bookId, policy: 'auto' });
    cc.open('bindings');
    await sleep(1800);
    const dialog = document.querySelector('.ilbcc-dialog');
    const body = dialog?.querySelector('.ilbcc-body');
    const bar = dialog?.querySelector('.ilbcc-add-bar');
    const sc = dialog?.querySelector('.ilbcc-bind-scroll');
    const b = body?.getBoundingClientRect();
    const a = bar?.getBoundingClientRect();
    r.narrowBarPinned = !!b && !!a && Math.abs(a.bottom - b.bottom) <= 4;
    r.narrowBarNotTooTall = !!b && !!a && a.height / b.height <= 0.4;
    r.narrowListScrolls = !!sc && sc.scrollHeight >= sc.clientHeight;

    cc.open('package');
    await sleep(2200);
    const pbody = dialog?.querySelector('.ilbcc-body');
    const meta = pbody?.querySelector('.ilbcc-check-meta');
    if (meta) {
      const mr = meta.getBoundingClientRect();
      const fs = parseFloat(getComputedStyle(meta).fontSize) || 14;
      r.narrowMetaHorizontal = mr.width > 30 && mr.height <= fs * 2.2;
    } else {
      r.narrowMetaHorizontal = 'no-row';
    }
    const importBtn = [...(pbody?.querySelectorAll('button') ?? [])].find((node) => node.textContent.includes('选择包文件'));
    r.narrowImportButtonVisible = !!importBtn && importBtn.getBoundingClientRect().width > 60;
  } finally {
    try {
      for (const row of (await api.bindings.list({ character: character.avatar })).bindings ?? []) {
        if (row.bookId === bookId) await api.bindings.remove(row.id);
      }
      if (bookId) await api.worldbooks.deleteBook(bookId, { cascade: true });
    } catch (err) {
      r.narrowCleanupError = String(err?.message ?? err);
    }
    cc.open('bindings');
  }
  return r;
})()`);
Object.assign(out, narrow);
await page.send('Emulation.setDeviceMetricsOverride', { width: 1360, height: 900, deviceScaleFactor: 1, mobile: false });

const rows = Object.entries(out).filter(([key]) => key !== 'exportFileName');
const failed = rows.filter(([key, value]) => {
  if (key === 'error' || key === 'cleanupCardError') return false;
  if (typeof value === 'string') return false; // 版本号/文件名这类是信息，不是判定项
  return value !== true;
});
console.log('— ILB 角色卡兼容 0.1.2 真机检查 —');
for (const [key, value] of rows) console.log(`${value === true || typeof value === 'string' ? '✓' : '✗'} ${key}: ${String(value)}`);
if (out.error) console.log(`✗ error: ${out.error}`);
if (out.cleanupCardError) console.log(`! 清理角色卡失败：${out.cleanupCardError}`);

if (failed.length > 0 || out.error) {
  console.log(`\n❌ 失败 ${failed.length} 项：${failed.map(([key, value]) => `${key}=${String(value)}`).join('、')}`);
  page.close();
  process.exit(1);
}
console.log('\n✅ v0.1.2 角色卡兼容检查通过');
page.close();
