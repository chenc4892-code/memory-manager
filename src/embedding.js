/**
 * Memory Manager — Embedding Vector Retrieval
 * Direct browser fetch to 中转站 /v1/embeddings.
 */

import { COMPRESS_SUMMARY } from './constants.js';
import { log, warn, cosineSimilarity, parseJsonResponse } from './utils.js';
import { getSettings, getMemoryData, saveMemoryData } from './data.js';
import { callSecondaryApi } from './api.js';
import { MEMORY_CATEGORIES, VALID_CATEGORIES } from './constants.js';

// ── Configuration Helpers ──

function getEmbeddingBaseUrl() {
    const s = getSettings();
    const url = (s.embeddingApiUrl || s.secondaryApiUrl || '').trim();
    return url
        .replace(/\/+$/, '')
        .replace(/\/chat\/completions\/?$/, '');
}

function getEmbeddingApiKey() {
    const s = getSettings();
    return (s.embeddingApiKey || s.secondaryApiKey || '').trim();
}

export function isEmbeddingConfigured() {
    const s = getSettings();
    return s.useEmbedding && getEmbeddingBaseUrl() && getEmbeddingApiKey();
}

// ── Core API ──

export async function callEmbeddingsApi(texts) {
    const s = getSettings();
    const baseUrl = getEmbeddingBaseUrl();
    const apiKey = getEmbeddingApiKey();

    if (!baseUrl || !apiKey) {
        throw new Error('Embedding API not configured');
    }

    log('Calling embedding API:', baseUrl, 'model:', s.embeddingModel, 'texts:', texts.length);

    const response = await fetch(`${baseUrl}/embeddings`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
            model: s.embeddingModel || 'text-embedding-3-large',
            input: texts,
            dimensions: s.embeddingDimensions || 256,
        }),
    });

    if (!response.ok) {
        const errText = await response.text().catch(() => '');
        throw new Error(`Embedding API error ${response.status}: ${errText.substring(0, 200)}`);
    }

    const result = await response.json();
    return result.data.map(d => d.embedding);
}

// ── Embed Individual Items ──

export async function embedPage(page) {
    if (!isEmbeddingConfigured()) return;
    const data = getMemoryData();
    try {
        const text = `${page.title}: ${page.content}`;
        const [vector] = await callEmbeddingsApi([text]);
        data.embeddings[page.id] = vector;
        saveMemoryData();
        log('Embedded page:', page.id, page.title);
    } catch (err) {
        warn('Failed to embed page:', page.id, err);
    }
}

export async function embedCharacter(char) {
    if (!isEmbeddingConfigured()) return;
    const data = getMemoryData();
    try {
        const text = `角色 ${char.name}: 外貌: ${char.appearance || ''} 性格: ${char.personality || ''} 关系: ${char.relationship || ''} 态度: ${char.attitude || ''} 状态: ${char.currentState || ''}`;
        const [vector] = await callEmbeddingsApi([text]);
        data.embeddings[`char_${char.name}`] = vector;
        saveMemoryData();
        log('Embedded character:', char.name);
    } catch (err) {
        warn('Failed to embed character:', char.name, err);
    }
}

export async function embedAllPages(pages) {
    if (!isEmbeddingConfigured()) return;
    const data = getMemoryData();
    const batchSize = 20;

    for (let i = 0; i < pages.length; i += batchSize) {
        const batch = pages.slice(i, i + batchSize);
        const texts = batch.map(p => `${p.title}: ${p.content}`);

        try {
            const vectors = await callEmbeddingsApi(texts);
            for (let j = 0; j < batch.length; j++) {
                data.embeddings[batch[j].id] = vectors[j];
            }
        } catch (err) {
            warn('Failed to embed batch starting at', i, err);
        }
    }

    saveMemoryData();
    log('Embedded all pages:', pages.length);
}

// ── Pre-Filter for Retrieval ──

export async function embeddingPreFilter(data, recentText, topK) {
    try {
        const [queryVec] = await callEmbeddingsApi([recentText]);

        // Score pages
        const scoredPages = [];
        for (const page of data.pages) {
            if (page.compressionLevel > COMPRESS_SUMMARY) continue;
            const pageVec = data.embeddings[page.id];
            if (!pageVec) continue;
            const score = cosineSimilarity(queryVec, pageVec);
            scoredPages.push({ page, score });
        }
        scoredPages.sort((a, b) => b.score - a.score);

        // Score characters
        const scoredChars = [];
        for (const char of data.characters) {
            const charVec = data.embeddings[`char_${char.name}`];
            if (!charVec) continue;
            const score = cosineSimilarity(queryVec, charVec);
            scoredChars.push({ char, score });
        }
        scoredChars.sort((a, b) => b.score - a.score);

        const pageResults = scoredPages.slice(0, topK);
        const charResults = scoredChars.filter(r => r.score >= 0.45).slice(0, 2);

        log('Embedding pre-filter results:', pageResults.map(r => `${r.page.title}(${r.score.toFixed(3)})`));
        if (charResults.length > 0) {
            log('Embedding character matches:', charResults.map(r => `${r.char.name}(${r.score.toFixed(3)})`));
        }
        return {
            pages: pageResults.map(r => r.page),
            characters: charResults.map(r => r.char),
        };
    } catch (err) {
        warn('Embedding pre-filter failed:', err);
        return null;
    }
}

// ── Test & Rebuild ──

export async function testEmbeddingApi() {
    toastr?.info?.('正在测试Embedding API连接...', 'Memory Manager');
    const vectors = await callEmbeddingsApi(['测试文本']);
    if (vectors && vectors[0] && vectors[0].length > 0) {
        toastr?.success?.(`Embedding连接成功！返回${vectors[0].length}维向量`, 'Memory Manager');
        return vectors[0].length;
    } else {
        throw new Error('Embedding API返回了空结果');
    }
}

/**
 * Rebuild all vectors for pages and characters.
 * NOTE: Callers must call updateBrowserUI(['embedding']) after this returns.
 */
export async function rebuildAllVectors() {
    const data = getMemoryData();
    const pages = data.pages.filter(p => p.compressionLevel <= COMPRESS_SUMMARY);
    const chars = data.characters || [];
    if (pages.length === 0 && chars.length === 0) {
        toastr?.warning?.('没有可索引的内容', 'Memory Manager');
        return;
    }

    toastr?.info?.(`正在为${pages.length}个页面和${chars.length}个角色生成向量...`, 'Memory Manager');
    data.embeddings = {};
    await embedAllPages(pages);
    for (const char of chars) {
        await embedCharacter(char);
    }

    const indexed = Object.keys(data.embeddings).length;
    toastr?.success?.(`向量库重建完成: ${indexed} 条已索引（${pages.length}页 + ${chars.length}角色）`, 'Memory Manager');
}

/**
 * Retroactively assign semantic categories to pages that have none.
 * NOTE: Callers must call updateBrowserUI(['pageList']) after this returns.
 */
export async function rebuildCategories() {
    const s = getSettings();
    const data = getMemoryData();
    const pagesNeedingCats = data.pages.filter(p =>
        p.compressionLevel <= COMPRESS_SUMMARY && (!p.categories || p.categories.length === 0),
    );

    if (pagesNeedingCats.length === 0) {
        toastr?.info?.('所有页面已有分类标签', 'Memory Manager');
        return;
    }

    const hasApi = s.useSecondaryApi && s.secondaryApiUrl && s.secondaryApiKey;
    if (!hasApi) {
        toastr?.warning?.('需要副API来分析页面内容并分配分类', 'Memory Manager');
        return;
    }

    toastr?.info?.(`正在为${pagesNeedingCats.length}个页面分配分类标签...`, 'Memory Manager');

    const validCats = Object.keys(MEMORY_CATEGORIES);
    const catDesc = validCats.map(c => `${c}(${MEMORY_CATEGORIES[c]})`).join(', ');

    let assigned = 0;
    const batchSize = 5;
    for (let i = 0; i < pagesNeedingCats.length; i += batchSize) {
        const batch = pagesNeedingCats.slice(i, i + batchSize);
        const batchPrompt = batch.map(p =>
            `[${p.id}] ${p.day} | ${p.title}\n内容: ${(p.content || '').substring(0, 200)}`,
        ).join('\n\n');

        try {
            const result = await callSecondaryApi(
                null,
                `为以下故事页面分配语义分类标签。每个页面分配1-3个最相关的分类。

可用分类: ${catDesc}

## 页面
${batchPrompt}

回复格式（严格JSON数组）:
[{"id":"页面ID","categories":["cat1","cat2"]}]

只输出JSON，不要其他文字。`,
                300,
            );

            const parsed = parseJsonResponse(result);
            if (Array.isArray(parsed)) {
                for (const item of parsed) {
                    const page = data.pages.find(p => p.id === item.id);
                    if (page && Array.isArray(item.categories)) {
                        page.categories = item.categories.filter(c => VALID_CATEGORIES.has(c));
                        if (page.categories.length > 0) assigned++;
                    }
                }
            }
        } catch (err) {
            warn('Category assignment batch failed:', err);
        }
    }

    saveMemoryData();
    toastr?.success?.(`分类标签分配完成: ${assigned}/${pagesNeedingCats.length} 页已分类`, 'Memory Manager');
}
