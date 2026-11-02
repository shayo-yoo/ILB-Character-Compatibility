// tests/live/st-v01-check.mjs —— 真酒馆验收：ILB 角色卡兼容 0.1.0
//
// 覆盖：
//   1) 扩展加载、设置页卡片、面板三个页签都能渲染；
//   2) 读到当前角色，能通过界面层（app.bindings）加关联，并让 ILB 的判定真的改变；
//   3) 导出：当前角色 + 关联书 → 一个完整的 .ilbchar.json；
//   4) 导入：把刚导出的包再导一遍（书已存在 → skip），应新建角色卡并恢复关联；
//   5) 诊断页能给出人话结论；
//   6) 清理：新增的卡、书、关联全部删掉，探针不留垃圾。
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

const rows = Object.entries(out).filter(([key]) => key !== 'exportFileName');
const failed = rows.filter(([key, value]) => {
  if (key === 'error' || key === 'cleanupCardError') return false;
  if (typeof value === 'string') return false; // 版本号/文件名这类是信息，不是判定项
  return value !== true;
});
console.log('— ILB 角色卡兼容 0.1.0 真机检查 —');
for (const [key, value] of rows) console.log(`${value === true || typeof value === 'string' ? '✓' : '✗'} ${key}: ${String(value)}`);
if (out.error) console.log(`✗ error: ${out.error}`);
if (out.cleanupCardError) console.log(`! 清理角色卡失败：${out.cleanupCardError}`);

if (failed.length > 0 || out.error) {
  console.log(`\n❌ 失败 ${failed.length} 项：${failed.map(([key, value]) => `${key}=${String(value)}`).join('、')}`);
  page.close();
  process.exit(1);
}
console.log('\n✅ v0.1 角色卡兼容检查通过');
page.close();
