/**
 * Memory Manager — Formatting & Prompt Building
 * Story index formatting, extraction prompts, agent prompts, directive suffix, timeline merging.
 */

import { getMemoryData, getKnownCharacterNames, getSettings } from './data.js';

import {
    getContext,
} from '../../../../extensions.js';

// ── Story Index Formatting ──

export function formatStoryIndex(data) {
    const s = getSettings();
    const mode = s.npcInjectionMode || 'half';
    const parts = ['[故事索引]'];
    const ctx = getContext();
    const userName = ctx.name1 || '{{user}}';

    // Timeline (compact)
    if (data.timeline) {
        parts.push('一、剧情时间线');
        parts.push(data.timeline);
    }

    // Item index (compact)
    if (data.items.length > 0) {
        parts.push('\n二、物品');
        for (const item of data.items) {
            parts.push(`· ${item.name} | ${item.status || ''}`);
        }
    }

    // Known character attitudes (always show all)
    if (data.knownCharacterAttitudes && data.knownCharacterAttitudes.length > 0) {
        parts.push(`\n三、已有角色对${userName}态度/关系`);
        for (const c of data.knownCharacterAttitudes) {
            if (c.attitude) {
                parts.push(`· ${c.name}: ${c.attitude}`);
            }
        }
    }

    // NPC section — controlled by npcInjectionMode
    if (data.characters.length > 0) {
        if (mode === 'full') {
            // Full: always inject complete dossiers
            parts.push('\n四、已登场NPC档案');
            for (const c of data.characters) {
                parts.push(formatDossier(c));
            }
        } else if (mode === 'keyword') {
            // Keyword activation: scan recent N messages, inject dossier only for matched NPCs
            const scanDepth = s.npcKeywordScanDepth || 4;
            const recentMsgs = (ctx.chat || []).slice(-scanDepth);
            const recentText = recentMsgs.map(m => m.mes || '').join(' ').toLowerCase();

            const activated = [];
            const dormant = [];
            for (const c of data.characters) {
                // Use character's keywords array; fallback to name if empty
                const kws = (c.keywords && c.keywords.length > 0) ? c.keywords : [c.name];
                const matched = kws.some(kw => recentText.includes(kw.toLowerCase()));
                if (matched) activated.push(c);
                else dormant.push(c);
            }

            if (activated.length > 0) {
                parts.push('\n四、已登场NPC档案（激活）');
                for (const c of activated) {
                    parts.push(formatDossier(c));
                }
                if (dormant.length > 0) {
                    const dormantNames = dormant.map(c => c.role ? `${c.name}（${c.role}）` : c.name).join('、');
                    parts.push(`\n五、其他NPC: ${dormantNames}`);
                }
            } else {
                // Nothing activated — fall back to half mode
                const names = data.characters.map(c => c.role ? `${c.name}（${c.role}）` : c.name).join('、');
                parts.push(`\n四、已登场NPC: ${names}`);
            }
        } else {
            // 'half' (default): names + role hints only
            const names = data.characters.map(c => c.role ? `${c.name}（${c.role}）` : c.name).join('、');
            parts.push(`\n四、已登场NPC: ${names}`);
        }
    }

    parts.push('[/故事索引]');
    return parts.join('\n');
}

export function formatRecalledPages(pages) {
    if (pages.length === 0) return '';

    const parts = ['[记忆闪回]'];
    for (const page of pages) {
        parts.push(`回忆起了……「${page.title}」(${page.day})`);
        parts.push(page.content);
        parts.push('');
    }
    parts.push('[/记忆闪回]');
    return parts.join('\n');
}

export function formatDossier(character) {
    const parts = [];
    parts.push(`[角色档案: ${character.name}]`);
    if (character.role) parts.push(`身份: ${character.role}`);
    if (character.appearance) parts.push(`外貌: ${character.appearance}`);
    if (character.personality) parts.push(`性格: ${character.personality}`);
    if (character.attitude) parts.push(`对主角态度: ${character.attitude}`);
    parts.push(`[/角色档案]`);
    return parts.join('\n');
}

// ── Directive Suffix ──

export function getDirectiveSuffix(stage) {
    const data = getMemoryData();
    const dir = data.managerDirective;
    if (!dir) return '';
    const parts = [];
    if (dir.global && dir.global.trim()) parts.push(dir.global.trim());
    if (dir[stage] && dir[stage].trim()) parts.push(dir[stage].trim());
    if (parts.length === 0) return '';
    return `\n\n## 用户对记忆管理的特别要求\n${parts.join('\n')}\n请在执行任务时遵循以上要求。`;
}

// ── Extraction Prompts ──

export function buildExtractionPrompt(data, newMessages) {
    const ctx = getContext();
    const userName = ctx.name1 || '{{user}}';
    const knownNames = getKnownCharacterNames();
    const knownCharNamesStr = knownNames.size > 0 ? [...knownNames].join('、') : '（无）';

    const knownAttJson = data.knownCharacterAttitudes.length > 0
        ? JSON.stringify(data.knownCharacterAttitudes, null, 2)
        : '[]';
    const charsJson = data.characters.length > 0
        ? JSON.stringify(data.characters, null, 2)
        : '[]';
    const itemsJson = data.items.length > 0
        ? JSON.stringify(data.items, null, 2)
        : '[]';

    return `[OOC: 停止角色扮演。你现在是剧情记忆管理系统。
## 任务

### 1. 更新时间线
基于现有时间线和新消息，输出更新后的完整时间线。
格式规则:
- 每行格式 "D{天数}: 短句"，每行不超过30字
- 旧事件合并为 "D{起}-D{止}: 一句话概括"，不超过30字
- 像书的目录一样简洁，只写关键转折
- 保留旧条目的核心信息（大幅压缩措辞）
- 按时间线排列，控制在15行以内
- 示例: "D1: 纽约初遇，自由女神像约会" "D2-D4: 共同调查失踪案，发现线索"

### 2. 更新角色信息
分两类输出：

**已知角色**（${knownCharNamesStr}）— 只更新态度：
  输出到 knownCharacterAttitudes 数组，每项: {name, attitude}
  attitude: 该角色对主角（${userName}）的态度/关系变化轨迹

**新NPC角色**（不含主角"${userName}"、不含已知角色）：
  输出到 newCharacters 数组，每项: {name, role, appearance, personality, attitude, keywords}
  role: 一句话身份简介，如"主角的私人医生"、"旅馆老板娘"（可留空）
  keywords: 用于识别该角色的关键词数组（含姓名、昵称、称呼等，2-5个，如["林医生","林晓薇","晓薇"]）
  仅收录剧情中新登场的、非已知角色列表中的NPC

### 3. 更新重要物品
更新物品名+位置+持有人+简述，仅为**有重要意义、会在后续剧情产生影响的物品**建立档案，不记录可乐薯片等消耗品
每个物品: name, status, significance

### 4. 提取故事页（Story Pages）
从消息中提取值得记录的事件。每个页面是一个完整事件的因果记录。
不仅限于重大转折，任何改变事件走向、揭示关键信息、推动关系变化的事件都应记录。
日常噪音（补妆、移动、整理仪容等不影响剧情的动作）不记录。

每个页面包含:
- title: 短标题（4-8字）
- day: 对应时间线中的D几
- date: 剧情中的具体日期，格式 YYMMDD（如 "251017"）。从消息中的状态栏/时间描述提取，无法确定则留空字符串
- content: 以事件为单位，记录因果链（50-150字）。规则：
  · 写"为什么"而非仅写"做了什么"（因果关系优先）
    ❌ "她典当了项链，去买了衣服"
    ✅ "她卖掉母亲留下的项链，换钱为他买面试穿的西装"
  · 按事件组织，不按分钟组织。一个事件=起因→经过→结果
    ❌ "08:14 A摔门 → 08:17 A哭泣 → 08:22 A喊哥哥"
    ✅ "[清晨] A说出全名后情绪崩溃离开，B追出安抚，C目睹后放弃审讯姿态"
  · 可记录1-2句决定事件走向的关键对话（用概括语言，禁止大段引用原文台词）
  · 使用时间段（清晨/上午/下午/傍晚/深夜），禁止精确到分钟
  · 不要文学修饰和感官细节渲染
- keywords: 用于检索的关键词数组（3-8个，含角色名、地点、物品、情感关键词）
- categories: 语义分类标签数组，从以下选择1-3个:
    "emotional"(情感事件), "relationship"(关系变化),
    "intimate"(亲密互动), "promise"(承诺/约定),
    "conflict"(冲突/争执), "discovery"(发现/揭秘),
    "turning_point"(重大转折), "daily"(日常片段)
- significance: "high"（重要转折/关系变化）或 "medium"（值得记住但非关键）

如果没有值得记录的事件，newPages为空数组。

现在开始，请分析以下新消息，完成记忆提取。
## 当前故事索引

### 剧情时间线
${data.timeline || '（尚无，请从头创建）'}

### 已知角色态度（当前）
${knownAttJson}

### NPC角色档案（当前）
${charsJson}

### 重要物品（当前）
${itemsJson}

## 新消息内容
${newMessages}



## 输出格式
严格按以下JSON格式输出，用markdown代码块包裹：

\`\`\`json
{
  "timeline": "D1: 短句\\nD2: 短句",
  "knownCharacterAttitudes": [
    {"name": "...", "attitude": "..."}
  ],
  "newCharacters": [
    {"name": "...", "role": "...", "appearance": "...", "personality": "...", "attitude": "...", "keywords": ["...", "..."]}
  ],
  "items": [
    {"name": "...", "status": "...", "significance": "..."}
  ],
  "newPages": [
    {
      "title": "...",
      "day": "D1",
      "date": "251017",
      "content": "...",
      "keywords": ["...", "..."],
      "categories": ["emotional", "relationship"],
      "significance": "high"
    }
  ]
}
\`\`\`

注意：
- 只输出JSON代码块，不要有其他文字
- 角色名使用实际名字，不用{{char}}或{{user}}
- knownCharacterAttitudes 只含已知角色（${knownCharNamesStr}）
- newCharacters 不含主角"${userName}"和已知角色
- items要输出完整列表（含未变化的旧条目）
- newPages仅包含本批消息中提取的新页面
- date格式为YYMMDD（如 "251017" 表示2025年10月17日），从消息中的状态栏/时间信息提取，不确定则留空
- categories从以下选1-3个: emotional, relationship, intimate, promise, conflict, discovery, turning_point, daily
- 时间线每行不超过30字，像目录一样简洁
]` + getDirectiveSuffix('extraction');
}

export function buildInitExtractionPrompt(data, messages) {
    const ctx = getContext();
    const userName = ctx.name1 || '{{user}}';
    const knownNames = getKnownCharacterNames();
    const knownCharNamesStr = knownNames.size > 0 ? [...knownNames].join('、') : '（无）';

    const knownAttJson = data.knownCharacterAttitudes.length > 0
        ? JSON.stringify(data.knownCharacterAttitudes, null, 2)
        : '[]';
    const charsJson = data.characters.length > 0
        ? JSON.stringify(data.characters, null, 2)
        : '[]';
    const itemsJson = data.items.length > 0
        ? JSON.stringify(data.items, null, 2)
        : '[]';

    return `[OOC: 停止角色扮演。你现在是剧情记忆管理系统。以下是你的任务要求

    ## 剧情记忆管理任务

### 1. 更新时间线
将本批内容中的事件整合进时间线。
格式规则:
- 每行格式 "D{天数}: 短句"，每行不超过30字
- 旧事件合并为 "D{起}-D{止}: 一句话概括"，不超过30字
- 像书的目录一样简洁，只写关键转折
- 保留旧条目核心信息
- 按时间线排列，控制在15行以内
- 示例: "D1: 纽约初遇，自由女神像约会"

### 2. 更新角色信息
分两类输出：

**已知角色**（${knownCharNamesStr}）— 只更新态度：
  输出到 knownCharacterAttitudes 数组，每项: {name, attitude}
  attitude: 该角色对主角（${userName}）的态度/关系变化轨迹
  禁止忽略此项！

**新NPC角色**（不含主角"${userName}"、不含已知角色）：
  输出到 newCharacters 数组，每项: {name, role, appearance, personality, attitude, keywords}
  role: 一句话身份简介，如"主角的私人医生"（可留空）
  keywords: 用于识别该角色的关键词数组（含姓名、昵称、称呼等，2-5个，如["林医生","林晓薇","晓薇"]）

### 3. 更新重要物品
更新物品名+位置+持有人+简述，仅为**有重要意义、会在后续剧情产生影响的物品**建立档案，不记录可乐薯片等消耗品
每个物品: name, status, significance

### 4. 提取故事页（重要！）
这是初始化流程。从故事开始的第一天起，为本批内容中所有值得记录的事件创建故事页。
即使这些事件已经反映在时间线中，仍然需要创建对应的故事页。
任何改变事件走向、揭示关键信息、推动关系变化的事件都应有一页。
日常噪音（补妆、移动、整理仪容等不影响剧情的动作）不记录。

每页包含:
- title: 短标题（4-8字）
- day: 对应时间线中的D几
- date: 剧情中的具体日期，格式 YYMMDD（如 "251017"）。从消息中的状态栏/时间描述提取，无法确定则留空字符串
- content: 以事件为单位，记录因果链（50-150字）。规则：
  · 写"为什么"而非仅写"做了什么"（因果关系优先）
    ❌ "她典当了项链，去买了衣服"
    ✅ "她卖掉母亲留下的项链，换钱为他买面试穿的西装"
  · 按事件组织，不按分钟组织。一个事件=起因→经过→结果
  · 可记录1-2句决定事件走向的关键对话（概括语言，禁止大段引用原文台词）
  · 使用时间段（清晨/上午/下午/傍晚/深夜），禁止精确到分钟
  · 不要文学修饰和感官细节渲染
- keywords: 关键词数组（3-8个）
- categories: 语义分类标签数组，从以下选择1-3个:
    "emotional"(情感事件), "relationship"(关系变化),
    "intimate"(亲密互动), "promise"(承诺/约定),
    "conflict"(冲突/争执), "discovery"(发现/揭秘),
    "turning_point"(重大转折), "daily"(日常片段)
- significance: "high" 或 "medium"



注意：
- 只输出JSON代码块，不要有其他文字
- 角色名使用实际名字
- knownCharacterAttitudes 只含已知角色（${knownCharNamesStr}）
- newCharacters 不含主角"${userName}"和已知角色
- items要输出完整列表
- newPages要为每个值得记录的事件都创建，不要遗漏
- date格式为YYMMDD（如 "251017" 表示2025年10月17日），从消息中的状态栏/时间信息提取，不确定则留空
- categories从以下选1-3个: emotional, relationship, intimate, promise, conflict, discovery, turning_point, daily
- 时间线每行不超过30字，像目录一样简洁

---
以下是本批内容：
## 当前故事索引（由之前的批次积累）

### 剧情时间线
${data.timeline || '（尚无，请从头创建）'}

### 已知角色态度（当前）
${knownAttJson}

### NPC角色档案（当前）
${charsJson}

### 重要物品（当前）
${itemsJson}

## 本批内容
${messages}

# 现在开始按照输出格式输出
## 输出格式
严格按JSON格式输出，用markdown代码块包裹：

\`\`\`json
{
  "timeline": "D1: 短句\\nD2: 短句",
  "knownCharacterAttitudes": [
    {"name": "...", "attitude": "..."}
  ],
  "newCharacters": [
    {"name": "...", "role": "...", "appearance": "...", "personality": "...", "attitude": "...", "keywords": ["...", "..."]}
  ],
  "items": [
    {"name": "...", "status": "...", "significance": "..."}
  ],
  "newPages": [
    {
      "title": "...",
      "day": "D1",
      "date": "251017",
      "content": "...",
      "keywords": ["...", "..."],
      "categories": ["emotional", "relationship"],
      "significance": "high"
    }
  ]
}
\`\`\`
]` + getDirectiveSuffix('extraction');
}

// ── Timeline Merge ──

export function mergeTimelines(oldTimeline, newTimeline) {
    if (!oldTimeline) return newTimeline || '';
    if (!newTimeline) return oldTimeline;

    // Parse D-entries from each timeline
    function parseEntries(tl) {
        const entries = [];
        for (const line of tl.split('\n')) {
            const m = line.match(/^D(\d+)(?:\s*-\s*D?(\d+))?:\s*(.*)$/);
            if (m) {
                entries.push({
                    start: parseInt(m[1]),
                    end: parseInt(m[2] || m[1]),
                    text: m[3],
                    raw: line,
                });
            }
        }
        return entries;
    }

    const oldEntries = parseEntries(oldTimeline);
    const newEntries = parseEntries(newTimeline);

    if (newEntries.length === 0) return oldTimeline;

    // Determine the range covered by new timeline
    const newStart = Math.min(...newEntries.map(e => e.start));
    const newEnd = Math.max(...newEntries.map(e => e.end));

    // Keep old entries that are NOT covered by the new timeline's range
    const keptOld = oldEntries.filter(e => e.end < newStart || e.start > newEnd);

    // Merge: old entries before new range + new entries + old entries after new range
    const merged = [
        ...keptOld.filter(e => e.end < newStart).map(e => e.raw),
        ...newEntries.map(e => e.raw),
        ...keptOld.filter(e => e.start > newEnd).map(e => e.raw),
    ];

    return merged.join('\n');
}
