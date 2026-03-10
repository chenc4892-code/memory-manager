# MMPEA 记忆管理 更新日志

## v5.6.5 (2026-02-24)

### Bug Fixes

#### 修复存档导入/加载导致的孤儿记忆误报
- **现象**：旧存档导入新窗口或加载到不同聊天时，体检报告全部记忆变成孤儿
- **原因**：`loadFromSlot()` 和 `onImportClick()` 替换整个 `memoryManager` 对象时，旧聊天的 `extractedMsgDates`（`send_date → true` 字典）一并被带入。新聊天中没有匹配的 `send_date`，所有旧日期都被判定为孤儿
- **修复**：在 `loadFromSlot()` 和 `onImportClick()` 中，加载/导入存档后立即清空 `extractedMsgDates`。此字段追踪的是当前聊天的处理状态，不是存档内容的一部分

#### 修复初始化不包含世界书内容
- **现象**：点击"初始化"按钮批量提取记忆时，LLM 无法看到世界书/角色卡中的背景设定
- **原因**：
  1. `buildInitExtractionPrompt()` 是死代码（存在但从未被任何地方调用），所有提取路径都使用 `buildExtractionPrompt()`
  2. 两个 prompt 函数都不包含世界书内容，尽管 `api.js` 中已有现成的 `gatherWorldBookContext()` 函数
- **修复**：
  - `buildExtractionPrompt()` 新增可选参数 `worldBookContext`，非空时在消息内容后附加世界书参考信息
  - `forceExtractUnprocessed()` 新增 `includeWorldBook` 选项，启用时调用 `gatherWorldBookContext()` 获取内容
  - 初始化弹窗新增"包含世界书/角色卡内容"checkbox（默认勾选），用户可自行选择
  - 允许零消息初始化：新窗口无聊天记录时，勾选世界书选项即可仅从世界书提取记忆
  - 新增 `_worldBookOnlyExtraction()` 分支处理纯世界书提取场景

#### 修复 v5.6.4 遗留的 p.day 引用
- 修复了 ui-fab.js、commands.js、compression.js、embedding.js、retrieval.js 中残留的 `p.day` / `page.day` 引用，统一改为 `p.date || '?'` / `page.date || '?'`

## v5.6.4 (2026-02-24)

### Refactor

#### 时间系统统一：D1/D2/D3 → YYYY-MM-DD
- **背景**：时间线用 D1/D2/D3 标记天数，故事页又用 YYMMDD 具体日期，两套时间体系互相冲突。LLM 在提取时需要同时理解两种格式，容易混乱
- **改动**：
  - 提取 prompt（`buildExtractionPrompt` / `buildInitExtractionPrompt`）：时间线格式改为 `YYYY-MM-DD: 短句`，合并格式改为 `YYYY-MM-DD~YYYY-MM-DD: 短句`；故事页移除 `day` 字段，`date` 格式统一为 YYYY-MM-DD
  - `mergeTimelines()`：正则从 D-format 改为 YYYY-MM-DD，保留旧 D-format 后向兼容解析；排序从整数比较改为字符串字典序比较
  - `formatRecalledPages()`：`page.day` → `page.date`
  - `applyExtractionResult()`：新建故事页不再写入 `day` 字段
  - `search_by_timerange` agent 工具：参数从 `d1/d2` 改为 `start_date/end_date`，匹配逻辑从整数范围改为日期字符串比较
  - UI 页面排序从 D-number 整数排序改为 date 字符串 `localeCompare`
  - UI 页面卡片/编辑面板：移除"天数"字段，日期 placeholder 改为 YYYY-MM-DD
  - 手动新增故事页：`day` 参数改为 `date`（YYYY-MM-DD 格式）
- **兼容性**：旧数据中的 `day` 字段保留不删，旧 D-format 时间线条目可被 `mergeTimelines` 正常解析

#### 角色新增 metDate（初遇时间）字段
- **背景**：移除 D1/D2/D3 后失去了"相识第几天"的隐含信息，需要在角色上补回
- **改动**：
  - 已知角色（`knownCharacterAttitudes`）和 NPC 角色（`characters`）均新增 `metDate` 字段（YYYY-MM-DD 格式）
  - 提取 prompt：LLM 在提取时自动填充 `metDate`（从消息推断初遇日期）
  - `applyExtractionResult()`：已知角色和 NPC 合并时写入 `metDate`，仅在无旧值时更新（不覆盖已有值）
  - `formatStoryIndex()`：已知角色显示增加 `(初遇YYYY-MM-DD)` 标注
  - UI 显示：已知角色和 NPC 卡片新增"初遇"行
  - UI 编辑：已知角色和 NPC 编辑面板新增"初遇时间"输入框（YYYY-MM-DD）
  - 手动新增已知角色/NPC 时新增 metDate 提示

### UI/UX 改进

#### 时间线内联 textarea 编辑
- **问题**：时间线编辑用浏览器 `prompt()` 弹窗，编辑区域极小，多行内容无法正常查看和编辑
- **修复**：改为内联展开的 textarea（monospace 字体，可拉伸），点击编辑按钮切换显示/编辑模式，支持保存和取消

#### 编辑面板 textarea 化
- 已知角色态度：`<input>` → `<textarea rows="2">`
- NPC 态度：`<input>` → `<textarea rows="2">`
- 物品状态：`<input>` → `<textarea rows="2">`

---

## v5.6.3 (2026-02-24)

### Refactor

#### 移除 `lastExtractedMessageId` 水位线，统一到 `extractedMsgDates` 单一数据源
- **背景**：提取进度追踪有两套并行系统——水位线（`lastExtractedMessageId`，整数索引）和日期标记（`extractedMsgDates`，`send_date → true` 字典）。两套系统各自更新、互不感知，在刷新页面死锁、删除消息、加载存档等场景下频繁脱节，导致待处理计数虚高、提取静默停止等问题。v5.5.4~v5.5.6 的多轮补丁（清锁、计数口径对齐、同步按钮）都是在双轨架构上打补丁
- **改动**：
  - 新增 `getHighestExtractedIndex(chat, dates)` 辅助函数：从聊天尾部向前扫描已提取消息，常规场景 O(1) 摊销复杂度
  - `performExtraction()`、`safeExtract()`、`hideProcessedMessages()` 全部改用 `extractedMsgDates` + 辅助函数，不再读写水位线
  - `forceExtractUnprocessed()` 删除 3 处水位线同步代码
  - 工具箱删除"同步待处理计数"按钮（不再需要）
  - `createDefaultData()` 移除 `lastExtractedMessageId` 字段，`getMemoryData()` 自动清理旧数据中的残留字段
- **效果**：净减少约 30 行代码，彻底消除两套系统脱节的可能性
- **兼容性**：旧数据中的 `lastExtractedMessageId` 字段会被自动清理，无需手动迁移

---

## v5.6.1 (2026-02-22)

### New Features

#### 一键归档全部 + 隐藏全部楼层（工具箱）
- **背景**：N-2 缓冲区设计保护用户免于提取可能会重投骰的消息，但代价是「换新窗口」时缓冲区内的消息记忆会丢失。例如设置 6 层可见时，最近 4 条消息永远不会被提取，切换窗口就断了这段记忆
- **新增**：工具箱「快速操作」区新增两个按钮：
  - **「一键归档全部」**（红色）：以 `noBuffer: true` 调用 `forceExtractUnprocessed()`，提取**全部**消息（包括 N-2 缓冲区内的），确认对话框会显示缓冲区内待提取消息数量
  - **「隐藏全部楼层」**（灰色）：调用 `hideChatMessageRange(0, chatLen-1, false)` 隐藏全部楼层
- **典型工作流**：归档全部 → 隐藏全部 → 继续新对话（记忆完整保留）
- **技术实现**：`forceExtractUnprocessed()` 新增可选 `options` 参数（第5参数），`options.noBuffer = true` 时将 BUFFER 从 4 改为 0，`defaultEnd` 从 `chat.length - 4` 改为 `chat.length`。现有调用点行为不变

### Bug Fixes

#### 「让管理员帮写prompt」按钮无响应
- **问题**：小电视→管理指令 Tab 中的「让管理员整理」按钮点击后无任何反应
- **原因**：`renderDirectiveTab()` 中只为 `#mm_dir_save` 和 `#mm_dir_clear` 绑定了 click 事件，**`#mm_dir_organize` 从未绑定任何事件处理器**
- **修复**：
  - 按钮文本从「让管理员整理」改为「让管理员帮写prompt」
  - 新增完整 click 处理器：
    - 如果用户已填写指令文本 → 调用 `callLLM` 整理并重新分配到四个环节
    - 如果所有 textarea 为空 → 根据当前记忆状态（页面数、NPC 数、时间线状态）自动生成建议指令
    - 生成结果填入对应 textarea，提示用户检查后点「直接保存」
  - 处理中按钮禁用并显示「生成中...」状态

#### 管理指令刷新页面后丢失
- **问题**：在管理指令 Tab 点击「直接保存」后刷新页面，指令消失
- **原因**：
  1. `getMemoryData()` 对 `managerDirective` 字段没有初始化检查——当记忆数据由旧版本创建（v4 但在 `managerDirective` 字段引入之前），该字段为 `undefined`，导致后续读写异常
  2. `saveMemoryData()` 使用 `saveMetadataDebounced()`（防抖延迟 ~1s），如果用户保存后立即刷新，防抖可能未触发，数据丢失
- **修复**：
  - `getMemoryData()` 新增 `managerDirective` 初始化检查（与 `knownCharacterAttitudes`、`embeddings` 等字段同等对待）
  - 新增 `saveMemoryDataImmediate()` 函数：调用 `saveMetadataDebounced()` 后尝试 `.flush()` 强制立即写入
  - 指令保存和清空操作改用 `saveMemoryDataImmediate()` 替代 `saveMemoryData()`

---

## v5.5.10 (2026-02-21)

### Bug Fixes

#### 初始化/强制提取范围输入无效
- **问题**：点击「初始化记忆」弹出范围对话框，输入起始/结束楼层后，实际仍然提取全部消息，用户指定的范围被忽略
- **原因**：`performBatchInitialization()` 收集了对话框的 `range`（start/end），但调用 `forceExtractUnprocessed()` 时未传入该参数；`forceExtractUnprocessed` 函数签名也不接受范围参数，始终从第 0 条扫描到末尾
- **修复**：
  - `forceExtractUnprocessed(data, ctx, s, range = null)` 新增可选 `range` 参数，有值时用 `range.start` / `range.end` 约束扫描范围，无值时行为不变
  - `safeExtract(force, range = null)` 同步新增 `range` 参数并透传
  - `performBatchInitialization()` 将对话框收集的 range 传入 `forceExtractUnprocessed`
  - `quickExtractRange(start, end)` 将 start/end 包装为 `{ start, end }` 传入 `safeExtract`（此函数此前同样存在参数未传递的问题）
- **影响范围**：仅影响带范围的强制提取路径；无范围的调用（强制提取按钮、`/mm-extract` 命令、失败重试）行为完全不变

---

## v5.5.9 (2026-02-20)

### New Features

#### NPC 注入模式（三档可选）
- **半注入**（默认，原行为）：Layer 1 故事索引只显示 NPC 名字+身份简介，省 token
- **全注入**：所有 NPC 完整档案（外貌/性格/态度）始终注入 Layer 1，适合 NPC 少的玩家
- **关键词激活**：扫描最近 N 条消息，命中关键词的 NPC 注入完整档案，其余只显示名字

#### NPC 关键词字段
- NPC 数据结构新增 `keywords` 数组（用于关键词激活模式的触发判断，不注入 prompt）
- 提取 prompt：LLM 在生成新 NPC 时同步提供 `keywords`（姓名、昵称、称呼等，2-5个）
- 多次提取时关键词增量合并（保留已有、追加新词）
- UI 编辑面板：可手动编辑 keywords（逗号分隔）
- 手动新建 NPC 时新增 keywords 提示步骤
- NPC 卡片显示 keywords 字段（仅在有关键词时显示）
- 实时指令 `show_characters` 工具同步显示 role + keywords

---

## v5.5.8 (2026-02-20)

### New Features

#### NPC 身份字段（role）
- **背景**：Layer 1 故事索引只显示 NPC 名字，AI 在无 embedding 召回的情况下无法区分同名或陌生 NPC，容易张冠李戴
- **新增**：NPC 角色数据结构增加 `role` 字段（一句话身份简介，如"主角的私人医生"）
- **Layer 1 展示**：`四、已登场NPC` 中有 role 的角色以 `名字（身份）` 格式显示，无 role 则只显示名字，向后兼容
- **Layer 2/3 档案**：`formatDossier` 新增 `身份` 行
- **提取 prompt**：`buildExtractionPrompt` 与 `buildInitExtractionPrompt` 的 `newCharacters` 格式均更新，要求 LLM 提供 `role` 字段
- **UI**：NPC 卡片在名字旁显示 role；编辑面板新增"身份"输入框；手动新建 NPC 时新增身份提示

---

## v5.5.7 (2026-02-20)

### Bug Fixes

#### 多存档内容相同（隔离机制失效）
- **根因**：`onChatChanged` 检测到新聊天无记忆时，会弹出可点击的 Toast 自动将活跃存档数据注入当前聊天；用户在新聊天中立即创建新存档时，保存的是刚注入的旧数据，导致两个存档内容完全相同
- **修复**：移除 Toast 的 `onclick` 自动加载行为，改为纯提示（列出该角色所有存档名），引导用户前往面板手动选择加载

### Removed

#### 自动保存（Auto-Save）功能已移除
- **移除原因**：Auto-save 的活跃槽位（`activeSlot`）是按角色名全局存储的，与具体聊天记录无关；在多聊天场景下（同一角色多个聊天记录），任意聊天触发提取后都会往同一个槽写入，导致跨聊天覆写存档
- **移除内容**：`autoSaveIfEnabled()` 函数、`autoSaveSlot` 设置项、UI 中"提取后自动保存"勾选框、force extract 阶段的自动备份/自动加载逻辑
- **替代方案**：使用面板中的"立即保存"按钮或"新建存档"手动管理，存档完全由玩家控制

---

## v5.5.6 (2026-02-20)

### Bug Fixes

#### 待处理消息计数错误
- **问题 1**: 旧算法 `pendingCount = chatLen - extractedCount` 把两套不同口径的数字相减：`chatLen` 是所有消息总数（含系统消息、无 `send_date` 的消息），`extractedCount` 是 `extractedMsgDates` 里的唯一日期键数——两者口径不匹配，系统消息或日期缺失的消息会虚增"待处理"计数
- **问题 2**: 修复时误加了 `msg.is_system` 过滤，将自动隐藏的消息（`is_system: true`）从统计中排除，导致"已处理"计数只剩可见消息（如显示"已处理: 3"，实际 49 条已隐藏处理）
- **修复**: 改为遍历 `ctx.chat`，跳过无 `send_date` 的消息（无法追踪），按 `send_date` 是否在 `extractedMsgDates` 中计入已处理/待处理；`is_system` 不影响计数，与强制提取行为一致

### New Features

#### 工具箱"同步待处理计数"按钮
- 快速操作区新增"同步待处理计数"按钮
- 功能：从尾部反向扫描 `ctx.chat`，找到最高索引的已提取消息，将 `lastExtractedMessageId` 水位线同步至该索引
- Toast 显示同步前后的值（`旧值 → 新值`）；若水位线已是最新则提示无需同步

---

## v5.5.5 (2026-02-20)

### New Features

#### Settings 防误触锁
- 设置面板顶部新增固定锁定按钮（`position: sticky`，滚动时始终可见）
- 点击切换锁定/解锁状态，锁定时设置区域 `pointer-events: none; opacity: 0.45`，所有滑条/输入框/按钮均无法误触
- 锁定状态持久化至 `localStorage`，刷新后自动恢复
- 解锁：🔓 "防误触"（半透明低调）；锁定：🔒 "已锁定"（琥珀色高亮）

---

## v5.5.4 (2026-02-20)

### Bug Fixes

#### 自动提取突然停止（extractionInProgress 死锁）
- **问题**: `extractionInProgress = true` 在提取开始时写入持久化存储，但刷新页面时 `finally` 块不执行，下次加载同一聊天时标志永久为 `true`，自动提取和强制提取全被静默拦截
- **修复 1**: `onChatChanged()` 在重置标志后增加 `saveMemoryData()` 调用，仅在标志为 `true` 时写盘，避免无谓写入
- **修复 2**: 强制提取遇到 `extractionInProgress = true` 时不再直接返回，改为自动解锁并提示"检测到提取锁未释放，已自动重置"，然后继续提取

#### 强制提取进度条视觉卡死
- **问题**: 进度条在每批 **调用 LLM 前** 更新（显示"第 X 批..."），等待 API 期间无任何变化，用户误判为卡死；批次失败时进度也不前进，整体反馈缺失
- **修复**: 进度条改为每批 **调用 LLM 后** 更新，成功/失败/解析失败均有独立进度提示（如"第2/5批解析失败，待重试"），重试阶段同理，确保进度条持续前进

#### 管理面板（Extension 设置区）点击被拦截
- **问题**: `isPanelVisible()` 使用 `el.offsetParent !== null` 判断面板可见性，但 Popover API 将元素放入浏览器 top layer，top layer 元素的 `offsetParent` 始终为 `null`，导致判断永远返回 `false`；后果：点击 FAB 时以为面板未开而反复调用 `showPanel()`，文档级 click-outside 监听也失效，backdrop 可能残留覆盖整个页面（含 Extension 设置区域）
- **修复 1**: `isPanelVisible()` 改为检查 inline style：`el.style.getPropertyValue('display') === 'flex'`，与 `showPanel()`/`hidePanel()` 的实际写法一致
- **修复 2**: `hidePanel()` 将 backdrop 清理移到 `!el` 返回检查之前，避免 panel 元素被外部 DOM 操作移除时 backdrop 永久残留

---

## v5.5.2 (2026-02-19)

### Bug Fixes

#### 记忆召回来源显示为不可读 ID
- **问题**: Agent 输出的 `来源: pg_mls0aur0_2mzm · pg_abc123` 原样展示，用户无法理解这些内部 ID
- **修复**: 提取 `pg_xx` ID 后自动解析为对应故事页标题，显示为 `来源: D3「初次约会」 · D5「雨中告白」`
- 同时修复来源行正则：原正则只匹配 `[来源: ...]`（带方括号），但 Agent prompt 模板输出的是 `来源: ...`（无方括号），导致来源行未被正确解析
- 新增剥离 `[记忆闪回]`/`[/记忆闪回]` 包裹标签，避免 LLM 输出的标签残留在叙事文本中

#### 移除 SKIP 机制
- **问题**: Agent 决策流程中的 SKIP 判断过于保守，频繁跳过记忆召回，导致角色"失忆"。Embedding 已找到相关候选页面，但 Agent 仍判定"不需要理解过去"而 SKIP
- **修复**: 从 `agentRetrieve()` 中移除 `narrative === 'SKIP'` 的特殊判断，仅在真正空响应时返回空结果
- Agent prompt 同步调整：移除"SKIP"输出指令，将"SKIP 的情况"改为"不调用工具的情况"

#### 检索降级逻辑重构
- **问题**: `agentRetrieve()` 外层 try-catch 吞掉所有错误，调用方无法区分"API 失败"和"成功但无结果"，降级路径不合理
- **修复**:
  - `agentRetrieve()` 返回值新增 `error` 字段（替代原 `skipped`），明确标识 API 调用失败
  - 内部追踪 `apiFailed` 标志，API 异常或空响应时 `error: true`，成功时 `error: false`
  - `retrieveMemories()` 降级逻辑重构为 5 路分支：
    1. Agent 成功 → 使用叙事
    2. Agent 失败 + Embedding 有候选 → 直接注入 Embedding 候选页面 + toast 提示
    3. Agent 失败 + 无 Embedding → 关键词检索降级 + toast 提示
    4. Agent 未配置 + Embedding 有候选 → 静默使用 Embedding 结果
    5. Agent 未配置 + 无 Embedding → 静默关键词检索

#### Agent 失败静默无反馈
- **问题**: 副 API 调用失败或返回空响应时，召回静默失败，用户无任何感知，表现为角色"突然失忆"
- **修复**: 每条降级路径均增加 toast 提示，明确告知用户当前降级状态：
  - Embedding 降级: `记忆代理调用失败，已降级为Embedding直接注入，请检查API状态哟(∪.∪ )...zzz`
  - 关键词降级: `记忆代理调用失败，没有设置embedding端点，已降级为关键词检索，请检查API与embedding状态哟( •̀ .̫ •́ )✧`

---

## v5.5.1 (2026-02-19)

### UI/UX 改进

#### 面板遮罩与移动端适配
- 面板弹出时增加半透明暗色遮罩 + 毛玻璃模糊（`backdrop-filter: blur(4px)`），点击遮罩关闭面板
- 移动端（屏幕宽度 <500px）面板自动居中显示，宽度为屏幕宽 -24px，高度最大 480px

#### 初始化弹窗重做
- 原 `prompt()` 文本输入替换为自定义 HTML 弹窗
- 起始/结束改为两个独立 `type="number"` 输入框，预填 0 和 chatLen-1
- 消除手动输入格式导致的解析失败风险

#### 记忆体检增强：孤儿页面管理
- 健康检查不再只显示孤立日期数量，改为展示受影响的故事页列表
- 每个故事页标注状态标签：**全孤立**（红色，所有源日期均已失效）/ **部分孤立**（琥珀色，部分源日期失效）
- 支持复选框选择 + 全选按钮
- **删除选中页面**：从 `data.pages` 中移除选中页面及其 Embedding 向量
- **清理孤立日期**：从 `extractedMsgDates` 中移除已不存在的消息日期记录
- 操作完成后自动重新运行体检刷新结果

#### 未提取标记图标修正
- 替换手绘 inline SVG，改用扩展目录中实际的 `robot-svgrepo-com.svg` 路径数据
- SVG `fill` 改为 `currentColor`，跟随 CSS 颜色控制

#### 设置面板 UI 修复（模块拆分后回归修复）
- 知识卡片（已知角色/NPC/物品）布局与样式还原
- 故事页编辑表单：隐藏预览区、恢复日期字段
- 标签样式：分类标签（catTags）彩色药丸、关键词标签（kwTags）灰色药丸
- 故事页卡片布局对齐原始设计稿
- 实时指令聊天区域高度自适应

#### 移动端悬浮球修复
- 重新挂载 Popover API（`popover="manual"`）确保 top layer 渲染
- 修复触屏拖拽事件（touchstart/touchmove/touchend）
- Lottie 动画加载失败时降级为静态图标
- 拖拽位置边界约束（不超出视口）

### Bug Fixes

#### 删楼后自动隐藏范围未更新
- **问题**: 用户删除消息后，`keepRecentMessages` 对应的可见消息范围未重新计算，导致本应可见的消息仍处于隐藏状态（例如删了 6 楼后第 60 楼还是隐藏的）
- **修复**: 新增 `recalculateHideRange()` 函数，在 `onMessageDeleted` 事件中自动比较新旧隐藏边界，若新边界更小则调用 `hideChatMessageRange(unhideFrom, oldBoundary, true)` 取消隐藏差额区间

---

## v5.5.0 (2026-02-18)

### 架构重构：模块化拆分

将原 ~6000 行单体 `index.js` 拆分为 15 个职责单一的 ES 模块，依赖关系为有向无环图（DAG），无循环依赖。

#### 模块清单

| 模块 | 职责 |
|------|------|
| `src/constants.js` | 纯常量（零依赖） |
| `src/utils.js` | 工具函数（escapeHtml、generateId、cosineSimilarity 等） |
| `src/mood.js` | Lottie 动画心情系统 |
| `src/data.js` | 数据层：设置、记忆 CRUD、迁移链 |
| `src/auth.js` | 授权验证（SHA-256 授权码校验） |
| `src/api.js` | LLM API 层（主/副 API、工具调用） |
| `src/save.js` | 存档系统（saveToSlot / loadFromSlot） |
| `src/embedding.js` | Embedding 向量检索系统 |
| `src/formatting.js` | 提示词构建与记忆格式化 |
| `src/compression.js` | 渐进式压缩引擎 |
| `src/extraction.js` | 记忆提取引擎（UI 回调注入模式） |
| `src/retrieval.js` | Agent 检索引擎（MemGPT 工具调用） |
| `src/ui-browser.js` | 设置面板 UI（updateBrowserUI、CRUD 操作） |
| `src/ui-fab.js` | 悬浮球、召回面板、工具箱、批量初始化 |
| `src/commands.js` | /mm-* 斜杠命令注册 |

`index.js` 精简为薄入口：jQuery 初始化、auth 门控、事件绑定、回调注入。

#### 关键架构决策

- **回调注入模式**：`setExtractionUI(callbacks)` 将 `updateBrowserUI` / `updateInitProgressUI` 等 UI 函数注入提取引擎，避免 extraction → ui-browser/ui-fab 的循环依赖
- **状态 getter 模式**：retrieval 模块通过 `getLastRecalledPages()` / `getLastNarrative()` 等 getter 暴露状态，不直接共享变量
- **UI 职责分离**：`safeCompress()` / `retrieveMemories()` 不再自行调用 `updateBrowserUI()`，由调用方决定 UI 刷新时机
- **全局拦截器包装**：`window['memoryManager_retrieveMemories']` 在 index.js 封装 `retrieveMemories` + `updateRecallFab`，保持检索后 FAB 自动更新

---

## v5.4.1 (2026-02-18)

### Performance Optimizations

#### escapeHtml 纯字符串替换
- 原实现每次调用创建一个 `document.createElement('div')` DOM 节点，在 UI 渲染时（每张卡片调用 5-8 次 escapeHtml）开销显著
- 改为纯字符串 `.replace()` 链，零 DOM 操作，性能提升约 10 倍

#### updateBrowserUI 分区更新
- 原实现每次调用都重建**全部** 9 个 UI 区域（timeline / knownChars / npcChars / items / pageStats / pageList / embedding / status / slots），包括完整的 innerHTML 重写和事件监听重绑
- 新增 `sections` 参数，支持按需只更新特定区域
- 编辑/删除/新增单个实体（角色/NPC/物品/故事页/时间线）时，只更新对应的 1-2 个区域，避免全量 DOM 重建
- 无参调用保持向后兼容（更新全部区域）
- 内部拆分为 `_renderKnownChars()`、`_renderNpcChars()`、`_renderItems()`、`_renderPageList()` 四个独立渲染函数

#### updateUnextractedBadges 定向更新
- 原实现每次调用都 `querySelectorAll('.mes[mesid]')` 全量扫描所有聊天消息 DOM 节点
- 新增 `targetMesId` 参数，`onMessageRendered` 时只处理单条消息的 badge，避免 O(n) 全量扫描
- 全量扫描仅在 `onChatChanged` 等真正需要时执行

#### data.pages 排序优化
- `data.pages.sort()` 改为 `[...data.pages].sort()` 避免原地变异，防止其他代码依赖的数组顺序被意外修改
- 排序比较器内的 `parseInt(day.replace(/\D/g, ''))` 改为 Map 缓存，每个 page 只解析一次

#### FAB 拖拽监听器按需绑定
- 原实现在 FAB 创建时就将 `mousemove` / `mouseup` / `touchmove` / `touchend` 四个监听器永久挂载到 `document`，每次鼠标移动都会触发回调（即使未拖拽）
- 改为在 `mousedown` / `touchstart` 时才绑定 move/end 监听，拖拽结束后立即 `removeEventListener`，非拖拽状态下零开销

---

## v5.4.0 (2026-02-18)

### New Features

#### 小电视面板 Tab 化
- 原单一"召回"面板拆分为三个 Tab：**召回 / 管理指令 / 工具箱**
- Tab 懒加载（首次切入才渲染内容）
- 关闭面板或离开工具箱 Tab 时自动清空实时指令上下文（节省 API 消耗）

#### 管理指令 Tab（新功能）
- 支持按环节填写用户指令：**全局 / 提取 / 召回 / 压缩**
- 各环节带有极简说明（写给完全不懂的人看的那种）
- "直接保存"与"让管理员整理"（LLM重新格式化分配到各字段）两种保存方式
- 指令自动注入到对应 prompt 函数末尾（5个提示词函数全覆盖）
- 数据存储在 `managerDirective` 字段，绑定到当前存档

#### 故事页完整编辑表单（新功能）
- 点击"编辑"展开完整内联表单，可编辑所有字段：标题、天数（D1）、日期（251017）、内容、关键词（逗号分隔）、分类标签（多选）、重要程度
- 原来只能编辑 content 文本框，现在全字段可改
- 保存后如启用了 Embedding 自动重新建向量

#### 手动新增故事页（新功能）
- 故事页列表底部增加"+ 新增故事页"按钮
- 点击后创建空白页并自动打开编辑表单

#### 工具箱 Tab（新功能）

**记忆体检**
- 比对 `extractedMsgDates` 与当前聊天记录，找出孤立（已删消息）的提取日期
- 显示受影响的故事页及其状态（全孤立=建议删除，部分孤立=建议审查）
- 支持选择性删除 + 清理孤立日期记录

**快捷操作**
- 提取指定范围（输入起止编号 → 调用完整提取 pipeline）
- 标记已提取（只打标不提取，用于跳过不需要记忆的消息段）
- 重建向量库（快捷入口，复用设置面板的同名功能）

**实时指令**（聊天式 agent）
- 和记忆管理员用自然语言对话，直接操作记忆数据
- 支持 7 个工具：搜索故事页、编辑字段、删除页面、提取范围、标记已提取、压缩页面、重建向量
- 最多 10 轮 tool calling，末轮禁用工具强制返回文字总结
- 离开 Tab 或关闭面板自动清空上下文

#### 删楼提醒 Toast（新功能）
- 用户删除消息后自动检测是否有孤立提取记录
- 发现孤立数据时弹出 toast，引导使用工具箱→记忆体检进行清理

### Bug Fixes
- **实时指令 tool call 崩溃**: `callSecondaryApiChat` 返回的 `toolCalls` 已解析为 `{name, arguments}`，但代码按原始 OpenAI 格式 `tc.function.name` 访问导致崩溃。修复：改用 `rawToolCalls` 迭代，保留 `tc.id` 和原始格式
- **副 API 不可用无反馈**: `agentRetrieve` 调用失败时只打日志，召回静默失败。修复：加 try-catch，失败时弹出红色 toast，显示错误信息并提示检查 API 状态，自动 fallback 到关键词检索

---

## v5.3.1 (2026-02-18)

### Bug Fixes
- **时间线被新提取覆盖**: `data.timeline = result.timeline` 直接替换，LLM 只输出本批内容的时间线时旧数据全部丢失。修复：新增 `mergeTimelines()` 函数，解析 D-条目范围，智能判断新旧时间线的覆盖程度，只覆盖已被新时间线包含的旧条目
- **强制提取覆盖存档**: 强制提取后 `autoSaveIfEnabled()` 自动保存，导致当前记忆数据（可能为空）直接覆盖已有存档。修复：强制提取前自动备份到 `{存档名}-备份`，如果当前记忆为空且存档存在则自动加载，确保不丢数据
- **故事页缺少 sourceDates**: 正常提取和强制提取创建的故事页 `sourceDates` 始终为空，无法追踪来源消息。修复：`applyExtractionResult` 新增 `sourceDates` 参数，全部 6 个调用点均传入对应批次的 `send_date` 列表
- **处理计数显示错误**: 存在 `extractedMsgDates` 标记时只用日期计数，忽略水位线；无标记时只用水位线。导致新旧混合数据下计数严重偏低（如"已处理4条"而实际已处理上千条）。修复：取日期计数和水位线计数的较大值

---

## v5.3.0 (2026-02-17)

### New Features
- **消息级提取标记系统** (`extractedMsgDates`): 每条消息提取成功后用 `send_date` 打标，精确追踪哪些消息已提取、哪些遗漏。替代原来仅靠水位线 (`lastExtractedMessageId`) 的粗略判断
- **强制提取重写**: 强制提取不再走水位线逻辑，而是扫描全部聊天消息（包括已隐藏的），找出所有未打标的消息进行分批提取。初始化失败遗漏的消息也能被捞回
- **强制提取自动重试**: 失败批次会自动重试一轮，与初始化的重试逻辑对齐
- **强制提取进度条**: 复用初始化进度 UI，显示分批进度和重试状态
- **精确待处理计数**: "未处理消息"数量改为基于 `extractedMsgDates` 精确统计，包含已隐藏的消息
- **初始化范围选择**: 初始化弹窗显示全部消息总数（含隐藏），用户可指定提取的消息范围
- **未提取消息标记图标**: 未被记忆管理器提取的消息在用户名旁显示一个小机器人图标（🤖），提取成功后自动消失。让用户一眼看出哪些消息还没被处理

### Bug Fixes
- **iOS 召回面板变扁**: Popover API 的浏览器默认样式 (`height: fit-content`) 导致面板在 iOS Safari 上塌缩。修复：在 `[popover]` 重置中增加 `height: auto`、`min-height: 200px`、`overflow: visible`
- **隐藏消息不可见**: `hideChatMessageRange` 将消息标记为 `is_system=true`，导致初始化/强制提取/计数用 `!is_system` 过滤时排除了这些消息。修复：在初始化、强制提取和计数中改用 `m.mes` 作为过滤条件，不再排除已隐藏的消息
- **旧数据兼容**: 旧数据 `extractedMsgDates` 从空开始，不做假设性迁移。待处理计数在无标记时 fallback 到水位线逻辑。用户可通过强制提取重新扫描全部消息补上遗漏

### Other
- 添加 `.gitignore`，排除 `auth-codes.txt` 和 `generate-auth-codes.cjs`，防止授权码明文和生成器泄露到仓库

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
