/**
 * Memory Manager v5.5 — Modular Architecture
 *
 * Thin entry point: jQuery init, event binding, settings panel wiring.
 * All business logic lives in src/ modules.
 *
 * Three-layer memory system with semantic retrieval:
 *   Layer 1: Story Index (always injected, compact ~400-600 tokens, bounded)
 *   Layer 2: Story Pages (retrieved on demand via embedding + agent)
 *   Layer 3: Character Dossiers (retrieved on demand)
 */

// ── SillyTavern imports ──

import {
    eventSource,
    event_types,
    setExtensionPrompt,
    extension_prompt_types,
    extension_prompt_roles,
} from '../../../../script.js';

import {
    getContext,
} from '../../../extensions.js';

// ── Module imports ──

import { MODULE_NAME, PROMPT_KEY_INDEX, PROMPT_KEY_PAGES } from './src/constants.js';
import {
    getSettings, loadSettings, getMemoryData, saveMemoryData,
    saveSetting, getCurrentCharName, getActiveSlotName, listSlots,
    toggleSecondaryApiFields, toggleAutoHideFields, toggleEmbeddingFields,
} from './src/data.js';
import { isAuthorized, showAuthScreen, hideAuthScreen, bindAuthUI } from './src/auth.js';
import { testSecondaryApi } from './src/api.js';
import { saveToSlot } from './src/save.js';
import { testEmbeddingApi, rebuildAllVectors, rebuildCategories } from './src/embedding.js';
import { formatStoryIndex } from './src/formatting.js';
import {
    setExtractionUI, resetConsecutiveFailures,
    safeExtract, hideProcessedMessages, recalculateHideRange,
} from './src/extraction.js';
import { safeCompress } from './src/compression.js';
import {
    getLastRecalledPages,
    resetRetrievalState, retrieveMemories,
} from './src/retrieval.js';
import {
    updateBrowserUI, updateStatusDisplay, updateUnextractedBadges,
    refreshSlotListUI, onResetClick, onExportClick, onImportClick,
    onEditTimelineClick, onAddKnownChar, onAddNpcChar, onAddItem, onAddPage,
} from './src/ui-browser.js';
import {
    bindRecallFab, updateRecallFab,
    performBatchInitialization, updateInitProgressUI, hideInitProgressUI,
} from './src/ui-fab.js';
import { registerSlashCommands } from './src/commands.js';

import { log, warn } from './src/utils.js';

const $ = window.jQuery;
const toastr = window.toastr;

// ── Callback Injection (breaks circular deps) ──

setExtractionUI({
    updateBrowserUI,
    updateStatusDisplay,
    updateInitProgressUI,
    hideInitProgressUI,
});

// ── Global Interceptor ──
// Wraps retrieveMemories so the FAB updates after each retrieval.

window['memoryManager_retrieveMemories'] = async (...args) => {
    await retrieveMemories(...args);
    updateRecallFab();
};

// ── Settings Panel Wiring ──

function bindSettingsPanel() {
    $('#mm_enabled').on('change', function () { saveSetting('enabled', this.checked); });
    $('#mm_debug').on('change', function () { saveSetting('debug', this.checked); });
    $('#mm_extraction_interval').on('input', function () {
        const v = Number(this.value);
        $('#mm_extraction_interval_value').text(v);
        saveSetting('extractionInterval', v);
    });
    $('#mm_extraction_max_tokens').on('change', function () { saveSetting('extractionMaxTokens', Number(this.value)); });
    $('#mm_index_depth').on('change', function () { saveSetting('indexDepth', Number(this.value)); });
    $('#mm_recall_depth').on('change', function () { saveSetting('recallDepth', Number(this.value)); });
    $('#mm_max_pages').on('input', function () {
        const v = Number(this.value);
        $('#mm_max_pages_value').text(v);
        saveSetting('maxPages', v);
    });
    $('#mm_show_recall_badges').on('change', function () { saveSetting('showRecallBadges', this.checked); });
    $('#mm_compress_timeline').on('change', function () { saveSetting('compressTimeline', this.checked); });
    $('#mm_compress_pages').on('change', function () { saveSetting('compressPages', this.checked); });
    $('#mm_archive_daily').on('change', function () { saveSetting('archiveDaily', this.checked); });
    $('#mm_known_characters').on('change', function () { saveSetting('knownCharacters', this.value.trim()); });

    // NPC injection mode bindings
    $('#mm_npc_injection_mode').on('change', function () {
        saveSetting('npcInjectionMode', this.value);
        $('#mm_npc_keyword_fields').toggle(this.value === 'keyword');
    });
    $('#mm_npc_keyword_scan_depth').on('change', function () { saveSetting('npcKeywordScanDepth', Number(this.value)); });

    // Auto-hide bindings
    $('#mm_auto_hide').on('change', function () {
        saveSetting('autoHide', this.checked);
        toggleAutoHideFields(this.checked);
        if (this.checked) hideProcessedMessages();
    });
    $('#mm_keep_recent_messages').on('change', function () {
        saveSetting('keepRecentMessages', Number(this.value));
        hideProcessedMessages();
    });

    // Secondary API bindings
    $('#mm_use_secondary_api').on('change', function () {
        saveSetting('useSecondaryApi', this.checked);
        toggleSecondaryApiFields(this.checked);
    });
    $('#mm_secondary_api_url').on('change', function () { saveSetting('secondaryApiUrl', this.value.trim()); });
    $('#mm_secondary_api_key').on('change', function () { saveSetting('secondaryApiKey', this.value.trim()); });
    $('#mm_secondary_api_model').on('change', function () { saveSetting('secondaryApiModel', this.value.trim()); });
    $('#mm_secondary_api_temperature').on('change', function () { saveSetting('secondaryApiTemperature', Number(this.value)); });
    $('#mm_test_secondary_api').on('click', testSecondaryApi);

    // Save management bindings
    $('#mm_save_now').on('click', async () => {
        const charName = getCurrentCharName();
        if (!charName) { toastr.warning('请先选择角色'); return; }
        const active = getActiveSlotName(charName);
        if (!active) { toastr.warning('当前未绑定存档，请先新建或加载一个存档', 'Memory Manager'); return; }
        await saveToSlot(charName, active);
        toastr.success(`已保存到存档「${active}」`);
        refreshSlotListUI();
    });
    $('#mm_new_slot').on('click', async () => {
        const charName = getCurrentCharName();
        if (!charName) { toastr.warning('请先选择角色'); return; }
        const name = prompt('新存档名称:', `IF线${Date.now() % 1000}`);
        if (!name) return;
        await saveToSlot(charName, name.trim());
        toastr.success(`已创建存档「${name.trim()}」`);
        refreshSlotListUI();
    });

    // Embedding bindings
    $('#mm_use_embedding').on('change', function () {
        saveSetting('useEmbedding', this.checked);
        toggleEmbeddingFields(this.checked);
    });
    $('#mm_embedding_model').on('change', function () { saveSetting('embeddingModel', this.value.trim()); });
    $('#mm_embedding_dimensions').on('input', function () {
        const v = Number(this.value);
        $('#mm_embedding_dimensions_value').text(v);
        saveSetting('embeddingDimensions', v);
    });
    $('#mm_embedding_top_k').on('input', function () {
        const v = Number(this.value);
        $('#mm_embedding_top_k_value').text(v);
        saveSetting('embeddingTopK', v);
    });
    $('#mm_embedding_api_url').on('change', function () { saveSetting('embeddingApiUrl', this.value.trim()); });
    $('#mm_embedding_api_key').on('change', function () { saveSetting('embeddingApiKey', this.value.trim()); });
    $('#mm_test_embedding').on('click', async () => {
        try {
            const result = await testEmbeddingApi();
            $('#mm_embedding_status').text(`连接成功！向量维度: ${result}`);
            toastr.success('Embedding API 连接成功');
        } catch (err) {
            $('#mm_embedding_status').text(`连接失败: ${err.message}`);
            toastr.error('Embedding API 连接失败: ' + err.message);
        }
    });
    $('#mm_rebuild_vectors').on('click', async () => {
        if (!confirm('重建向量库将为所有页面重新生成向量，确认？')) return;
        try {
            $('#mm_embedding_status').text('正在重建向量库...');
            await rebuildAllVectors();
            const data = getMemoryData();
            const count = Object.keys(data.embeddings).length;
            $('#mm_embedding_status').text(`重建完成！已索引 ${count} 个页面`);
            toastr.success(`向量库重建完成，${count} 个页面已索引`);
            updateBrowserUI(['embedding']);
        } catch (err) {
            $('#mm_embedding_status').text(`重建失败: ${err.message}`);
            toastr.error('向量库重建失败: ' + err.message);
        }
    });
    $('#mm_rebuild_categories').on('click', async () => {
        if (!confirm('将使用副API为所有未分类页面自动分配语义标签，确认？')) return;
        try {
            $('#mm_embedding_status').text('正在分配分类标签...');
            await rebuildCategories();
            $('#mm_embedding_status').text('分类标签分配完成');
            updateBrowserUI(['pageList']);
        } catch (err) {
            $('#mm_embedding_status').text(`分类分配失败: ${err.message}`);
            toastr.error('分类标签分配失败: ' + err.message);
        }
    });

    // Action buttons
    $('#mm_force_extract').on('click', () => safeExtract(true));
    $('#mm_force_compress').on('click', async () => {
        await safeCompress(true);
        updateBrowserUI();
    });
    $('#mm_initialize').on('click', performBatchInitialization);
    $('#mm_reset').on('click', onResetClick);
    $('#mm_export').on('click', onExportClick);
    $('#mm_import').on('click', onImportClick);
    $('#mm_edit_timeline').on('click', onEditTimelineClick);
    $('#mm_add_known_char').on('click', onAddKnownChar);
    $('#mm_add_npc_char').on('click', onAddNpcChar);
    $('#mm_add_item').on('click', onAddItem);
    $('#mm_add_page').on('click', onAddPage);

    // Settings lock (防误触)
    const LOCK_KEY = 'mm_settings_locked';
    function applyLockState(locked) {
        const $content = $('#mm_main_content');
        const $icon = $('#mm_settings_lock_btn i');
        const $label = $('#mm_lock_label');
        if (locked) {
            $content.addClass('mm-settings-locked');
            $icon.removeClass('fa-lock-open').addClass('fa-lock');
            $label.text('已锁定');
        } else {
            $content.removeClass('mm-settings-locked');
            $icon.removeClass('fa-lock').addClass('fa-lock-open');
            $label.text('防误触');
        }
    }
    const initialLocked = localStorage.getItem(LOCK_KEY) === 'true';
    applyLockState(initialLocked);
    $('#mm_settings_lock_btn').on('click', function () {
        const nowLocked = !$('#mm_main_content').hasClass('mm-settings-locked');
        localStorage.setItem(LOCK_KEY, nowLocked);
        applyLockState(nowLocked);
    });
}

// ── Event Handlers ──

async function onChatEvent() {
    if (!getSettings().enabled) return;
    setTimeout(() => safeExtract(false), 500);
}

function onMessageDeleted() {
    if (!getSettings().enabled) return;

    // Recalculate auto-hide boundary after deletion
    recalculateHideRange();

    const data = getMemoryData();
    const dates = data.processing.extractedMsgDates || {};
    if (Object.keys(dates).length === 0) return;

    const ctx = getContext();
    const chatDates = new Set();
    if (ctx.chat) {
        for (const m of ctx.chat) {
            if (m && m.send_date) chatDates.add(m.send_date);
        }
    }

    let orphanCount = 0;
    for (const d of Object.keys(dates)) {
        if (!chatDates.has(d)) orphanCount++;
    }

    if (orphanCount > 0) {
        toastr?.warning?.(
            `检测到 ${orphanCount} 条已提取但已删除的消息。建议打开小电视→工具箱→记忆体检，清理孤立记忆。`,
            'Memory Manager',
            { timeOut: 8000 },
        );
    }
}

function onChatChanged() {
    setExtensionPrompt(PROMPT_KEY_INDEX, '', extension_prompt_types.IN_CHAT, 0);
    setExtensionPrompt(PROMPT_KEY_PAGES, '', extension_prompt_types.IN_CHAT, 0);
    resetRetrievalState();
    resetConsecutiveFailures();

    const data = getMemoryData();
    if (data.processing.extractionInProgress) {
        data.processing.extractionInProgress = false;
        saveMemoryData(); // Persist the reset — prevents stale lock from surviving page reloads on the same chat
    }

    // Notify if this character has saves but current chat has no memory
    const charName = getCurrentCharName();
    if (charName && !data.timeline && data.pages.length === 0) {
        const slots = listSlots(charName);
        if (slots.length > 0) {
            const names = slots.map(s => s.name).join('、');
            toastr?.info?.(
                `角色「${charName}」有 ${slots.length} 个记忆存档：${names}，请前往插件面板选择加载`,
                'Memory Manager',
                { timeOut: 8000 },
            );
        }
    }

    // Re-inject story index
    if (data.timeline || data.characters.length > 0) {
        const s = getSettings();
        setExtensionPrompt(
            PROMPT_KEY_INDEX,
            formatStoryIndex(data),
            extension_prompt_types.IN_CHAT,
            s.indexDepth,
            false,
            extension_prompt_roles.SYSTEM,
        );
    }

    updateBrowserUI();
    hideProcessedMessages();
    setTimeout(updateUnextractedBadges, 1000);
}

function onMessageRendered(messageId) {
    if (getLastRecalledPages().length > 0) {
        const data = getMemoryData();
        if (!data.messageRecalls[messageId]) {
            data.messageRecalls[messageId] = getLastRecalledPages().map(p => p.id);
            saveMemoryData();
        }
    }
    updateUnextractedBadges(messageId);
}

// ── Initialization ──

function fullInitialize() {
    bindSettingsPanel();
    bindRecallFab();

    // Register events
    eventSource.on(event_types.CHAT_CHANGED, onChatChanged);
    eventSource.makeLast(event_types.CHARACTER_MESSAGE_RENDERED, onChatEvent);
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, onMessageRendered);
    for (const evt of [event_types.MESSAGE_DELETED, event_types.MESSAGE_UPDATED, event_types.MESSAGE_SWIPED]) {
        eventSource.on(evt, onChatEvent);
    }
    eventSource.on(event_types.MESSAGE_DELETED, onMessageDeleted);

    registerSlashCommands();
    updateBrowserUI();

    log('Memory Manager v5.5 (Modular) initialized');
}

jQuery(async function () {
    try {
        const baseUrl = new URL('.', import.meta.url).pathname;
        const settingsHtml = await $.get(`${baseUrl}settings.html`);
        $('#extensions_settings2').append(settingsHtml);
    } catch (err) {
        warn('Failed to load settings HTML:', err);
    }

    loadSettings();

    // === AUTH GATE ===
    if (!isAuthorized()) {
        showAuthScreen();
        bindAuthUI(fullInitialize);
        return;
    }

    hideAuthScreen();
    fullInitialize();
});

export { MODULE_NAME };
