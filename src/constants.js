/**
 * Memory Manager — Constants & Configuration
 */

export const MODULE_NAME = 'memory_manager';
export const LOG_PREFIX = '[MemMgr]';
export const PROMPT_KEY_INDEX = 'mm_story_index';
export const PROMPT_KEY_PAGES = 'mm_recalled_pages';
export const DATA_VERSION = 4;

// Compression level constants
export const COMPRESS_FRESH = 0;      // Full detail, 100-300 chars
export const COMPRESS_SUMMARY = 1;    // Compressed, 30-80 chars
export const COMPRESS_ARCHIVED = 2;   // Merged into timeline, page deleted

// Semantic category constants
export const MEMORY_CATEGORIES = {
    emotional:      '情感',
    relationship:   '关系',
    intimate:       '亲密',
    promise:        '承诺',
    conflict:       '冲突',
    discovery:      '发现',
    turning_point:  '转折',
    daily:          '日常',
};
export const VALID_CATEGORIES = new Set(Object.keys(MEMORY_CATEGORIES));

// Category color mapping (for UI)
export const CATEGORY_COLORS = {
    emotional:      '#ec4899',
    relationship:   '#f59e0b',
    intimate:       '#ef4444',
    promise:        '#8b5cf6',
    conflict:       '#f97316',
    discovery:      '#06b6d4',
    turning_point:  '#22c55e',
    daily:          '#6b7280',
};

// Lottie mood system
export const LOTTIE_CDN = 'https://cdnjs.cloudflare.com/ajax/libs/lottie-web/5.12.2/lottie_light.min.js';
export const MOOD_FILES = {
    idle: 'friendly-robot-animation_14079420.json',
    thinking: 'wink-robot-animation_14079421.json',
    joyful: 'joyful-robot-animation_14079418.json',
    inlove: 'inlove-robot-animation_14079419.json',
    angry: 'angry-robot-animation_14079422.json',
    sad: 'sad-robot-animation_14079423.json',
};

export const DEFAULT_SETTINGS = {
    enabled: true,
    debug: false,
    extractionInterval: 5,
    extractionMaxTokens: 4096,
    indexDepth: 9999,
    recallDepth: 2,
    maxPages: 3,
    showRecallBadges: true,
    // Compression (3 independent toggles)
    compressTimeline: true,
    compressPages: false,
    archiveDaily: false,
    compressAfterPages: 15,
    archiveThreshold: 50,
    maxTimelineEntries: 20,
    // Auto-hide
    autoHide: false,
    keepRecentMessages: 10,
    // Secondary API
    useSecondaryApi: false,
    secondaryApiUrl: '',
    secondaryApiKey: '',
    secondaryApiModel: '',
    secondaryApiTemperature: 0.3,
    // Known characters
    knownCharacters: '',
    // NPC injection mode: 'half' | 'full' | 'keyword'
    npcInjectionMode: 'half',
    npcKeywordScanDepth: 4,
    // === v5 additions ===
    // Embedding
    useEmbedding: false,
    embeddingModel: 'text-embedding-3-large',
    embeddingDimensions: 256,
    embeddingTopK: 10,
    embeddingApiUrl: '',
    embeddingApiKey: '',
};
