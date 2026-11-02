# 接口需求：角色卡关联（bindings）与运行时状态

> 提出方：ILB Character Compatibility（ILB 的附属扩展）
> 接收方：ILB 本体
> 目标版本：ILB 0.28.x / `ILB.api` **1.4**（具体版本号由 ILB 决定）
> 关联文档：`docs/开发前审计与需求理解.md`、ILB `docs/UI扩展接口.md`、ILB `docs/开发规划-现阶段.md:691`
> 状态：待 ILB 确认。本文只写**需求与契约**，不规定内部实现。

---

## 0. 摘要

本扩展要做两件 ILB 目前不允许外部扩展做的事：

1. 保存「角色卡 ↔ ILB 世界书」的多对多关联；
2. 让这些关联**真正参与** ILB 每次生成的启用判定。

这两件事都发生在 ILB 的运行时里，扩展无法替代。因此请 ILB 增加下列能力：

| 优先级 | 能力 | 为什么必须 |
|---|---|---|
| P0 | `bindings` 的增删查改 | 关联总得有地方存，而且必须由 ILB 存（扩展不能写 ILB 存档） |
| P0 | `resolveBooks` 接入 bindings | 关联要影响「这次生成启用哪些书」，不是只做 UI 展示 |
| P1 | `runtime.preview()` / `runtime.status()` | 扩展和用户要能看到「实际启用了什么、为什么」 |
| P1 | `worldbooks.deleteBook()` | 导入到一半失败时，要能清理刚建出来的书 |
| P2 | `importBook` 校验 `schema_version` | 包可能来自旧版本，不能静默接受 |
| P2 | 备份导出/导入带 `bindings` | 否则用户做一次整份备份，关联全丢 |

**约束：全部只增不改。** 没有 bindings 时，ILB 的行为必须和 1.3 完全一致（逐字节回归）。

---

## 1. 背景

### 1.1 目标

用户希望：

- 角色卡 A 关联 ILB 书 X、Y；
- 角色卡 B 关联 X、Z；
- 切到 A 时，X、Y 参与生成；切到 B 时，X、Z 参与；
- 把「A + X + Y + 关联」打成一个 `.ilbchar.json`，换台机器导入后原样恢复。

### 1.2 为什么扩展自己做不到

1. **注入发生在 ILB 的 pipeline 里。** 扩展没有 prompt 注入权，也不允许 import ILB 内部模块（两个扩展没有稳定加载顺序，见 ILB `docs/交接-UI扩展.md`）。
2. **扩展不能写 ILB 存档。** `extension_settings.independent_lorebook` 的 owner 是 ILB；`docs/UI扩展接口.md` 明确写了「没有写权限委托」。
3. **`activationProviders` 目前不对外。** 即便开放注册，关联仍然需要一个持久化位置；而这个位置按需求必须是 ILB 的公开 API。

所以：**要么 ILB 提供 bindings，要么本扩展只能退化成「只打包、不自动启停」。**

### 1.3 现状差距（ILB 0.27.0 / API 1.3）

| 编号 | 差距 | 证据 |
|---|---|---|
| G1 | 没有角色 ↔ 书的关联存储/查询 | `runtime/api.js` 无 `bindings`；存档无该键 |
| G2 | 没有运行时状态/预览 | `worldbooks.list` 的 `enabled` 恒为 true（`runtime/api.js` 的 `briefBook`），不是运行态 |
| G3 | 删除书只有内部函数，没有 API | `adapters/repository.js` 的 `deleteBook` 未暴露 |
| G4 | `importBook` 不校验 `schema_version` | `adapters/repository.js` 直接 `normalizeBook` |
| G5 | 整份备份不包含 bindings | `adapters/repository.js` 的 `exportAll/importAll` 按白名单复制 |
| G6 | 角色重命名后没有关联迁移 | `CHARACTER_RENAMED` 只被事件适配层用来刷新缓存 |

---

## 2. 设计约束

1. **只增不改**：现有方法签名、返回形状、错误码不变；`API_VERSION` 升到 1.4，`caps` 增加新项。
2. **零关联零回归**：`bindings` 为空时，`resolveBooks` 对每一本书的输出必须与 1.3 完全一致（规则名、reason、启用集合）。
3. **数据归属**：关联存在 ILB 存档的 `bindings` 键，随 ILB 整份备份/恢复；扩展不存副本。
4. **宿主边界**：读 ST 的代码仍然只在 `adapters/`；`core/` 保持纯函数。
5. **身份键**：角色用 `avatar`（文件名）标识，**不用名字**。名字只做显示缓存。
6. **性能**：`preview` 在 200 本书 / 2000 条关联下 < 10ms；每次生成多一次 O(bindings) 过滤，可忽略。
7. **安全**：关联来自外部输入，必须校验长度和类型；`avatar` 只作为不透明键，不拼路径。
8. **不引入 UI 依赖**：bindings 的核心逻辑不能依赖面板是否打开。

---

## 3. 数据模型

### 3.1 存储位置

`extension_settings.independent_lorebook.bindings`，数组。与 `logicGroups/logics` 一样是**可选键**：

- 老存档没有该键 → 读时补 `[]`，不报错、不弹迁移提示；
- `DATA_VERSION` **不需要**因此 +1（没有破坏性变化）；
- `bucket()` 初始化、`emptyState()` 都要带上 `bindings: []`。

### 3.2 记录

```js
{
  id: 'bind-<base36 时间>-<4 位随机>',   // 全局唯一，稳定，不随角色/书改名变化
  character: {
    avatar: 'A.png',                    // 必填，键；不存路径，不做大小写归一
    name: 'A'                           // 可选，显示缓存；改名时更新
  },
  bookId: 'book-abc',                   // 必填，必须指向现存的书
  policy: 'auto',                       // 'auto' | 'on' | 'off'，默认 'auto'
  note: '',                             // 可选，纯文本，≤ 500 字
  createdAt: 0,                         // 毫秒时间戳
  updatedAt: 0,
  orphanedAt: null                      // 角色被删除后写入时间戳；不自动删记录
}
```

### 3.3 不变式

1. `(character.avatar, bookId)` 唯一。重复创建返回 `CONFLICT`，并在 `error.id` 里带已有记录 id。
2. `bookId` 必须存在；不存在返回 `NOT_FOUND`。
3. `policy` 只接受三个值；非法值返回 `BAD_PAYLOAD`。
4. `character.avatar`：trim 后非空、≤ 512 字符、无控制字符；**原样存储**（大小写、扩展名都不改）。
5. `name` ≤ 200 字符；`note` ≤ 500 字符；超出截断（不是报错），并在返回值里带 `truncated: ['note']` 之类的提示（可选）。
6. 单存档最多 5000 条；超过返回 `BAD_PAYLOAD`，message 说明上限。
7. 读取时逐条 `normalizeBinding`：缺 `id` 补、缺 `avatar`/`bookId` 的整条丢弃并 `console.warn`，**不抛异常**。
8. 未知字段保留（向前兼容）。

### 3.4 生命周期

| 事件 | 处理 |
|---|---|
| 创建关联 | `bindings.create`；写 `createdAt/updatedAt` |
| 改策略/备注 | `bindings.update`；只改 `policy/note/updatedAt` |
| 删关联 | `bindings.remove`（幂等） |
| 角色重命名 | ILB 在 `CHARACTER_RENAMED` 里调 `renameCharacter(old,new)`：批量改 `avatar/name`；若新 avatar 已有同书关联，保留 `updatedAt` 较新的一条，另一条删除，返回 `merged` 数 |
| 角色删除 | `CHARACTER_DELETED`：给该 avatar 的所有关联写 `orphanedAt`，**不删除**；UI 可提示「角色已不存在，可清理」 |
| 角色复制 | `CHARACTER_DUPLICATED`：**不复制关联**（避免误扩散） |
| 角色编辑 | `CHARACTER_EDITED`：avatar 不变、名字变了 → 更新 `character.name` 缓存 |
| 删除书 | 仓库层 `deleteBook` 同步删除该书全部关联（见 §4.3） |
| 整份恢复 | `importAll` 带 `bindings` 时整体替换；不带时保留现有（见 §4.5） |

---

## 4. API 契约

### 4.0 通用约定

- 全部**同步返回**（与 `worldbooks.list/get` 一致），不抛异常。
- 成功：`{ ok: true, ... }`；失败：`{ ok: false, error: { code, message, ...extra } }`。
- 错误码沿用：`NOT_FOUND / CONFLICT / BAD_PAYLOAD / NOT_SUPPORTED`。
- 所有方法都要有 JSDoc（参数、返回、错误码），与现有 `api.js` 风格一致。

### 4.1 `api.bindings`

#### `list(opts?)`

```js
api.bindings.list({ character: 'A.png', bookId: 'book-abc', includeOrphaned: true })
→ { ok: true, bindings: [Binding], total: 3 }
```

- 无过滤 → 全部。
- `character` 按 `character.avatar` 精确匹配。
- `bookId` 精确匹配。
- `includeOrphaned` 默认 `true`；为 `false` 时过滤 `orphanedAt != null`。
- 排序：`createdAt` 升序，稳定。

#### `get(id)`

```js
→ { ok: true, binding: Binding } | { ok: false, error: { code: 'NOT_FOUND', message } }
```

#### `create(input)`

```js
api.bindings.create({
  character: { avatar: 'A.png', name: 'A' },
  bookId: 'book-abc',
  policy: 'auto',        // 可选
  note: ''               // 可选
})
→ { ok: true, binding: Binding }
```

错误：

- `BAD_PAYLOAD`：缺 avatar / 缺 bookId / policy 非法 / 超过上限。
- `NOT_FOUND`：书不存在（`error.field = 'bookId'`）。
- `CONFLICT`：同 `(avatar, bookId)` 已存在，`error.id` 为已有记录 id。

#### `update(id, patch)`

```js
api.bindings.update('bind-...', { policy: 'off', note: '这张卡不用这本书' })
→ { ok: true, binding: Binding }
```

- 只接受 `policy` / `note`；`character` / `bookId` 不可改（要改就删了重建）。
- `NOT_FOUND` / `BAD_PAYLOAD` 同上。

#### `remove(id)`

```js
→ { ok: true, removed: true }    // 不存在时 removed:false，幂等，不报错
```

#### `removeForCharacter(avatar)`

```js
→ { ok: true, removed: 2 }
```

用于「清理某角色的全部关联」；幂等。

#### `renameCharacter(oldAvatar, newAvatar, opts?)`

```js
api.bindings.renameCharacter('A.png', 'A (2).png', { name: 'A (2)' })
→ { ok: true, updated: 2, merged: 0 }
```

- 幂等；`oldAvatar === newAvatar` 时只更新 `name`。
- 合并规则见 §3.4。
- 也由 ILB 自己在 `CHARACTER_RENAMED` 事件里调用，外部可重复调用。

#### `purgeOrphans()`（可选，P1）

```js
→ { ok: true, removed: 3 }
```

删除所有 `orphanedAt != null` 的记录，供扩展的「清理失效关联」按钮使用。

### 4.2 `api.runtime`

#### `preview()`

```js
api.runtime.preview()
→ {
  ok: true,
  at: 1760000000000,
  chatId: 'chat-1',
  character: { avatar: 'A.png', name: 'A' } | null,
  group: { id: 'g1', members: ['A.png', 'B.png'] } | null,
  books: [
    {
      id: 'book-abc',
      name: '世界观',
      enabled: true,
      rule: 'binding-on',
      reason: '当前角色「A」关联了这本书，并设为强制启用',
      binding: { id: 'bind-...', avatar: 'A.png', policy: 'on' } | null
    }
  ],
  activeBooks: ['book-abc']
}
```

要求：

- **纯函数语义**：不跑逻辑、不注入、不写状态、不发事件。
- 当前上下文的构造必须与 `pipeline.run` **共用同一段代码**（建议抽 `buildResolveInput()`），禁止复制两份，否则 preview 和真实运行会漂移。
- 读不到 hostContext 时：`character: null`，按 1.3 的老路解析，不报错。
- `books` 要覆盖全部书（含停用的），方便扩展做「为什么没启用」。
- `binding` 字段只在该书被关联规则命中时出现。

#### `status()`

```js
api.runtime.status()
→ { ok: true, ran: true,  at: 1760000000000, chatId: 'chat-1', character: {...}, books: [...], activeBooks: [...] }
→ { ok: true, ran: false, at: 0, error: null }
```

- 包装现有 `pipeline.describeLastRun()`，只做形状转换和补 `ok`。
- `ran: false` 表示本会话还没跑过生成（刷新页面后为 false，不持久化）。
- **不得包含**聊天内容、提示词、条目正文；只包含书名、id、enabled/rule/reason/binding。
- `error` 为字符串或 null，来自 `lastError`。

### 4.3 `api.worldbooks.deleteBook(id, opts?)`

```js
api.worldbooks.deleteBook('book-abc')
→ { ok: false, error: { code: 'CONFLICT', message: '还有 2 个角色关联这本书', boundCount: 2 } }

api.worldbooks.deleteBook('book-abc', { cascade: true })
→ { ok: true, id: 'book-abc', removedBindings: 2 }
```

- 默认**拒绝**有绑定的删除，避免外部扩展误删。
- `cascade: true` 时删书 + 删关联，返回删除的关联数。
- 不存在的书：`NOT_FOUND`。
- **ILB 自己的书架删除**（`ui/view-shelf.js` 里的 `repository.deleteBook` 路径）也要清关联：删除确认框里加一句「还会解除 N 个角色关联」，确认后 cascade。不能只在 API 层清理。

### 4.4 `worldbooks.importBook` 的版本校验（P2）

- `schema_version > DATA_VERSION` → `NOT_SUPPORTED`，message 说明「这本书来自更新的 ILB」。
- `schema_version < DATA_VERSION` → 走现有迁移逻辑（可临时包成 `{version: 1, books:[book]}` 调 `migrateBucket` 取 `books[0]`）；迁移失败 → `BAD_PAYLOAD`。
- 不得再静默 `normalizeBook` 后接受。
- `importMany` 对每本执行同样校验，失败进 `failed[]`，不影响其他本。

### 4.5 整份备份 / 恢复

- `exportAll()` 增加 `bindings`（规范化后的深拷贝）。
- `importAll(blob)`：
  - `Array.isArray(source.bindings)` → 替换现有；
  - 字段不存在 → **保留现有**（与 `ui/settings` 等字段的现有处理一致），并记一条 `lastImportNote` 之类的提示（可选）。
- `migrateBucket` 无需改（`clone` 会保留未知键），但要加测试防止未来白名单化。

### 4.6 能力声明

```js
API_VERSION = '1.4'
API_CAPS += ['bindings', 'runtime', 'bookDelete']
```

- 扩展用 `caps` 判断，不比较版本字符串。
- `api.describe()` 的 `methods/worldbooks` 列表同步补上新方法。
- `ilb:ready` 事件 detail 里的 `caps` 自动带上（现有代码已展开 `API_CAPS`）。

---

## 5. 解析语义

### 5.1 优先级（必须）

按顺序，第一条命中即生效：

| # | 条件 | enabled | rule |
|---|---|---|---|
| 1 | 书 `activation.override = 'off'` | false | `force-off` |
| 2 | 书 `activation.override = 'on'` | true | `force-on` |
| 3 | 当前角色的关联投票 = `off` | false | `binding-off` |
| 4 | 当前角色的关联投票 = `on` | true | `binding-on` |
| 5 | 书 `strategy = 'always'` | true | `always` |
| 6 | 书 `strategy = 'auto'` 且（投票 = `auto` 或原生匹配） | true | `binding` / `auto` |
| 7 | 书 `strategy = 'manual'` | `manualOn` | `manual` |
| 8 | 其余 | false | — |

投票计算：

```text
avatars = group.id ? group.members.map(m => m.avatar) : [character.avatar]
relevant = bindings.filter(b => b.bookId === book.book_id
                             && avatars.includes(b.character.avatar)
                             && !b.orphanedAt)
无 relevant        → null
任一 policy='on'   → 'on'
否则任一 'auto'    → 'auto'
否则（全 'off'）   → 'off'
```

> 注意：第 3 条把「关联强制停用」放在「书始终启用」之前。这是**建议值**，理由是三态覆盖是用户对这张卡的显式决定，应当压过书级默认。如果 ILB 认为 `always` 应该更高，请在第 10 节明确，扩展会按 ILB 的最终顺序调整文案。

### 5.2 群聊

- `hostContext.group.members` 已经排除了 `disabled_members`（`adapters/sillytavern-context.js`），直接用。
- 多人对同一本书有不同 policy：`on` > `auto` > `off`（即只要有一人 `on` 就启用；全员 `off` 才停）。
- 成员卡找不到 avatar：跳过该成员，不报错。
- `group.id` 存在时，**不要**用 `character.avatar`（群聊时它通常是空的或占位）。

### 5.3 宿主联动总开关

- `settings.hostLinkEnabled = false` 时：**原生来源匹配关闭，但 bindings 仍然生效**。理由：bindings 是 ILB 自己的关联，不是原生世界书联动；用户关掉联动不代表放弃角色关联。
- 实现上，`resolveBooks` 目前在第 142 行把 `auto` 直接退回 `legacyCharacterMode`。bindings 的投票必须在这个回退**之前**计算并生效。
- `hostContext.contextAvailable !== true`（读不到 ST 上下文）时：没有 avatar，投票为 `null`，保持 1.3 的 `auto-unknown` 行为。

### 5.4 规则名与文案

- 新增 `binding-on` / `binding-off` / `binding`（auto 命中）。
- `reason` 必须是人话，带角色名：
  - `binding-on`：`当前角色「A」关联了这本书，并设为强制启用`
  - `binding-off`：`当前角色「A」把这本书设为强制停用`
  - `binding`：`当前角色「A」关联了这本书`
- 群聊时用 `群成员「A」…`。
- 可选：在 `details[bookId]` 里加 `bindings: [{id, avatar, name, policy}]`，方便诊断页显示「因为哪条关联」。

### 5.5 空关联回归

`bindings = []` 时，对 1.3 的全部现有测试逐条比对：`activeBooks`、每本书的 `enabled/rule/reason` 必须一致。这是发布门槛。

---

## 6. 事件

ILB 已经监听 ST 事件（`adapters/sillytavern-events.js`，150ms 合并）。新增：

| 事件 | 动作 |
|---|---|
| `CHARACTER_RENAMED(old,new)` | `renameCharacter`，然后 `notify('characters')` |
| `CHARACTER_DELETED({character})` | 标记 `orphanedAt`，`notify` |
| `CHARACTER_EDITED({detail})` | avatar 不变时更新 `name` 缓存 |
| `CHARACTER_DUPLICATED` | 不处理（显式） |

不需要监听聊天/Persona 切换：解析发生在每次生成前，实时读上下文。

---

## 7. 兼容与发布

- 旧扩展（1.3 消费方）在 1.4 上不受影响；旧 ILB（1.3）上，新扩展通过 `caps` 缺失提示「请升级 ILB」。
- `bindings` 空时零行为变化。
- 发布物：
  - 代码 + 单测；
  - `docs/UI扩展接口.md` 增加 bindings/runtime 章节；
  - `docs/世界书接口.md` 增加 deleteBook、importBook 校验；
  - `docs/开发规划-现阶段.md` 把 P1 标成已完成；
  - `CHANGELOG.md` 一条（按 ILB 现有格式：一句话 / 接口 / 验证 / 未验证）；
  - `docs/决策记录.md` 新增 ADR：为什么 bindings 由 ILB 存、为什么用 avatar 不用名字、为什么空关联零回归。

---

## 8. 验收清单

ILB 侧自测（必须全部通过）：

- [ ] `bindings.create` 正常路径 + 重复 `CONFLICT` + 书不存在 `NOT_FOUND` + 非法 policy `BAD_PAYLOAD`
- [ ] `bindings.list` 按角色/按书过滤正确；`includeOrphaned` 生效
- [ ] `bindings.update` 只改 policy/note；`updatedAt` 变化
- [ ] `bindings.remove` 幂等
- [ ] `renameCharacter` 迁移 + 冲突合并（同书两条 → 一条）
- [ ] `CHARACTER_DELETED` 后记录仍在、`orphaned` 为 true、运行时不参与
- [ ] 解析优先级 8 条各一个用例
- [ ] 群聊三人：on/auto/off 组合 → on 胜出；全员 off → 停
- [ ] `hostLinkEnabled=false` 时 bindings 仍生效
- [ ] `bindings=[]` 时全量回归与 1.3 一致
- [ ] `preview()` 与 `run()` 对同一上下文给出相同的 `activeBooks`
- [ ] `status()` 在未生成时 `ran:false`，生成后字段完整
- [ ] `deleteBook` 无关联直接删；有关联默认 `CONFLICT`；`cascade` 删干净；书架删除也清关联
- [ ] `importBook` 拒绝 `schema_version=3`，迁移 `schema_version=1`
- [ ] 整份导出 → 导入，`bindings` 数量与内容一致；旧备份（无该键）导入不丢现有 bindings
- [ ] 单测 + `linkcheck` + 一次真机 A/B 切换（`tests/live/` 新增一条）

---

## 9. 非目标

- 不做角色卡管理、不做包格式、不做本扩展的 UI。
- 不自动根据原生世界书名创建关联。
- 不修改原生世界书绑定，不写 `character.data.extensions.world`。
- 不打包聊天记录、变量、运行状态。
- 不要求 ILB 书架展示关联角色（可选加分项，不是验收项）。

---

## 10. 待 ILB 确认

1. **优先级**：第 3 条「关联强制停用」压过第 5 条「书始终启用」，可以吗？如果不行，请给出最终顺序。
2. **deleteBook 默认**：有绑定就拒绝（需显式 `cascade`），还是默认级联？我倾向拒绝，防误删。
3. **status 持久化**：`ran:false` 表示本会话没跑过，刷新即清空。是否需要把「最近一次」写进存档？我倾向不写（存档会变大且容易过期）。
4. **bindings 上限**：5000 条够不够？如果用户可能更多，请给一个上限。
5. **书架 UI**：删除确认里加「解除 N 个角色关联」的提示，是否接受？

---

## 11. 最小可用集

如果一次做不完，按这个顺序切：

1. **MVP（必须）**：`bindings` CRUD + `resolveBooks` 接入 + `preview`。
2. **P1**：`status` + `deleteBook`。
3. **P2**：`importBook` 校验 + 备份往返。

只做 MVP 也能让本扩展的「关联 + 自动启停」跑起来；P1/P2 影响的是诊断、清理和迁移体验。

---

## 附录 A：扩展侧会这样用

```js
const api = globalThis.ILB?.api ?? (globalThis.ILB_READY ? await globalThis.ILB_READY : null);
await api?.ready;
if (!api?.caps?.includes('bindings')) {
  // 提示：需要 ILB 0.28+（接口 1.4），当前版本不支持角色关联
  return;
}

// 当前角色关联了哪些书
const mine = api.bindings.list({ character: current.avatar });

// 关联一本
api.bindings.create({
  character: { avatar: current.avatar, name: current.name },
  bookId: 'book-abc',
  policy: 'auto',
});

// 这次生成会启用哪些书（UI 展示用，不触发生成）
const view = api.runtime.preview();

// 上一次生成实际启用了哪些书（诊断用）
const last = api.runtime.status();
```

## 附录 B：最小测试数据

```js
books: [
  { book_id: 'b1', name: '共享', activation: { strategy: 'auto', override: 'auto' } },
  { book_id: 'b2', name: 'A 专属', activation: { strategy: 'auto', override: 'auto' } },
  { book_id: 'b3', name: 'B 专属', activation: { strategy: 'auto', override: 'auto' } },
]
bindings: [
  { character: { avatar: 'A.png', name: 'A' }, bookId: 'b1', policy: 'auto' },
  { character: { avatar: 'A.png', name: 'A' }, bookId: 'b2', policy: 'auto' },
  { character: { avatar: 'B.png', name: 'B' }, bookId: 'b1', policy: 'off'  },
  { character: { avatar: 'B.png', name: 'B' }, bookId: 'b3', policy: 'on'   },
]
```

期望：

- 当前 A：`b1`、`b2` 启用，`b3` 停用。
- 当前 B：`b1` 停用（B 显式 off），`b3` 启用，`b2` 停用。
- 群聊 A+B：`b1` 启用（A auto 胜 B off），`b2` 启用，`b3` 启用。
