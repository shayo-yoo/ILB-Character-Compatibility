# CHANGELOG

## 0.1.0 — 2026-11-02

**一句话**：角色卡、它要用的 ILB 世界书、以及两者的关联，现在可以打成一个 `.ilbchar.json` 带走并原样导回来。

### 接口 / 新增

- 包格式 `ilb-character-package`（format_version 1）：角色卡用酒馆原生导出的 V2 JSON 原样保存；书用 `ILB.api.worldbooks.exportBook` 完整保存；关联只引用包内 `ref`（ADR-0002）
- `ILBCC` 全局对象：`open(tab)` / `close()` / `refresh()` / `state()` / `app`（探针与排障用）
- 三个页签：关联（增删改、三态策略）、导入导出（勾书导出、预览后导入）、诊断（连接、上下文、运行态、历史）

### 界面

- 扩展设置页新增「ILB 角色卡兼容」卡片，不改酒馆原生按钮
- 导入前必须经过「检查并预览」：逐本显示冲突与默认处理方式
- 结果逐条列出成功/跳过/复用/失败，部分成功不会显示成整体成功

### 兼容性

- 依赖 SillyTavern 1.19.x 的 `/api/characters/{get,export,import,delete}`
- 依赖 ILB 0.28.0+（`ILB.api` 1.4，caps：`bindings` / `runtime` / `worldbooks`）
- 不读 ILB 内部数据、不写角色卡 `data.extensions.world`、不改原生导入导出

### 验证

- 单元测试 `node --test tests/*.test.mjs`：**50/50 通过**（包格式、身份、服务编排、ILB 客户端、linkcheck）
- 真机 `node tests/live/st-v01-check.mjs`（ST 1.19.0 + 无头 Chrome 156，真实角色卡）：**23 项全 true**
  - 扩展加载、卡片挂载、三个页签渲染
  - 关联新增后 ILB 判定真的变成 `binding-on`
  - 导出包结构正确（角色卡 + 书 + 关联）
  - 自往返导入：书冲突识别为同 id、按 skip 处理、新建角色卡、关联指向正确
  - 清理：探针新增的卡、书、关联全部删除

### 未验证

- 手机真机（窄屏布局只做了代码适配，没在手机上实测）
- 群聊场景（群聊里没有"当前角色"，关联页只做提示）
- 酒馆版本差异（只测了 1.19.0；更早版本可能没有 `/api/characters/export`）
- 超大包（上百本书）在低配设备上的界面表现
