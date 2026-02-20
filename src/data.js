/**
 * Memory Manager — Data Layer
 * Settings, memory data CRUD, migrations, character name helpers.
 */

import {
    MODULE_NAME,
    DATA_VERSION,
    COMPRESS_FRESH,
    DEFAULT_SETTINGS,
} from './constants.js';
import { log, warn, generateId, setDebugMode } from './utils.js';

import {
    extension_settings,
    getContext,
    saveMetadataDebounced,
} from '../../../../extensions.js';

import {
    saveSettingsDebounced,
} from '../../../../../script.js';

const $ = window.jQuery;

// ── Settings ──

export function getSettings() {
    if (!extension_settings[MODULE_NAME]) {
        extension_settings[MODULE_NAME] = { ...DEFAULT_SETTINGS };
    }
    return extension_settings[MODULE_NAME];
}

export function saveSetting(key, value) {
    getSettings()[key] = value;
    saveSettingsDebounced();
}

/**
 * Load settings from extension_settings into UI elements.
 * NOTE: Callers must call refreshSlotListUI() separately after this.
 */
export function loadSettings() {
    const s = getSettings();
    for (const [key, val] of Object.entries(DEFAULT_SETTINGS)) {
        if (s[key] === undefined) s[key] = val;
    }

    // Migrate old autoCompress → new toggles
    if (s.autoCompress !== undefined) {
        if (s.compressTimeline === undefined) s.compressTimeline = s.autoCompress;
        if (s.compressPages === undefined) s.compressPages = s.autoCompress;
        if (s.archiveDaily === undefined) s.archiveDaily = false;
        delete s.autoCompress;
        if (s.archiveAfterPages !== undefined) {
            delete s.archiveAfterPages;
        }
        saveSettingsDebounced();
    }

    // Inject debug mode into utils.log()
    setDebugMode(s.debug);

    $('#mm_enabled').prop('checked', s.enabled);
    $('#mm_debug').prop('checked', s.debug);
    $('#mm_extraction_interval').val(s.extractionInterval);
    $('#mm_extraction_interval_value').text(s.extractionInterval);
    $('#mm_extraction_max_tokens').val(s.extractionMaxTokens);
    $('#mm_index_depth').val(s.indexDepth);
    $('#mm_recall_depth').val(s.recallDepth);
    $('#mm_max_pages').val(s.maxPages);
    $('#mm_max_pages_value').text(s.maxPages);
    $('#mm_show_recall_badges').prop('checked', s.showRecallBadges);

    // Compression
    $('#mm_compress_timeline').prop('checked', s.compressTimeline);
    $('#mm_compress_pages').prop('checked', s.compressPages);
    $('#mm_archive_daily').prop('checked', s.archiveDaily);

    // Auto-hide
    $('#mm_auto_hide').prop('checked', s.autoHide);
    $('#mm_keep_recent_messages').val(s.keepRecentMessages);
    toggleAutoHideFields(s.autoHide);

    // Secondary API
    $('#mm_use_secondary_api').prop('checked', s.useSecondaryApi);
    $('#mm_secondary_api_url').val(s.secondaryApiUrl);
    $('#mm_secondary_api_key').val(s.secondaryApiKey);
    $('#mm_secondary_api_model').val(s.secondaryApiModel);
    $('#mm_secondary_api_temperature').val(s.secondaryApiTemperature);
    toggleSecondaryApiFields(s.useSecondaryApi);

    // Known characters
    $('#mm_known_characters').val(s.knownCharacters);

    // NPC injection mode
    $('#mm_npc_injection_mode').val(s.npcInjectionMode || 'half');
    $('#mm_npc_keyword_scan_depth').val(s.npcKeywordScanDepth || 4);
    toggleNpcKeywordFields((s.npcInjectionMode || 'half') === 'keyword');

    // Embedding
    $('#mm_use_embedding').prop('checked', s.useEmbedding);
    $('#mm_embedding_model').val(s.embeddingModel);
    $('#mm_embedding_dimensions').val(s.embeddingDimensions);
    $('#mm_embedding_dimensions_value').text(s.embeddingDimensions);
    $('#mm_embedding_top_k').val(s.embeddingTopK);
    $('#mm_embedding_top_k_value').text(s.embeddingTopK);
    $('#mm_embedding_api_url').val(s.embeddingApiUrl);
    $('#mm_embedding_api_key').val(s.embeddingApiKey);
    toggleEmbeddingFields(s.useEmbedding);
}

// ── UI toggle helpers (used by loadSettings + bindSettingsPanel) ──

export function toggleSecondaryApiFields(show) {
    $('#mm_secondary_api_fields').toggle(show);
}

export function toggleAutoHideFields(show) {
    $('#mm_auto_hide_fields').toggle(show);
}

export function toggleEmbeddingFields(show) {
    $('#mm_embedding_fields').toggle(show);
}

export function toggleNpcKeywordFields(show) {
    $('#mm_npc_keyword_fields').toggle(show);
}

// ── Memory Data ──

export function createDefaultData() {
    return {
        version: DATA_VERSION,
        timeline: '',
        knownCharacterAttitudes: [],
        characters: [],
        items: [],
        pages: [],
        embeddings: {},
        processing: {
            lastExtractedMessageId: -1,
            extractionInProgress: false,
            extractedMsgDates: {},
        },
        messageRecalls: {},
        managerDirective: {
            global: '',
            extraction: '',
            recall: '',
            compression: '',
        },
    };
}

function migrateV1toV2(oldData) {
    log('Migrating data from v1 to v2...');
    const newData = createDefaultData();
    if (oldData.storyBible?.timeline) {
        newData.timeline = oldData.storyBible.timeline;
    }
    if (Array.isArray(oldData.storyBible?.characters)) {
        newData.characters = oldData.storyBible.characters.map(c => ({
            name: c.name || '',
            appearance: c.appearance || '',
            personality: c.personality || '',
            attitude: c.relationship || c.attitude || '',
        }));
    }
    if (Array.isArray(oldData.storyBible?.items)) {
        newData.items = oldData.storyBible.items.map(item => ({
            name: item.name || '',
            status: item.status || '',
            significance: item.significance || '',
        }));
    }
    if (Array.isArray(oldData.memories)) {
        newData.pages = oldData.memories
            .filter(m => m.status === 'active')
            .map(m => ({
                id: m.id || generateId(),
                day: m.day || '',
                title: m.title || '',
                content: m.content || '',
                keywords: m.tags || [],
                characters: [],
                significance: m.significance || 'medium',
                compressionLevel: COMPRESS_FRESH,
                sourceMessages: m.sourceMessages || [],
                createdAt: m.createdAt || Date.now(),
                compressedAt: null,
            }));
    }
    if (oldData.processing) {
        newData.processing = { ...newData.processing, ...oldData.processing };
    }
    if (oldData.messageRecalls) {
        newData.messageRecalls = oldData.messageRecalls;
    }
    log('Migration complete. Pages:', newData.pages.length, 'Characters:', newData.characters.length);
    return newData;
}

function migrateV2toV3(oldData) {
    log('Migrating data from v2 to v3...');
    const newData = createDefaultData();
    newData.timeline = oldData.timeline || '';
    newData.items = oldData.items || [];
    newData.pages = oldData.pages || [];
    newData.processing = { ...newData.processing, ...(oldData.processing || {}) };
    newData.messageRecalls = oldData.messageRecalls || {};
    const knownNames = getKnownCharacterNames();
    if (Array.isArray(oldData.characters)) {
        for (const c of oldData.characters) {
            if (!c.name) continue;
            const attitude = c.attitude || c.relationship || '';
            if (knownNames.has(c.name)) {
                newData.knownCharacterAttitudes.push({ name: c.name, attitude });
            } else {
                newData.characters.push({
                    name: c.name,
                    appearance: c.appearance || '',
                    personality: c.personality || '',
                    attitude,
                });
            }
        }
    }
    log('Migration v2->v3 complete. Known:', newData.knownCharacterAttitudes.length,
        'NPC:', newData.characters.length);
    return newData;
}

function migrateV3toV4(oldData) {
    log('Migrating data from v3 to v4...');
    const newData = createDefaultData();
    newData.timeline = oldData.timeline || '';
    newData.knownCharacterAttitudes = oldData.knownCharacterAttitudes || [];
    newData.characters = oldData.characters || [];
    newData.items = oldData.items || [];
    newData.processing = { ...newData.processing, ...(oldData.processing || {}) };
    newData.messageRecalls = oldData.messageRecalls || {};
    newData.pages = (oldData.pages || []).map(p => ({
        ...p,
        categories: Array.isArray(p.categories) ? p.categories : [],
    }));
    newData.embeddings = {};
    log('Migration v3->v4 complete. Pages:', newData.pages.length);
    return newData;
}

/** Run the full migration chain on imported data. Returns migrated data. */
export function runMigrationChain(imported) {
    if (imported.storyBible || imported.version === 1) {
        imported = migrateV1toV2(imported);
    }
    if (imported.version === 2) {
        imported = migrateV2toV3(imported);
    }
    if (imported.version === 3) {
        imported = migrateV3toV4(imported);
    }
    imported.version = DATA_VERSION;
    return imported;
}

export function getMemoryData() {
    const ctx = getContext();
    if (!ctx.chatMetadata) return createDefaultData();
    if (!ctx.chatMetadata.memoryManager) {
        ctx.chatMetadata.memoryManager = createDefaultData();
    }
    let d = ctx.chatMetadata.memoryManager;

    if (d.version !== DATA_VERSION) {
        d = runMigrationChain(d);
        ctx.chatMetadata.memoryManager = d;
        saveMemoryData();
        log('Data migrated and saved');
    }

    if (!Array.isArray(d.knownCharacterAttitudes)) {
        d.knownCharacterAttitudes = [];
    }
    if (!d.embeddings || typeof d.embeddings !== 'object') {
        d.embeddings = {};
    }
    if (!d.processing.extractedMsgDates) {
        d.processing.extractedMsgDates = {};
    }
    return d;
}

export function saveMemoryData() {
    saveMetadataDebounced();
}

// ── Character / Save Helpers ──

export function getKnownCharacterNames() {
    const s = getSettings();
    const ctx = getContext();
    const charName = (ctx.name2 || '').trim();
    const fromSetting = (s.knownCharacters || '')
        .split(/[,，]/)
        .map(n => n.trim())
        .filter(Boolean);
    const result = new Set(fromSetting);
    if (charName) result.add(charName);
    return result;
}

export function getCurrentCharName() {
    const ctx = getContext();
    return (ctx.name2 || '').trim();
}

// ── Save Index (stored in extension_settings) ──

export function getSaveIndex() {
    const s = getSettings();
    if (!s.saveIndex) s.saveIndex = {};
    return s.saveIndex;
}

export function updateSaveIndex(charName, slotData) {
    const idx = getSaveIndex();
    idx[charName] = slotData;
    saveSettingsDebounced();
}

export function listSlots(charName) {
    const idx = getSaveIndex();
    return idx[charName]?.slots || [];
}

export function getActiveSlotName(charName) {
    const idx = getSaveIndex();
    return idx[charName]?.activeSlot || null;
}
