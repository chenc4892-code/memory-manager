/**
 * Memory Manager — API Layer
 * LLM calls (primary + secondary), world book context gathering.
 */

import { log, warn } from './utils.js';
import { getSettings } from './data.js';

import {
    generateQuietPrompt,
    getRequestHeaders,
} from '../../../../../script.js';

import {
    getSortedEntries,
} from '../../../../world-info.js';

// ── Primary / Secondary API ──

export async function callLLM(systemPrompt, userPrompt, maxTokens = null) {
    const s = getSettings();

    if (s.useSecondaryApi && s.secondaryApiUrl && s.secondaryApiKey) {
        return await callSecondaryApi(systemPrompt, userPrompt, maxTokens);
    }

    // Fallback: use main API
    log('Using main API (no secondary API configured)');
    const fullPrompt = systemPrompt
        ? `${systemPrompt}\n\n${userPrompt}`
        : userPrompt;
    return await generateQuietPrompt(fullPrompt, false, true, null, null, maxTokens || s.extractionMaxTokens);
}

export async function callSecondaryApi(systemPrompt, userPrompt, maxTokens) {
    const s = getSettings();
    const baseUrl = s.secondaryApiUrl
        .replace(/\/+$/, '')
        .replace(/\/chat\/completions\/?$/, '');

    const messages = [];
    if (systemPrompt) {
        messages.push({ role: 'system', content: systemPrompt });
    }
    messages.push({ role: 'user', content: userPrompt });

    log('Calling secondary API via server proxy:', baseUrl, 'model:', s.secondaryApiModel);

    const response = await fetch('/api/backends/chat-completions/generate', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({
            chat_completion_source: 'openai',
            reverse_proxy: baseUrl,
            proxy_password: s.secondaryApiKey,
            model: s.secondaryApiModel || undefined,
            messages: messages,
            temperature: s.secondaryApiTemperature ?? 0.3,
            max_tokens: (maxTokens && maxTokens > 0) ? maxTokens : undefined,
            stream: false,
        }),
    });

    if (!response.ok) {
        const errText = await response.text().catch(() => '');
        throw new Error(`Secondary API error ${response.status}: ${errText.substring(0, 200)}`);
    }

    const responseText = await response.text();
    let data;
    try {
        data = JSON.parse(responseText);
    } catch (e) {
        warn('Failed to parse server response as JSON:', e.message, 'raw:', responseText.substring(0, 300));
        throw new Error(`Server response is not valid JSON: ${e.message}`);
    }

    let content = data.choices?.[0]?.message?.content;
    if (!content && typeof data === 'string') content = data;

    if (!content) {
        warn('Secondary API response structure:', JSON.stringify(data).substring(0, 500));
        throw new Error('Secondary API returned empty response');
    }

    log('Secondary API response length:', content.length);
    return content;
}

/**
 * Call secondary API with tool calling support.
 * Returns { content, toolCalls } where toolCalls is an array of parsed tool calls.
 */
export async function callSecondaryApiWithTools(systemPrompt, userPrompt, tools, maxTokens) {
    const s = getSettings();
    const baseUrl = s.secondaryApiUrl
        .replace(/\/+$/, '')
        .replace(/\/chat\/completions\/?$/, '');

    const messages = [];
    if (systemPrompt) {
        messages.push({ role: 'system', content: systemPrompt });
    }
    messages.push({ role: 'user', content: userPrompt });

    log('Calling secondary API with tools:', tools.map(t => t.function.name));

    const body = {
        chat_completion_source: 'openai',
        reverse_proxy: baseUrl,
        proxy_password: s.secondaryApiKey,
        model: s.secondaryApiModel || undefined,
        messages: messages,
        temperature: s.secondaryApiTemperature ?? 0.3,
        max_tokens: (maxTokens && maxTokens > 0) ? maxTokens : undefined,
        stream: false,
        tools: tools,
        tool_choice: 'auto',
    };

    const response = await fetch('/api/backends/chat-completions/generate', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify(body),
    });

    if (!response.ok) {
        const errText = await response.text().catch(() => '');
        throw new Error(`Secondary API (tools) error ${response.status}: ${errText.substring(0, 200)}`);
    }

    const responseText = await response.text();
    let respData;
    try {
        respData = JSON.parse(responseText);
    } catch (e) {
        throw new Error(`Server response is not valid JSON: ${e.message}`);
    }

    const message = respData.choices?.[0]?.message;
    const content = message?.content || '';
    const rawToolCalls = message?.tool_calls || [];

    // Parse tool call arguments
    const toolCalls = rawToolCalls.map(tc => {
        let args = {};
        try {
            args = typeof tc.function?.arguments === 'string'
                ? JSON.parse(tc.function.arguments)
                : tc.function?.arguments || {};
        } catch (e) {
            warn('Failed to parse tool call arguments:', tc.function?.arguments);
        }
        return {
            name: tc.function?.name || '',
            arguments: args,
        };
    });

    log('Tool calls received:', toolCalls.length, toolCalls.map(tc => `${tc.name}(${JSON.stringify(tc.arguments)})`));
    return { content, toolCalls };
}

/**
 * Call secondary API with arbitrary messages array (for multi-round tool calling).
 * Returns { content, toolCalls, rawMessage, rawToolCalls }
 */
export async function callSecondaryApiChat(messages, tools, maxTokens) {
    const s = getSettings();
    const baseUrl = s.secondaryApiUrl
        .replace(/\/+$/, '')
        .replace(/\/chat\/completions\/?$/, '');
    const body = {
        chat_completion_source: 'openai',
        reverse_proxy: baseUrl,
        proxy_password: s.secondaryApiKey,
        model: s.secondaryApiModel || undefined,
        messages: messages,
        temperature: s.secondaryApiTemperature ?? 0.3,
        max_tokens: (maxTokens && maxTokens > 0) ? maxTokens : undefined,
        stream: false,
    };
    if (tools && tools.length > 0) {
        body.tools = tools;
        body.tool_choice = 'auto';
    }
    const response = await fetch('/api/backends/chat-completions/generate', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify(body),
    });
    if (!response.ok) {
        const errText = await response.text().catch(() => '');
        throw new Error(`Secondary API error ${response.status}: ${errText.substring(0, 200)}`);
    }
    const responseText = await response.text();
    let respData;
    try {
        respData = JSON.parse(responseText);
    } catch (e) {
        throw new Error(`Response not valid JSON: ${e.message}`);
    }
    const rawMessage = respData.choices?.[0]?.message || {};
    const content = rawMessage.content || '';
    const rawToolCalls = rawMessage.tool_calls || [];
    const toolCalls = rawToolCalls.map(tc => {
        let args = {};
        try {
            args = typeof tc.function?.arguments === 'string'
                ? JSON.parse(tc.function.arguments)
                : tc.function?.arguments || {};
        } catch (e) {
            warn('Failed to parse tool call arguments:', tc.function?.arguments);
        }
        return { name: tc.function?.name || '', arguments: args };
    });
    log('API chat response:', toolCalls.length, 'tool calls');
    return { content, toolCalls, rawMessage, rawToolCalls };
}

export async function testSecondaryApi() {
    const s = getSettings();
    if (!s.secondaryApiUrl || !s.secondaryApiKey) {
        toastr?.warning?.('请先填写副API地址和密钥', 'Memory Manager');
        return;
    }

    try {
        toastr?.info?.('正在测试副API连接...', 'Memory Manager');
        const result = await callSecondaryApi(
            '你是一个测试助手。',
            '请回复"连接成功"四个字。',
            50,
        );
        toastr?.success?.(`副API连接成功！回复: ${result.substring(0, 100)}`, 'Memory Manager');
    } catch (err) {
        toastr?.error?.(`副API连接失败: ${err.message}`, 'Memory Manager');
    }
}

// ── World Book Context ──

export async function gatherWorldBookContext() {
    try {
        const entries = await getSortedEntries();
        const activeEntries = entries?.filter(e => !e.disable && e.content?.trim());
        if (!activeEntries || activeEntries.length === 0) return '';

        const positionLabels = {
            0: '角色定义前 (↑Char)',
            1: '角色定义后 (↓Char)',
            2: '作者注释顶部 (↑AT)',
            3: '作者注释底部 (↓AT)',
            4: '指定深度 (@D)',
            5: '扩展提示顶部 (↑EM)',
            6: '扩展提示底部 (↓EM)',
        };
        const positionOrder = [0, 1, 2, 3, 4, 5, 6];

        const groups = new Map();
        for (const entry of activeEntries) {
            const pos = entry.position ?? 0;
            if (!groups.has(pos)) groups.set(pos, []);
            groups.get(pos).push(entry);
        }

        const parts = [];
        for (const pos of positionOrder) {
            const group = groups.get(pos);
            if (!group || group.length === 0) continue;

            const label = positionLabels[pos] || `位置 ${pos}`;
            parts.push(`=== ${label} ===`);
            group.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
            for (const entry of group) {
                const name = entry.comment || (entry.key || []).join('/') || '(无标题)';
                parts.push(`【${name}】${entry.content}`);
            }
        }

        return parts.join('\n');
    } catch (err) {
        warn('Failed to load world info:', err);
        return '';
    }
}
