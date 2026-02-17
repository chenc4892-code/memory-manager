# MMPEA 记忆管理 更新日志

## v5.3.0 (2026-02-17)

### New Features
- **消息级提取标记系统** (`extractedMsgDates`): 每条消息提取成功后用 `send_date` 打标，精确追踪哪些消息已提取、哪些遗漏。替代原来仅靠水位线 (`lastExtractedMessageId`) 的粗略判断
- **强制提取重写**: 强制提取不再走水位线逻辑，而是扫描全部聊天消息（包括已隐藏的），找出所有未打标的消息进行分批提取。初始化失败遗漏的消息也能被捞回
- **强制提取自动重试**: 失败批次会自动重试一轮，与初始化的重试逻辑对齐
- **强制提取进度条**: 复用初始化进度 UI，显示分批进度和重试状态
- **精确待处理计数**: "未处理消息"数量改为基于 `extractedMsgDates` 精确统计，包含已隐藏的消息
- **初始化范围选择**: 初始化弹窗显示全部消息总数（含隐藏），用户可指定提取的消息范围

### Bug Fixes
- **iOS 召回面板变扁**: Popover API 的浏览器默认样式 (`height: fit-content`) 导致面板在 iOS Safari 上塌缩。修复：在 `[popover]` 重置中增加 `height: auto`、`min-height: 200px`、`overflow: visible`
- **隐藏消息不可见**: `hideChatMessageRange` 将消息标记为 `is_system=true`，导致初始化/强制提取/计数用 `!is_system` 过滤时排除了这些消息。修复：在初始化、强制提取和计数中改用 `m.mes` 作为过滤条件，不再排除已隐藏的消息
- **旧数据兼容**: 旧数据 `extractedMsgDates` 从空开始，不做假设性迁移。待处理计数在无标记时 fallback 到水位线逻辑。用户可通过强制提取重新扫描全部消息补上遗漏

---

## v5.2.4 (2026-02-17)

### Bug Fixes
- **初始化重试按钮不显示**: `updateInitProgressUI` 中重试按钮的渲染条件要求 `!initializationInProgress`，但调用时该标志仍为 `true`（在 `finally` 中才重置），导致按钮永远不会出现。修复：在 `finally` 块中重置标志后重新渲染 UI
- **强制提取无反馈**: 点击强制提取后没有任何提示或进度显示，用户不知道请求已发出会反复点击。修复：添加开始/完成/失败的 toast 提示，以及各种边界情况的反馈（正在提取中、无聊天记录、消息发送中）
- **强制压缩虚假成功**: 压缩条件不满足时实际没有执行任何操作，但仍显示"压缩完成"。修复：`runCompressionCycle` 返回实际工作量统计，根据结果显示具体信息（"3 页压缩，2 页归档"）或"当前没有需要压缩的内容"

---

## v5.2.2 (2026-02-17)

### Bug Fixes
- **NPC/物品消失修复**: 提取结果改用合并逻辑（merge），不再整体替换角色和物品数组。已有NPC不会因为某次提取未输出而丢失
- **重投骰记忆污染修复**: 新增提取缓冲区，autoHide开启时跳过最近N-2条消息，避免用户重投骰前旧回复被写入记忆
- **悬浮球/召回面板被主题遮挡修复**（三轮迭代）:
  - 第一轮: z-index 提升至 99990/99991 + CSS `!important` → 部分主题仍被挡
  - 第二轮: JS 内联 `setProperty(..., 'important')` → 部分主题仍被挡
  - 第三轮（最终方案）: **Popover API** (`popover="manual"`) 将面板渲染到浏览器 top layer，彻底免疫所有 z-index/stacking context 问题
- **面板样式**: 改回半透明白底 + 黑字 + 磨砂玻璃效果，不再依赖主题CSS变量

### New Features
- **知识卡片式布局**: 已知角色态度、NPC档案、物品信息改为卡片式展示，显示全部字段（外貌/性格/态度/状态等）
- **YYMMDD日期标记**: 故事页新增 `date` 字段，提取时从消息状态栏/时间描述中提取具体日期（格式如 "251017"）
- **初始化批次重试**: 初始化失败的批次会被记录，提供"重试失败批次"按钮
- **强制提取自动分批**: 待处理消息超过25条时自动按每批20条分批提取，避免单次请求过大导致失败

---

## 技术笔记：SillyTavern 扩展中浮动UI的渲染层级问题

### 问题
扩展创建的 `position: fixed` 浮动元素（悬浮球、弹出面板）被某些主题遮挡，用户看不到或无法点击。

### 踩过的坑（从低到高）

#### 1. 提高 z-index（无效）
```css
.my-panel { z-index: 99991; }
```
**为什么不够**: SillyTavern 的弹窗系统用原生 `<dialog>` + `.showModal()`，dialog 进入浏览器的 **top layer**，这是一个独立于 z-index 的渲染层。任何 z-index 值（哪怕是 999999999）都在 top layer 之下。

#### 2. CSS `!important`（无效）
```css
.my-panel { z-index: 99991 !important; display: flex !important; }
```
**为什么不够**: 主题的 `custom_css` 如果用了更高特异性的选择器 + `!important`，会覆盖扩展的样式表规则。

#### 3. JS 内联 `setProperty(..., 'important')`（部分有效）
```javascript
el.style.setProperty('display', 'flex', 'important');
el.style.setProperty('z-index', '99991', 'important');
```
**进步**: 内联 `!important` 是 CSS 优先级最高的，任何样式表规则都无法覆盖。
**仍然不够**: 解决了 CSS 覆盖问题，但没解决 top layer 问题。如果 ST 的 dialog 系统或其他 top layer 元素在前，面板仍然被挡。

#### 4. Popover API（最终方案 ✓）
```javascript
panel.setAttribute('popover', 'manual');
// 显示时:
panel.showPopover();  // 进入 top layer
panel.style.setProperty('display', 'flex', 'important');
// 隐藏时:
panel.hidePopover();  // 离开 top layer
panel.style.setProperty('display', 'none', 'important');
```
**为什么有效**: `popover="manual"` + `.showPopover()` 将元素放入浏览器的 **top layer**，与 `<dialog>` 同级。Top layer 中最后加入的元素在最上面。不需要 z-index，不受任何 CSS 影响。

### CSS 优先级速查（从低到高）

```
普通样式表规则          →  可被更高特异性覆盖
样式表 !important       →  可被内联 !important 覆盖
内联 style="..."        →  可被内联 !important 覆盖
内联 setProperty+important →  CSS 层面的最高优先级
──────────────────────────────────────────────
top layer (dialog/popover)  →  独立渲染层，z-index 无关
```

### 浮动UI最佳实践（SillyTavern 扩展）

1. **面板/弹窗**: 用 `popover="manual"` + `showPopover()`/`hidePopover()`
2. **定位**: 仍然用 `position: fixed` + 内联 `setProperty` 设置 top/left/right/bottom
3. **样式**: 不要依赖主题 CSS 变量（`--SmartThemeXxx`），用硬编码颜色，因为面板在 top layer 里跟主题是隔离的
4. **降级**: 检测 `typeof HTMLElement.prototype.showPopover === 'function'`，不支持时回退到 z-index 方案
5. **Popover 默认样式重置**: 浏览器给 `[popover]` 元素有默认样式（margin/padding/border/inset），需要重置：
   ```css
   .my-panel[popover] { margin: 0; padding: 0; inset: auto; }
   ```

### 浏览器兼容性

Popover API 支持: Chrome 114+, Edge 114+, Firefox 125+, Safari 17+ (2023年底起全面支持)

---

## v5.2.1

### Features
- 授权码系统（SHA-256哈希验证）
- 已知角色/NPC/物品的编辑和删除功能
- crypto.subtle 降级兼容修复

## v5.0.0

### Major Release
- PageIndex + Embedding + MemGPT Agent 架构
- 独立存档系统（跨聊天记忆持久化）
- Embedding 向量语义检索
- 语义分类标签系统
- 增强记忆代理（6工具集 + 两轮工具调用）
- 统一检索流（Embedding预筛选 → Agent检索 → 关键词降级）
- 副API支持
- 渐进式压缩（时间线/故事页/归档）
