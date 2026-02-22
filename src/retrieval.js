/**
 * Memory Manager — Retrieval Engine (MemGPT Agent + Embedding + Keyword Fallback)
 * Agent-based memory retrieval with tool calling, embedding pre-filter, keyword fallback.
 *
 * NOTE: retrieveMemories() does NOT call updateRecallFab(). Callers must handle FAB update
 * after retrieval (to avoid circular dependency with ui-fab).
 */

import {
  PROMPT_KEY_INDEX,
  PROMPT_KEY_PAGES,
  COMPRESS_SUMMARY,
  MEMORY_CATEGORIES,
} from './constants.js';
import { log, warn } from './utils.js';
import { getSettings, getMemoryData, saveMemoryData } from './data.js';
import { callSecondaryApiChat } from './api.js';
import {
  formatStoryIndex, formatRecalledPages, formatDossier,
  getDirectiveSuffix,
} from './formatting.js';
import { setMood } from './mood.js';
import { isEmbeddingConfigured, embeddingPreFilter } from './embedding.js';
import { isAuthorized } from './auth.js';

import {
  setExtensionPrompt,
  extension_prompt_types,
  extension_prompt_roles,
} from '../../../../../script.js';
import { getContext } from '../../../../extensions.js';

const toastr = window.toastr;

// ── Module State (exported via getters) ──

let lastRecalledPages = [];
let lastRecalledChars = [];
let lastNarrative = '';

export function getLastRecalledPages() { return lastRecalledPages; }
export function getLastRecalledChars() { return lastRecalledChars; }
export function getLastNarrative() { return lastNarrative; }

export function resetRetrievalState() {
  lastNarrative = '';
  lastRecalledPages = [];
  lastRecalledChars = [];
}

// ── Agent Tools ──

export function buildAgentTools(data) {
  const tools = [];
  const pages = data.pages.filter(p => p.compressionLevel <= COMPRESS_SUMMARY);

  // 1. search_by_category
  tools.push({
    type: 'function',
    function: {
      name: 'search_by_category',
      description: '按语义分类搜索记忆页面。分类: emotional(情感), relationship(关系), intimate(亲密), promise(承诺), conflict(冲突), discovery(发现), turning_point(转折), daily(日常)',
      parameters: {
        type: 'object',
        properties: {
          category: { type: 'string', enum: Object.keys(MEMORY_CATEGORIES), description: '语义分类' },
        },
        required: ['category'],
      },
    },
  });

  // 2. search_by_timerange
  tools.push({
    type: 'function',
    function: {
      name: 'search_by_timerange',
      description: '按时间范围搜索记忆页面。',
      parameters: {
        type: 'object',
        properties: {
          d1: { type: 'string', description: '起始天数，如 "D3"' },
          d2: { type: 'string', description: '结束天数，如 "D7"' },
        },
        required: ['d1', 'd2'],
      },
    },
  });

  // 3. search_by_keyword
  tools.push({
    type: 'function',
    function: {
      name: 'search_by_keyword',
      description: '按关键词搜索记忆页面标题和关键词。',
      parameters: {
        type: 'object',
        properties: {
          keyword: { type: 'string', description: '搜索关键词' },
        },
        required: ['keyword'],
      },
    },
  });

  // 4. read_story_page — read full content of a page (for pages NOT in candidates)
  if (pages.length > 0) {
    tools.push({
      type: 'function',
      function: {
        name: 'read_story_page',
        description: '读取一个记忆页面的完整内容。用于读取搜索发现的、不在候选列表中的页面。',
        parameters: {
          type: 'object',
          properties: {
            page_id: { type: 'string', enum: pages.map(p => p.id), description: '故事页ID' },
          },
          required: ['page_id'],
        },
      },
    });
  }

  return tools;
}

export function executeAgentTool(toolName, args, data) {
  const pages = data.pages.filter(p => p.compressionLevel <= COMPRESS_SUMMARY);
  switch (toolName) {
    case 'search_by_category': {
      const cat = args.category;
      const matched = pages.filter(p => Array.isArray(p.categories) && p.categories.includes(cat));
      if (matched.length === 0) return `没有找到分类为"${MEMORY_CATEGORIES[cat] || cat}"的页面。`;
      return matched.map(p => `[${p.id}] ${p.day} | ${p.title}`).join('\n');
    }
    case 'search_by_timerange': {
      const d1 = parseInt((args.d1 || '').replace(/\D/g, '')) || 0;
      const d2 = parseInt((args.d2 || '').replace(/\D/g, '')) || 9999;
      const matched = pages.filter(p => {
        const d = parseInt((p.day || '').replace(/\D/g, '')) || 0;
        return d >= d1 && d <= d2;
      });
      if (matched.length === 0) return `D${d1}-D${d2}之间没有找到页面。`;
      return matched.map(p => `[${p.id}] ${p.day} | ${p.title}`).join('\n');
    }
    case 'search_by_keyword': {
      const kw = (args.keyword || '').toLowerCase();
      const matched = pages.filter(p =>
        (p.keywords || []).some(k => k.toLowerCase().includes(kw)) || p.title.toLowerCase().includes(kw),
      );
      if (matched.length === 0) return `没有找到关键词"${args.keyword}"相关的页面。`;
      return matched.map(p => `[${p.id}] ${p.day} | ${p.title}`).join('\n');
    }
    case 'read_story_page': {
      const page = data.pages.find(p => p.id === args.page_id);
      if (!page) return `页面 ${args.page_id} 不存在。`;
      const cats = (page.categories || []).map(c => MEMORY_CATEGORIES[c] || c).join(', ') || '无';
      return `[${page.id}] ${page.day} | ${page.title} | 分类: ${cats}\n${page.content}`;
    }
    default:
      return '未知工具';
  }
}

// ── Agent Prompt ──

export function buildAgentPrompt(data, recentText, candidatePages, maxPages) {
  const allPages = data.pages.filter(p => p.compressionLevel <= COMPRESS_SUMMARY);
  const candidateIds = new Set((candidatePages || []).map(p => p.id));

  // Candidate pages with full content
  let candidateSection = '';
  if (candidatePages && candidatePages.length > 0) {
    const formatted = candidatePages.map(p => {
      const cats = (p.categories || []).map(c => MEMORY_CATEGORIES[c] || c).join(', ') || '无';
      const content = p.content.length > 500 ? p.content.substring(0, 500) + '…' : p.content;
      return `### [${p.id}] ${p.day} | ${p.title} | 分类: ${cats}\n${content}`;
    }).join('\n\n');
    candidateSection = `\n## Embedding候选记忆（按语义相关度排序，完整内容）\n${formatted}`;
  }

  // Non-candidate pages catalog (titles only, so agent knows what else exists)
  const otherPages = allPages.filter(p => !candidateIds.has(p.id));
  let catalogSection = '';
  if (otherPages.length > 0) {
    catalogSection = `\n## 其他记忆页面（仅标题，可用搜索工具探索）\n${otherPages.map(p => `[${p.id}] ${p.day} | ${p.title}`).join('\n')}`;
  }

  const charList = data.characters.map(c => `  ${c.name}: ${c.attitude || '(未知)'}`).join('\n');

  return `你是记忆代理——角色的海马体。记忆是独立的agent，你就是负责激活大脑记忆神经元的智能体。发送给你的上下文是角色在故事开始后经历的事件的结构性存贮，而你的输出将直接作为[记忆闪回]注入主AI上下文。

# 你的核心价值

向量搜索只能找到"语义相似"的内容。
你能做到向量搜索做不到的：
- **因果推理**：A导致B导致C → 所以角色现在会这样反应
- **情感脉络**：因为X事件带来的创伤 → 角色对Y有阴影
- **连贯叙事**：把散落的记忆碎片组织成有意义的故事
**Write the why, not just the what. Never reduce meaningful actions to a grocery list of movements.**
When summarizing or recalling events, capture the *causal chain* — the intention behind the action, not merely the action itself.
❌ Wrong:
> She pawned her necklace. She went to a store. She bought clothes.
This is a security camera log. It records motion without meaning.
✅ Correct:
> She sold her mother's necklace to buy him a suit for his interview.
One sentence. The sacrifice, the purpose, the relationship — all present.
---

# 决策流程

## Step 1: 扫描当前对话
识别触发词：
- 人物？地点？物品？
- 情绪状态？关系动态？
- 正在做的选择？

## Step 2: 需要"理解过去"吗？
问自己：
- 回应这段对话，需要知道"之前发生过什么"吗？
- 需要解释"为什么角色会这样"吗？
- 涉及角色关系的变化原因吗？

## Step 3: 候选记忆够吗？
看Embedding候选记忆：
- 能推理出因果链？能写出情感脉络？
- **够 → 直接写叙事，不调用工具**
- 有明显的逻辑断裂 → 用工具补充，然后写叙事

# 不调用工具的情况
- 纯问候："你好"、"早安"、"在吗"
- 元指令：换模式、调整语气、重新生成、meta讨论
- 无关话题：与角色/故事/世界观完全无关

---

# 写叙事的情况

- 角色做出选择时（需要理解动机）
- 遇到认识的人时（需要关系脉络）
- 回到某个地点时（场景记忆触发）
- 涉及情感模式时（愤怒/恐惧/渴望的来源）
- 需要解释"角色会怎么反应"时

---

# 工具调用规则

**默认不调用。候选记忆通常够用。**

仅在以下情况调用：
1. 对话明确提到某事件/日期/人物，候选记忆里完全没有
2. 候选记忆有明显因果断裂（知道A和C，不知道B）
3. "其他记忆页面"标题显示有关键信息，且对当前对话至关重要

**以下理由不够格调用**：
- "可能有用" ✗
- "让我确认一下" ✗
- "补充背景" ✗ （候选记忆的背景够了）

---

# 输出格式
- 直接输出决策结果和记忆闪回；
- 根据决策流程直接在内部判断上述情况，不需要将决策流程、思路等写到<think>中

[记忆闪回]

（字数在200-500之间，不多于500字的连贯叙事）
- 时间线、故事页等中的D1D2等标识，在写叙事时不要写成D1，写成第一天/初识时等等，以此类推
- 写清事件之间的因果和情感脉络，保持因果与时间逻辑清晰可读，不得简化因果链，例如:
小红为了给小明买衣服所以去当铺当掉了自己心爱的包✓
小红给小明买衣服，小红当掉了包❌(缺失因果链，缺失"包是小红最喜欢的"一重要细节，传递出来的意思就偏移了)
- 保留对当前对话重要的具体细节
- 聚焦当前需要，不面面俱到
- 简单对话只需要简写逻辑即可
- 不要将## 当前对话中已有的剧情和内容写进叙事里，那些还没有形成长期记忆
- 保持语言客观中立，只回忆、不点评
- 不预测接下来的故事发展
- 基于已有内容，不要胡编乱造
- 书写记忆时，与当前叙事/本批内容紧密相连的记忆细节必须准确。例如: 用户说角色的屁股像派大星的屁股，不能省略为角色像派大星。
来源: pg_xx · pg_yy · pg_zz
[/记忆闪回]

---

# 上下文

## 故事索引
${formatStoryIndex(data)}

## Embedding候选记忆（按相关度排序）
${candidateSection}

## 其他记忆页面（仅标题，可用工具探索）
${catalogSection}

## NPC角色
${charList}

## 当前对话
${recentText}
# 现在，执行决策流程。` + getDirectiveSuffix('recall');
}

// ── Agent Retrieve ──

export async function agentRetrieve(data, recentText, candidatePages, maxPages) {
  if (data.pages.length === 0) {
    return { narrative: '', sourcePageIds: [], error: false };
  }

  const tools = buildAgentTools(data);
  const prompt = buildAgentPrompt(data, recentText, candidatePages, maxPages);
  const messages = [{ role: 'user', content: prompt }];
  const maxRounds = 3;
  let narrative = '';
  let apiFailed = false;

  log('MemGPT Agent: starting');

  for (let round = 0; round < maxRounds; round++) {
    log(`Agent round ${round + 1}/${maxRounds}`);
    let response;
    try {
      response = await callSecondaryApiChat(messages, tools, 800);
    } catch (err) {
      warn(`Agent round ${round + 1} failed:`, err);
      apiFailed = true;
      break;
    }

    // No tool calls → text is the final narrative
    if (response.toolCalls.length === 0) {
      narrative = (response.content || '').trim();
      log('Agent finished:', narrative.substring(0, 150));
      break;
    }

    // Process tool calls — sanitize empty content (API rejects empty string)
    const assistantMsg = { ...response.rawMessage };
    if (!assistantMsg.content) delete assistantMsg.content;
    messages.push(assistantMsg);

    for (const rawTc of response.rawToolCalls) {
      const name = rawTc.function?.name || '';
      let args;
      try {
        args = typeof rawTc.function?.arguments === 'string'
          ? JSON.parse(rawTc.function.arguments)
          : rawTc.function?.arguments || {};
      } catch (e) { args = {}; }

      const result = executeAgentTool(name, args, data);
      messages.push({ role: 'tool', tool_call_id: rawTc.id, content: result });
      log(`  [Round ${round + 1}] ${name}(${JSON.stringify(args).substring(0, 60)}) → ${result.substring(0, 100)}`);
    }

    // Last round: force text output (no tools)
    if (round === maxRounds - 1) {
      try {
        const finalResp = await callSecondaryApiChat(messages, [], 800);
        narrative = (finalResp.content || '').trim();
        log('Agent forced narrative:', narrative.substring(0, 150));
      } catch (err) {
        warn('Agent final round failed:', err);
        apiFailed = true;
      }
    }
  }

  // Strip <think>...</think> reasoning blocks (e.g. DeepSeek)
  narrative = narrative.replace(/<think>[\s\S]*?<\/think>/g, '').trim();

  // Empty or failed → return with error flag
  if (!narrative) {
    log(apiFailed ? 'Agent: API call failed' : 'Agent: empty response');
    return { narrative: '', sourcePageIds: [], error: true };
  }

  // Extract source page IDs from various formats:
  //   [来源: pg_xx · pg_yy]  or  来源: pg_xx · pg_yy · pg_zz
  const sourcePageIds = [];
  let sourceMatch = narrative.match(/\[来源[:\uff1a]\s*([^\]]+)\]/);
  if (sourceMatch) {
    narrative = narrative.replace(/\n?\[来源[:\uff1a][^\]]*\]\s*$/, '').trim();
  } else {
    sourceMatch = narrative.match(/来源[:\uff1a]\s*((?:pg_\S+[\s·,，]*)+)/);
    if (sourceMatch) {
      narrative = narrative.replace(/\n?来源[:\uff1a]\s*(?:pg_\S+[\s·,，]*)+\s*$/, '').trim();
    }
  }
  if (sourceMatch) {
    const ids = sourceMatch[1].split(/[,，·\s]+/).filter(s => s.startsWith('pg_'));
    sourcePageIds.push(...ids);
  }

  // Strip [记忆闪回]/[/记忆闪回] wrapper tags if LLM included them
  narrative = narrative.replace(/^\[记忆闪回\]\s*/, '').replace(/\s*\[\/记忆闪回\]\s*$/, '').trim();

  // Replace pg_xx IDs with readable page titles
  if (sourcePageIds.length > 0) {
    const readableSources = sourcePageIds.map(id => {
      const page = data.pages.find(p => p.id === id);
      return page ? `${page.day}「${page.title}」` : id;
    });
    narrative += `\n来源: ${readableSources.join(' · ')}`;
  }

  log('Agent narrative:', narrative.length, 'chars, sources:', sourcePageIds);
  return { narrative, sourcePageIds, error: false };
}

// ── Keyword Fallback ──

export function keywordFallbackRetrieve(data, queryKeywords, maxPages) {
  const scored = data.pages
    .filter(p => p.compressionLevel <= COMPRESS_SUMMARY)
    .map(p => {
      let score = 0;
      for (const kw of (p.keywords || [])) {
        if (queryKeywords.has(kw)) score += 2;
        for (const q of queryKeywords) {
          if (q !== kw && (q.includes(kw) || kw.includes(q))) score += 1;
        }
      }
      if (p.significance === 'high') score += 1;
      if (p.compressionLevel === 0) score += 0.5;
      return { page: p, score };
    })
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score);

  const pages = scored.slice(0, maxPages).map(s => s.page);

  // Find relevant characters from selected pages + keyword matches
  const mentionedChars = new Set();
  for (const p of pages) {
    for (const c of (p.characters || [])) mentionedChars.add(c);
  }
  // Also check if any character name appears in keywords
  for (const c of data.characters) {
    if (queryKeywords.has(c.name)) mentionedChars.add(c.name);
  }
  const characters = data.characters.filter(c => mentionedChars.has(c.name)).slice(0, 2);

  return { pages, characters };
}

export function extractQueryKeywords(recentMessages) {
  const text = recentMessages.map(m => m.mes || '').join(' ');
  const matches = text.match(/[\u4e00-\u9fff\u3400-\u4dbf]{2,}|[a-zA-Z]{3,}/g) || [];
  return new Set(matches);
}

// ── Main Retrieval (generate_interceptor) ──

/**
 * Main retrieval function registered as generate_interceptor.
 * NOTE: Does NOT call updateRecallFab(). Callers/index.js must handle FAB update.
 */
export async function retrieveMemories(chat, contextSize, abort, type) {
  if (type === 'quiet') return;
  if (!isAuthorized()) return;

  const s = getSettings();
  if (!s.enabled) return;

  const data = getMemoryData();

  // Extract recent messages for keyword/name analysis
  const recentCount = Math.min(5, chat.length);
  const recentMessages = chat.slice(-recentCount).filter(m => !m.is_system);
  const recentText = recentMessages.map(m => {
    let text = m.mes || '';
    // Extract only <content> tag content for char messages; strip metadata
    const contentMatch = text.match(/<content>([\s\S]*?)<\/content>/);
    if (contentMatch) {
      text = contentMatch[1].trim();
    } else {
      // Strip HTML comments (Tidal Memory etc.)
      text = text.replace(/<!--[\s\S]*?-->/g, '');
      // Strip <details> blocks
      text = text.replace(/<details>[\s\S]*?<\/details>/g, '');
    }
    return `${m.name}: ${text}`;
  }).join('\n');

  // === Layer 1: Always inject Story Index (timeline + items + known attitudes + NPC list) ===
  if (data.timeline || data.items.length > 0 || data.knownCharacterAttitudes.length > 0 || data.characters.length > 0) {
    const indexText = formatStoryIndex(data);
    setExtensionPrompt(
      PROMPT_KEY_INDEX,
      indexText,
      extension_prompt_types.IN_CHAT,
      s.indexDepth,
      false,
      extension_prompt_roles.SYSTEM,
    );
  } else {
    setExtensionPrompt(PROMPT_KEY_INDEX, '', extension_prompt_types.IN_CHAT, 0);
  }

  // === Layer 2 & 3: Retrieve Pages + Character Dossiers ===
  if (data.pages.length === 0 && data.characters.length === 0) {
    setExtensionPrompt(PROMPT_KEY_PAGES, '', extension_prompt_types.IN_CHAT, 0);
    lastNarrative = '';
    lastRecalledPages = [];
    lastRecalledChars = [];
    return;
  }

  // --- Retrieval flow: Embedding → Agent → Keyword fallback ---

  let narrative = '';
  let recalledChars = [];
  let sourcePageIds = [];

  // Step 1: Embedding pre-filter (if configured)
  let candidatePages = null;
  if (s.useEmbedding && isEmbeddingConfigured()) {
    try {
      const embResult = await embeddingPreFilter(data, recentText, s.embeddingTopK);
      if (embResult) {
        candidatePages = embResult.pages;
        recalledChars = embResult.characters || [];
        log('Embedding pre-filter returned', candidatePages.length, 'pages,', recalledChars.length, 'characters');
      }
    } catch (embErr) {
      warn('Embedding pre-filter failed, skipping:', embErr);
    }
  }

  // Step 2: MemGPT Agent (if secondary API configured)
  let agentFailed = false;
  if (s.useSecondaryApi && s.secondaryApiUrl && s.secondaryApiKey) {
    try {
      const result = await agentRetrieve(data, recentText, candidatePages, s.maxPages);
      narrative = result.narrative;
      sourcePageIds = result.sourcePageIds;
      agentFailed = result.error;
    } catch (agentErr) {
      warn('Agent retrieve failed:', agentErr);
      agentFailed = true;
    }
  }

  // Step 3: Fallback when agent failed or returned empty
  if (!narrative) {
    if (agentFailed) {
      // Agent was called but failed — notify user
      if (candidatePages && candidatePages.length > 0) {
        toastr?.warning?.('记忆代理调用失败，已降级为Embedding直接注入，请检查API状态哟(∪.∪ )...zzz', 'Memory Manager', { timeOut: 5000 });
        log('Agent failed, injecting embedding candidates:', candidatePages.length, 'pages');
        narrative = formatRecalledPages(candidatePages);
        sourcePageIds = candidatePages.map(p => p.id);
      } else {
        toastr?.warning?.('记忆代理调用失败，没有设置embedding端点，已降级为关键词检索，请检查API与embedding状态哟( •̀ .̫ •́ )✧', 'Memory Manager', { timeOut: 5000 });
        const queryKeywords = extractQueryKeywords(recentMessages);
        log('Agent failed, keyword fallback, keywords:', [...queryKeywords]);
        const kwResult = keywordFallbackRetrieve(data, queryKeywords, s.maxPages);
        if (kwResult.pages.length > 0) {
          narrative = formatRecalledPages(kwResult.pages);
          sourcePageIds = kwResult.pages.map(p => p.id);
        }
      }
    } else if (candidatePages && candidatePages.length > 0) {
      // Agent not configured — use embedding results directly
      log('No agent configured, using embedding candidates:', candidatePages.length, 'pages');
      narrative = formatRecalledPages(candidatePages);
      sourcePageIds = candidatePages.map(p => p.id);
    } else {
      // No agent, no embedding — keyword fallback
      const queryKeywords = extractQueryKeywords(recentMessages);
      log('Keyword fallback, keywords:', [...queryKeywords]);
      const kwResult = keywordFallbackRetrieve(data, queryKeywords, s.maxPages);
      if (kwResult.pages.length > 0) {
        narrative = formatRecalledPages(kwResult.pages);
        sourcePageIds = kwResult.pages.map(p => p.id);
      }
    }
  }

  // Build injection text
  const injectionParts = [];

  if (narrative) {
    // Agent narrative: wrap in [记忆闪回] tags
    // Keyword fallback (formatRecalledPages) already includes the tags
    if (narrative.startsWith('[记忆闪回]')) {
      injectionParts.push(narrative);
    } else {
      injectionParts.push(`[记忆闪回]\n${narrative}\n[/记忆闪回]`);
    }
  }

  if (recalledChars.length > 0) {
    for (const char of recalledChars) {
      injectionParts.push(formatDossier(char));
    }
  }

  if (injectionParts.length > 0) {
    setExtensionPrompt(
      PROMPT_KEY_PAGES,
      injectionParts.join('\n\n'),
      extension_prompt_types.IN_PROMPT,
      0,
      false,
      extension_prompt_roles.SYSTEM,
    );
  } else {
    setExtensionPrompt(PROMPT_KEY_PAGES, '', extension_prompt_types.IN_PROMPT, 0);
  }

  // Store for UI display
  lastNarrative = narrative;
  lastRecalledPages = sourcePageIds.map(id => data.pages.find(p => p.id === id)).filter(Boolean);
  lastRecalledChars = recalledChars;
  // NOTE: updateRecallFab() is NOT called here. index.js wrapper handles it.

  // Update mood based on recall results
  const totalRecalled = sourcePageIds.length + recalledChars.length;
  if (totalRecalled >= 3) {
    setMood('inlove', 6000);
  } else if (totalRecalled > 0) {
    setMood('joyful', 5000);
  }

  // Record in messageRecalls for the next message
  const nextMessageId = chat.length;
  if (sourcePageIds.length > 0) {
    data.messageRecalls[nextMessageId] = sourcePageIds;
    saveMemoryData();
  }
}
