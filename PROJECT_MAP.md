# PROJECT_MAP —— ILB 角色卡兼容

> 这份文档描述**当前真实存在的结构**，不写计划。新增/删除模块、改公共接口、改数据结构时必须同步更新。

## 1. 项目定位

SillyTavern 扩展。把「角色卡 + 若干本 ILB 世界书 + 关联关系」打包成 `.ilbchar.json`，并提供关联管理与导入导出。

**不负责**：角色卡的内容管理（归酒馆）、世界书的内容编辑（归 ILB）、生成时的注入（归 ILB）。

## 2. 技术栈与运行环境

- 纯浏览器 ES Module，无构建步骤、无第三方依赖
- 宿主要求：SillyTavern 1.19.x（`/api/characters/*` 与 `extension_settings`）
- ILB 要求：`ILB.api` ≥ 1.4，caps 含 `bindings` / `runtime` / `worldbooks`
- 测试：Node ≥ 20（`node --test`），真机用 CDP

## 3. 目录结构与模块职责

```
index.js                 装配层：拿宿主 → 等 ILB → 建服务 → 挂卡片/面板。不含业务判断
manifest.json            扩展清单（js 只声明 index.js）
style.css                全部样式（.ilbcc- 前缀）
src/
  st/host.js             唯一 import 酒馆代码的地方（getContext / 事件 / headers / saveSettings）
  st/cards.js            唯一调用 /api/characters/* 的地方（取全量、导出 V2、导入、删除）
  ilb/client.js          唯一碰 ILB.api 的地方（等就绪、能力校验、{ok} 翻译成异常）
  core/package.js        包格式：组装、校验、解析、摘要、文件名（纯函数）
  core/identity.js       角色身份：avatar 取值、浅数据判断、同名判断（纯函数）
  service/bindings.js    当前角色关联的读写（数据在 ILB，这里只组合与补书名）
  service/export.js      导出编排：计划 → 逐本导出 → 取卡 → 组装
  service/import.js      导入编排：计划 → 先书 → 再卡 → 建关联 → 报告
  service/history.js     最近 20 次导入导出（存 extension_settings.ilb_character_compatibility）
  ui/panel.js            卡片 + <dialog> 外壳 + 页签切换
  ui/view-bindings.js    「关联」页签
  ui/view-package.js     「导入导出」页签
  ui/view-diagnostics.js 「诊断」页签
  ui/dom.js              建 DOM / 下载 / 时间格式化的小工具
tests/
  package.test.mjs       包格式与身份（纯函数）
  services.test.mjs      服务编排（假 ILB + 假酒馆）
  client.test.mjs        ILB 客户端翻译层
  linkcheck.test.mjs     所有模块可 import + manifest 指向正确
  live/cdp.mjs           CDP 小工具（真机验收用）
  live/st-v01-check.mjs  真机验收探针
docs/
  开发前审计与需求理解.md   ST 1.19.0 / ILB 1.3 的审计与方案（历史依据，已标出哪些缺口已被 1.4 解决）
  ILB接口需求-角色卡关联与运行时.md  ILB 侧接口需求（已由 ILB 0.28.0 实现）
  decisions/ADR-*.md      架构决策
```

## 4. 依赖方向

```
index.js ──> st/*、ilb/client、service/*、ui/*
service/* ──> core/*（纯函数）+ 注入进来的 ilb/cards
ui/* ──> service/*（通过 app 对象）+ core/identity、core/package
core/* ──> 无依赖
```

- 反向依赖禁止：`core/` 不 import 任何其他层；`service/` 不 import `ui/`
- `st/host.js` 与 `st/cards.js` 是宿主适配层；`ilb/client.js` 是 ILB 适配层
- `index.js` 是唯一把各层接起来的地方

## 5. 对外接口（本扩展提供给外部/探针的）

`globalThis.ILBCC`：

| 字段 | 说明 |
| --- | --- |
| `version` | 扩展版本 |
| `app` | 服务与状态的集合（探针与排障用，见下） |
| `panel` | 面板控制器 |
| `open(tab?)` | 打开面板，可指定 `bindings` / `package` / `diagnostics` |
| `close()` | 关闭 |
| `refresh()` | 重渲染当前页签 |
| `state()` | `{ok, version, caps, message}` 的 ILB 连接状态 |

`globalThis.ILBCC_READY`：启动完成的 Promise。

`app` 上给探针用的：`currentCharacter()`、`groupInfo()`、`chatId()`、`ilbState()`、`ilb`（客户端）、`bindings`、`exporter`、`importer`、`cards`、`history`、`refreshViews()`。

## 6. 数据结构

### 6.1 包（`.ilbchar.json`，format_version 1）

```jsonc
{
  "format": "ilb-character-package",
  "format_version": 1,
  "created_at": 1730000000000,
  "generator": "ILB Character Compatibility",
  "character": {
    "identity": { "avatar": "ali.png", "name": "阿离" },
    "card": { /* 酒馆原生导出的 V2 JSON，原样保留 */ }
  },
  "worldbooks": [
    { "ref": "b1", "name": "共享书", "book": { /* ILB exportBook 的完整 book */ } }
  ],
  "bindings": [ { "book_ref": "b1", "policy": "auto|on|off", "note": "" } ],
  "metadata": { "book_count": 1, "binding_count": 1 }
}
```

不变式：
- `format` 必须匹配、`format_version` 只认 1（更高版本明确拒绝）
- `worldbooks[].ref` 包内唯一
- `bindings[].book_ref` 必须指向包内存在的 ref
- `book.schema_version > 2` 拒绝（比当前 ILB 新）
- `character.card` 不裁剪字段

### 6.2 关联行（界面用，来自 ILB）

```
{ id, bookId, bookName, bookExists, policy, note, orphaned, createdAt, updatedAt }
```

### 6.3 历史记录

```
{ at, kind:'export'|'import', character:{avatar,name}, summary, result:'ok'|'partial'|'failed', detail }
```

存 `extension_settings.ilb_character_compatibility.history`，最多 20 条；只存结论，不存书内容/聊天内容。

## 7. 关键流程

### 7.1 启动

1. `loadHost()` 拿 `getContext / eventSource / eventTypes / getRequestHeaders / saveSettings`
2. 挂设置页卡片（`#extensions_settings`）
3. `waitForIlb()`（最多 6 秒）→ 校验 caps 与版本 → 建客户端；失败则界面显示原因、诊断页可重连
4. 订阅 `CHAT_CHANGED / CHARACTER_* / GROUP_* / PERSONA_CHANGED / ilb:change / ilb:ready`，160ms 合并后重渲染

### 7.2 导出

`exporter.plan(avatar)` → `exporter.run({avatar, bookIds})`：
取全量卡 → 逐本 `ILB.worldbooks.exportBook` → **任一失败即整体取消** → 取原生 V2 JSON → `buildPackage` → 下载。

界面每次渲染都重读 `plan()`，不缓存结论：缓存过「没有角色」会让用户进了聊天之后仍然看到这句话（0.1.1 修）。

### 7.3 导入

`importer.plan(pkg)` → `importer.run(pkg, {decisions})`：
逐本 `worldbooks.importBook`（默认 `ask` 由界面决定：skip / overwrite / create / reuse）→
**有书失败就停** → `cards.importJson`（不传 preserved_name）→ 用新 avatar + 新 book id 建关联 → 校验并报告。

### 7.4 两条界面约定（踩过坑）

- **`<dialog>` 关闭必须真的不显示**：作者样式里的 `display:flex` 会盖过浏览器对 `dialog:not([open])` 的 `display:none`，
  结果关掉的面板还按普通元素排版、被聊天窗口盖住。`style.css` 里默认 `display:none`，只在 `[open]` 时 `flex`。
- **不要直接用 `<input type="file">` 当按钮**：酒馆全局样式把它设成 `display:none`，手机上什么都看不到。
  用自绘按钮调 `input.click()`，input 自己隐藏。

## 8. 扩展点

- 新的导入冲突策略：`service/import.js` 的 `DEFAULT_ACTIONS` 与 `plan()` 的 `options`
- 新页签：`ui/panel.js` 的 `TABS` + `index.js` 里 `views` 注册
- 新的宿主能力：只加在 `src/st/host.js`
- 新的 ILB 能力：只加在 `src/ilb/client.js`

## 9. 文档与测试入口

| 想了解 | 看哪里 |
| --- | --- |
| 怎么用 | README.md |
| 为什么这么设计 | docs/decisions/ |
| 需求与审计 | docs/开发前审计与需求理解.md、docs/ILB接口需求-角色卡关联与运行时.md |
| 这次改了什么 | CHANGELOG.md |
| 真机测试 | tests/live/README.md |
