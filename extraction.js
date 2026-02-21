/**
 * Memory Manager — Extraction Engine
 * Incremental extraction, force extraction, auto-hide processed messages.
 *
 * UI callbacks (updateBrowserUI, updateStatusDisplay, updateInitProgressUI, hideInitProgressUI)
 * are injected via setExtractionUI() to avoid circular dependencies with ui-browser/ui-fab.
 */

import {
    VALID_CATEGORIES,
    COMPRESS_FRESH,
    COMPRESS_SUMMARY,
} from './constants.js';
import { log, warn, parseJsonResponse, generateId } from './utils.js';
import {
    getMemoryData, saveMemoryData, getSettings,
    getKnownCharacterNames,
} from './data.js';
import { callLLM } from './api.js';
import { buildExtractionPrompt, mergeTimelines } from './formatting.js';
import { setMood } from './mood.js';
import { isEmbeddingConfigured, embedPage, embedCharacter } from './embedding.js';
import { safeCompress } from './compression.js';

import { getContext } from '../../../../extensions.js';
import { is_send_press } from '../../../../../script.js';
import { hideChatMessageRange } from '../../../../chats.js';

const toastr = window.toastr;

// ── UI Callback Injection ──

let _ui = {};

/**
 * Inject UI callbacks to avoid circular dependency with ui-browser/ui-fab.
 * Must be called once during initialization.
 * @param {{ updateBrowserUI?: Function, updateStatusDisplay?: Function,
 *           updateInitProgressUI?: Function, hideInitProgressUI?: Function }} callbacks
 */
export function setExtractionUI(callbacks) {
    _ui = callbacks;
}

// ── Module State ──

let consecutiveFailures = 0;

export function resetConsecutiveFailures() {
    consecutiveFailures = 0;
}

// ── Core Functions ──

export function applyExtractionResult(data, result, sourceDates = []) {
    // Update timeline (merge to prevent data loss from weak LLM outputs)
    if (result.timeline) {
        data.timeline = mergeTimelines(data.timeline, result.timeline);
    }

    const ctx = getContext();
    const userName = (ctx.name1 || '').trim().toLowerCase();
    const knownNames = getKnownCharacterNames();
    const knownLower = new Set([...knownNames].map(n => n.toLowerCase()));

    // Update known character attitudes (new format)
    if (Array.isArray(result.knownCharacterAttitudes) && result.knownCharacterAttitudes.length > 0) {
        for (const incoming of result.knownCharacterAttitudes) {
            if (!incoming.name) continue;
            // Only accept characters actually in the known list
            if (!knownLower.has(incoming.name.trim().toLowerCase())) continue;
            const existing = data.knownCharacterAttitudes.find(
                k => k.name.toLowerCase() === incoming.name.trim().toLowerCase(),
            );
            if (existing) {
                if (incoming.attitude) existing.attitude = incoming.attitude;
            } else {
                data.knownCharacterAttitudes.push({
                    name: incoming.name.trim(),
                    attitude: incoming.attitude || '',
                });
            }
        }
    }

    // Update new NPC characters (new format) — merge, not replace
    if (Array.isArray(result.newCharacters) && result.newCharacters.length > 0) {
        for (const c of result.newCharacters) {
            if (!c.name || c.name.trim().toLowerCase() === userName) continue;
            if (knownLower.has(c.name.trim().toLowerCase())) continue;
            const existingIdx = data.characters.findIndex(
                ch => ch.name.toLowerCase() === c.name.trim().toLowerCase(),
            );
            const charData = {
                name: c.name.trim(),
                role: c.role || '',
                appearance: c.appearance || '',
                personality: c.personality || '',
                attitude: c.attitude || '',
                keywords: Array.isArray(c.keywords) ? c.keywords : [],
            };
            if (existingIdx >= 0) {
                // Merge: only overwrite non-empty fields
                if (charData.role) data.characters[existingIdx].role = charData.role;
                if (charData.appearance) data.characters[existingIdx].appearance = charData.appearance;
                if (charData.personality) data.characters[existingIdx].personality = charData.personality;
                if (charData.attitude) data.characters[existingIdx].attitude = charData.attitude;
                if (charData.keywords.length > 0) {
                    // Merge keywords: preserve existing, add new ones
                    const existingKws = new Set(data.characters[existingIdx].keywords || []);
                    for (const kw of charData.keywords) existingKws.add(kw);
                    data.characters[existingIdx].keywords = [...existingKws];
                }
            } else {
                data.characters.push(charData);
            }
        }
    }

    // Backward compatibility: if LLM returns old "characters" array instead of split format
    if (Array.isArray(result.characters) && !result.newCharacters) {
        for (const c of result.characters) {
            if (!c.name || c.name.trim().toLowerCase() === userName) continue;
            const attitude = c.attitude || c.relationship || '';
            if (knownLower.has(c.name.trim().toLowerCase())) {
                // Known character → update attitude only
                const existing = data.knownCharacterAttitudes.find(
                    k => k.name.toLowerCase() === c.name.trim().toLowerCase(),
                );
                if (existing) {
                    if (attitude) existing.attitude = attitude;
                } else {
                    data.knownCharacterAttitudes.push({
                        name: c.name.trim(),
                        attitude: attitude,
                    });
                }
            } else {
                // NPC character
                const existingIdx = data.characters.findIndex(
                    ch => ch.name.toLowerCase() === c.name.trim().toLowerCase(),
                );
                const charData = {
                    name: c.name || '',
                    appearance: c.appearance || '',
                    personality: c.personality || '',
                    attitude: attitude,
                };
                if (existingIdx >= 0) {
                    data.characters[existingIdx] = charData;
                } else {
                    data.characters.push(charData);
                }
                embedCharacter(charData).catch(() => {});
            }
        }
    }

    // Update items — merge, not replace
    if (Array.isArray(result.items)) {
        for (const item of result.items) {
            if (!item.name) continue;
            const existingIdx = data.items.findIndex(
                it => it.name.toLowerCase() === item.name.trim().toLowerCase(),
            );
            const itemData = {
                name: item.name.trim(),
                status: item.status || '',
                significance: item.significance || '',
            };
            if (existingIdx >= 0) {
                if (itemData.status) data.items[existingIdx].status = itemData.status;
                if (itemData.significance) data.items[existingIdx].significance = itemData.significance;
            } else {
                data.items.push(itemData);
            }
        }
    }

    // Add new pages
    const newPageIds = [];
    if (Array.isArray(result.newPages)) {
        for (const page of result.newPages) {
            if (!page.title || !page.content || page.content.length < 10) continue;
            const keywords = Array.isArray(page.keywords) ? page.keywords : [];
            if (keywords.length < 1) continue;

            // Extract character names from keywords
            const charNames = data.characters.map(c => c.name);
            const pageChars = keywords.filter(k => charNames.includes(k));

            // Validate and filter categories
            const rawCategories = Array.isArray(page.categories) ? page.categories : [];
            const categories = rawCategories.filter(c => VALID_CATEGORIES.has(c));

            const newId = generateId('pg');
            data.pages.push({
                id: newId,
                day: page.day || '',
                date: page.date || '',
                title: page.title,
                content: page.content,
                keywords: keywords,
                characters: pageChars,
                categories: categories,
                significance: page.significance || 'medium',
                compressionLevel: COMPRESS_FRESH,
                sourceMessages: [],
                sourceDates: [...sourceDates],
                createdAt: Date.now(),
                compressedAt: null,
            });
            newPageIds.push(newId);
        }
    }
    return newPageIds;
}

/** Mark messages as extracted by their send_date */
export function markMsgsExtracted(data, messages) {
    if (!data.processing.extractedMsgDates) data.processing.extractedMsgDates = {};
    for (const m of messages) {
        if (m && m.send_date) {
            data.processing.extractedMsgDates[m.send_date] = true;
        }
    }
}

/**
 * Perform incremental extraction based on watermark.
 * NOTE: Does NOT call updateBrowserUI(). Caller (safeExtract) handles post-extraction flow.
 */
export async function performExtraction() {
    const ctx = getContext();
    const data = getMemoryData();
    const lastId = data.processing.lastExtractedMessageId;

    const startIdx = Math.max(0, lastId + 1);
    const chat = ctx.chat;
    if (startIdx >= chat.length) return;

    // Buffer zone: skip recent N-2 messages to avoid extracting content user might re-roll
    const s = getSettings();
    let endIdx = chat.length; // exclusive
    if (s.autoHide && s.keepRecentMessages >= 3) {
        const buffer = Math.max(0, s.keepRecentMessages - 2);
        endIdx = Math.max(startIdx, chat.length - buffer);
    }
    if (startIdx >= endIdx) return;

    const pendingMsgs = chat.slice(startIdx, endIdx).filter(m => !m.is_system && m.mes);
    if (pendingMsgs.length === 0) return;

    const BATCH_THRESHOLD = 25;
    const BATCH_SIZE = 20;

    if (pendingMsgs.length <= BATCH_THRESHOLD) {
        // Single-batch extraction (original behavior)
        const newMsgs = pendingMsgs.map(m => `${m.name}: ${m.mes}`).join('\n\n');
        log('Extracting from messages', startIdx, 'to', endIdx - 1, `(buffer: skipping last ${chat.length - endIdx} msgs)`);

        const prompt = buildExtractionPrompt(data, newMsgs);
        const response = await callLLM(
            '你是剧情记忆管理系统。严格按要求输出JSON。',
            prompt,
            s.extractionMaxTokens,
        );

        log('Extraction response length:', response?.length);

        const result = parseJsonResponse(response);
        if (!result) {
            throw new Error('Failed to parse extraction response');
        }

        applyExtractionResult(data, result, pendingMsgs.filter(m => m.send_date).map(m => m.send_date));
        markMsgsExtracted(data, pendingMsgs);
        data.processing.lastExtractedMessageId = endIdx - 1;
        saveMemoryData();
    } else {
        // Multi-batch extraction for large backlogs
        const msgWithIdx = [];
        for (let i = startIdx; i < endIdx; i++) {
            const m = chat[i];
            if (!m.is_system && m.mes) {
                msgWithIdx.push({ msg: m, idx: i });
            }
        }

        const batches = [];
        for (let i = 0; i < msgWithIdx.length; i += BATCH_SIZE) {
            batches.push(msgWithIdx.slice(i, i + BATCH_SIZE));
        }

        log(`Batched extraction: ${msgWithIdx.length} messages → ${batches.length} batches`);
        const initMaxTokens = Math.max(s.extractionMaxTokens, 8192);

        for (let bi = 0; bi < batches.length; bi++) {
            const batch = batches[bi];
            const batchText = batch.map(item => `${item.msg.name}: ${item.msg.mes}`).join('\n\n');
            const batchLastIdx = batch[batch.length - 1].idx;

            log(`Batch ${bi + 1}/${batches.length}: messages ${batch[0].idx}-${batchLastIdx}`);
            toastr?.info?.(`正在提取第 ${bi + 1}/${batches.length} 批...`, 'Memory Manager', { timeOut: 3000 });

            const prompt = buildExtractionPrompt(data, batchText);
            const response = await callLLM(
                '你是剧情记忆管理系统。严格按要求输出JSON。',
                prompt,
                initMaxTokens,
            );

            const result = parseJsonResponse(response);
            if (!result) {
                warn(`Batch ${bi + 1}: Failed to parse response, skipping`);
                continue;
            }

            applyExtractionResult(data, result, batch.map(item => item.msg?.send_date).filter(Boolean));
            markMsgsExtracted(data, batch.map(item => item.msg));
            data.processing.lastExtractedMessageId = batchLastIdx;
            saveMemoryData();
            log(`Batch ${bi + 1}/${batches.length} done. Pages: ${data.pages.length}`);
        }
    }

    log('Extraction complete. Pages:', data.pages.length, 'Timeline updated.');

    // Embed newly created pages
    if (isEmbeddingConfigured()) {
        const newPages = data.pages.filter(p => !data.embeddings[p.id] && p.compressionLevel <= COMPRESS_SUMMARY);
        for (const page of newPages) {
            await embedPage(page);
        }
    }

    // Run compression cycle after extraction (checks individual toggles internally)
    await safeCompress(false);
}

export async function safeExtract(force = false, range = null) {
    const s = getSettings();
    if (!s.enabled && !force) return;

    const data = getMemoryData();
    if (data.processing.extractionInProgress) {
        if (force) {
            // Force extraction overrides any stale lock (can't be running after a page reload)
            warn('Force extract: clearing stale extractionInProgress lock');
            data.processing.extractionInProgress = false;
            saveMemoryData();
            toastr?.info?.('检测到提取锁未释放，已自动重置，开始强制提取...', 'Memory Manager', { timeOut: 4000 });
        } else {
            log('Extraction already in progress, skipping');
            return;
        }
    }

    const ctx = getContext();
    if (!ctx.chat || ctx.chat.length === 0) {
        if (force) toastr?.info?.('当前没有聊天记录', 'Memory Manager');
        return;
    }

    if (is_send_press) {
        log('Send in progress, deferring extraction');
        if (force) toastr?.warning?.('消息发送中，请稍后再试', 'Memory Manager');
        return;
    }

    if (force) {
        await forceExtractUnprocessed(data, ctx, s, range);
    } else {
        // Normal mode: watermark-based incremental extraction
        const pendingCount = ctx.chat.length - 1 - data.processing.lastExtractedMessageId;
        if (pendingCount < s.extractionInterval) return;

        data.processing.extractionInProgress = true;
        saveMemoryData();
        setMood('thinking');

        try {
            await performExtraction();
            consecutiveFailures = 0;
            setMood('joyful', 5000);
            await hideProcessedMessages();
            _ui.updateBrowserUI?.();
        } catch (err) {
            warn('Extraction failed:', err);
            setMood('sad', 5000);
            consecutiveFailures++;
            if (consecutiveFailures >= 3) {
                toastr?.warning?.('记忆提取连续失败，请检查API状态', 'Memory Manager');
                consecutiveFailures = 0;
            }
        } finally {
            data.processing.extractionInProgress = false;
            saveMemoryData();
            _ui.updateStatusDisplay?.();
        }
    }
}

/**
 * Force extraction: scan ALL chat messages, find unextracted ones by send_date marks,
 * batch them, extract with retry logic.
 */
export async function forceExtractUnprocessed(data, ctx, s, range = null) {
    const dates = data.processing.extractedMsgDates || {};
    const chat = ctx.chat;

    // Buffer zone: skip last 4 messages
    const BUFFER = 4;
    const defaultEnd = Math.max(0, chat.length - BUFFER);

    // Apply user-specified range if provided (range.end is inclusive from dialog)
    const scanStart = (range && typeof range.start === 'number') ? Math.max(0, range.start) : 0;
    const endIdx = (range && typeof range.end === 'number') ? Math.min(range.end + 1, defaultEnd) : defaultEnd;

    // Find all unextracted messages (including hidden ones — auto-hide sets is_system=true)
    const unextracted = [];
    for (let i = scanStart; i < endIdx; i++) {
        const m = chat[i];
        if (!m || !m.mes) continue;
        if (m.send_date && dates[m.send_date]) continue; // already extracted
        unextracted.push({ msg: m, idx: i });
    }

    if (unextracted.length === 0) {
        // All messages are already marked — sync the watermark to avoid phantom pending count
        if (endIdx - 1 > data.processing.lastExtractedMessageId) {
            data.processing.lastExtractedMessageId = endIdx - 1;
            saveMemoryData();
        }
        toastr?.info?.('所有消息均已提取，没有需要处理的内容', 'Memory Manager');
        _ui.updateStatusDisplay?.();
        return;
    }

    data.processing.extractionInProgress = true;
    saveMemoryData();
    setMood('thinking');

    const BATCH_SIZE = 20;
    const batches = [];
    for (let i = 0; i < unextracted.length; i += BATCH_SIZE) {
        batches.push(unextracted.slice(i, i + BATCH_SIZE));
    }

    const totalBatches = batches.length;
    let successCount = 0;
    let forceFailedBatches = [];
    const initMaxTokens = Math.max(s.extractionMaxTokens, 8192);

    toastr?.info?.(`发现 ${unextracted.length} 条未提取消息，分 ${totalBatches} 批处理...`, 'Memory Manager', { timeOut: 5000 });
    _ui.updateInitProgressUI?.(0, totalBatches, `强制提取: ${unextracted.length} 条未提取消息`);

    try {
        for (let bi = 0; bi < totalBatches; bi++) {
            const batch = batches[bi];
            const batchText = batch.map(item => `${item.msg.name}: ${item.msg.mes}`).join('\n\n');
            const batchLastIdx = batch[batch.length - 1].idx;

            _ui.updateInitProgressUI?.(bi, totalBatches, `正在等待第 ${bi + 1}/${totalBatches} 批 API 响应...`);

            try {
                const prompt = buildExtractionPrompt(data, batchText);
                const response = await callLLM(
                    '你是剧情记忆管理系统。严格按要求输出JSON。',
                    prompt,
                    initMaxTokens,
                );

                const result = parseJsonResponse(response);
                if (!result) {
                    warn(`Force batch ${bi + 1}: Failed to parse response`);
                    forceFailedBatches.push({ index: bi, batch, reason: '解析失败' });
                    _ui.updateInitProgressUI?.(bi + 1, totalBatches, `第 ${bi + 1}/${totalBatches} 批解析失败，待重试`);
                    continue;
                }

                applyExtractionResult(data, result, batch.map(item => item.msg?.send_date).filter(Boolean));
                markMsgsExtracted(data, batch.map(item => item.msg));

                // Advance watermark if applicable
                if (batchLastIdx > data.processing.lastExtractedMessageId) {
                    data.processing.lastExtractedMessageId = batchLastIdx;
                }

                saveMemoryData();
                successCount++;
                log(`Force batch ${bi + 1}/${totalBatches} done. Pages: ${data.pages.length}`);
                _ui.updateInitProgressUI?.(bi + 1, totalBatches, `第 ${bi + 1}/${totalBatches} 批完成，已有 ${data.pages.length} 个故事页`);
            } catch (err) {
                warn(`Force batch ${bi + 1} failed:`, err);
                forceFailedBatches.push({ index: bi, batch, reason: err.message });
                _ui.updateInitProgressUI?.(bi + 1, totalBatches, `第 ${bi + 1}/${totalBatches} 批失败: ${err.message.substring(0, 40)}`);
            }
        }

        // Retry failed batches once
        if (forceFailedBatches.length > 0) {
            const retryList = [...forceFailedBatches];
            forceFailedBatches = [];
            toastr?.info?.(`重试 ${retryList.length} 个失败批次...`, 'Memory Manager', { timeOut: 3000 });

            for (let ri = 0; ri < retryList.length; ri++) {
                const { batch } = retryList[ri];
                const batchText = batch.map(item => `${item.msg.name}: ${item.msg.mes}`).join('\n\n');
                const batchLastIdx = batch[batch.length - 1].idx;

                _ui.updateInitProgressUI?.(ri, retryList.length, `重试第 ${ri + 1}/${retryList.length} 批，等待API响应...`);

                try {
                    const prompt = buildExtractionPrompt(data, batchText);
                    const response = await callLLM(
                        '你是剧情记忆管理系统。严格按要求输出JSON。',
                        prompt,
                        initMaxTokens,
                    );

                    const result = parseJsonResponse(response);
                    if (!result) {
                        forceFailedBatches.push({ index: retryList[ri].index, batch, reason: '重试解析失败' });
                        _ui.updateInitProgressUI?.(ri + 1, retryList.length, `重试第 ${ri + 1}/${retryList.length} 批解析仍失败`);
                        continue;
                    }

                    applyExtractionResult(data, result, batch.map(item => item.msg?.send_date).filter(Boolean));
                    markMsgsExtracted(data, batch.map(item => item.msg));

                    if (batchLastIdx > data.processing.lastExtractedMessageId) {
                        data.processing.lastExtractedMessageId = batchLastIdx;
                    }

                    saveMemoryData();
                    successCount++;
                    _ui.updateInitProgressUI?.(ri + 1, retryList.length, `重试第 ${ri + 1}/${retryList.length} 批成功`);
                } catch (err) {
                    warn(`Force retry batch failed:`, err);
                    forceFailedBatches.push({ index: retryList[ri].index, batch, reason: err.message });
                    _ui.updateInitProgressUI?.(ri + 1, retryList.length, `重试第 ${ri + 1}/${retryList.length} 批失败`);
                }
            }
        }

        // Report results
        if (forceFailedBatches.length > 0) {
            _ui.updateInitProgressUI?.(totalBatches, totalBatches, `完成！${forceFailedBatches.length} 批失败`);
            setMood('sad', 6000);
            toastr?.warning?.(
                `强制提取完成: ${successCount} 批成功，${forceFailedBatches.length} 批仍失败`,
                'Memory Manager', { timeOut: 8000 },
            );
        } else {
            _ui.updateInitProgressUI?.(totalBatches, totalBatches, '强制提取完成！');
            setMood('joyful', 5000);
            toastr?.success?.(
                `强制提取完成！${successCount} 批全部成功，当前共 ${data.pages.length} 个故事页`,
                'Memory Manager', { timeOut: 8000 },
            );
            _ui.hideInitProgressUI?.();
        }

        // Post-extraction tasks
        if (isEmbeddingConfigured()) {
            const newPages = data.pages.filter(p => !data.embeddings[p.id] && p.compressionLevel <= COMPRESS_SUMMARY);
            for (const page of newPages) {
                await embedPage(page);
            }
        }
        await safeCompress(false);
        await hideProcessedMessages();
        _ui.updateBrowserUI?.();

    } catch (err) {
        warn('Force extraction error:', err);
        setMood('sad', 5000);
        toastr?.error?.('强制提取出错: ' + err.message, 'Memory Manager');
    } finally {
        data.processing.extractionInProgress = false;
        saveMemoryData();
        _ui.updateStatusDisplay?.();
    }
}

// ── Auto-hide Processed Messages ──

export async function hideProcessedMessages() {
    const s = getSettings();
    if (!s.autoHide) return;

    const ctx = getContext();
    const data = getMemoryData();
    const lastExtracted = data.processing.lastExtractedMessageId;
    if (lastExtracted < 0) return;

    const chatLen = ctx.chat.length;
    const hideUpTo = Math.min(lastExtracted, chatLen - 1 - s.keepRecentMessages);
    if (hideUpTo < 0) return;

    let hiddenCount = 0;
    for (let i = 0; i <= hideUpTo; i++) {
        if (ctx.chat[i] && !ctx.chat[i].is_system) {
            hiddenCount++;
        }
    }

    if (hiddenCount === 0) return;

    log(`Auto-hiding messages 0-${hideUpTo} (keeping last ${s.keepRecentMessages} visible)`);
    await hideChatMessageRange(0, hideUpTo, false);
}

/**
 * Recalculate the hide boundary after message deletion.
 * If messages were deleted, the "last N visible" window shifts down,
 * so previously hidden messages near the boundary should be unhidden.
 */
export async function recalculateHideRange() {
    const s = getSettings();
    if (!s.autoHide || s.keepRecentMessages < 1) return;

    const ctx = getContext();
    const chatLen = ctx.chat.length;
    if (chatLen === 0) return;

    // The correct hide boundary: keep last N messages visible
    const newHideUpTo = chatLen - 1 - s.keepRecentMessages;

    // Find the current highest hidden index
    let currentHideUpTo = -1;
    for (let i = chatLen - 1; i >= 0; i--) {
        if (ctx.chat[i] && ctx.chat[i].is_system) {
            currentHideUpTo = i;
            break;
        }
    }

    if (currentHideUpTo < 0) return; // Nothing is hidden

    // If the new boundary is lower than current, unhide the difference
    if (newHideUpTo < currentHideUpTo) {
        const unhideFrom = Math.max(0, newHideUpTo + 1);
        log(`Unhiding messages ${unhideFrom}-${currentHideUpTo} after deletion (keeping last ${s.keepRecentMessages} visible)`);
        await hideChatMessageRange(unhideFrom, currentHideUpTo, true);
    }
}
