/**
 * Memory Manager — Browser Settings Panel UI
 * updateBrowserUI, status display, CRUD operations, export/import/reset.
 *
 * NOTE: No circular dependency on extraction/compression/retrieval.
 */

import {
    PROMPT_KEY_INDEX, PROMPT_KEY_PAGES,
    MEMORY_CATEGORIES, CATEGORY_COLORS,
    COMPRESS_FRESH, COMPRESS_SUMMARY,
} from './constants.js';
import { warn, escapeHtml, generateId } from './utils.js';
import {
    getSettings, getMemoryData, saveMemoryData, createDefaultData,
    getCurrentCharName, getActiveSlotName,
    listSlots,
} from './data.js';
import { loadFromSlot, deleteSlot } from './save.js';
import { embedPage, embedCharacter } from './embedding.js';

import {
    setExtensionPrompt,
    extension_prompt_types,
} from '../../../../../script.js';
import {
    getContext,
} from '../../../../extensions.js';

const $ = window.jQuery;
const toastr = window.toastr;

// ── Main Update Function ──

/**
 * Update the settings panel browser UI.
 * @param {string[]} [sections] - specific sections to update (e.g. ['pageList', 'status'])
 *   If omitted, updates everything.
 */
export function updateBrowserUI(sections) {
    const data = getMemoryData();
    const s = getSettings();
    const all = !sections;

    // Sync checkboxes / inputs with current settings
    if (all) {
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
        $('#mm_compress_timeline').prop('checked', s.compressTimeline);
        $('#mm_compress_pages').prop('checked', s.compressPages);
        $('#mm_archive_daily').prop('checked', s.archiveDaily);
        $('#mm_known_characters').val(s.knownCharacters || '');
        $('#mm_npc_injection_mode').val(s.npcInjectionMode || 'half');
        $('#mm_npc_keyword_fields').toggle((s.npcInjectionMode || 'half') === 'keyword');
        $('#mm_npc_keyword_scan_depth').val(s.npcKeywordScanDepth || 4);
        $('#mm_auto_hide').prop('checked', s.autoHide);
        $('#mm_auto_hide_fields').toggle(!!s.autoHide);
        $('#mm_keep_recent_messages').val(s.keepRecentMessages);
        $('#mm_use_secondary_api').prop('checked', s.useSecondaryApi);
        $('#mm_secondary_api_fields').toggle(!!s.useSecondaryApi);
        $('#mm_secondary_api_url').val(s.secondaryApiUrl || '');
        $('#mm_secondary_api_key').val(s.secondaryApiKey || '');
        $('#mm_secondary_api_model').val(s.secondaryApiModel || '');
        $('#mm_secondary_api_temperature').val(s.secondaryApiTemperature ?? 0.3);
        $('#mm_use_embedding').prop('checked', s.useEmbedding);
        $('#mm_embedding_fields').toggle(!!s.useEmbedding);
        $('#mm_embedding_model').val(s.embeddingModel || '');
        $('#mm_embedding_dimensions').val(s.embeddingDimensions || 256);
        $('#mm_embedding_dimensions_value').text(s.embeddingDimensions || 256);
        $('#mm_embedding_top_k').val(s.embeddingTopK || 10);
        $('#mm_embedding_top_k_value').text(s.embeddingTopK || 10);
        $('#mm_embedding_api_url').val(s.embeddingApiUrl || '');
        $('#mm_embedding_api_key').val(s.embeddingApiKey || '');
    }

    // Timeline
    if (all || sections.includes('timeline')) {
        $('#mm_bible_timeline').text(data.timeline || '（尚无数据）');
    }

    // Known character attitudes
    if (all || sections.includes('knownChars')) {
        renderKnownCharsSection(data);
    }

    // NPC Characters
    if (all || sections.includes('characters')) {
        renderNpcCharsSection(data);
    }

    // Items
    if (all || sections.includes('items')) {
        renderItemsSection(data);
    }

    // Pages
    if (all || sections.includes('pageList')) {
        renderPageList(data);
    }

    // Status
    if (all || sections.includes('status')) {
        updateStatusDisplay();
    }

    // Save slots
    if (all || sections.includes('slots')) {
        refreshSlotListUI();
    }

    // Embedding status
    if (all || sections.includes('embedding')) {
        const count = data.embeddings ? Object.keys(data.embeddings).length : 0;
        if (count > 0) {
            $('#mm_embedding_status').text(`已索引 ${count} 项`);
        }
    }
}

// ── Status Display ──

export function updateStatusDisplay() {
    const data = getMemoryData();
    const ctx = getContext();
    const dates = data.processing.extractedMsgDates || {};

    // Count by scanning actual chat messages — avoid inflating pending
    // with messages that share a send_date key or have no trackable date.
    // is_system (auto-hidden) messages still have send_date and must be included.
    let extractedCount = 0;
    let pendingCount = 0;
    if (ctx.chat) {
        for (const msg of ctx.chat) {
            if (!msg || !msg.send_date) continue; // no trackable key → skip
            if (dates[msg.send_date]) {
                extractedCount++;
            } else {
                pendingCount++;
            }
        }
    }

    if (data.processing.extractionInProgress) {
        $('#mm_status_text').text('提取中...');
    } else if (extractedCount > 0) {
        $('#mm_status_text').text('就绪');
    } else {
        $('#mm_status_text').text('未初始化');
    }

    $('#mm_processed_count').text(extractedCount);
    $('#mm_pending_count').text(pendingCount);
}

// ── Unextracted Badges ──

export function updateUnextractedBadges(messageId) {
    const s = getSettings();
    if (!s.showRecallBadges) return;

    const data = getMemoryData();
    const dates = data.processing.extractedMsgDates || {};

    if (messageId !== undefined) {
        // Update single message
        _updateSingleBadge(messageId, dates, data);
        return;
    }

    // Full scan
    const ctx = getContext();
    if (!ctx.chat) return;
    for (let i = 0; i < ctx.chat.length; i++) {
        _updateSingleBadge(i, dates, data);
    }
}

function _updateSingleBadge(messageId, dates, data) {
    const ctx = getContext();
    const msg = ctx.chat?.[messageId];
    if (!msg || msg.is_system) return;

    const el = $(`.mes[mesid="${messageId}"]`);
    if (el.length === 0) return;

    // Remove existing badges
    el.find('.mm-recall-badge, .mm-unextracted-badge').remove();

    // Recall badge
    const recalls = data.messageRecalls[messageId];
    if (recalls && recalls.length > 0) {
        const pages = recalls.map(id => data.pages.find(p => p.id === id)).filter(Boolean);
        if (pages.length > 0) {
            const titles = pages.map(p => `${p.day} ${p.title}`).join('\n');
            const badge = $(`<div class="mm-recall-badge" title="${escapeHtml(titles)}">📖${pages.length}</div>`);
            el.find('.mes_block .ch_name').after(badge);
        }
    }

    // Unextracted badge
    if (msg.send_date && !dates[msg.send_date] && !msg.is_system) {
        const badge = $(`<div class="mm-unextracted-badge" title="此消息尚未被记忆系统提取"><svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M9 15C8.44771 15 8 15.4477 8 16C8 16.5523 8.44771 17 9 17C9.55229 17 10 16.5523 10 16C10 15.4477 9.55229 15 9 15Z" fill="currentColor"/><path d="M14 16C14 15.4477 14.4477 15 15 15C15.5523 15 16 15.4477 16 16C16 16.5523 15.5523 17 15 17C14.4477 17 14 16.5523 14 16Z" fill="currentColor"/><path fill-rule="evenodd" clip-rule="evenodd" d="M12 1C10.8954 1 10 1.89543 10 3C10 3.74028 10.4022 4.38663 11 4.73244V7H6C4.34315 7 3 8.34315 3 10V20C3 21.6569 4.34315 23 6 23H18C19.6569 23 21 21.6569 21 20V10C21 8.34315 19.6569 7 18 7H13V4.73244C13.5978 4.38663 14 3.74028 14 3C14 1.89543 13.1046 1 12 1ZM5 10C5 9.44772 5.44772 9 6 9H7.38197L8.82918 11.8944C9.16796 12.572 9.86049 13 10.618 13H13.382C14.1395 13 14.832 12.572 15.1708 11.8944L16.618 9H18C18.5523 9 19 9.44772 19 10V20C19 20.5523 18.5523 21 18 21H6C5.44772 21 5 20.5523 5 20V10ZM13.382 11L14.382 9H9.61803L10.618 11H13.382Z" fill="currentColor"/><path d="M1 14C0.447715 14 0 14.4477 0 15V17C0 17.5523 0.447715 18 1 18C1.55228 18 2 17.5523 2 17V15C2 14.4477 1.55228 14 1 14Z" fill="currentColor"/><path d="M22 15C22 14.4477 22.4477 14 23 14C23.5523 14 24 14.4477 24 15V17C24 17.5523 23.5523 18 23 18C22.4477 18 22 17.5523 22 17V15Z" fill="currentColor"/></svg></div>`);
        el.find('.mes_block .ch_name').after(badge);
    }
}

// ── Save Slot UI ──

export function refreshSlotListUI() {
    const charName = getCurrentCharName();
    const container = $('#mm_slot_list');
    container.empty();

    if (!charName) {
        container.html('<div class="mm-empty-state">请先选择角色</div>');
        $('#mm_current_slot').text('（未选择角色）');
        return;
    }

    const slots = listSlots(charName);
    const activeSlot = getActiveSlotName(charName);
    $('#mm_current_slot').text(activeSlot || '（未绑定）');

    if (slots.length === 0) {
        container.html('<div class="mm-empty-state">暂无存档</div>');
        return;
    }

    for (const slot of slots) {
        const isActive = slot.name === activeSlot;
        const dateStr = slot.savedAt ? new Date(slot.savedAt).toLocaleString() : '未知';
        const row = $(`
            <div class="mm-slot-card ${isActive ? 'mm-slot-active' : ''}" data-slot="${escapeHtml(slot.name)}">
                <div class="mm-slot-card-header">
                    <span class="mm-slot-card-name">${escapeHtml(slot.name)}</span>
                    ${isActive ? '<span class="mm-slot-badge">当前</span>' : ''}
                </div>
                <div class="mm-slot-card-time">${dateStr} | ${slot.pageCount || 0}页</div>
                <div class="mm-slot-card-actions">
                    <button class="mm-slot-load" title="加载此存档">加载</button>
                    <button class="mm-slot-delete" title="删除此存档" style="color:#ef4444">删除</button>
                </div>
            </div>
        `);

        row.find('.mm-slot-load').on('click', async () => {
            if (!confirm(`加载存档「${slot.name}」？当前记忆数据将被覆盖。`)) return;
            await loadFromSlot(charName, slot.name);
            updateBrowserUI();
            toastr?.success?.(`已加载存档「${slot.name}」`);
        });

        row.find('.mm-slot-delete').on('click', async () => {
            if (!confirm(`确认删除存档「${slot.name}」？`)) return;
            await deleteSlot(charName, slot.name);
            refreshSlotListUI();
            toastr?.success?.(`已删除存档「${slot.name}」`);
        });

        container.append(row);
    }
}

// ── Section Renderers ──

function renderKnownCharsSection(data) {
    const container = $('#mm_bible_known_chars');
    container.empty();

    if (!data.knownCharacterAttitudes || data.knownCharacterAttitudes.length === 0) {
        container.html('<div class="mm-empty-state">暂无数据</div>');
        return;
    }

    for (const c of data.knownCharacterAttitudes) {
        const row = $(`
            <div class="mm-entry-card" data-name="${escapeHtml(c.name)}">
                <div class="mm-entry-header">
                    <span class="mm-entry-name">${escapeHtml(c.name)}</span>
                    <div class="mm-entry-actions">
                        <button class="mm-entry-btn mm-entry-edit" title="编辑">✏️</button>
                        <button class="mm-entry-btn mm-btn-del-entry mm-entry-delete" title="删除">🗑️</button>
                    </div>
                </div>
                <div class="mm-entry-body">
                    <div class="mm-entry-field">
                        <span class="mm-entry-field-label">态度</span>
                        <span class="mm-entry-field-value">${escapeHtml(c.attitude || '(未知)')}</span>
                    </div>
                </div>
            </div>
        `);
        row.find('.mm-entry-edit').on('click', () => openEditKnownChar(c.name));
        row.find('.mm-entry-delete').on('click', () => onDeleteKnownChar(c.name));
        container.append(row);
    }
}

function renderNpcCharsSection(data) {
    const container = $('#mm_bible_characters');
    container.empty();

    if (!data.characters || data.characters.length === 0) {
        container.html('<div class="mm-empty-state">暂无人物数据</div>');
        return;
    }

    for (const c of data.characters) {
        const fields = [];
        if (c.appearance) fields.push(`<div class="mm-entry-field"><span class="mm-entry-field-label">外貌</span><span class="mm-entry-field-value">${escapeHtml(c.appearance)}</span></div>`);
        if (c.personality) fields.push(`<div class="mm-entry-field"><span class="mm-entry-field-label">性格</span><span class="mm-entry-field-value">${escapeHtml(c.personality)}</span></div>`);
        if (c.attitude) fields.push(`<div class="mm-entry-field"><span class="mm-entry-field-label">态度</span><span class="mm-entry-field-value">${escapeHtml(c.attitude)}</span></div>`);
        if (c.keywords && c.keywords.length > 0) fields.push(`<div class="mm-entry-field"><span class="mm-entry-field-label">关键词</span><span class="mm-entry-field-value mm-entry-keywords">${escapeHtml(c.keywords.join('、'))}</span></div>`);

        const row = $(`
            <div class="mm-entry-card" data-name="${escapeHtml(c.name)}">
                <div class="mm-entry-header">
                    <span class="mm-entry-name">${escapeHtml(c.name)}</span>
                    ${c.role ? `<span class="mm-entry-role">${escapeHtml(c.role)}</span>` : ''}
                    <div class="mm-entry-actions">
                        <button class="mm-entry-btn mm-entry-edit" title="编辑">✏️</button>
                        <button class="mm-entry-btn mm-btn-del-entry mm-entry-delete" title="删除">🗑️</button>
                    </div>
                </div>
                ${fields.length > 0 ? `<div class="mm-entry-body">${fields.join('')}</div>` : ''}
            </div>
        `);
        row.find('.mm-entry-edit').on('click', () => openEditNpcChar(c.name));
        row.find('.mm-entry-delete').on('click', () => onDeleteNpcChar(c.name));
        container.append(row);
    }
}

function renderItemsSection(data) {
    const container = $('#mm_bible_items');
    container.empty();

    if (!data.items || data.items.length === 0) {
        container.html('<div class="mm-empty-state">暂无物品数据</div>');
        return;
    }

    for (const item of data.items) {
        const sigLabel = item.significance === 'high' ? '重要' : '普通';
        const sigClass = item.significance === 'high' ? 'mem-sig-high' : 'mem-sig-medium';

        const row = $(`
            <div class="mm-entry-card" data-name="${escapeHtml(item.name)}">
                <div class="mm-entry-header">
                    <span class="mm-entry-name">${escapeHtml(item.name)}</span>
                    <span class="mm-entry-significance ${sigClass}">${sigLabel}</span>
                    <div class="mm-entry-actions">
                        <button class="mm-entry-btn mm-entry-edit" title="编辑">✏️</button>
                        <button class="mm-entry-btn mm-btn-del-entry mm-entry-delete" title="删除">🗑️</button>
                    </div>
                </div>
                ${item.status ? `<div class="mm-entry-body"><div class="mm-entry-field"><span class="mm-entry-field-label">状态</span><span class="mm-entry-field-value">${escapeHtml(item.status)}</span></div></div>` : ''}
            </div>
        `);
        row.find('.mm-entry-edit').on('click', () => openEditItem(item.name));
        row.find('.mm-entry-delete').on('click', () => onDeleteItem(item.name));
        container.append(row);
    }
}

function renderPageList(data) {
    const container = $('#mm_page_list');
    container.empty();

    const pages = data.pages.filter(p => p.compressionLevel <= COMPRESS_SUMMARY);
    $('#mm_page_count').text(data.pages.length);
    $('#mm_fresh_count').text(data.pages.filter(p => p.compressionLevel === COMPRESS_FRESH).length);
    $('#mm_compressed_count').text(data.pages.filter(p => p.compressionLevel === COMPRESS_SUMMARY).length);

    if (pages.length === 0) {
        container.html('<div class="mm-empty-state">暂无故事页</div>');
        return;
    }

    // Sort by day (numeric), then by createdAt
    const sorted = [...pages].sort((a, b) => {
        const da = parseInt((a.day || '').replace(/\D/g, '')) || 0;
        const db = parseInt((b.day || '').replace(/\D/g, '')) || 0;
        if (da !== db) return da - db;
        return (a.createdAt || 0) - (b.createdAt || 0);
    });

    for (const page of sorted) {
        const levelLabel = page.compressionLevel === COMPRESS_FRESH ? '详细' : '摘要';
        const levelClass = page.compressionLevel === COMPRESS_FRESH ? 'mm-level-fresh' : 'mm-level-compressed';

        // Category tags (colored)
        const catTags = (page.categories || []).map(c => {
            const color = CATEGORY_COLORS[c] || '#6b7280';
            const label = MEMORY_CATEGORIES[c] || c;
            return `<span class="mm-cat-tag" style="background:${color}">${escapeHtml(label)}</span>`;
        }).join('');

        // Keyword tags (gray)
        const kwTags = (page.keywords || []).map(k =>
            `<span class="mm-kw-tag">${escapeHtml(k)}</span>`,
        ).join('');

        const sigMark = page.significance === 'high' ? '<span class="mm-memory-card-sig mem-sig-high">!!</span>' : '';

        const card = $(`
            <div class="mm-memory-card ${levelClass}" data-page-id="${page.id}">
                <div class="mm-memory-card-header">
                    <span class="mm-memory-card-day">${escapeHtml(page.day || '?')}</span>
                    ${page.date ? `<span class="mm-memory-card-date">${escapeHtml(page.date)}</span>` : ''}
                    <span class="mm-memory-card-title">${escapeHtml(page.title)}</span>
                    ${sigMark}
                    <span class="mm-memory-card-level ${levelClass}">${levelLabel}</span>
                </div>
                <div class="mm-memory-card-tags">${catTags}${kwTags}</div>
                <div class="mm-memory-card-body">${escapeHtml(page.content || '')}</div>
                <div class="mm-memory-card-actions">
                    <span style="flex:1"></span>
                    <button class="mm-page-edit">编辑</button>
                    <button class="mm-page-delete mm-btn-danger">删除</button>
                </div>
            </div>
        `);
        card.find('.mm-page-edit').on('click', () => onEditPage(page.id));
        card.find('.mm-page-delete').on('click', () => onDeletePage(page.id));
        container.append(card);
    }
}

// ── Page CRUD ──

export function onDeletePage(pageId) {
    const data = getMemoryData();
    const page = data.pages.find(p => p.id === pageId);
    if (!page) return;

    if (!confirm(`确认删除故事页「${page.title}」？`)) return;

    const idx = data.pages.findIndex(p => p.id === pageId);
    if (idx !== -1) data.pages.splice(idx, 1);
    if (data.embeddings) delete data.embeddings[pageId];

    // Clean messageRecalls
    for (const [msgId, ids] of Object.entries(data.messageRecalls)) {
        const filtered = ids.filter(id => id !== pageId);
        if (filtered.length === 0) delete data.messageRecalls[msgId];
        else data.messageRecalls[msgId] = filtered;
    }

    saveMemoryData();
    updateBrowserUI(['pageList', 'status']);
    toastr?.success?.(`已删除故事页「${page.title}」`);
}

export function onEditPage(pageId) {
    const data = getMemoryData();
    const page = data.pages.find(p => p.id === pageId);
    if (!page) return;

    const card = $(`.mm-memory-card[data-page-id="${pageId}"]`);
    if (!card.length) return;

    // Toggle: if already open, close and restore display
    if (card.find('.mm-page-edit-panel').length) {
        card.find('.mm-page-edit-panel').remove();
        card.find('.mm-memory-card-header, .mm-memory-card-tags, .mm-memory-card-body, .mm-memory-card-actions').show();
        return;
    }

    // Hide the preview content
    card.find('.mm-memory-card-header, .mm-memory-card-tags, .mm-memory-card-body, .mm-memory-card-actions').hide();

    // Build category checkboxes
    const catCheckboxes = Object.entries(MEMORY_CATEGORIES).map(([key, label]) => {
        const checked = (page.categories || []).includes(key) ? 'checked' : '';
        const color = CATEGORY_COLORS[key] || '#6b7280';
        return `<label class="mm-cat-checkbox">
            <input type="checkbox" value="${key}" ${checked} />
            <span style="color:${color}">${label}</span>
        </label>`;
    }).join('');

    const panel = $(`
        <div class="mm-page-edit-panel">
            <div class="mm-page-edit-form">
                <div class="mm-edit-field-row">
                    <div class="mm-edit-field" style="flex:0 0 70px">
                        <label>天数</label>
                        <input type="text" class="mm-edit-day text_pole" value="${escapeHtml(page.day || '')}" />
                    </div>
                    <div class="mm-edit-field" style="flex:1">
                        <label>标题</label>
                        <input type="text" class="mm-edit-title text_pole" value="${escapeHtml(page.title || '')}" />
                    </div>
                    <div class="mm-edit-field" style="flex:0 0 110px">
                        <label>日期</label>
                        <input type="text" class="mm-edit-date text_pole" value="${escapeHtml(page.date || '')}" placeholder="YYMMDD 如 251017" />
                    </div>
                    <div class="mm-edit-field" style="flex:0 0 90px">
                        <label>重要性</label>
                        <select class="mm-edit-sig text_pole">
                            <option value="high" ${page.significance === 'high' ? 'selected' : ''}>重要</option>
                            <option value="medium" ${page.significance !== 'high' ? 'selected' : ''}>普通</option>
                        </select>
                    </div>
                </div>
                <div class="mm-edit-field">
                    <label>内容</label>
                    <textarea class="mm-edit-content text_pole" rows="4">${escapeHtml(page.content || '')}</textarea>
                </div>
                <div class="mm-edit-field">
                    <label>关键词 (逗号分隔)</label>
                    <input type="text" class="mm-edit-keywords text_pole" value="${escapeHtml((page.keywords || []).join(', '))}" />
                </div>
                <div class="mm-edit-field">
                    <label>分类标签</label>
                    <div class="mm-cat-checkboxes">${catCheckboxes}</div>
                </div>
                <div class="mm-edit-btns">
                    <button class="mm-btn-save-entry">保存</button>
                    <button class="mm-btn-cancel-entry">取消</button>
                </div>
            </div>
        </div>
    `);

    panel.find('.mm-btn-save-entry').on('click', () => {
        page.title = panel.find('.mm-edit-title').val().trim() || page.title;
        page.day = panel.find('.mm-edit-day').val().trim() || page.day;
        page.date = panel.find('.mm-edit-date').val().trim();
        page.content = panel.find('.mm-edit-content').val().trim() || page.content;
        page.keywords = panel.find('.mm-edit-keywords').val()
            .split(/[,，]/).map(k => k.trim()).filter(Boolean);
        page.significance = panel.find('.mm-edit-sig').val();
        page.categories = [];
        panel.find('.mm-cat-checkboxes input:checked').each(function () {
            page.categories.push($(this).val());
        });
        saveMemoryData();
        const s = getSettings();
        if (s.useEmbedding) embedPage(page).catch(() => {});
        updateBrowserUI(['pageList']);
        toastr?.success?.(`已更新故事页「${page.title}」`);
    });
    panel.find('.mm-btn-cancel-entry').on('click', () => {
        panel.remove();
        card.find('.mm-memory-card-header, .mm-memory-card-tags, .mm-memory-card-body, .mm-memory-card-actions').show();
    });
    card.append(panel);
}

export function onAddPage() {
    const title = prompt('标题 (4-8字):');
    if (!title) return;

    const day = prompt('天数 (如 D1):');
    if (!day) return;

    const content = prompt('内容 (50-150字):');
    if (!content) return;

    const keywords = prompt('关键词 (逗号分隔):');
    const cats = prompt('分类标签 (逗号分隔，可选: emotional,relationship,intimate,promise,conflict,discovery,turning_point,daily):');
    const sig = prompt('重要性 (high/medium):', 'medium');

    const data = getMemoryData();
    const page = {
        id: `pg_${generateId()}`,
        title: title.trim(),
        day: day.trim(),
        date: '',
        content: content.trim(),
        keywords: (keywords || '').split(/[,，]/).map(k => k.trim()).filter(Boolean),
        categories: (cats || '').split(/[,，]/).map(c => c.trim()).filter(Boolean),
        significance: (sig || 'medium').trim(),
        compressionLevel: COMPRESS_FRESH,
        createdAt: Date.now(),
        characters: [],
    };

    data.pages.push(page);
    saveMemoryData();

    // Embed
    const s = getSettings();
    if (s.useEmbedding) {
        embedPage(page).catch(() => {});
    }

    updateBrowserUI(['pageList', 'status']);
    toastr?.success?.(`已添加故事页「${page.title}」`);
}

// ── Known Character CRUD ──

export function openEditKnownChar(charName) {
    const data = getMemoryData();
    const char = data.knownCharacterAttitudes.find(c => c.name === charName);
    if (!char) return;

    const card = $(`.mm-entry-card[data-name="${CSS.escape(charName)}"]`);
    if (!card.length) return;

    // Toggle: if already open, close
    if (card.find('.mm-entry-edit-panel').length) {
        card.find('.mm-entry-edit-panel').remove();
        return;
    }

    const panel = $(`
        <div class="mm-entry-edit-panel">
            <div class="mm-edit-field">
                <label>对主角的态度</label>
                <input type="text" class="mm-edit-attitude text_pole" value="${escapeHtml(char.attitude || '')}" />
            </div>
            <div class="mm-edit-btns">
                <button class="mm-btn-save-entry">保存</button>
                <button class="mm-btn-cancel-entry">取消</button>
            </div>
        </div>
    `);

    panel.find('.mm-btn-save-entry').on('click', () => {
        char.attitude = panel.find('.mm-edit-attitude').val().trim();
        saveMemoryData();
        updateBrowserUI(['knownChars']);
        toastr?.success?.(`已更新「${charName}」的态度`);
    });
    panel.find('.mm-btn-cancel-entry').on('click', () => panel.remove());
    card.append(panel);
}

export function onDeleteKnownChar(charName) {
    const data = getMemoryData();
    if (!confirm(`确认删除已知角色「${charName}」的态度记录？`)) return;
    data.knownCharacterAttitudes = data.knownCharacterAttitudes.filter(c => c.name !== charName);
    saveMemoryData();
    updateBrowserUI(['knownChars']);
}

export function onAddKnownChar() {
    const name = prompt('角色名:');
    if (!name) return;
    const attitude = prompt('该角色对主角的态度:');
    if (attitude === null) return;

    const data = getMemoryData();
    const existing = data.knownCharacterAttitudes.find(c => c.name === name.trim());
    if (existing) {
        existing.attitude = attitude.trim();
    } else {
        data.knownCharacterAttitudes.push({ name: name.trim(), attitude: attitude.trim() });
    }
    saveMemoryData();
    updateBrowserUI(['knownChars']);
}

// ── NPC Character CRUD ──

export function openEditNpcChar(charName) {
    const data = getMemoryData();
    const char = data.characters.find(c => c.name === charName);
    if (!char) return;

    const card = $(`.mm-entry-card[data-name="${CSS.escape(charName)}"]`);
    if (!card.length) return;

    if (card.find('.mm-entry-edit-panel').length) {
        card.find('.mm-entry-edit-panel').remove();
        return;
    }

    const panel = $(`
        <div class="mm-entry-edit-panel">
            <div class="mm-edit-field">
                <label>身份</label>
                <input type="text" class="mm-edit-role text_pole" value="${escapeHtml(char.role || '')}" placeholder="如"主角的私人医生"，可留空" />
            </div>
            <div class="mm-edit-field">
                <label>外貌</label>
                <input type="text" class="mm-edit-appearance text_pole" value="${escapeHtml(char.appearance || '')}" />
            </div>
            <div class="mm-edit-field">
                <label>性格</label>
                <input type="text" class="mm-edit-personality text_pole" value="${escapeHtml(char.personality || '')}" />
            </div>
            <div class="mm-edit-field">
                <label>态度</label>
                <input type="text" class="mm-edit-attitude text_pole" value="${escapeHtml(char.attitude || '')}" />
            </div>
            <div class="mm-edit-field">
                <label>关键词激活 <small style="opacity:0.6">（逗号分隔，用于关键词模式识别该角色）</small></label>
                <input type="text" class="mm-edit-keywords text_pole" value="${escapeHtml((char.keywords || []).join(', '))}" placeholder="默认用角色名；可加昵称、称呼，如：林医生, 林晓薇" />
            </div>
            <div class="mm-edit-btns">
                <button class="mm-btn-save-entry">保存</button>
                <button class="mm-btn-cancel-entry">取消</button>
            </div>
        </div>
    `);

    panel.find('.mm-btn-save-entry').on('click', () => {
        char.role = panel.find('.mm-edit-role').val().trim();
        char.appearance = panel.find('.mm-edit-appearance').val().trim();
        char.personality = panel.find('.mm-edit-personality').val().trim();
        char.attitude = panel.find('.mm-edit-attitude').val().trim();
        char.keywords = panel.find('.mm-edit-keywords').val()
            .split(/[,，]/).map(k => k.trim()).filter(Boolean);
        saveMemoryData();
        const s = getSettings();
        if (s.useEmbedding) embedCharacter(char).catch(() => {});
        updateBrowserUI(['characters']);
        toastr?.success?.(`已更新NPC「${charName}」`);
    });
    panel.find('.mm-btn-cancel-entry').on('click', () => panel.remove());
    card.append(panel);
}

export function onDeleteNpcChar(charName) {
    const data = getMemoryData();
    if (!confirm(`确认删除NPC角色「${charName}」？`)) return;
    data.characters = data.characters.filter(c => c.name !== charName);
    if (data.embeddings) delete data.embeddings[`char_${charName}`];
    saveMemoryData();
    updateBrowserUI(['characters']);
}

export function onAddNpcChar() {
    const name = prompt('NPC名:');
    if (!name) return;
    const role = prompt('身份（可留空，如"主角的私人医生"）:') || '';
    const appearance = prompt('外貌:') || '';
    const personality = prompt('性格:') || '';
    const attitude = prompt('对主角态度:') || '';
    const keywordsRaw = prompt('关键词激活（可留空；逗号分隔，如：林医生,林晓薇）:') || '';

    const data = getMemoryData();
    const char = {
        name: name.trim(),
        role: role.trim(),
        appearance: appearance.trim(),
        personality: personality.trim(),
        attitude: attitude.trim(),
        keywords: keywordsRaw.trim() ? keywordsRaw.split(/[,，]/).map(k => k.trim()).filter(Boolean) : [],
    };
    data.characters.push(char);
    saveMemoryData();

    const s = getSettings();
    if (s.useEmbedding) {
        embedCharacter(char).catch(() => {});
    }

    updateBrowserUI(['characters']);
    toastr?.success?.(`已添加NPC「${char.name}」`);
}

// ── Item CRUD ──

export function openEditItem(itemName) {
    const data = getMemoryData();
    const item = data.items.find(i => i.name === itemName);
    if (!item) return;

    const card = $(`.mm-entry-card[data-name="${CSS.escape(itemName)}"]`);
    if (!card.length) return;

    if (card.find('.mm-entry-edit-panel').length) {
        card.find('.mm-entry-edit-panel').remove();
        return;
    }

    const panel = $(`
        <div class="mm-entry-edit-panel">
            <div class="mm-edit-field">
                <label>状态</label>
                <input type="text" class="mm-edit-status text_pole" value="${escapeHtml(item.status || '')}" />
            </div>
            <div class="mm-edit-field">
                <label>重要性</label>
                <select class="mm-edit-significance text_pole">
                    <option value="high" ${item.significance === 'high' ? 'selected' : ''}>重要 (high)</option>
                    <option value="medium" ${item.significance !== 'high' ? 'selected' : ''}>普通 (medium)</option>
                </select>
            </div>
            <div class="mm-edit-btns">
                <button class="mm-btn-save-entry">保存</button>
                <button class="mm-btn-cancel-entry">取消</button>
            </div>
        </div>
    `);

    panel.find('.mm-btn-save-entry').on('click', () => {
        item.status = panel.find('.mm-edit-status').val().trim();
        item.significance = panel.find('.mm-edit-significance').val();
        saveMemoryData();
        updateBrowserUI(['items']);
    });
    panel.find('.mm-btn-cancel-entry').on('click', () => panel.remove());
    card.append(panel);
}

export function onDeleteItem(itemName) {
    const data = getMemoryData();
    if (!confirm(`确认删除物品「${itemName}」？`)) return;
    data.items = data.items.filter(i => i.name !== itemName);
    saveMemoryData();
    updateBrowserUI(['items']);
}

export function onAddItem() {
    const name = prompt('物品名:');
    if (!name) return;
    const status = prompt('状态:') || '';
    const sig = prompt('重要性 (high/medium):', 'medium') || 'medium';

    const data = getMemoryData();
    data.items.push({ name: name.trim(), status: status.trim(), significance: sig.trim() });
    saveMemoryData();
    updateBrowserUI(['items']);
}

// ── Timeline Edit ──

export function onEditTimelineClick() {
    const data = getMemoryData();
    const newTl = prompt('编辑剧情时间线（每行一条，如 D1: 事件描述）:', data.timeline || '');
    if (newTl === null) return;
    data.timeline = newTl.trim();
    saveMemoryData();
    updateBrowserUI(['timeline']);
    toastr?.success?.('时间线已更新');
}

// ── Reset / Export / Import ──

export function onResetClick() {
    if (!confirm('确认重置当前聊天的所有记忆数据？此操作不可撤销。')) return;

    const ctx = getContext();
    ctx.chatMetadata.memoryManager = createDefaultData();
    saveMemoryData();

    setExtensionPrompt(PROMPT_KEY_INDEX, '', extension_prompt_types.IN_CHAT, 0);
    setExtensionPrompt(PROMPT_KEY_PAGES, '', extension_prompt_types.IN_CHAT, 0);

    updateBrowserUI();
    toastr?.success?.('记忆数据已重置', 'Memory Manager');
}

export function onExportClick() {
    const data = getMemoryData();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const charName = getCurrentCharName() || 'unknown';
    a.download = `memory_${charName}_${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toastr?.success?.('记忆数据已导出');
}

export function onImportClick() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.addEventListener('change', async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        try {
            const text = await file.text();
            const imported = JSON.parse(text);

            if (!imported.pages || !Array.isArray(imported.pages)) {
                toastr?.error?.('无效的记忆数据文件');
                return;
            }

            if (!confirm(`导入 ${imported.pages.length} 页记忆数据？将覆盖当前数据。`)) return;

            const ctx = getContext();
            ctx.chatMetadata.memoryManager = imported;
            saveMemoryData();

            updateBrowserUI();
            toastr?.success?.(`已导入记忆数据 (${imported.pages.length} 页)`);
        } catch (err) {
            warn('Import failed:', err);
            toastr?.error?.('导入失败: ' + err.message);
        }
    });
    input.click();
}
