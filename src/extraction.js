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
import { callLLM, gatherWorldBookContext, getActiveApiName } from './api.js';
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
const EXTRACTION_STALE_MS = 10 * 60 * 1000;
const HEALTH_NOTICE_MS = 15 * 1000;
const RECENT_EVENT_LIMIT = 20;
const TIMELINE_WARNING_THRESHOLD = 3;
const QUEUED_EXTRACTION_DELAY_MS = 500;
const extractionQueue = {
    timerId: null,
    running: false,
    rerunRequested: false,
    sources: new Set(),
};

export function resetConsecutiveFailures() {
    consecutiveFailures = 0;
    const data = getMemoryData();
    if (data?.diagnostics) {
        data.diagnostics.consecutiveFailures = 0;
        saveMemoryData();
    }
}

export function resetExtractionQueue() {
    if (extractionQueue.timerId) {
        clearTimeout(extractionQueue.timerId);
        extractionQueue.timerId = null;
    }
    extractionQueue.running = false;
    extractionQueue.rerunRequested = false;
    extractionQueue.sources.clear();
}

function addRecentEvent(data, event) {
    if (!data?.diagnostics) return;
    const entry = {
        at: Date.now(),
        ...event,
    };
    data.diagnostics.recentEvents.push(entry);
    if (data.diagnostics.recentEvents.length > RECENT_EVENT_LIMIT) {
        data.diagnostics.recentEvents = data.diagnostics.recentEvents.slice(-RECENT_EVENT_LIMIT);
    }
    saveMemoryData();
}

function setHealthNotice(data, text) {
    if (!data?.diagnostics) return;
    data.diagnostics.lastHealthNotice = text || '';
    data.diagnostics.lastHealthNoticeAt = text ? Date.now() : 0;
    saveMemoryData();
}

function setConsecutiveFailureCount(data, count) {
    consecutiveFailures = Math.max(0, count || 0);
    if (!data?.diagnostics) return;
    data.diagnostics.consecutiveFailures = consecutiveFailures;
    saveMemoryData();
}

function markExtractionSuccess(data) {
    setConsecutiveFailureCount(data, 0);
    if (!data?.diagnostics) return;
    data.diagnostics.lastSuccessfulExtractionAt = Date.now();
    data.diagnostics.lastFailureAt = 0;
    data.diagnostics.lastFailureReason = '';
    saveMemoryData();
}

function markExtractionFailure(data, reason) {
    const nextCount = consecutiveFailures + 1;
    setConsecutiveFailureCount(data, nextCount);
    if (!data?.diagnostics) return;
    data.diagnostics.lastFailureAt = Date.now();
    data.diagnostics.lastFailureReason = reason || '';
    saveMemoryData();
}

function markLockRecovered(data, reason, elapsedMs = 0) {
    if (!data?.diagnostics) return;
    data.diagnostics.lastLockRecoveryAt = Date.now();
    data.diagnostics.lastLockRecoveryReason = reason || '';
    setHealthNotice(data, '已从异常中恢复');
    addRecentEvent(data, {
        type: 'lock_recovery',
        source: reason || 'auto',
        started: false,
        recovered: true,
        success: true,
        api: getActiveApiName(),
        reason: elapsedMs > 0 ? `${reason || 'recovered'} after ${Math.round(elapsedMs / 1000)}s` : (reason || 'recovered'),
    });
}

function getHealthNotice(data) {
    const diagnostics = data?.diagnostics;
    if (!diagnostics?.lastHealthNotice || !diagnostics.lastHealthNoticeAt) return '';
    if ((Date.now() - diagnostics.lastHealthNoticeAt) > HEALTH_NOTICE_MS) return '';
    return diagnostics.lastHealthNotice;
}

function normalizeString(value) {
    if (value === null || value === undefined) return '';
    if (typeof value === 'string') return value.trim();
    if (typeof value === 'number' || typeof value === 'boolean') return String(value).trim();
    return '';
}

function normalizeStringList(value) {
    if (Array.isArray(value)) {
        return value
            .map(item => normalizeString(item))
            .filter(Boolean);
    }
    const single = normalizeString(value);
    return single ? [single] : [];
}

function normalizeTimelineValue(value) {
    if (typeof value === 'string') return value.trim();
    if (Array.isArray(value)) {
        return value.map(item => {
            if (typeof item === 'string') return item.trim();
            if (item && typeof item === 'object') {
                const label = normalizeString(item.time || item.date || item.label || item.key);
                const event = normalizeString(item.event || item.content || item.value || item.summary);
                if (label && event) return `${label}: ${event}`;
                if (label) return label;
                return '';
            }
            return normalizeString(item);
        }).filter(Boolean).join('\n');
    }
    if (value && typeof value === 'object') {
        const entries = Object.entries(value)
            .map(([key, item]) => {
                const left = normalizeString(key);
                const right = normalizeString(item);
                return left && right ? `${left}: ${right}` : '';
            })
            .filter(Boolean);
        return entries.join('\n');
    }
    return '';
}

function normalizeObjectArray(value) {
    if (Array.isArray(value)) return value.filter(item => item && typeof item === 'object');
    if (value && typeof value === 'object') return [value];
    return [];
}

function normalizeExtractionResult(raw) {
    const result = (raw && typeof raw === 'object') ? raw : {};
    const normalized = {
        timeline: normalizeTimelineValue(result.timeline),
        knownCharacterAttitudes: normalizeObjectArray(result.knownCharacterAttitudes).map(item => ({
            name: normalizeString(item.name),
            attitude: normalizeString(item.attitude || item.relationship),
            metDate: normalizeString(item.metDate || item.date || item.time),
        })).filter(item => item.name),
        newCharacters: normalizeObjectArray(result.newCharacters).map(item => ({
            name: normalizeString(item.name),
            role: normalizeString(item.role),
            appearance: normalizeString(item.appearance),
            personality: normalizeString(item.personality),
            attitude: normalizeString(item.attitude || item.relationship),
            keywords: normalizeStringList(item.keywords),
            metDate: normalizeString(item.metDate || item.date || item.time),
        })).filter(item => item.name),
        characters: normalizeObjectArray(result.characters).map(item => ({
            name: normalizeString(item.name),
            appearance: normalizeString(item.appearance),
            personality: normalizeString(item.personality),
            attitude: normalizeString(item.attitude || item.relationship),
        })).filter(item => item.name),
        items: normalizeObjectArray(result.items).map(item => ({
            name: normalizeString(item.name),
            status: normalizeString(item.status),
            significance: normalizeString(item.significance),
        })).filter(item => item.name),
        newPages: normalizeObjectArray(result.newPages).map(item => ({
            date: normalizeString(item.date || item.time),
            title: normalizeString(item.title),
            content: normalizeString(item.content || item.summary || item.description),
            keywords: normalizeStringList(item.keywords),
            categories: normalizeStringList(item.categories),
            significance: normalizeString(item.significance),
        })).filter(item => item.title && item.content),
    };

    if (!Array.isArray(result.newPages) && result.newPages !== undefined) {
        warn('Extraction result newPages was not an array; falling back to empty array');
        addRecentEvent(getMemoryData(), {
            type: 'parse_warning',
            source: 'newPages',
            started: false,
            success: false,
            api: getActiveApiName(),
            reason: 'newPages was not an array; ignored',
        });
        normalized.newPages = [];
    }

    return normalized;
}

function trackTimelineHealth(data, resultStats, source) {
    if (!data?.diagnostics) return;
    if (resultStats.newPageCount > 0 && !resultStats.timelineChanged) {
        data.diagnostics.timelineNoChangeWarnings += 1;
        const count = data.diagnostics.timelineNoChangeWarnings;
        const reason = `new pages created without timeline update (${count})`;
        warn('Timeline did not change even though new pages were created');
        addRecentEvent(data, {
            type: 'timeline_warning',
            source,
            started: false,
            success: false,
            api: getActiveApiName(),
            reason,
        });
        if (count >= TIMELINE_WARNING_THRESHOLD) {
            toastr?.warning?.('时间线连续多次没有更新，模型可能没有按要求返回 timeline。', 'Memory Manager', { timeOut: 5000 });
        }
    } else if (resultStats.timelineChanged) {
        data.diagnostics.timelineNoChangeWarnings = 0;
        saveMemoryData();
    }
}

function markExtractionStarted(data) {
    const now = Date.now();
    data.processing.extractionInProgress = true;
    data.processing.extractionStartedAt = now;
    data.processing.lastExtractionActivityAt = now;
    saveMemoryData();
}

function touchExtractionActivity(data) {
    if (!data?.processing?.extractionInProgress) return;
    data.processing.lastExtractionActivityAt = Date.now();
    saveMemoryData();
}

function clearExtractionLock(data) {
    if (!data?.processing) return;
    data.processing.extractionInProgress = false;
    data.processing.extractionStartedAt = 0;
    data.processing.lastExtractionActivityAt = 0;
    saveMemoryData();
}

function recoverStaleExtractionLock(data, force = false) {
    if (!data?.processing?.extractionInProgress) return false;

    const lastActivity = data.processing.lastExtractionActivityAt || data.processing.extractionStartedAt || 0;
    const elapsed = Date.now() - lastActivity;
    if (!force && elapsed < EXTRACTION_STALE_MS) return false;

    log('Auto-recovering stale extraction lock', { elapsedMs: elapsed, force });
    warn(`Clearing stale extraction lock after ${Math.round(elapsed / 1000)}s`);
    clearExtractionLock(data);
    markLockRecovered(data, force ? 'forced-lock-reset' : 'stale-lock-recovered', elapsed);
    return true;
}

function getExtractionWindow(chat, dates, settings) {
    if (!Array.isArray(chat) || chat.length === 0) {
        return { startIdx: -1, endIdx: 0, pendingMsgs: [] };
    }

    let endIdx = chat.length;
    if (settings.autoHide && settings.keepRecentMessages >= 3) {
        const buffer = Math.max(0, settings.keepRecentMessages - 2);
        endIdx = Math.max(0, chat.length - buffer);
    }

    let startIdx = -1;
    const pendingMsgs = [];
    for (let i = 0; i < endIdx; i++) {
        const msg = chat[i];
        if (!msg || msg.is_system || !msg.mes) continue;
        if (msg.send_date && dates[msg.send_date]) continue;
        if (startIdx === -1) startIdx = i;
        pendingMsgs.push(msg);
    }

    return { startIdx, endIdx, pendingMsgs };
}

// ── Core Functions ──

/**
 * 从聊天尾部向前扫描，找到最近一条已提取消息的索引。
 * 常规场景下只需扫描几条即可返回，O(1) 摊销复杂度。
 * @param {Array} chat - ctx.chat 数组
 * @param {Object} dates - data.processing.extractedMsgDates 字典
 * @returns {number} 最近已提取消息的索引，无则返回 -1
 */
export function getHighestExtractedIndex(chat, dates) {
    if (!chat || !dates) return -1;
    for (let i = chat.length - 1; i >= 0; i--) {
        const msg = chat[i];
        if (msg?.send_date && dates[msg.send_date]) return i;
    }
    return -1;
}

export function applyExtractionResult(data, result, sourceDates = []) {
    const previousTimeline = data.timeline || '';

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
                if (incoming.metDate && !existing.metDate) existing.metDate = incoming.metDate;
            } else {
                data.knownCharacterAttitudes.push({
                    name: incoming.name.trim(),
                    attitude: incoming.attitude || '',
                    metDate: incoming.metDate || '',
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
                metDate: c.metDate || '',
            };
            if (existingIdx >= 0) {
                // Merge: only overwrite non-empty fields
                if (charData.role) data.characters[existingIdx].role = charData.role;
                if (charData.appearance) data.characters[existingIdx].appearance = charData.appearance;
                if (charData.personality) data.characters[existingIdx].personality = charData.personality;
                if (charData.attitude) data.characters[existingIdx].attitude = charData.attitude;
                if (charData.metDate && !data.characters[existingIdx].metDate) data.characters[existingIdx].metDate = charData.metDate;
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
    return {
        newPageIds,
        newPageCount: newPageIds.length,
        timelineChanged: (data.timeline || '') !== previousTimeline,
    };
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
 * Perform incremental extraction based on extractedMsgDates.
 * NOTE: Does NOT call updateBrowserUI(). Caller (safeExtract) handles post-extraction flow.
 */
export async function performExtraction(source = 'auto') {
    const ctx = getContext();
    const data = getMemoryData();
    const s = getSettings();
    const chat = ctx.chat;
    const dates = data.processing.extractedMsgDates || {};
    const { startIdx, endIdx, pendingMsgs } = getExtractionWindow(chat, dates, s);
    if (startIdx < 0 || startIdx >= endIdx) return;
    if (pendingMsgs.length === 0) return;

    const BATCH_THRESHOLD = 25;
    const BATCH_SIZE = 20;

    if (pendingMsgs.length <= BATCH_THRESHOLD) {
        // Single-batch extraction (original behavior)
        const newMsgs = pendingMsgs.map(m => `${m.name}: ${m.mes}`).join('\n\n');
        log('Extracting from messages', startIdx, 'to', endIdx - 1, `(buffer: skipping last ${chat.length - endIdx} msgs)`);

        const prompt = buildExtractionPrompt(data, newMsgs);
        touchExtractionActivity(data);
        const response = await callLLM(
            '你是剧情记忆管理系统。严格按要求输出JSON。',
            prompt,
            s.extractionMaxTokens,
        );

        log('Extraction response length:', response?.length);

        const parsed = parseJsonResponse(response);
        if (!parsed) {
            throw new Error('Failed to parse extraction response');
        }

        const result = normalizeExtractionResult(parsed);
        const resultStats = applyExtractionResult(data, result, pendingMsgs.filter(m => m.send_date).map(m => m.send_date));
        trackTimelineHealth(data, resultStats, source);
        markMsgsExtracted(data, pendingMsgs);
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
            touchExtractionActivity(data);
            const response = await callLLM(
                '你是剧情记忆管理系统。严格按要求输出JSON。',
                prompt,
                initMaxTokens,
            );

            const parsed = parseJsonResponse(response);
            if (!parsed) {
                warn(`Batch ${bi + 1}: Failed to parse response, skipping`);
                continue;
            }

            const result = normalizeExtractionResult(parsed);
            const resultStats = applyExtractionResult(data, result, batch.map(item => item.msg?.send_date).filter(Boolean));
            trackTimelineHealth(data, resultStats, `${source}:batch-${bi + 1}`);
            markMsgsExtracted(data, batch.map(item => item.msg));
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

async function runQueuedExtraction() {
    if (extractionQueue.running) {
        extractionQueue.rerunRequested = true;
        addRecentEvent(data, {
            type: 'extract',
            source,
            started: false,
            success: false,
            api,
            reason: 'skipped: no chat',
        });
        return { started: false, requeue: false, reason: 'no_chat' };
    }

    extractionQueue.running = true;
    try {
        do {
            extractionQueue.rerunRequested = false;
            const sources = [...extractionQueue.sources];
            extractionQueue.sources.clear();
            const source = sources.length > 0 ? sources.join(', ') : 'queued';
            const result = await safeExtract(false, null, { source, queued: true });
            if (result?.requeue) {
                await new Promise(resolve => setTimeout(resolve, QUEUED_EXTRACTION_DELAY_MS));
                if (extractionQueue.sources.size === 0) {
                    extractionQueue.sources.add(source);
                }
                extractionQueue.rerunRequested = true;
            }
        } while (extractionQueue.rerunRequested || extractionQueue.sources.size > 0);
    } finally {
        extractionQueue.running = false;
    }
}

export function queueExtractionRequest(source = 'unknown') {
    const data = getMemoryData();
    extractionQueue.sources.add(source);
    addRecentEvent(data, {
        type: 'trigger',
        source,
        started: false,
        success: true,
        api: getActiveApiName(),
        reason: extractionQueue.running || extractionQueue.timerId ? 'merged into queued extraction' : 'queued',
    });

    if (extractionQueue.running || extractionQueue.timerId) return;

    extractionQueue.timerId = setTimeout(() => {
        extractionQueue.timerId = null;
        runQueuedExtraction().catch(err => warn('Queued extraction failed:', err));
    }, QUEUED_EXTRACTION_DELAY_MS);
}

export async function safeExtract(force = false, range = null, meta = {}) {
    const s = getSettings();
    if (!s.enabled && !force) return { started: false, requeue: false, reason: 'disabled' };

    const data = getMemoryData();
    const source = meta.source || (force ? 'force' : 'auto');
    const api = getActiveApiName();
    const recovered = recoverStaleExtractionLock(data, force);
    if (data.processing.extractionInProgress) {
        if (force) {
            markLockRecovered(data, 'manual-force-reset');
            clearExtractionLock(data);
            toastr?.info?.('检测到提取锁未释放，已自动重置，开始强制提取...', 'Memory Manager', { timeOut: 4000 });
            toastr?.info?.('检测到提取锁未释放，已自动重置，开始强制提取...', 'Memory Manager', { timeOut: 4000 });
        } else {
            log('Extraction already in progress, skipping');
            addRecentEvent(data, {
                type: 'extract',
                source,
                started: false,
                success: false,
                api,
                reason: 'skipped: extraction already in progress',
            });
            return { started: false, requeue: true, reason: 'already_in_progress' };
        }
    }

    const ctx = getContext();
    if (!ctx.chat || ctx.chat.length === 0) {
        if (force) toastr?.info?.('当前没有聊天记录', 'Memory Manager');
        addRecentEvent(data, {
            type: 'extract',
            source,
            started: false,
            success: false,
            api,
            reason: 'skipped: no chat',
        });
        return { started: false, requeue: false, reason: 'no_chat' };
    }

    if (is_send_press) {
        log('Send in progress, deferring extraction');
        if (force) toastr?.warning?.('消息发送中，请稍后再试', 'Memory Manager');
        addRecentEvent(data, {
            type: 'extract',
            source,
            started: false,
            success: false,
            api,
            reason: 'skipped: send in progress',
        });
        return { started: false, requeue: true, reason: 'send_in_progress' };
    }

    if (force) {
        addRecentEvent(data, {
            type: 'extract_start',
            source,
            started: true,
            success: true,
            api,
            reason: 'force extraction started',
        });
        await forceExtractUnprocessed(data, ctx, s, range);
        return { started: true, requeue: false, reason: 'force_finished' };
    }

    const dates = data.processing.extractedMsgDates || {};
    const { pendingMsgs } = getExtractionWindow(ctx.chat, dates, s);
    const pendingCount = pendingMsgs.length;
    if (pendingCount < s.extractionInterval) {
        addRecentEvent(data, {
            type: 'extract',
            source,
            started: false,
            success: true,
            api,
            reason: `skipped: pending below threshold (${pendingCount}/${s.extractionInterval})`,
        });
        return { started: false, requeue: false, reason: 'below_threshold' };
    }

    markExtractionStarted(data);
    setMood('thinking');
    addRecentEvent(data, {
        type: 'extract_start',
        source,
        started: true,
        success: true,
        api,
        reason: `pending=${pendingCount}${recovered ? ', recovered=true' : ''}`,
    });

    try {
            await performExtraction(source);
            markExtractionSuccess(data);
            setMood('joyful', 5000);
            await hideProcessedMessages();
            _ui.updateBrowserUI?.();
            addRecentEvent(data, {
                type: 'extract',
                source,
                started: true,
                success: true,
                api,
                recovered,
                reason: `success: pending=${pendingCount}`,
            });
            return { started: true, requeue: false, reason: 'success' };
        } catch (err) {
            warn('Extraction failed:', err);
            setMood('sad', 5000);
            addRecentEvent(data, {
                type: 'extract',
                source,
                started: true,
                success: false,
                api,
                recovered,
                reason: err.message,
            });
            markExtractionFailure(data, err.message);
            if (consecutiveFailures >= 3) {
                toastr?.warning?.('记忆提取连续失败，请检查API状态', 'Memory Manager');
                setConsecutiveFailureCount(data, 0);
            }
            return { started: true, requeue: false, reason: 'failed' };
        } finally {
            clearExtractionLock(data);
            _ui.updateStatusDisplay?.();
        }
}

/**
 * World-book-only extraction: no chat messages, just extract from world book content.
 * Used when initializing a new chat with world book data.
 */
async function _worldBookOnlyExtraction(data, s) {
    let worldBookContext = '';
    try {
        worldBookContext = await gatherWorldBookContext();
    } catch (err) {
        warn('Failed to gather world book context:', err);
    }

    if (!worldBookContext) {
        toastr?.info?.('没有未提取的消息，世界书也为空', 'Memory Manager');
        _ui.updateStatusDisplay?.();
        return;
    }

    markExtractionStarted(data);
    setMood('thinking');

    const initMaxTokens = Math.max(s.extractionMaxTokens, 8192);
    toastr?.info?.('从世界书/角色卡提取记忆...', 'Memory Manager', { timeOut: 5000 });
    _ui.updateInitProgressUI?.(0, 1, '正在从世界书提取记忆...');

    try {
        const prompt = buildExtractionPrompt(data, '（无聊天消息，请仅从下方世界书内容提取角色、物品、背景设定等信息）', worldBookContext);
        const response = await callLLM(
            '你是剧情记忆管理系统。严格按要求输出JSON。',
            prompt,
            initMaxTokens,
        );

        const parsed = parseJsonResponse(response);
        if (!parsed) {
            throw new Error('世界书提取结果解析失败');
        }

        const result = normalizeExtractionResult(parsed);
        const resultStats = applyExtractionResult(data, result, []);
        trackTimelineHealth(data, resultStats, 'worldbook');
        saveMemoryData();
        markExtractionSuccess(data);
        addRecentEvent(data, {
            type: 'extract',
            source: 'worldbook',
            started: true,
            success: true,
            api: getActiveApiName(),
            reason: `pages=${resultStats.newPageCount}, timelineChanged=${resultStats.timelineChanged}`,
        });

        _ui.updateInitProgressUI?.(1, 1, '世界书提取完成！');
        setMood('joyful', 5000);
        toastr?.success?.(
            `世界书提取完成！当前共 ${data.pages.length} 个故事页`,
            'Memory Manager', { timeOut: 8000 },
        );

        // Post-extraction tasks
        if (isEmbeddingConfigured()) {
            const newPages = data.pages.filter(p => !data.embeddings[p.id] && p.compressionLevel <= COMPRESS_SUMMARY);
            for (const page of newPages) {
                await embedPage(page);
            }
        }
        await safeCompress(false);
        _ui.updateBrowserUI?.();
    } catch (err) {
        warn('World book extraction failed:', err);
        setMood('sad', 5000);
        markExtractionFailure(data, err.message);
        addRecentEvent(data, {
            type: 'extract',
            source: 'worldbook',
            started: true,
            success: false,
            api: getActiveApiName(),
            reason: err.message,
        });
        toastr?.error?.('世界书提取失败: ' + err.message, 'Memory Manager');
    } finally {
        clearExtractionLock(data);
        _ui.updateStatusDisplay?.();
    }
}

/**
 * Force extraction: scan ALL chat messages, find unextracted ones by send_date marks,
 * batch them, extract with retry logic.
 */
export async function forceExtractUnprocessed(data, ctx, s, range = null, options = {}) {
    const dates = data.processing.extractedMsgDates || {};
    const chat = ctx.chat || [];

    // Buffer zone: skip last 4 messages (unless noBuffer is set)
    const BUFFER = options.noBuffer ? 0 : 4;
    const defaultEnd = options.noBuffer ? chat.length : Math.max(0, chat.length - BUFFER);

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

    // No unextracted messages — but if world book requested, try world-book-only extraction
    if (unextracted.length === 0) {
        if (options.includeWorldBook) {
            return await _worldBookOnlyExtraction(data, s);
        }
        toastr?.info?.('所有消息均已提取，没有需要处理的内容', 'Memory Manager');
        _ui.updateStatusDisplay?.();
        return;
    }

    markExtractionStarted(data);
    setMood('thinking');

    // Gather world book context if requested (used during initialization)
    let worldBookContext = '';
    if (options.includeWorldBook) {
        try {
            worldBookContext = await gatherWorldBookContext();
            if (worldBookContext) {
                log('World book context gathered:', worldBookContext.length, 'chars');
            }
        } catch (err) {
            warn('Failed to gather world book context:', err);
        }
    }

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
                const prompt = buildExtractionPrompt(data, batchText, worldBookContext);
                touchExtractionActivity(data);
                const response = await callLLM(
                    '你是剧情记忆管理系统。严格按要求输出JSON。',
                    prompt,
                    initMaxTokens,
                );

                const parsed = parseJsonResponse(response);
                if (!parsed) {
                    warn(`Force batch ${bi + 1}: Failed to parse response`);
                    forceFailedBatches.push({ index: bi, batch, reason: '解析失败' });
                    _ui.updateInitProgressUI?.(bi + 1, totalBatches, `第 ${bi + 1}/${totalBatches} 批解析失败，待重试`);
                    continue;
                }

                const result = normalizeExtractionResult(parsed);
                const resultStats = applyExtractionResult(data, result, batch.map(item => item.msg?.send_date).filter(Boolean));
                trackTimelineHealth(data, resultStats, `force-batch-${bi + 1}`);
                markMsgsExtracted(data, batch.map(item => item.msg));

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
                    const prompt = buildExtractionPrompt(data, batchText, worldBookContext);
                    touchExtractionActivity(data);
                    const response = await callLLM(
                        '你是剧情记忆管理系统。严格按要求输出JSON。',
                        prompt,
                        initMaxTokens,
                    );

                    const parsed = parseJsonResponse(response);
                    if (!parsed) {
                        forceFailedBatches.push({ index: retryList[ri].index, batch, reason: '重试解析失败' });
                        _ui.updateInitProgressUI?.(ri + 1, retryList.length, `重试第 ${ri + 1}/${retryList.length} 批解析仍失败`);
                        continue;
                    }

                    const result = normalizeExtractionResult(parsed);
                    const resultStats = applyExtractionResult(data, result, batch.map(item => item.msg?.send_date).filter(Boolean));
                    trackTimelineHealth(data, resultStats, `force-retry-${ri + 1}`);
                    markMsgsExtracted(data, batch.map(item => item.msg));

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
            markExtractionFailure(data, `${forceFailedBatches.length} force batches failed`);
            addRecentEvent(data, {
                type: 'extract',
                source: 'force',
                started: true,
                success: false,
                api: getActiveApiName(),
                reason: `${forceFailedBatches.length} failed batches after retry`,
            });
            _ui.updateInitProgressUI?.(totalBatches, totalBatches, `完成！${forceFailedBatches.length} 批失败`);
            setMood('sad', 6000);
            toastr?.warning?.(
                `强制提取完成: ${successCount} 批成功，${forceFailedBatches.length} 批仍失败`,
                'Memory Manager', { timeOut: 8000 },
            );
        } else {
            markExtractionSuccess(data);
            addRecentEvent(data, {
                type: 'extract',
                source: 'force',
                started: true,
                success: true,
                api: getActiveApiName(),
                reason: `successBatches=${successCount}`,
            });
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
        markExtractionFailure(data, err.message);
        addRecentEvent(data, {
            type: 'extract',
            source: 'force',
            started: true,
            success: false,
            api: getActiveApiName(),
            reason: err.message,
        });
        toastr?.error?.('强制提取出错: ' + err.message, 'Memory Manager');
    } finally {
        clearExtractionLock(data);
        _ui.updateStatusDisplay?.();
    }
}

// ── Auto-hide Processed Messages ──

export async function hideProcessedMessages() {
    const s = getSettings();
    if (!s.autoHide) return;

    const ctx = getContext();
    const data = getMemoryData();
    const dates = data.processing.extractedMsgDates || {};
    const lastExtracted = getHighestExtractedIndex(ctx.chat, dates);
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
