/**
 * Memory Manager — Save System (存档系统)
 * Save/load/delete memory slots, auto-save.
 */

import { log, warn } from './utils.js';
import {
    getMemoryData,
    saveMemoryData,
    getSaveIndex,
    updateSaveIndex,
    runMigrationChain,
} from './data.js';

import {
    getRequestHeaders,
} from '../../../../../script.js';

import {
    getContext,
} from '../../../../extensions.js';

export async function saveToSlot(charName, slotName) {
    if (!charName) return;
    const data = getMemoryData();

    // Serialize memory data
    const saveData = { ...data };
    const json = JSON.stringify(saveData);
    const bytes = new TextEncoder().encode(json);
    let binary = '';
    for (const b of bytes) binary += String.fromCharCode(b);
    const base64 = btoa(binary);

    // Sanitize filename: ST only allows [a-zA-Z0-9_-], no Chinese chars
    const safeChar = charName.replace(/[^a-zA-Z0-9_-]/g, '') || 'char';
    const safeSlot = slotName.replace(/[^a-zA-Z0-9_-]/g, '') || 'slot';
    const fileName = `mm-save-${safeChar}-${safeSlot}-${Date.now()}.json`;

    try {
        const response = await fetch('/api/files/upload', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                name: fileName,
                data: base64,
            }),
        });

        if (!response.ok) {
            throw new Error(`Upload failed: ${response.status}`);
        }

        const result = await response.json();
        const filePath = result.path;

        // Update save index
        const idx = getSaveIndex();
        if (!idx[charName]) {
            idx[charName] = { activeSlot: slotName, slots: [] };
        }

        // Find existing slot or create new
        const existingSlot = idx[charName].slots.find(s => s.name === slotName);
        if (existingSlot) {
            // Delete old file
            try {
                await fetch('/api/files/delete', {
                    method: 'POST',
                    headers: getRequestHeaders(),
                    body: JSON.stringify({ path: existingSlot.path }),
                });
            } catch (e) {
                warn('Failed to delete old save file:', e);
            }
            existingSlot.path = filePath;
            existingSlot.updatedAt = Date.now();
            existingSlot.pageCount = data.pages.length;
        } else {
            idx[charName].slots.push({
                name: slotName,
                path: filePath,
                updatedAt: Date.now(),
                pageCount: data.pages.length,
            });
        }

        idx[charName].activeSlot = slotName;
        updateSaveIndex(charName, idx[charName]);

        log('Saved to slot:', charName, slotName, filePath);
        return true;
    } catch (err) {
        warn('Save to slot failed:', err);
        toastr?.error?.(`存档保存失败: ${err.message}`, 'Memory Manager');
        return false;
    }
}

/**
 * Load memory data from a save slot.
 * NOTE: Callers must call updateBrowserUI() after this returns.
 */
export async function loadFromSlot(charName, slotName) {
    const idx = getSaveIndex();
    const slot = idx[charName]?.slots?.find(s => s.name === slotName);
    if (!slot) {
        toastr?.warning?.('找不到存档', 'Memory Manager');
        return false;
    }

    try {
        const response = await fetch(slot.path);
        if (!response.ok) {
            throw new Error(`Fetch failed: ${response.status}`);
        }

        let imported = await response.json();

        // Run migration chain if needed
        imported = runMigrationChain(imported);

        const ctx = getContext();
        ctx.chatMetadata.memoryManager = imported;
        saveMemoryData();

        // Update active slot
        idx[charName].activeSlot = slotName;
        updateSaveIndex(charName, idx[charName]);

        log('Loaded from slot:', charName, slotName);
        toastr?.success?.(`已加载存档「${slotName}」`, 'Memory Manager');
        return true;
    } catch (err) {
        warn('Load from slot failed:', err);
        toastr?.error?.(`存档加载失败: ${err.message}`, 'Memory Manager');
        return false;
    }
}

export async function deleteSlot(charName, slotName) {
    const idx = getSaveIndex();
    const charIdx = idx[charName];
    if (!charIdx) return;

    const slotIdx = charIdx.slots.findIndex(s => s.name === slotName);
    if (slotIdx === -1) return;

    const slot = charIdx.slots[slotIdx];

    // Delete file
    try {
        await fetch('/api/files/delete', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ path: slot.path }),
        });
    } catch (e) {
        warn('Failed to delete save file:', e);
    }

    // Remove from index
    charIdx.slots.splice(slotIdx, 1);
    if (charIdx.activeSlot === slotName) {
        charIdx.activeSlot = charIdx.slots.length > 0 ? charIdx.slots[0].name : null;
    }

    updateSaveIndex(charName, charIdx);
    log('Deleted slot:', charName, slotName);
}

