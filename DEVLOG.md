# MMPEA 记忆管理 — 开发日志

## v3: 基础框架 (Story Bible)

实现了：
- 两层架构：故事圣经（全量注入）+ 记忆条目（关键词匹配检索）
- 自动提取、副API支持、批量初始化、自动隐藏、JSON容错

问题：故事圣经全量注入，token随剧情线性增长无上限。本质上和手动 Plot Summary 没有根本区别。

---

## v4: PageIndex 架构

### 核心变化

从"注入一切"变成"索引 + 按需检索 + 压缩"：

```
v3: Story Bible (全量注入, 无上限) + Memories (关键词匹配)
v4: Story Index (~400-600 tokens, 有上限) + Pages (工具调用检索) + 压缩
```

### 架构设计

- **Layer 1 - Story Index**: 始终注入，只有时间线+物品（角色移出索引）
- **Layer 2 - Story Pages**: 副API通过 function calling 选页面
- **Layer 3 - Character Dossiers**: 副API通过 function calling 选角色
- **渐进压缩**: L0(详细) → L1(摘要) → L2(归档删除)
- **时间线压缩**: 超过20行自动合并旧条目
- **数据迁移**: v1→v2 自动迁移

---

## v5: Embedding + MemGPT Agent

### Session 6-8: 架构升级

#### 独立存档系统

解决"切换聊天=失忆"：
- 记忆通过 `/api/files/upload` 保存为独立JSON文件
- 存档索引在 `extension_settings` 中维护
- 支持多槽位（主线/IF线/分支）
- 切换聊天时自动检测并提示加载同角色存档
- 提取后自动保存

#### 语义分类标签

每个故事页自动标注 1-3 个分类（emotional/relationship/intimate/promise/conflict/discovery/turning_point/daily），用于分类检索和 UI 展示。

#### 数据结构 v3→v4 迁移

新增 `categories: []` 和 `embeddings: {}` 字段。

### Session 9-12: 检索引擎重写（多次迭代）

#### 迭代过程

1. **初版**: supervisor + reasoning agent + build_memory_chain（两个独立agent + 记忆链工具）
   - 问题：6次API调用（1向量+1supervisor+3agent轮+1主模型），注入的还是散装页面dump

2. **第二版**: 合并supervisor到agent，去掉build_memory_chain
   - 问题：agent输出被丢弃，只提取page_id后dump原文。"又绕远了"

3. **最终版**: 单agent，输出即注入内容
   - Embedding top-K 候选（完整内容）放进 agent 输入
   - Agent 直接写因果链叙事，输出即 [记忆闪回] 注入内容
   - 不需要时输出 SKIP
   - 4个辅助工具（search_by_category/timerange/keyword + read_story_page），仅在候选不够时使用
   - 角色档案通过 embedding 匹配，不需要 agent 工具调用

#### 关键设计决策

| 决策 | 选择 | 原因 |
|------|------|------|
| agent数量 | 1个 | supervisor职能可以合并到agent |
| 注入格式 | agent写的叙事原文 | 比dump散装页面更连贯，LLM更容易理解 |
| 记忆链工具 | 去掉 | agent本身就能做因果推理 |
| 角色检索 | embedding匹配 | 比工具调用更快，不需要额外API轮次 |
| 候选页面 | 完整内容放入prompt | agent需要读内容才能写叙事 |
| 工具调用 | 保留但非必须 | "候选能推理出因果链时，不需要工具调用" |

#### 数据清洗

发现发给agent的 recentText 包含大量元数据（Tidal Memory注释、`<details>`状态块）。修复：
- char消息：只提取 `<content>` 标签内容
- 其他消息：剔除 `<!-- -->` 注释和 `<details>` 块
- 不截断内容

### Session 13: Bug修复 + 压缩系统改进

#### 存档切换bug

`updateBrowserUI()` 从未调用 `refreshSlotListUI()`，导致切换角色后存档列表不刷新。修复：在 `updateBrowserUI` 末尾加 `refreshSlotListUI()`。

#### 自动隐藏触发时机

`hideProcessedMessages()` 只在提取后触发。修复：
- 保持"提取后触发"的主流程（累积N条 → 提取 → hide）
- 新增切换聊天时触发（对已提取消息）
- 新增设置变更时触发

#### think标签清洗

agent（DeepSeek等）输出包含 `<think>...</think>` 推理块。在注入前剔除。

#### 压缩系统拆分

原来一个 `autoCompress` 开关控制所有压缩。拆成3个独立开关：
- **时间线压缩**（默认开）：超过20条自动合并
- **故事页压缩**（默认关）：故事页不占上下文，通常不需要压缩
- **归档日常页**（默认关）：只删 categories 仅含 "daily" 的页面，阈值50页，重要记忆永远不删

---

## v5.3.x: 提取系统重构 + Bug修复

### 消息级追踪系统

原来用水位线（`lastExtractedMessageId`）追踪提取进度，粗糙且不处理删除/隐藏场景。

新增 `extractedMsgDates: { [send_date]: true }` 精确追踪每条消息的提取状态。每条消息成功提取后用 `send_date` 打标。

**状态计数逻辑**（修复前后对比）：
- 修复前：有标记时只用日期计数，忽略水位线 → 混合数据下计数严重偏低
- 修复后：`Math.max(日期计数, 水位线)` → 兼容新旧数据

### 时间线保护

发现问题：LLM 提取本批消息后只输出本批的时间线，`data.timeline = result.timeline` 直接替换导致旧数据全丢。

新增 `mergeTimelines(old, new)` 函数：
- 解析 D-条目范围（处理 "D2-D4" 这类合并条目）
- 判断新时间线是否已完全覆盖旧时间线（新条目数 ≥ 旧的60% 且最大天数 ≥ 旧最大天数）
- 若已覆盖则信任新时间线；否则保留旧时间线中未被新时间线覆盖的条目

### 强制提取保护

发现问题：强制提取后 `autoSaveIfEnabled()` 自动保存，可能将空/少量记忆数据覆盖已有完整存档。

修复策略：
1. 强制提取前自动备份到 `{存档名}-备份`
2. 备份完成后恢复 `activeSlot`（`saveToSlot` 会修改它）
3. 如果当前记忆为空但存档存在，自动加载存档
4. 重新获取 `data` 引用（`loadFromSlot` 替换了 `ctx.chatMetadata.memoryManager` 对象引用）

### sourceDates 追踪

故事页新增 `sourceDates: string[]` 字段，记录生成该页面的批次消息的 `send_date` 列表。

修改 `applyExtractionResult(data, result, sourceDates = [])` 签名，全部6个调用点传入批次 `send_date`。

这是后续"孤立记忆检测"的基础数据。

---

## v5.4.0: UI 大升级 + 工具箱

### 小电视面板 Tab 化

原来面板只有一个页面（召回内容展示）。用户需要更丰富的交互入口。

将面板重构为三 Tab 结构：
- **召回**：保留原有召回内容展示
- **管理指令**：用户自定义 prompt 注入
- **工具箱**：记忆数据操作工具

Tab 懒加载（首次切入才执行 `renderDirectiveTab()` / `renderToolboxTab()`），避免无用渲染。

关闭面板时清空 `rtCommandMessages`（实时指令上下文），防止意外延续对话上下文浪费 token。

### 管理指令系统

需求：用户想给提取/召回/压缩过程加自定义要求，但现有提示词硬编码。

设计：
- 数据存在 `data.managerDirective: { global, extraction, recall, compression }` 中，绑定存档
- `getDirectiveSuffix(stage)` 按需返回附加文本，格式：`\n\n## 用户对记忆管理的特别要求\n...\n`
- 注入到 5 个提示词函数末尾（两个提取、一个召回、两个压缩）
- UI：四个 textarea + 直接保存 + LLM整理（让模型把乱写的指令重新分配到对应字段）

LLM整理实现：把四个字段内容拼接后请求 LLM 输出 `{global, extraction, recall, compression}` JSON，反填回 textarea。

### 故事页完整编辑

原来 `onEditPage` 只显示一个 content textarea。

重写后展开完整内联表单：title / day / date / content / keywords / categories(多选) / significance。

结构对齐已有的 `openEditKnownChar` / `openEditNpcChar` 内联编辑模式（隐藏展示区域，显示 `.mm-page-edit-panel`）。

修改页面卡片 HTML，添加 `<div class="mm-page-edit-panel" style="display:none"></div>`。

新增 `onAddPage()` 创建空白页并自动打开编辑表单。

### 工具箱实现

#### 记忆体检

核心逻辑：
1. 从 `extractedMsgDates` 取出所有已提取的 `send_date`
2. 从当前 `ctx.chat` 取出所有消息的 `send_date`（构成 chatDates Set）
3. 差集 = 孤立日期（在提取记录中但已不在聊天中）
4. 遍历故事页的 `sourceDates`，判断被孤立的比例 → 全部孤立/部分孤立

UI：checkbox 列表 + "删除选中" + "清理孤立日期"。

#### 快捷操作

`quickExtractRange(start, end)`：从 `ctx.chat` 提取第 start~end 条消息，调用 `buildExtractionPrompt` + `callLLM` + `applyExtractionResult` 完整流程。

`quickMarkExtracted(start, end)`：只打 `extractedMsgDates` 标记，不实际提取。用于跳过已人工处理或不需要记忆的消息段。

#### 实时指令（聊天式 agent）

设计：维护 `rtCommandMessages[]` 上下文，用 `callSecondaryApiChat` 支持 tool calling。

7个工具：
- `search_pages`：按关键词/分类/天数范围搜索故事页
- `edit_page_field`：修改故事页的单个字段
- `delete_page`：删除故事页
- `extract_range`：调用快捷提取（复用 `quickExtractRange`）
- `mark_extracted`：标记已提取
- `compress_page`：压缩单页（L0→L1）
- `rebuild_embeddings`：重建向量库

轮次控制：
- 最多10轮 tool calling
- 末轮禁用工具（`tools = []`），强制拿到文字总结
- 修复：不再误报"已达最大轮次限制"，改为"操作已执行完毕（共N轮）"

**关键 Bug 修复**：`callSecondaryApiChat` 返回的 `toolCalls` 是已解析格式 `{name, arguments}`，没有 `tc.id`。实时指令代码误用 `rawToolCalls` 需求的 `tc.function.name` 格式，导致崩溃。修复：始终用 `rawToolCalls` 迭代（有 `tc.id` 和原始 `tc.function`）。

### 副 API 失败报错

原来 `agentRetrieve` 调用失败只打 console warning，用户看不到任何提示，以为召回正常（实际是空的）。

修复：在调用层（不在 `agentRetrieve` 内部）加 try-catch，失败时弹红色 toast（10秒），显示错误信息并提示检查副API状态。失败后自动 fallback 到关键词检索，不中断主流程。

### 删楼提醒

注册 `MESSAGE_DELETED` 事件的第二个监听器 `onMessageDeleted`（原有的 `onChatEvent` 监听器触发重新提取，新监听器独立检测孤立记忆）。

检测逻辑同体检，只是只看孤立日期数量，不展开具体页面分析。发现孤立数据时弹 toast 引导用户去工具箱。

---

## 当前架构概览

```
用户发消息
  ↓
generate_interceptor
  ↓
Layer 1: Story Index 始终注入 (depth=9999, ~400-600 tokens)
  时间线 + 角色态度 + NPC列表 + 物品
  ↓
Layer 2+3: 统一检索
  ① Embedding → top-K候选 (含角色档案)
  ② 记忆Agent → 读候选 → 写叙事 or SKIP   [副API失败 → toast + fallback]
  ③ 关键词匹配 (兜底)
  ↓
注入 [记忆闪回] 叙事 + 角色档案 (depth=2)
  ↓
主模型生成回复 [附加管理指令: getDirectiveSuffix('recall')]
```

```
每N条消息
  ↓
提取 → 更新时间线(merge)/角色/物品/故事页(+sourceDates)
  [附加管理指令: getDirectiveSuffix('extraction')]
  ↓
压缩周期 (按各自开关)
  [附加管理指令: getDirectiveSuffix('compression')]
  ↓
自动保存存档
  ↓
自动隐藏旧消息

用户删楼
  ↓
onMessageDeleted → 检测孤立日期 → toast提醒（如有）
```

小电视面板：
```
召回 Tab  ←→  管理指令 Tab  ←→  工具箱 Tab
  ↑                                  ↑
召回内容展示          记忆体检 / 快捷操作 / 实时指令agent
```

---

## v5.5.x: Bug 排查与修复记录

### extractionInProgress 死锁（v5.5.4）

**现象**：某个时间点后自动提取突然完全停止，强制提取也无效，部分用户待处理数量为 0，部分用户持续堆积。

**根因**：`extractionInProgress = true` 在提取开始时就写入了持久化存储（`saveMemoryData()`），但重置逻辑在 `finally` 块里。刷新页面时 JS 执行中断，`finally` 不运行，下次加载同一聊天时标志永久为 `true`。

```javascript
// Bug 所在
data.processing.extractionInProgress = true;
saveMemoryData(); // ← 此时已持久化，刷新后锁死

try {
    await performExtraction();
} finally {
    data.processing.extractionInProgress = false; // ← 刷新后这里不执行
    saveMemoryData();
}
```

两种表现的原因：
- **0 条待处理**：上次水印恰好接近 `chat.length`，新消息少于 interval 阈值
- **大量堆积**：水印滞后，消息持续累积，但锁死后任何提取都被拦截

**修复**：
1. `onChatChanged()` 重置标志时补 `saveMemoryData()`（切换聊天/角色时清锁）
2. 强制提取遇到 `extractionInProgress = true` 时**自动解锁**而非返回（用户自救入口）

**教训**：持久化锁需要配合"超时自动解锁"或"启动时强制清锁"机制。JS 单线程的锁语义和多线程不同——页面卸载即意味着所有异步任务终止，任何"正在进行中"的持久化标志在下次启动时都应视为脏数据。

---

### 强制提取进度条视觉卡死（v5.5.4）

**现象**：点强制提取后进度条立刻停在某个值不动，但副 API 后台日志显示内容已经生成完毕（有时几万 token），插件无任何写入。

**两个叠加问题**：

**问题 A — 进度条更新时机错误**：进度条在每批**调用 LLM 前**更新，LLM 执行期间（可能几十秒）无任何视觉反馈，用户误判为卡死。

```javascript
// 修复前：更新在调用前，看起来卡在这里
_ui.updateInitProgressUI?.(bi, totalBatches, `正在提取第 ${bi+1} 批...`);
await callLLM(...); // ← 几十秒空白

// 修复后：调用完再更新，无论成功失败都有反馈
_ui.updateInitProgressUI?.(bi, total, `正在等待第 ${bi+1} 批 API 响应...`);
await callLLM(...);
_ui.updateInitProgressUI?.(bi+1, total, `第 ${bi+1} 批完成 / 解析失败 / 失败: ...`);
```

**问题 B — 副 API 流式响应导致 JSON 解析失败**：部分 API 中转站（one-api / new-api 等）即便收到 `stream: false` 请求，内部仍用 SSE 流式传输后汇总再返回。某些代理会把原始 SSE 文本直接吐给客户端，`JSON.parse` 必然失败，全部批次静默进入重试，重试也全败，最终无写入。副 API 日志里看到的"几万 token"是所有批次（含重试）的总消耗。

**教训**：进度类 UI 的更新点应放在**操作完成后**，让用户看到每一步的结果，而非只看到每一步的开始。

---

### FAB 面板/管理面板点击失效（v5.5.4）

**现象**：Extension 设置面板有时无法点击，FAB 点击行为异常（有时按了没反应或反复弹出）。

**根因 1 — `offsetParent` 在 Popover top-layer 中无效**：

`isPanelVisible()` 用 `el.offsetParent !== null` 判断面板是否可见。Popover API 把元素放入浏览器 top layer，top layer 中的元素脱离正常布局流，`offsetParent` **始终为 null**。结果：
- FAB 点击时 `isPanelVisible()` 永远返回 `false` → 以为面板没开 → 调 `showPanel()` 而非 `hidePanel()`
- 文档级 click-outside 监听永远不触发关闭

```javascript
// Bug
function isPanelVisible() {
    return el && el.style.display !== 'none' && el.offsetParent !== null; // ← top-layer = null
}

// 修复：直接检查我们自己设置的 inline style
function isPanelVisible() {
    return el && el.style.getPropertyValue('display') === 'flex';
}
```

**根因 2 — `hidePanel()` 早返回跳过了 backdrop 清理**：

```javascript
// Bug
function hidePanel() {
    const el = document.getElementById('mm_recall_panel');
    if (!el) return; // ← 如果 el 被外部 DOM 操作移除，这里直接返回
    if (backdrop) backdrop.classList.remove('mm-panel-backdrop-visible'); // ← 永远执行不到
```

若 `mm_recall_panel` 被外部 DOM 操作清除（如 SillyTavern 重置部分页面），backdrop 残留 `mm-panel-backdrop-visible` 类，`z-index: 99990` 的固定定位遮罩覆盖整个页面，包括 Extension 设置区域，所有点击被拦截。

修复：将 backdrop 清理移到 `!el` 检查前面。

**教训**：使用浏览器原生 API（Popover、Dialog 等）时，依赖布局属性（`offsetParent`、`offsetWidth` 等）判断可见性可能失效。应始终用自己写入的状态（inline style、class、data 属性）作为状态判断依据。

---

### 发送按钮消失（已记录，暂缓修复）

**现象**：使用插件后，SillyTavern 发送按钮有时消失，需刷新恢复。

**根因分析**：

1. **generate_interceptor 阻塞生成主流程**：插件注册为 `generate_interceptor`，在 `Generate()` 调用 `deactivateSendButtons()` 之后、主体生成之前同步 await `retrieveMemories()`。`retrieveMemories()` 内部调用副 API（agent），若副 API 响应慢或挂起，发送按钮在整个等待期间都是隐藏状态。

```
Generate() 流程：
  deactivateSendButtons()          ← 按钮消失
    ↓
  runGenerationInterceptors()      ← await retrieveMemories()
    ↓ (副 API 响应慢时，在这里阻塞)
  主体生成
    ↓
  unblockGeneration()              ← 按钮恢复
```

2. **主 API 路径的 `callLLM` 额外触发一次 `deactivateSendButtons()`**：无副 API 时，自动提取用 `generateQuietPrompt()` → `Generate('quiet')` → `deactivateSendButtons()`。用户会看到发送按钮在主生成结束后再次短暂消失（提取期间）。

**为何"有时候"**：无副 API 时提取很快，消失不明显；有副 API 时 agent 调用时间不定，且若 agent 挂起，消失时间无上限。

**暂缓原因**：影响面取决于用户 API 稳定性，根本修复需对 interceptor 中的副 API 调用加超时控制，改动面略大。记录于此待处理。

---

## v5.5.6: 待处理计数修复 & 水位线同步按钮

### updateStatusDisplay 计数口径不一致

**现象**：状态栏显示待处理消息数虚高（如显示 23 待处理，但强制提取说"全部已提取"）；或已处理数严重偏低（如显示"已处理: 3"，实际大量消息已隐藏处理）。

**第一次错误修复（引入新 bug）**：

旧算法：
```javascript
const chatLen = ctx.chat ? ctx.chat.length : 0;
const extractedCount = Object.keys(dates).length;
const pendingCount = Math.max(0, chatLen - extractedCount);
```

问题：`chatLen` 是所有消息总数（含系统消息、`send_date` 缺失的消息），`extractedCount` 是 `extractedMsgDates` 里的唯一日期键数。两者口径不同——没有 `send_date` 的消息永远不会进 `extractedMsgDates`，但会被 `chatLen` 计数，每条都虚增一个"待处理"。

修复时加了 `msg.is_system` 过滤：
```javascript
if (!msg || !msg.send_date || msg.is_system) continue;
```
但这把自动隐藏的消息（`is_system: true`）排除在外了。自动隐藏功能把已提取消息标记为 `is_system: true` 来从 UI 移除，这些消息依然有 `send_date` 且在 `extractedMsgDates` 里，应该计入"已处理"。结果：一个有 49 条已隐藏消息的聊天显示"已处理: 3"（只有 3 条可见的已处理消息）。

**最终正确修复**：
```javascript
if (!msg || !msg.send_date) continue; // 只跳过无法追踪的消息
if (dates[msg.send_date]) {
    extractedCount++;
} else {
    pendingCount++;
}
```

规则：
- 无 `send_date` → 跳过（无法在 `extractedMsgDates` 里追踪）
- `is_system` 不影响计数（与 `forceExtractUnprocessed` 行为一致，它也不过滤 `is_system`）
- `extractedCount + pendingCount` = 所有有 `send_date` 的消息数

**教训**：计数的两个分母必须来自同一数据集。这里应该以 `ctx.chat` 为基准做分类计数，而不是用 `Object.keys(dates).length` 和 `chatLen` 分别从两个来源取数再相减。

### 工具箱水位线同步按钮

用户反馈：`extractedMsgDates`（按消息 `send_date` 打标）和 `lastExtractedMessageId`（自动提取的起点水位线）两套系统在边界情况下会脱节，导致状态栏"待处理"数不准，手动强制提取也无法修正。

新增"同步待处理计数"按钮（工具箱 → 快速操作）：
```javascript
// 从尾部反向扫描，找最高已提取消息的索引
for (let i = chat.length - 1; i >= 0; i--) {
    if (chat[i]?.send_date && extracted[chat[i].send_date]) {
        highestIdx = i; break;
    }
}
// 仅在需要时推进水位线
if (highestIdx > oldWatermark) {
    data.processing.lastExtractedMessageId = highestIdx;
    saveMemoryData();
}
```

同步方向只能向前推进（不会回退已有的水位线），避免已处理消息被重复提取。

---

## v5.6.4: 时间系统统一 + metDate + UI 编辑优化

### 问题

三个关联问题推动了这次重构：

1. **两套时间体系冲突**：时间线用 `D1: 事件` 格式标记天数，故事页用 `YYMMDD` 格式标记日期。LLM 提取时需要同时理解两种格式，经常混乱——比如 `D3` 和 `251019` 之间没有任何映射关系，LLM 只能猜测。

2. **D-number 没有绝对时间语义**：`D1` 是"第一天"，但从哪天开始算？换新聊天后 `D1` 重新计数？合并存档时 `D1` 冲突？这些问题在 YYMMDD 格式下自然消失——`2025-10-17` 就是 `2025-10-17`，无歧义。

3. **移除 D-number 后的信息损失**：`D1/D2/D3` 有一个隐含功能——让 AI 知道角色之间"相识第几天"。砍掉 D-number 后需要显式补回这个信息。方案：在角色数据上新增 `metDate`（初遇日期），由 LLM 提取+用户可编辑。

### 统一格式选择

YYYY-MM-DD（长格式）优势：
- 字符串字典序 = 时间顺序，排序/比较不需要解析
- 不存在歧义（D3 是哪天？YYMMDD 是 25年还是 2025年？）
- LLM 对 ISO 日期格式的理解最准确
- 与消息中的时间描述（状态栏、角色对话）直接对应

### 具体改动

#### formatting.js — 提取 prompt

两个提取 prompt 函数（常规提取 + 初始化提取）同步修改：

```
旧：
  "timeline": "D1: 短句\nD2: 短句"
  "day": "D1"
  "date": "251017"

新：
  "timeline": "2025-01-01: 短句\n2025-01-02: 短句"
  "date": "2025-01-01"
  角色增加 "metDate": "2025-01-01"
```

- 时间线格式指令：`D{天数}: 短句` → `YYYY-MM-DD: 短句`
- 合并格式：`D{起}-D{止}: 概括` → `YYYY-MM-DD~YYYY-MM-DD: 概括`
- 故事页：移除 `day` 字段，`date` 统一为 YYYY-MM-DD
- 已知角色：新增 `metDate` 字段要求
- NPC 角色：新增 `metDate` 字段要求

#### formatting.js — mergeTimelines

正则重写，支持双格式（新格式优先，旧格式后向兼容）：

```javascript
// 新格式：2025-01-01: ... 或 2025-01-01~2025-01-03: ...
const mDate = line.match(/^(\d{4}-\d{2}-\d{2})(?:\s*~\s*(\d{4}-\d{2}-\d{2}))?\s*:\s*(.*)$/);

// 旧格式（兼容）：D1: ... 或 D1-D3: ...
const mDay = line.match(/^D(\d+)(?:\s*-\s*D?(\d+))?:\s*(.*)$/);
```

旧格式的 D-number 被 padStart 到 10 位字符串，确保和 YYYY-MM-DD 在同一个排序空间里。

排序从整数比较改为字符串字典序，YYYY-MM-DD 天然支持。

#### extraction.js — applyExtractionResult

- 新建故事页：不再写入 `day` 字段，只写 `date`
- 已知角色合并：新增 `metDate`，仅在旧值为空时写入（不覆盖用户手动设置的值）
- NPC 角色合并：同上

#### retrieval.js — search_by_timerange agent 工具

```javascript
// 旧
d1: { type: 'string', description: '起始天数，如 "D3"' }
d2: { type: 'string', description: '结束天数，如 "D7"' }
const d = parseInt((p.day || '').replace(/\D/g, '')) || 0;

// 新
start_date: { type: 'string', description: '起始日期，如 "2025-01-01"' }
end_date: { type: 'string', description: '结束日期，如 "2025-01-07"' }
const d = p.date || '';
return d >= start && d <= end;  // 字符串比较
```

所有工具结果中的 `p.day` 引用统一改为 `p.date || '?'`。

#### ui-browser.js

| 函数 | 改动 |
|------|------|
| `renderPageList` | 排序 `parseInt(day)` → `date.localeCompare()` |
| 页面卡片 HTML | 移除 `mm-memory-card-day`，只保留 `mm-memory-card-date` |
| `onEditPage` | 移除"天数"字段，日期 placeholder 改 YYYY-MM-DD |
| 保存逻辑 | 删除 `page.day = ...` |
| `onAddPage` | `day` 参数 → `date` 参数 |
| recall badge | `p.day` → `p.date \|\| '?'` |
| `renderKnownCharsSection` | 新增 metDate 行显示 |
| `openEditKnownChar` | 态度 input→textarea，新增 metDate 输入框 |
| `onAddKnownChar` | 新增 metDate prompt |
| `renderNpcCharsSection` | 新增 metDate 行显示 |
| `openEditNpcChar` | 态度 input→textarea，新增 metDate 输入框 |
| `onAddNpcChar` | 新增 metDate prompt |
| `onEditTimelineClick` | `prompt()` → 内联 textarea |
| timeline 显示 | 包裹 `.mm-bible-preview-text` span 以支持 toggle |
| `openEditItem` | status input→textarea |

#### style.css

- `.mm-memory-card-date`：从灰色小字改为 badge 样式（填补 `.mm-memory-card-day` 的视觉位置）
- 新增 `.mm-timeline-edit` 和 `.mm-timeline-textarea`（monospace 字体，min-height 120px，可拉伸）

### 设计决策

| 决策 | 选择 | 原因 |
|------|------|------|
| 日期格式 | YYYY-MM-DD | 字典序=时间序，LLM 理解最准确 |
| 旧 day 字段 | 保留不删 | 不破坏旧数据结构，向后兼容 |
| metDate 写入策略 | 仅在无旧值时写入 | 避免 LLM 每次提取覆盖用户手动设定的值 |
| 时间线编辑 | 内联 textarea | 不依赖 `prompt()` 弹窗的小空间 |
| 态度/状态编辑 | textarea | 长文本不适合单行 input |

---

## v5.6.5: 存档孤儿误报 + 初始化世界书 + 遗留 day 引用修复

### 存档导入/加载导致孤儿记忆误报

**现象**：用户把旧存档导入新聊天窗口，体检报告所有记忆全变成孤儿。

**根因**：`loadFromSlot()` 和 `onImportClick()` 执行 `ctx.chatMetadata.memoryManager = imported`，把旧聊天的 `extractedMsgDates` 带入新环境。`extractedMsgDates` 的 key 是旧聊天消息的 `send_date`（如 `"February 20, 2026 3:05pm"`），新聊天中没有这些消息，孤儿检测逻辑（`onMessageDeleted` 和 `runHealthCheck`）做差集时全部命中。

**修复**：在 `loadFromSlot()` 和 `onImportClick()` 中，加载存档后清空 `imported.processing.extractedMsgDates = {}`。

**设计决策**：`extractedMsgDates` 是"当前聊天的处理进度"，不是"存档内容"。存档的价值在于故事页、时间线、角色等提取后的结构化数据，不在于哪些原始消息被处理过。跨聊天加载存档后，处理进度应该从零开始。

### 初始化不包含世界书内容

**现象**：用户点击"初始化"按钮，LLM 看不到世界书/角色卡中的背景设定（技能描述、世界观设定、地名等）。settings.html 按钮文字写着"从已有聊天记录+世界书+角色卡批量构建记忆"，但实际只处理聊天记录。

**两个根因**：

1. **`buildInitExtractionPrompt()` 是死代码**：formatting.js 中有这个函数且被 export，但 extraction.js 只 import 了 `buildExtractionPrompt`，所有提取路径（`performExtraction`、`forceExtractUnprocessed`）都用 `buildExtractionPrompt`。`buildInitExtractionPrompt` 从未被调用。

2. **`gatherWorldBookContext()` 存在但未接入提取流程**：api.js 中有完整的世界书收集函数（`getSortedEntries` → 按 position 分组 → 格式化输出），但没有任何提取代码调用它。

**修复方案**：

不去复活 `buildInitExtractionPrompt`（两个 prompt 函数维护两份几乎相同的模板是维护负担），而是给 `buildExtractionPrompt` 加可选参数：

```javascript
export function buildExtractionPrompt(data, newMessages, worldBookContext = '') {
    // ...existing code...
    // 在新消息内容后插入世界书上下文
    ${worldBookContext ? `\n## 世界书/角色卡参考信息\n${worldBookContext}\n` : ''}
}
```

**初始化弹窗新增 checkbox**：

用户反馈"我不想加世界书"的场景——不是所有人都把背景放世界书里，强制附带浪费 token。方案：在 `showInitRangeDialog` 范围选择弹窗中新增"包含世界书/角色卡内容"checkbox，默认勾选。`resolve` 返回值从 `{ start, end }` 变为 `{ start, end, includeWorldBook }`。

**允许零消息初始化**：

去掉了 `showInitRangeDialog` 中 `chatLen === 0` 时的早返回。新窗口没有聊天记录，但用户可能只想从世界书提取记忆。

**纯世界书提取分支 `_worldBookOnlyExtraction`**：

`forceExtractUnprocessed` 扫描到 0 条未提取消息时，原来直接返回"没有需要处理的内容"。现在检查 `options.includeWorldBook`：
- 为 true → 调用 `_worldBookOnlyExtraction(data, s)`：收集世界书 → 单独跑一次提取（消息部分传占位文本） → 写入记忆数据
- 世界书也为空 → 提示"没有未提取的消息，世界书也为空"
- 为 false → 原逻辑不变

**完整调用链**：

```
有消息 + 勾选世界书:
  performBatchInitialization → forceExtractUnprocessed(... { includeWorldBook: true })
    → gatherWorldBookContext() → buildExtractionPrompt(data, batchText, worldBookContext)

无消息 + 勾选世界书:
  performBatchInitialization → forceExtractUnprocessed(... { includeWorldBook: true })
    → unextracted.length === 0 → _worldBookOnlyExtraction(data, s)
    → gatherWorldBookContext() → buildExtractionPrompt(data, placeholder, worldBookContext)

有消息 + 不勾选:
  performBatchInitialization → forceExtractUnprocessed(... {})
    → 正常消息提取，不附带世界书

无消息 + 不勾选:
  → "所有消息均已提取，没有需要处理的内容"
```

普通增量提取和普通强制提取不传 worldBookContext，避免每次提取都浪费 token 发送整个世界书。

### v5.6.4 遗留 p.day 引用修复

v5.6.4 时间系统统一改了 formatting.js / extraction.js / retrieval.js / ui-browser.js，但遗漏了以下文件中的 `p.day` / `page.day` 引用：

| 文件 | 位置 | 修复 |
|------|------|------|
| ui-fab.js | 召回面板页面显示（line 325） | `p.day` → `p.date \|\| '?'` |
| ui-fab.js | 孤儿体检列表（line 810） | `p.day` → `p.date \|\| '?'` |
| ui-fab.js | 实时指令工具 search/read/list（3处） | `p.day` → `p.date \|\| '?'` |
| commands.js | 召回来源显示、页面列表（2处） | `p.day` → `p.date \|\| '?'` |
| compression.js | 压缩 prompt 原文标题（1处） | `page.day` → `page.date \|\| '?'` |
| embedding.js | 分类重建 prompt（1处） | `p.day` → `p.date \|\| '?'` |
| retrieval.js | agent 工具页面显示、来源格式（2处） | `page.day` → `page.date \|\| '?'` |

**教训**：全局重命名时应该用 grep 扫描所有文件，不能只改"知道会用到的"文件。

---

## v5.6.3: 移除水位线，统一到 extractedMsgDates 单一数据源

### 问题回顾

v5.5.4~v5.5.6 连续打了三轮补丁来修复提取进度追踪的各种脱节问题，但根因始终没有解决：**两套并行系统**。

| 系统 | 数据结构 | 用于 | 更新时机 |
|------|----------|------|----------|
| 水位线 `lastExtractedMessageId` | 整数索引 | 自动提取起点、自动隐藏边界、pending count | 每次提取后写入 |
| 日期标记 `extractedMsgDates` | `send_date → true` 字典 | 强制提取去重、UI 计数、badge 显示 | 每次提取后写入 |

两套系统各自独立更新、互不感知，但共同影响用户看到的"待处理"数字。以下场景会导致脱节：

1. **刷新页面死锁**：水位线在 `finally` 块里重置，刷新时 `finally` 不执行 → 水位线被锁死
2. **删除消息**：水位线指向的索引可能变成另一条消息
3. **强制提取**：只更新日期标记，水位线需要额外同步
4. **计数显示**：`ui-browser.js` 用日期标记计数，`safeExtract()` 用水位线判断 → 结果不一致

每次修一个场景就加一层补丁：清锁 → 计数修复 → 同步按钮 → 修计数口径。典型的"面多加水"。

### 解决方案

**砍掉水位线，只保留 `extractedMsgDates`。** 所有需要水位线的地方改为从日期标记实时派生：

```javascript
// 新增辅助函数：从尾部向前扫描，找最近已提取消息索引
export function getHighestExtractedIndex(chat, dates) {
    if (!chat || !dates) return -1;
    for (let i = chat.length - 1; i >= 0; i--) {
        if (chat[i]?.send_date && dates[chat[i].send_date]) return i;
    }
    return -1;
}
```

性能：正常聊天场景下（提取持续推进），从尾部扫描 1-5 次即可命中，O(1) 摊销。即使几千楼全未提取的极端情况，全量遍历也在 1ms 以内（纯对象属性查找，无 DOM 操作）。

### 具体改动

| 函数 | 旧逻辑 | 新逻辑 |
|------|--------|--------|
| `performExtraction()` | 读水位线做 startIdx，提取后写水位线 | 用 `getHighestExtractedIndex` 算 startIdx，提取后只写日期标记 |
| `safeExtract()` | `chat.length - 1 - lastExtractedMessageId` | `chat.length - 1 - getHighestExtractedIndex(chat, dates)` |
| `forceExtractUnprocessed()` | 提取后同步水位线（3处） | 删除所有水位线同步代码 |
| `hideProcessedMessages()` | 读水位线做隐藏边界 | 用 `getHighestExtractedIndex` 算隐藏边界 |
| 工具箱同步按钮 | 手动对齐两套系统 | 删除（不再需要） |
| `createDefaultData()` | 包含 `lastExtractedMessageId: -1` | 移除该字段 |
| `getMemoryData()` | — | 新增 `delete d.processing.lastExtractedMessageId` 清理旧数据 |

### 关于 send_date 分钟级碰撞

`send_date` 由 SillyTavern 的 `getMessageTimeStamp()` 生成，格式为 `"February 24, 2026 3:05pm"`，精度只到分钟。同一分钟内的多条消息共享同一个 key，标记其中一条为已提取，其他的也会被视为已提取。

接受这个碰撞：同一分钟内的消息内容高度关联（一问一答），跳过不影响记忆质量。如果后续需要更精确的追踪，再换用唯一 key（如 `send_date + '_' + index`）。

### 教训

旧版选了一个在简单场景下够用的水位线方案，后来为了修补各种边界场景引入了第二套日期标记系统。两套共存导致复杂度指数级增长——每个新功能都要考虑"两套系统是否同步"。正确的做法是在引入第二套系统时就应该替换掉第一套，而不是让它们并存。



**需求**：手机端用户在滚动/操作时容易误触 settings 面板的滑条和输入框，改出预期外的配置。

**设计**：锁定按钮 + CSS 状态类方案。不需要 JS 遍历 disable 所有控件（脆弱，遗漏风险高），也不需要额外遮罩层（z-index 管理复杂），直接用 `pointer-events: none` 阻断整个 body 区域的交互。

```
mm_main_content
  ├── mm_lock_bar (position: sticky, 始终可点)
  └── mm_settings_body
        锁定时：pointer-events: none; opacity: 0.45
```

关键实现细节：
- 锁定按钮用 `position: sticky; top: 0` 固定在面板顶部，无论滚动到哪都能解锁
- 状态存 `localStorage`（不存 `extension_settings`，是纯 UI 偏好，不需要同步到服务器）
- `mm-settings-locked` 类挂在 `mm_main_content` 上，CSS 选择器 `#mm_main_content.mm-settings-locked .mm-settings-body` 精确控制范围



- 纯浏览器端 JS（SillyTavern 第三方扩展）
- 副API通过 ST 服务端代理（避免CORS）
- Embedding 直接浏览器 fetch（中转站支持CORS）
- 向量存储在本地 chatMetadata/存档文件
- 余弦相似度纯JS计算
- 无需修改 SillyTavern 核心代码

---

## v5.7.0: 流式接收 + JSON截断修复 + Bug修复

### 副API流式接收

**问题**：`callSecondaryApi` 使用 `stream: false`，Claude 等模型的非流式支持较差，且截断时整批提取失败无法恢复。部分 API 中转站即便收到 `stream: false` 也内部用 SSE 传输后汇总，导致二次截断。

**修复**：将 `callSecondaryApi` 改为 `stream: true`，新增 `readSSEStream()` 内联 SSE 读取器：

```javascript
async function readSSEStream(response) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    // 逐行解析 SSE: data: {JSON}\n\n → choices[0].delta.content
    // data: [DONE] → 正常结束
    // 流中断 → 返回已累积的部分内容（而非抛异常）
}
```

关键设计：
- 不使用 SillyTavern 的 `EventSourceStream`（未导出，扩展无法 import）
- 流异常中断时 **返回已累积文本** 而非抛错，配合 JSON 截断修复可挽救部分数据
- `callSecondaryApiWithTools` / `callSecondaryApiChat` 保持 `stream: false`（tool calling 不兼容流式）

### JSON 截断修复

**问题**：流式接收即便返回了部分文本，JSON 不完整仍然解析失败。

**修复**：

1. 新增 `repairTruncatedJson(text)` 函数：状态机追踪 `inString` / `escaped` / bracket stack，遍历结束后补闭合 `"` / `]` / `}`。
2. `parseJsonResponse` 新增 Strategy 4：前三个策略全失败后，尝试 `repairTruncatedJson` → `fixJsonString` → `JSON.parse`。修复成功时输出 warn 日志提示数据可能不完整。

截断修复效果：时间线、已提取角色等靠前的字段通常能保留，`newPages` 数组可能被截断到中间某页。`applyExtractionResult` 的增量合并逻辑保证部分数据也能正确写入。

### 强制提取确认对话框

**问题**：用户误触"强制提取"按钮可能触发大量 API 调用和 token 消耗。

**修复**：点击按钮后先计算未处理消息数（排除缓冲区 4 条），0 条时 toast 提示无需处理，否则弹出 `confirm()` 显示：待处理数量 + token 提醒 + 替代方案建议（分楼层提取/等自动提取）。

### Bug 1: 待处理消息虚高

**现象**：状态栏待处理数持续堆积，但自动提取不处理也无报错。

**根因**：`safeExtract()` 计算 `pendingCount = ctx.chat.length - 1 - highestIdx` 包含了缓冲区内的消息，但 `performExtraction()` 会跳过缓冲区（`endIdx = chat.length - buffer`）。两处口径不一致：safeExtract 认为有 N 条待处理并达到阈值触发提取，performExtraction 实际只处理 N-buffer 条，缓冲区内的消息永远"待处理"。

**修复**（两处）：

1. `safeExtract()` 计算 pendingCount 时排除缓冲区：
```javascript
let effectiveEnd = ctx.chat.length;
if (s.autoHide && s.keepRecentMessages >= 3) {
    const buffer = Math.max(0, s.keepRecentMessages - 2);
    effectiveEnd = Math.max(0, ctx.chat.length - buffer);
}
const pendingCount = Math.max(0, effectiveEnd - 1 - highestIdx);
```

2. `updateStatusDisplay()` 将计数分为"真正待处理"和"缓冲区"两部分，缓冲区消息显示为 `"5 (+8 缓冲)"` 格式，让用户理解这些消息是被故意跳过的。

### Bug 2: 加载存档/导入后假性未处理堆积

**现象**：加载旧存档到新聊天后，状态栏显示几百条"待处理"，但这些消息实际上已经被存档覆盖了对应的记忆数据。

**根因**：`loadFromSlot()` 和 `onImportClick()` 清空 `extractedMsgDates = {}`（正确，避免孤儿误报），但没有把当前聊天的消息标记为已提取。清空后所有消息的 `send_date` 都不在字典里，全部显示为"未处理"。

**修复**：清空后立即遍历 `ctx.chat`，将所有消息的 `send_date` 标记为已提取。`loadFromSlot` 和 `onImportClick` 同理。

### "未初始化" 状态文案修复

**现象**：新开楼的用户看到状态栏显示"未初始化"，以为需要手动操作，实际自动提取会自动处理。

**修复**：`updateStatusDisplay()` 中 `extractedCount === 0` 时显示"就绪 · 等待新消息"替代"未初始化"。
