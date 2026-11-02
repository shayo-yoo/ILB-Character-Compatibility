# 真机验收（tests/live）

这些脚本不属于 `node --test`：它们需要一个已经跑起来的 SillyTavern，和一个带
`--remote-debugging-port=9222` 的 Chrome。脚本会新开一个标签页，跑完自己关掉。

## 准备

```powershell
# 1. 把扩展装到酒馆
#    整个目录复制到 SillyTavern/public/scripts/extensions/third-party/ILB-Character-Compatibility/

# 2. 酒馆与 Chrome 都开着（Chrome 需要调试端口）

# 3. 跑
$env:ST_DIR='D:\1\APP\SillyTavern'
node tests/live/st-v01-check.mjs
```

输出最后一行是 `✅ v0.1 角色卡兼容检查通过` 才算过；任何一项 `✗` 都会以退出码 1 结束。

## st-v01-check.mjs —— 0.1.0

覆盖：

1. 页面里出现 `globalThis.ILBCC`，版本正确，ILB 连接为 1.4
2. 设置页卡片挂上；面板能打开、三个页签都在、关联页有内容
3. 新标签页默认停在角色列表 → 探针会像用户一样点开第一张角色卡，确认拿到 avatar
4. 造一本探针书（`probe-ilbcc-b1`，经 ILB 公开接口），加一条 `policy:'on'` 关联：
   - 关联列表里能看到
   - ILB 的 `runtime.preview()` 对这本书给出 `enabled:true, rule:'binding-on'`（证明不是"只画在界面上"）
5. 导出：结构正确（format/角色卡/书/关联各一条）
6. 自往返导入：书被识别为同 id 冲突 → skip；角色卡新建；关联指向正确的书且策略保留
7. 诊断页能渲染出 ILB/关联结论
8. **清理**：删掉探针新建的关联、角色卡、书

## 注意

- 探针会在真实酒馆里新建一张角色卡（名字来自包里的卡），跑完通过
  `POST /api/characters/delete` 删除；如果中途崩了，请在酒馆里手动删掉多出来的那张卡。
- 探针只清理自己建的 `probe-ilbcc-*` 书与关联，不碰用户数据。
- 截了一张关联页的图：`last-ilbcc.png`（每次运行覆盖）。
