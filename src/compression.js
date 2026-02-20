/**
 * Memory Manager — Compression Engine (Progressive Compression)
 * Page compression (L0→L1), archiving (L1→L2), timeline compression.
 *
 * NOTE: safeCompress() does NOT call updateBrowserUI(). Callers must handle UI refresh.
 */

import { COMPRESS_FRESH, COMPRESS_SUMMARY } from './constants.js';
import { log, warn } from './utils.js';
import { getSettings, getMemoryData, saveMemoryData } from './data.js';
import { callLLM } from './api.js';
import { isEmbeddingConfigured, embedPage } from './embedding.js';
import { getDirectiveSuffix } from './formatting.js';
import { setMood } from './mood.js';

const toastr = window.toastr;

// ── Prompt Builders ──

export function buildPageCompressionPrompt(page) {
    return `[OOC: 将以下故事事件压缩为30-50字的精炼摘要。保留：谁、做了什么、为什么、结果如何。去除感官细节和修辞。

原文 (${page.day} - ${page.title}):
${page.content}

要求:
- 输出纯文本，不要JSON不要代码块
- 30-50字
- 保留因果关系和关键角色
- 不要丢失核心事实
]` + getDirectiveSuffix('compression');
}

export function buildTimelineCompressionPrompt(timeline, maxEntries) {
    return `[OOC: 以下剧情时间线条目过多，请压缩。

## 当前时间线
${timeline}

## 压缩规则
1. 最近5个条目保持不变
2. 更早的条目: 相邻的连续天数合并为范围 "D{起}-D{止}: 综合概括"
3. 合并后的条目用不超过30字的短句概括该段时期的核心事件
4. 压缩后总行数不超过 ${maxEntries} 行
5. 不丢失任何重要转折点或关系变化
6. 每行不超过30字，像书的目录一样简洁

## 输出
只输出压缩后的时间线文本，每行一条。不要JSON，不要代码块，不要解释。
]` + getDirectiveSuffix('compression');
}

// ── Core Compression Functions ──

export async function compressPage(data, pageId) {
    const page = data.pages.find(p => p.id === pageId);
    if (!page || page.compressionLevel !== COMPRESS_FRESH) return;

    log('Compressing page:', page.title, '(', page.content.length, 'chars )');

    try {
        const prompt = buildPageCompressionPrompt(page);
        const compressed = await callLLM(
            '你是文本压缩助手。只输出压缩结果。',
            prompt,
            200,
        );

        if (compressed && compressed.trim().length > 10) {
            page.content = compressed.trim();
            page.compressionLevel = COMPRESS_SUMMARY;
            page.compressedAt = Date.now();
            log('Page compressed:', page.title, '→', page.content.length, 'chars');

            // Re-embed after compression (content changed)
            if (getSettings().useEmbedding && isEmbeddingConfigured()) {
                try { await embedPage(page); } catch (_) { /* non-critical */ }
            }
        }
    } catch (err) {
        warn('Failed to compress page:', page.title, err);
    }
}

export function archivePage(data, pageId) {
    const idx = data.pages.findIndex(p => p.id === pageId);
    if (idx === -1) return;

    const page = data.pages[idx];
    if (page.compressionLevel < COMPRESS_SUMMARY) return;

    log('Archiving page:', page.title);
    data.pages.splice(idx, 1);

    // Clean up embedding
    if (data.embeddings) delete data.embeddings[pageId];

    // Clean up messageRecalls referencing this page
    for (const [msgId, ids] of Object.entries(data.messageRecalls)) {
        const filtered = ids.filter(id => id !== pageId);
        if (filtered.length === 0) {
            delete data.messageRecalls[msgId];
        } else {
            data.messageRecalls[msgId] = filtered;
        }
    }
}

export async function compressTimeline(data) {
    const s = getSettings();
    const lines = data.timeline.split('\n').filter(l => l.trim());

    if (lines.length <= s.maxTimelineEntries) return;

    log('Timeline has', lines.length, 'entries, compressing to', s.maxTimelineEntries);

    try {
        const prompt = buildTimelineCompressionPrompt(data.timeline, s.maxTimelineEntries);
        const compressed = await callLLM(
            '你是时间线压缩助手。只输出压缩后的时间线。',
            prompt,
            1000,
        );

        if (compressed && compressed.trim().length > 20) {
            const newLines = compressed.trim().split('\n').filter(l => l.trim());
            if (newLines.length <= lines.length) {
                data.timeline = compressed.trim();
                log('Timeline compressed:', lines.length, '→', newLines.length, 'entries');
            } else {
                warn('Timeline compression produced more lines, keeping original');
            }
        }
    } catch (err) {
        warn('Failed to compress timeline:', err);
    }
}

// ── Compression Cycle ──

export async function runCompressionCycle(data, force = false) {
    const s = getSettings();
    const anyEnabled = s.compressTimeline || s.compressPages || s.archiveDaily;
    if (!anyEnabled && !force) return { compressed: 0, archived: 0, timeline: false };

    log('Running compression cycle...');
    let compressedCount = 0;
    let archivedCount = 0;
    let timelineCompressed = false;

    // 1. Compress timeline if too long
    if (s.compressTimeline || force) {
        const beforeLen = (data.timeline || []).length;
        await compressTimeline(data);
        const afterLen = (data.timeline || []).length;
        if (afterLen < beforeLen) timelineCompressed = true;
    }

    // 2. Compress old L0 pages to L1 (optional)
    if (s.compressPages || force) {
        const freshPages = data.pages
            .filter(p => p.compressionLevel === COMPRESS_FRESH)
            .sort((a, b) => a.createdAt - b.createdAt);

        if (freshPages.length > s.compressAfterPages) {
            const toCompress = freshPages.slice(0, freshPages.length - s.compressAfterPages);
            log('Compressing', toCompress.length, 'fresh pages to summary');
            for (const page of toCompress) {
                await compressPage(data, page.id);
                saveMemoryData();
                compressedCount++;
            }
        }
    }

    // 3. Archive daily-only pages when total exceeds threshold (optional)
    if (s.archiveDaily || force) {
        const totalPages = data.pages.length;
        if (totalPages > s.archiveThreshold) {
            const dailyPages = data.pages
                .filter(p => p.compressionLevel >= COMPRESS_SUMMARY
                    && (p.categories || []).length === 1
                    && p.categories[0] === 'daily')
                .sort((a, b) => a.createdAt - b.createdAt);

            const excess = totalPages - s.archiveThreshold;
            const toArchive = dailyPages.slice(0, Math.min(excess, dailyPages.length));
            if (toArchive.length > 0) {
                log('Archiving', toArchive.length, 'daily pages (total', totalPages, '>', s.archiveThreshold, ')');
                for (const page of toArchive) {
                    archivePage(data, page.id);
                    archivedCount++;
                }
            }
        }
    }

    saveMemoryData();
    log('Compression cycle complete. Total pages:', data.pages.length);
    return { compressed: compressedCount, archived: archivedCount, timeline: timelineCompressed };
}

/**
 * Safe wrapper around runCompressionCycle with mood + toast feedback.
 * NOTE: Does NOT call updateBrowserUI(). Callers must handle UI refresh after this returns.
 */
export async function safeCompress(force = false) {
    try {
        setMood('angry');
        const data = getMemoryData();
        if (force) toastr?.info?.('开始压缩...', 'Memory Manager', { timeOut: 3000 });
        const result = await runCompressionCycle(data, force);
        setMood('idle');
        if (force) {
            const parts = [];
            if (result && result.compressed > 0) parts.push(`${result.compressed} 页压缩`);
            if (result && result.archived > 0) parts.push(`${result.archived} 页归档`);
            if (result && result.timeline) parts.push('时间线已压缩');
            if (parts.length > 0) {
                toastr?.success?.(`压缩完成: ${parts.join('，')}`, 'Memory Manager');
            } else {
                toastr?.info?.('当前没有需要压缩的内容', 'Memory Manager');
            }
        }
        return result;
    } catch (err) {
        warn('Compression cycle failed:', err);
        setMood('sad', 5000);
        if (force) {
            toastr?.error?.('压缩失败: ' + err.message, 'Memory Manager');
        }
        return null;
    }
}
