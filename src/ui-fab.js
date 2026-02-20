/**
 * Memory Manager — FAB, Recall Panel, Directive Tab, Toolbox
 * Floating action button with Lottie animation, recall panel with tabs,
 * directive editing, toolbox (health check, quick extract, real-time commands),
 * batch initialization.
 */

import {
    MEMORY_CATEGORIES, CATEGORY_COLORS,
    COMPRESS_SUMMARY,
} from './constants.js';
import { warn, escapeHtml } from './utils.js';
import {
    getSettings, getMemoryData, saveMemoryData,
} from './data.js';
import { callSecondaryApiChat } from './api.js';
import { formatStoryIndex } from './formatting.js';
import { loadLottieLib, setMood } from './mood.js';
import {
    safeExtract, forceExtractUnprocessed,
    markMsgsExtracted,
} from './extraction.js';
import {
    getLastNarrative, getLastRecalledPages, getLastRecalledChars,
} from './retrieval.js';
import { updateBrowserUI } from './ui-browser.js';

import { getContext } from '../../../../extensions.js';

const $ = window.jQuery;
const toastr = window.toastr;

// ── Module State ──

let rtCommandMessages = [];
let initializationInProgress = false;
let failedBatches = [];
let fabDragMoved = false; // track if last mousedown ended as drag

// ── FAB Creation & Binding ──

export function bindRecallFab() {
    // Create FAB element
    if ($('#mm_fab').length) return; // Already bound

    const fabHtml = `
        <div id="mm_fab" class="mm-recall-fab" title="MMPEA记忆管理">
            <div id="mm_lottie_container" class="mm-lottie-container"></div>
        </div>
        <div id="mm_panel_backdrop" class="mm-panel-backdrop"></div>
        <div id="mm_recall_panel" class="mm-recall-panel" popover="manual">
            <div class="mm-recall-panel-header">
                <div class="mm-recall-tabs">
                    <button class="mm-recall-tab mm-recall-tab-active" data-tab="recall">召回</button>
                    <button class="mm-recall-tab" data-tab="directive">管理指令</button>
                    <button class="mm-recall-tab" data-tab="toolbox">工具箱</button>
                </div>
                <button class="mm-recall-panel-close" id="mm_panel_close" title="关闭">✕</button>
            </div>
            <div class="mm-recall-tab-content" id="mm_panel_content">
                <div class="mm-empty-state">点击小电视查看记忆召回</div>
            </div>
        </div>
    `;

    $('body').append(fabHtml);

    // Detect Popover API support
    const hasPopover = typeof HTMLElement.prototype.showPopover === 'function';

    // Load Lottie and set idle mood; add fallback if loading fails
    loadLottieLib().then(() => {
        if (window.lottie) {
            setMood('idle');
        } else {
            // Lottie failed to load — show fallback icon
            $('#mm_lottie_container').html('<div class="mm-fab-fallback">TV</div>');
        }
    });

    // Helper: show/hide panel using Popover API when available
    function showPanel(left, top) {
        const el = document.getElementById('mm_recall_panel');
        const backdrop = document.getElementById('mm_panel_backdrop');
        if (!el) return;

        // On mobile (<500px), center the panel instead of anchoring to FAB
        const isMobile = window.innerWidth < 500;
        if (isMobile) {
            const panelW = window.innerWidth - 24;
            const panelH = Math.min(480, window.innerHeight - 80);
            el.style.setProperty('width', panelW + 'px', 'important');
            el.style.setProperty('height', panelH + 'px', 'important');
            el.style.setProperty('left', '12px', 'important');
            el.style.setProperty('top', Math.max(12, (window.innerHeight - panelH) / 2) + 'px', 'important');
        } else {
            el.style.removeProperty('width');
            el.style.removeProperty('height');
            el.style.setProperty('left', left + 'px', 'important');
            el.style.setProperty('top', top + 'px', 'important');
        }
        el.style.setProperty('right', 'auto', 'important');
        el.style.setProperty('bottom', 'auto', 'important');

        if (backdrop) backdrop.classList.add('mm-panel-backdrop-visible');
        if (hasPopover) {
            try { el.showPopover(); } catch (_) { /* already showing */ }
        }
        el.style.setProperty('display', 'flex', 'important');
    }

    function hidePanel() {
        const el = document.getElementById('mm_recall_panel');
        const backdrop = document.getElementById('mm_panel_backdrop');
        // Always clean up the backdrop first, even if panel element is missing
        if (backdrop) backdrop.classList.remove('mm-panel-backdrop-visible');
        if (!el) return;
        if (hasPopover) {
            try { el.hidePopover(); } catch (_) { /* already hidden */ }
        }
        el.style.setProperty('display', 'none', 'important');
    }

    function isPanelVisible() {
        const el = document.getElementById('mm_recall_panel');
        if (!el) return false;
        // offsetParent is null for elements in the Popover API top-layer, so use inline style instead
        return el.style.getPropertyValue('display') === 'flex';
    }

    // Tab switching
    $('#mm_recall_panel').on('click', '.mm-recall-tab', function () {
        const tab = $(this).data('tab');
        $('#mm_recall_panel .mm-recall-tab').removeClass('mm-recall-tab-active');
        $(this).addClass('mm-recall-tab-active');
        renderPanelTab(tab);
    });

    // Close button
    $('#mm_panel_close').on('click', hidePanel);

    // Backdrop click to close
    $('#mm_panel_backdrop').on('click', hidePanel);

    // Click outside to close
    $(document).on('click.mm_panel', function (e) {
        if (isPanelVisible() && !$(e.target).closest('#mm_recall_panel, #mm_fab').length) {
            hidePanel();
        }
    });

    // FAB click toggles panel, positioned relative to FAB
    $('#mm_fab').on('click', function () {
        if (fabDragMoved) { fabDragMoved = false; return; }

        if (isPanelVisible()) {
            hidePanel();
            return;
        }

        // Calculate position: panel appears above (or below) the FAB
        const fab = document.getElementById('mm_fab');
        const rect = fab.getBoundingClientRect();
        const panelW = Math.min(380, window.innerWidth - 16);
        const panelH = Math.min(480, window.innerHeight - 16);

        let left = rect.right - panelW;
        let top = rect.top - panelH - 8;

        if (top < 8) top = rect.bottom + 8;
        left = Math.max(8, Math.min(left, window.innerWidth - panelW - 8));
        top = Math.max(8, Math.min(top, window.innerHeight - panelH - 8));

        showPanel(left, top);
    });

    // Make FAB draggable
    makeFabDraggable();
}

function makeFabDraggable() {
    const fab = document.getElementById('mm_fab');
    if (!fab) return;

    let isDragging = false;
    let startX, startY, startLeft, startTop;

    function onPointerDown(e) {
        const clientX = e.touches ? e.touches[0].clientX : e.clientX;
        const clientY = e.touches ? e.touches[0].clientY : e.clientY;
        isDragging = false;
        startX = clientX;
        startY = clientY;
        const rect = fab.getBoundingClientRect();
        startLeft = rect.left;
        startTop = rect.top;

        function onMove(ev) {
            const mx = ev.touches ? ev.touches[0].clientX : ev.clientX;
            const my = ev.touches ? ev.touches[0].clientY : ev.clientY;
            const dx = mx - startX;
            const dy = my - startY;
            if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
                isDragging = true;
                fab.style.left = (startLeft + dx) + 'px';
                fab.style.top = (startTop + dy) + 'px';
                fab.style.right = 'auto';
                fab.style.bottom = 'auto';
                if (ev.cancelable) ev.preventDefault();
            }
        }
        function onUp() {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
            document.removeEventListener('touchmove', onMove);
            document.removeEventListener('touchend', onUp);
            if (isDragging) {
                fabDragMoved = true;
                localStorage.setItem('mm_fab_left', fab.style.left);
                localStorage.setItem('mm_fab_top', fab.style.top);
            }
        }
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
        document.addEventListener('touchmove', onMove, { passive: false });
        document.addEventListener('touchend', onUp);
    }

    fab.addEventListener('mousedown', onPointerDown);
    fab.addEventListener('touchstart', onPointerDown, { passive: true });

    // Restore saved position or set default (lower-right area)
    const savedLeft = localStorage.getItem('mm_fab_left');
    const savedTop = localStorage.getItem('mm_fab_top');
    if (savedLeft && savedTop) {
        // Ensure saved position is still within viewport
        const sl = parseInt(savedLeft);
        const st = parseInt(savedTop);
        if (sl >= 0 && sl < window.innerWidth - 32 && st >= 0 && st < window.innerHeight - 32) {
            fab.style.left = savedLeft;
            fab.style.top = savedTop;
        } else {
            fab.style.left = Math.max(8, window.innerWidth - 90) + 'px';
            fab.style.top = Math.max(8, window.innerHeight - 150) + 'px';
        }
    } else {
        fab.style.left = Math.max(8, window.innerWidth - 90) + 'px';
        fab.style.top = Math.max(8, window.innerHeight - 150) + 'px';
    }
    fab.style.right = 'auto';
    fab.style.bottom = 'auto';
}

// ── FAB Update ──

export function updateRecallFab() {
    const narrative = getLastNarrative();
    const pages = getLastRecalledPages();

    // Update panel content if it's on the recall tab
    const activeTab = $('#mm_recall_panel .mm-recall-tab.mm-recall-tab-active').data('tab');
    if (activeTab === 'recall' || !activeTab) {
        renderPanelTab('recall');
    }

    // Visual indicator on FAB
    if (narrative && pages.length > 0) {
        $('#mm_fab').addClass('has-recall');
    } else {
        $('#mm_fab').removeClass('has-recall');
    }
}

// ── Panel Tab Rendering ──

function renderPanelTab(tab) {
    switch (tab) {
    case 'recall':
        updateRecallPanel();
        break;
    case 'directive':
        renderDirectiveTab();
        break;
    case 'toolbox':
        renderToolboxTab();
        break;
    }
}

export function updateRecallPanel() {
    const container = $('#mm_panel_content');
    const narrative = getLastNarrative();
    const pages = getLastRecalledPages();
    const chars = getLastRecalledChars();

    if (!narrative && pages.length === 0 && chars.length === 0) {
        container.html('<div class="mm-empty-state">暂无记忆召回</div>');
        return;
    }

    let html = '<div style="padding:10px 14px">';

    // Narrative section
    if (narrative) {
        html += `<div class="mm-recall-panel-section">
            <div class="mm-recall-panel-section-title">叙述</div>
            <div class="mm-recall-panel-page-body">${escapeHtml(narrative)}</div>
        </div>`;
    }

    // Recalled pages section
    if (pages.length > 0) {
        html += '<div class="mm-recall-panel-section">';
        html += '<div class="mm-recall-panel-section-title">记忆来源</div>';
        for (const p of pages) {
            const catTags = (p.categories || []).map(c => {
                const color = CATEGORY_COLORS[c] || '#6b7280';
                const label = MEMORY_CATEGORIES[c] || c;
                return `<span class="mm-cat-tag-sm" style="background:${color}">${escapeHtml(label)}</span>`;
            }).join(' ');
            const preview = (p.content || '').substring(0, 120) + ((p.content || '').length > 120 ? '...' : '');
            html += `<div class="mm-recall-panel-page">
                <div class="mm-recall-panel-page-header">
                    <span class="mm-recall-panel-page-day">${escapeHtml(p.day || '?')}</span>
                    <span class="mm-recall-panel-page-title">${escapeHtml(p.title)}</span>
                    ${catTags}
                </div>
                <div class="mm-recall-panel-page-body">${escapeHtml(preview)}</div>
            </div>`;
        }
        html += '</div>';
    }

    // Recalled characters section
    if (chars.length > 0) {
        html += '<div class="mm-recall-panel-section">';
        html += '<div class="mm-recall-panel-section-title">角色信息</div>';
        for (const c of chars) {
            html += `<div class="mm-recall-panel-char">
                <div class="mm-recall-panel-char-name">${escapeHtml(c.name)}</div>
                ${c.attitude ? escapeHtml(c.attitude) : ''}
            </div>`;
        }
        html += '</div>';
    }

    html += '</div>';
    container.html(html);
}

export function renderDirectiveTab() {
    const container = $('#mm_panel_content');
    const data = getMemoryData();
    const dir = data.managerDirective || {};

    const html = `
        <div class="mm-directive-container">
            <details class="mm-directive-help">
                <summary style="cursor:pointer;font-size:12px;font-weight:600;color:#888">各环节说明 (点击展开)</summary>
                <div class="mm-directive-help-content">
                    <div class="mm-directive-help-item">
                        <b>提取 (Extraction)</b><br>
                        小电视每隔几条消息就会像写日记一样，把你们的对话记下来变成"故事页"。<br>
                        你可以告诉它：哪些事情更值得记、用什么风格记。
                    </div>
                    <div class="mm-directive-help-item">
                        <b>召回 (Recall)</b><br>
                        角色说话之前，小电视会翻翻小本本，找找以前有没有相关的回忆告诉角色。<br>
                        你可以告诉它：什么情况下优先找什么类型的记忆。
                    </div>
                    <div class="mm-directive-help-item">
                        <b>压缩 (Compression)</b><br>
                        笔记太多太长时，小电视会把旧的浓缩成一两句话的摘要。<br>
                        你可以告诉它：哪些内容压缩时一定要保留。
                    </div>
                </div>
            </details>
            <div class="mm-directive-field">
                <label>全局指令 <small style="opacity:0.6">(所有环节都会附加)</small></label>
                <textarea id="mm_dir_global" class="text_pole mm-directive-textarea" rows="2"
                    placeholder="例如：所有记忆以第三人称记录，保持简洁">${escapeHtml(dir.global || '')}</textarea>
            </div>
            <div class="mm-directive-field">
                <label>提取指令</label>
                <textarea id="mm_dir_extraction" class="text_pole mm-directive-textarea" rows="2"
                    placeholder="例如：重点记录角色的情感变化和承诺">${escapeHtml(dir.extraction || '')}</textarea>
            </div>
            <div class="mm-directive-field">
                <label>召回指令</label>
                <textarea id="mm_dir_recall" class="text_pole mm-directive-textarea" rows="2"
                    placeholder="例如：优先召回与当前话题相关的承诺和冲突">${escapeHtml(dir.recall || '')}</textarea>
            </div>
            <div class="mm-directive-field">
                <label>压缩指令</label>
                <textarea id="mm_dir_compression" class="text_pole mm-directive-textarea" rows="2"
                    placeholder="例如：压缩时保留所有角色名和关键日期">${escapeHtml(dir.compression || '')}</textarea>
            </div>
            <div class="mm-directive-actions">
                <button id="mm_dir_save" class="mm-btn-save-entry">直接保存</button>
                <button id="mm_dir_organize" class="mm-btn-cancel-entry" title="让LLM帮你整理指令">让管理员整理</button>
                <button id="mm_dir_clear" class="mm-btn-cancel-entry" style="color:#ef4444">清空</button>
            </div>
        </div>
    `;
    container.html(html);

    container.find('.mm-directive-save').on('click', () => {
        const data2 = getMemoryData();
        if (!data2.managerDirective) data2.managerDirective = {};
        container.find('.mm-directive-textarea').each(function () {
            const key = $(this).data('key');
            data2.managerDirective[key] = $(this).val().trim();
        });
        saveMemoryData();
        toastr?.success?.('指令已保存', 'Memory Manager');
    });
}

export function renderToolboxTab() {
    const container = $('#mm_panel_content');
    // Clear real-time messages when entering toolbox
    rtCommandMessages = [];

    const html = `
        <div class="mm-toolbox-container">
            <div class="mm-toolbox-section">
                <div class="mm-toolbox-section-title">记忆体检</div>
                <button class="mm-toolbox-btn mm-toolbox-health-check">运行体检</button>
                <div class="mm-health-list mm-health-results"></div>
            </div>

            <div class="mm-toolbox-section">
                <div class="mm-toolbox-section-title">快速操作</div>
                <div class="mm-toolbox-row">
                    <span class="mm-toolbox-label">提取范围:</span>
                    <input type="number" class="mm-quick-start text_pole" placeholder="起始" min="0" style="width:58px" />
                    <span class="mm-toolbox-sep">—</span>
                    <input type="number" class="mm-quick-end text_pole" placeholder="结束" min="0" style="width:58px" />
                    <button class="mm-toolbox-btn mm-quick-extract-btn">提取</button>
                </div>
                <div class="mm-toolbox-row">
                    <span class="mm-toolbox-label">标记已提取:</span>
                    <input type="number" class="mm-mark-start text_pole" placeholder="起始" min="0" style="width:58px" />
                    <span class="mm-toolbox-sep">—</span>
                    <input type="number" class="mm-mark-end text_pole" placeholder="结束" min="0" style="width:58px" />
                    <button class="mm-toolbox-btn mm-quick-mark-btn">标记</button>
                </div>
                <div class="mm-toolbox-row">
                    <button class="mm-toolbox-btn mm-rebuild-vectors-btn">重建向量库</button>
                </div>
                <div class="mm-toolbox-row">
                    <button class="mm-toolbox-btn mm-sync-watermark-btn">同步待处理计数</button>
                </div>
            </div>

            <div class="mm-toolbox-section">
                <div class="mm-toolbox-section-title">实时指令</div>
                <div class="mm-toolbox-desc">和记忆管理员对话，直接操作记忆数据。离开此页面自动清除对话（省钱）。</div>
                <div class="mm-rt-messages mm-rt-response"></div>
                <div class="mm-toolbox-row">
                    <input type="text" class="mm-rt-command-input text_pole" placeholder="输入指令..." style="flex:1" />
                    <button class="mm-toolbox-btn mm-toolbox-btn-send mm-rt-send-btn">发送</button>
                </div>
            </div>
        </div>
    `;
    container.html(html);

    // Health check
    container.find('.mm-toolbox-health-check').on('click', () => {
        const { html, orphanDates } = runHealthCheck();
        const resultsEl = container.find('.mm-health-results');
        resultsEl.html(html);

        // Select all button
        resultsEl.find('.mm-orphan-select-all').on('click', () => {
            resultsEl.find('.mm-orphan-check').prop('checked', true);
        });

        // Delete selected orphan pages
        resultsEl.find('.mm-orphan-delete-btn').on('click', () => {
            const ids = [];
            resultsEl.find('.mm-orphan-check:checked').each(function () {
                ids.push($(this).data('page-id'));
            });
            if (ids.length === 0) {
                toastr?.warning?.('请先勾选要删除的故事页');
                return;
            }
            if (!confirm(`确认删除 ${ids.length} 个故事页？此操作不可撤销。`)) return;

            const data = getMemoryData();
            let deleted = 0;
            for (const id of ids) {
                const idx = data.pages.findIndex(p => p.id === id);
                if (idx !== -1) {
                    data.pages.splice(idx, 1);
                    if (data.embeddings) delete data.embeddings[id];
                    deleted++;
                }
            }
            saveMemoryData();
            updateBrowserUI(['pageList']);
            toastr?.success?.(`已删除 ${deleted} 个孤立故事页`);

            // Re-run health check to refresh results
            const refreshed = runHealthCheck();
            resultsEl.html(refreshed.html);
        });

        // Clean orphan dates from extractedMsgDates
        resultsEl.find('.mm-orphan-clean-dates-btn').on('click', () => {
            if (orphanDates.length === 0) {
                toastr?.info?.('没有需要清理的孤立日期');
                return;
            }
            const data = getMemoryData();
            const extracted = data.processing.extractedMsgDates || {};
            let cleaned = 0;
            for (const d of orphanDates) {
                if (extracted[d]) {
                    delete extracted[d];
                    cleaned++;
                }
            }
            saveMemoryData();
            toastr?.success?.(`已清理 ${cleaned} 条孤立日期记录`);

            // Re-run to refresh
            const refreshed = runHealthCheck();
            resultsEl.html(refreshed.html);
        });
    });

    // Quick extract
    container.find('.mm-quick-extract-btn').on('click', async () => {
        const start = parseInt(container.find('.mm-quick-start').val()) || 0;
        const end = parseInt(container.find('.mm-quick-end').val()) || 0;
        if (start > end) { toastr?.warning?.('起始不能大于结束'); return; }
        await quickExtractRange(start, end);
    });

    // Quick mark (separate inputs)
    container.find('.mm-quick-mark-btn').on('click', () => {
        const start = parseInt(container.find('.mm-mark-start').val()) || 0;
        const end = parseInt(container.find('.mm-mark-end').val()) || 0;
        if (start > end) { toastr?.warning?.('起始不能大于结束'); return; }
        quickMarkExtracted(start, end);
    });

    // Rebuild vectors — delegate to settings panel button
    container.find('.mm-rebuild-vectors-btn').on('click', () => {
        const settingsBtn = $('#mm_rebuild_vectors');
        if (settingsBtn.length) {
            settingsBtn.click();
        } else {
            toastr?.warning?.('请先在设置面板中配置向量相关参数');
        }
    });

    // Sync watermark to extractedMsgDates
    container.find('.mm-sync-watermark-btn').on('click', () => {
        const data = getMemoryData();
        const ctx = getContext();
        const extracted = data.processing.extractedMsgDates || {};
        const chat = ctx.chat || [];

        // Find the highest chat index whose send_date is marked as extracted
        let highestIdx = -1;
        for (let i = chat.length - 1; i >= 0; i--) {
            const msg = chat[i];
            if (msg?.send_date && extracted[msg.send_date]) {
                highestIdx = i;
                break;
            }
        }

        const oldWatermark = data.processing.lastExtractedMessageId ?? -1;
        if (highestIdx <= oldWatermark) {
            toastr?.info?.(`水位线已是最新（${oldWatermark}），无需同步`, 'Memory Manager');
            return;
        }

        data.processing.lastExtractedMessageId = highestIdx;
        saveMemoryData();
        updateBrowserUI(['status']);
        toastr?.success?.(`水位线已同步：${oldWatermark} → ${highestIdx}`, 'Memory Manager');
    });

    // Real-time command
    container.find('.mm-rt-send-btn').on('click', async () => {
        const input = container.find('.mm-rt-command-input');
        const text = input.val().trim();
        if (!text) return;
        input.val('');

        // Show user message
        const msgArea = container.find('.mm-rt-response');
        msgArea.append(`<div class="mm-rt-msg mm-rt-user">${escapeHtml(text)}</div>`);
        msgArea.append('<div class="mm-rt-msg mm-rt-assistant"><i>处理中...</i></div>');
        msgArea.scrollTop(msgArea[0].scrollHeight);

        const response = await sendRealTimeCommand(text);
        // Replace the "处理中" with actual response
        msgArea.find('.mm-rt-assistant').last().html(escapeHtml(response));
        msgArea.scrollTop(msgArea[0].scrollHeight);
    });

    // Enter key to send
    container.find('.mm-rt-command-input').on('keydown', function (e) {
        if (e.key === 'Enter') container.find('.mm-rt-send-btn').click();
    });
}

// ── Health Check ──

export function runHealthCheck() {
    const data = getMemoryData();
    const ctx = getContext();
    const issues = [];
    const stats = [];

    // Stats
    stats.push(`故事页: ${data.pages.length}`);
    stats.push(`NPC: ${data.characters.length}`);
    stats.push(`已知角色: ${data.knownCharacterAttitudes.length}`);
    stats.push(`物品: ${data.items.length}`);
    stats.push(`向量: ${data.embeddings ? Object.keys(data.embeddings).length : 0}`);

    const dates = data.processing.extractedMsgDates || {};
    stats.push(`已提取: ${Object.keys(dates).length}`);

    // ── Orphan analysis ──
    let orphanDates = new Set();
    let affectedPages = []; // { page, status: 'full' | 'partial', orphanCount, totalCount }

    if (ctx.chat) {
        const chatDates = new Set(ctx.chat.filter(m => m?.send_date).map(m => m.send_date));
        for (const d of Object.keys(dates)) {
            if (!chatDates.has(d)) orphanDates.add(d);
        }

        if (orphanDates.size > 0) {
            // Find affected story pages
            for (const page of data.pages) {
                const sd = page.sourceDates || [];
                if (sd.length === 0) continue;
                const orphanCount = sd.filter(d => orphanDates.has(d)).length;
                if (orphanCount > 0) {
                    affectedPages.push({
                        page,
                        status: orphanCount === sd.length ? 'full' : 'partial',
                        orphanCount,
                        totalCount: sd.length,
                    });
                }
            }
            issues.push(`⚠️ ${orphanDates.size} 条已提取消息已被删除`);
        }
    }

    // Check for pages without embeddings
    if (data.embeddings && getSettings().useEmbedding) {
        const missing = data.pages.filter(p =>
            p.compressionLevel <= COMPRESS_SUMMARY && !data.embeddings[p.id],
        );
        if (missing.length > 0) {
            issues.push(`⚠️ ${missing.length} 个故事页缺少向量索引`);
        }
    }

    // Check for pages without categories
    const noCats = data.pages.filter(p =>
        p.compressionLevel <= COMPRESS_SUMMARY && (!p.categories || p.categories.length === 0),
    );
    if (noCats.length > 0) {
        issues.push(`⚠️ ${noCats.length} 个故事页缺少分类标签`);
    }

    // Check timeline
    if (!data.timeline) {
        issues.push('ℹ️ 时间线为空');
    } else {
        const lines = data.timeline.split('\n').filter(l => l.trim());
        stats.push(`时间线: ${lines.length} 条`);
    }

    // ── Build HTML ──
    let html = '<div class="mm-health-stats">' + stats.join(' | ') + '</div>';

    if (issues.length > 0) {
        html += '<div class="mm-health-issues">' + issues.map(i => `<div>${i}</div>`).join('') + '</div>';
    } else {
        html += '<div class="mm-health-ok">✅ 记忆系统健康</div>';
    }

    // ── Orphan page list with checkboxes ──
    if (affectedPages.length > 0) {
        html += '<div class="mm-health-orphan-section">';
        html += '<div class="mm-health-orphan-title">受影响的故事页:</div>';
        html += '<div class="mm-health-orphan-list">';
        for (const item of affectedPages) {
            const p = item.page;
            const statusLabel = item.status === 'full'
                ? '<span class="mm-orphan-full">全孤立</span>'
                : `<span class="mm-orphan-partial">部分孤立 (${item.orphanCount}/${item.totalCount})</span>`;
            const checked = item.status === 'full' ? 'checked' : '';
            html += `
                <label class="mm-health-orphan-item">
                    <input type="checkbox" class="mm-orphan-check" data-page-id="${p.id}" ${checked} />
                    <span class="mm-orphan-day">${escapeHtml(p.day || '?')}</span>
                    <span class="mm-orphan-title">${escapeHtml(p.title)}</span>
                    ${statusLabel}
                </label>`;
        }
        html += '</div>';
        html += `<div class="mm-health-orphan-actions">
            <button class="mm-toolbox-btn mm-orphan-select-all">全选</button>
            <button class="mm-toolbox-btn mm-btn-danger mm-orphan-delete-btn">删除选中页面</button>
            <button class="mm-toolbox-btn mm-orphan-clean-dates-btn">清理孤立日期</button>
        </div>`;
        html += '</div>';
    } else if (orphanDates.size > 0) {
        // Orphan dates exist but no page has sourceDates linking to them
        html += `<div class="mm-health-orphan-section">
            <div class="mm-health-orphan-title">未找到关联故事页（可能是旧数据缺少 sourceDates）</div>
            <div class="mm-health-orphan-actions">
                <button class="mm-toolbox-btn mm-orphan-clean-dates-btn">清理 ${orphanDates.size} 条孤立日期记录</button>
            </div>
        </div>`;
    }

    return { html, orphanDates: [...orphanDates] };
}

// ── Quick Extract / Mark ──

export async function quickExtractRange(start, end) {
    const ctx = getContext();
    if (!ctx.chat || end >= ctx.chat.length) {
        toastr?.warning?.('消息范围超出聊天长度');
        return;
    }

    toastr?.info?.(`正在提取消息 ${start}-${end}...`, 'Memory Manager');
    try {
        await safeExtract(true);
        toastr?.success?.(`消息 ${start}-${end} 提取完成`);
    } catch (err) {
        toastr?.error?.('提取失败: ' + err.message);
    }
}

export function quickMarkExtracted(start, end) {
    const ctx = getContext();
    const data = getMemoryData();
    if (!ctx.chat || end >= ctx.chat.length) {
        toastr?.warning?.('消息范围超出聊天长度');
        return;
    }

    const messages = ctx.chat.slice(start, end + 1).filter(m => !m.is_system);
    markMsgsExtracted(data, messages);
    saveMemoryData();

    updateBrowserUI(['status']);
    toastr?.success?.(`已标记消息 ${start}-${end} 为已提取 (${messages.length} 条)`);
}

// ── Real-time Agent Command ──

export function buildRealTimeAgentTools(_data) {
    const tools = [];

    tools.push({
        type: 'function',
        function: {
            name: 'search_pages',
            description: '搜索故事页',
            parameters: {
                type: 'object',
                properties: {
                    keyword: { type: 'string', description: '搜索关键词' },
                },
                required: ['keyword'],
            },
        },
    });

    tools.push({
        type: 'function',
        function: {
            name: 'read_page',
            description: '读取故事页内容',
            parameters: {
                type: 'object',
                properties: {
                    page_id: { type: 'string', description: '故事页ID' },
                },
                required: ['page_id'],
            },
        },
    });

    tools.push({
        type: 'function',
        function: {
            name: 'list_pages',
            description: '列出所有故事页',
            parameters: { type: 'object', properties: {} },
        },
    });

    tools.push({
        type: 'function',
        function: {
            name: 'show_timeline',
            description: '显示时间线',
            parameters: { type: 'object', properties: {} },
        },
    });

    tools.push({
        type: 'function',
        function: {
            name: 'show_characters',
            description: '显示角色信息',
            parameters: { type: 'object', properties: {} },
        },
    });

    return tools;
}

export function executeRealTimeTool(name, args, data) {
    const pages = data.pages.filter(p => p.compressionLevel <= COMPRESS_SUMMARY);

    switch (name) {
    case 'search_pages': {
        const kw = (args.keyword || '').toLowerCase();
        const matched = pages.filter(p =>
            (p.keywords || []).some(k => k.toLowerCase().includes(kw))
            || p.title.toLowerCase().includes(kw)
            || p.content.toLowerCase().includes(kw),
        );
        if (matched.length === 0) return `没有找到关键词"${args.keyword}"相关的页面。`;
        return matched.map(p => `[${p.id}] ${p.day} | ${p.title}`).join('\n');
    }
    case 'read_page': {
        const page = data.pages.find(p => p.id === args.page_id);
        if (!page) return `页面 ${args.page_id} 不存在。`;
        return `[${page.id}] ${page.day} | ${page.title}\n${page.content}`;
    }
    case 'list_pages':
        if (pages.length === 0) return '没有故事页。';
        return pages.map(p => `[${p.id}] ${p.day} | ${p.title}`).join('\n');
    case 'show_timeline':
        return data.timeline || '（时间线为空）';
    case 'show_characters': {
        const parts = [];
        if (data.knownCharacterAttitudes.length > 0) {
            parts.push('已知角色:');
            for (const c of data.knownCharacterAttitudes) {
                parts.push(`  ${c.name}: ${c.attitude || '(未知)'}`);
            }
        }
        if (data.characters.length > 0) {
            parts.push('NPC角色:');
            for (const c of data.characters) {
                const roleStr = c.role ? `（${c.role}）` : '';
                const kwStr = (c.keywords && c.keywords.length > 0)
                    ? ` [关键词: ${c.keywords.join(', ')}]`
                    : '';
                parts.push(`  ${c.name}${roleStr}: ${c.attitude || ''}${kwStr}`);
            }
        }
        return parts.length > 0 ? parts.join('\n') : '没有角色数据。';
    }
    default:
        return '未知工具';
    }
}

export async function sendRealTimeCommand(text) {
    const s = getSettings();
    if (!s.useSecondaryApi || !s.secondaryApiUrl || !s.secondaryApiKey) {
        return '请先配置副API。';
    }

    const data = getMemoryData();
    const tools = buildRealTimeAgentTools(data);

    const systemMsg = `你是记忆管理助手。用户可以向你查询角色的记忆数据。\n\n当前故事索引:\n${formatStoryIndex(data)}`;
    const messages = [
        { role: 'system', content: systemMsg },
        ...rtCommandMessages.slice(-6), // Keep last 3 exchanges
        { role: 'user', content: text },
    ];

    rtCommandMessages.push({ role: 'user', content: text });

    try {
        const maxRounds = 3;
        for (let round = 0; round < maxRounds; round++) {
            const response = await callSecondaryApiChat(messages, tools, 500);

            if (response.toolCalls.length === 0) {
                const answer = (response.content || '').trim();
                rtCommandMessages.push({ role: 'assistant', content: answer });
                return answer || '（无回复）';
            }

            // Process tool calls
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
                } catch { args = {}; }

                const result = executeRealTimeTool(name, args, data);
                messages.push({ role: 'tool', tool_call_id: rawTc.id, content: result });
            }

            if (round === maxRounds - 1) {
                const finalResp = await callSecondaryApiChat(messages, [], 500);
                const answer = (finalResp.content || '').trim();
                rtCommandMessages.push({ role: 'assistant', content: answer });
                return answer || '（无回复）';
            }
        }
    } catch (err) {
        warn('Real-time command failed:', err);
        return '指令执行失败: ' + err.message;
    }

    return '（处理超时）';
}

// ── Batch Initialization ──

export function showInitRangeDialog() {
    return new Promise((resolve) => {
        const ctx = getContext();
        const chatLen = ctx.chat ? ctx.chat.length : 0;

        if (chatLen === 0) {
            toastr?.warning?.('当前没有聊天消息');
            resolve(null);
            return;
        }

        // Remove any existing dialog
        $('#mm_init_dialog').remove();

        const dialog = $(`
            <div id="mm_init_dialog" class="mm-init-dialog-backdrop">
                <div class="mm-init-dialog">
                    <div class="mm-init-dialog-title">初始化记忆提取</div>
                    <div class="mm-init-dialog-info">当前聊天共 <strong>${chatLen}</strong> 条消息</div>
                    <div class="mm-init-dialog-range">
                        <div class="mm-init-dialog-field">
                            <label>起始</label>
                            <input type="number" class="mm-init-start text_pole" value="0" min="0" max="${chatLen - 1}" />
                        </div>
                        <span class="mm-init-dialog-sep">—</span>
                        <div class="mm-init-dialog-field">
                            <label>结束</label>
                            <input type="number" class="mm-init-end text_pole" value="${chatLen - 1}" min="0" max="${chatLen - 1}" />
                        </div>
                    </div>
                    <div class="mm-init-dialog-hint">留空或 0 — ${chatLen - 1} 表示处理全部消息</div>
                    <div class="mm-init-dialog-actions">
                        <button class="mm-toolbox-btn mm-init-cancel">取消</button>
                        <button class="mm-toolbox-btn mm-toolbox-btn-send mm-init-confirm">开始初始化</button>
                    </div>
                </div>
            </div>
        `);

        dialog.find('.mm-init-cancel').on('click', () => {
            dialog.remove();
            resolve(null);
        });

        // Click backdrop to cancel
        dialog.on('click', function (e) {
            if ($(e.target).is('#mm_init_dialog')) {
                dialog.remove();
                resolve(null);
            }
        });

        dialog.find('.mm-init-confirm').on('click', () => {
            const start = parseInt(dialog.find('.mm-init-start').val()) || 0;
            const end = Math.min(parseInt(dialog.find('.mm-init-end').val()) || chatLen - 1, chatLen - 1);
            dialog.remove();
            if (start > end) {
                toastr?.warning?.('起始不能大于结束');
                resolve(null);
                return;
            }
            resolve({ start, end });
        });

        $('body').append(dialog);
        dialog.find('.mm-init-start').focus();
    });
}

export async function performBatchInitialization() {
    if (initializationInProgress) {
        toastr?.warning?.('初始化正在进行中...');
        return;
    }

    const range = await showInitRangeDialog();
    if (!range) return;

    initializationInProgress = true;
    failedBatches = [];

    const ctx = getContext();
    const data = getMemoryData();
    const s = getSettings();

    try {
        setMood('thinking');
        updateInitProgressUI(0, 1, '准备初始化...');

        await forceExtractUnprocessed(data, ctx, s);

        setMood('joyful', 5000);
        updateBrowserUI();
    } catch (err) {
        warn('Batch initialization failed:', err);
        setMood('sad', 5000);
        toastr?.error?.('初始化失败: ' + err.message, 'Memory Manager');
    } finally {
        initializationInProgress = false;
        hideInitProgressUI();
    }
}

export async function retryFailedBatches() {
    if (failedBatches.length === 0) {
        toastr?.info?.('没有失败的批次需要重试');
        return;
    }

    toastr?.info?.(`重试 ${failedBatches.length} 个失败批次...`);
    const batches = [...failedBatches];
    failedBatches = [];

    for (const batch of batches) {
        try {
            await safeExtract(true);
        } catch (err) {
            warn('Retry batch failed:', err);
            failedBatches.push(batch);
        }
    }

    if (failedBatches.length > 0) {
        toastr?.warning?.(`仍有 ${failedBatches.length} 个批次失败`);
    } else {
        toastr?.success?.('所有批次重试成功');
    }
}

// ── Init Progress UI ──

export function updateInitProgressUI(current, total, msg) {
    const container = $('#mm_init_progress');
    if (container.length === 0) return;

    container.show();
    const pct = total > 0 ? Math.round((current / total) * 100) : 0;
    container.html(`
        <div class="mm-init-progress-bar-track">
            <div class="mm-init-progress-bar-fill" style="width: ${pct}%"></div>
        </div>
        <div class="mm-init-progress-text">${escapeHtml(msg || '')} (${current}/${total}) ${pct}%</div>
    `);
}

export function hideInitProgressUI() {
    $('#mm_init_progress').hide().empty();
}
