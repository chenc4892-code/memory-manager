/**
 * Memory Manager — Utility Functions
 */

import { LOG_PREFIX } from './constants.js';

// Debug mode flag — injected by data.js via setDebugMode() to avoid circular dependency
let _debug = false;

export function setDebugMode(flag) {
    _debug = flag;
}

export function log(...args) {
    if (_debug) console.log(LOG_PREFIX, ...args);
}

export function warn(...args) {
    console.warn(LOG_PREFIX, ...args);
}

export function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

export function generateId(prefix = 'pg') {
    return prefix + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
}

export function cosineSimilarity(a, b) {
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// ── JSON Parsing ──

export function parseJsonResponse(text) {
    if (!text || typeof text !== 'string') {
        warn('parseJsonResponse: received non-string input:', typeof text, text);
        return null;
    }

    log('parseJsonResponse: input length =', text.length, 'preview:', text.substring(0, 150));

    // Strategy 1: markdown code block (greedy)
    const blockMatch = text.match(/```(?:json)?\s*\n?([\s\S]+)\n?\s*```/);
    if (blockMatch) {
        const raw = blockMatch[1].trim();
        log('Strategy 1: code block found, inner length =', raw.length);
        const fixed = fixJsonString(raw);
        try {
            const result = JSON.parse(fixed);
            log('Strategy 1: parse SUCCESS, keys:', Object.keys(result));
            return result;
        } catch (e) {
            warn('Strategy 1: code block parse failed:', e.message);
        }
    }

    // Strategy 2: bare JSON object (outermost braces)
    const braceStart = text.indexOf('{');
    const braceEnd = text.lastIndexOf('}');
    if (braceStart !== -1 && braceEnd > braceStart) {
        const raw = text.substring(braceStart, braceEnd + 1);
        log('Strategy 2: bare JSON found, length =', raw.length);
        const fixed = fixJsonString(raw);
        try {
            const result = JSON.parse(fixed);
            log('Strategy 2: parse SUCCESS, keys:', Object.keys(result));
            return result;
        } catch (e) {
            warn('Strategy 2: bare JSON parse failed:', e.message);
        }
    }

    // Strategy 3: aggressive fix — smart/curly quotes
    {
        const braceMatch = text.match(/\{[\s\S]*\}/);
        if (braceMatch) {
            let raw = braceMatch[0];
            raw = raw.replace(/[\u201C\u201D\u201E\u201F\u2033\u2036]/g, '\\"');
            raw = raw.replace(/[\u2018\u2019\u201A\u201B\u2032\u2035]/g, "\\'");
            const fixed = fixJsonString(raw);
            try {
                const result = JSON.parse(fixed);
                log('Strategy 3: aggressive fix SUCCESS, keys:', Object.keys(result));
                return result;
            } catch (e) {
                warn('Strategy 3: aggressive fix also failed:', e.message);
            }
        }
    }

    warn('Could not parse JSON from response. First 500 chars:', text.substring(0, 500));
    return null;
}

export function fixJsonString(raw) {
    let result = '';
    let inString = false;
    let escaped = false;

    for (let i = 0; i < raw.length; i++) {
        const ch = raw[i];

        if (escaped) {
            result += ch;
            escaped = false;
            continue;
        }

        if (ch === '\\' && inString) {
            result += ch;
            escaped = true;
            continue;
        }

        if (ch === '"') {
            if (!inString) {
                inString = true;
                result += ch;
            } else {
                // Peek ahead to decide: closing quote or content quote
                let j = i + 1;
                while (j < raw.length && (raw[j] === ' ' || raw[j] === '\t')) j++;
                const next = raw[j];
                if (next === ':' || next === ',' || next === '}' || next === ']'
                    || next === '\n' || next === '\r' || next === undefined) {
                    inString = false;
                    result += ch;
                } else {
                    result += '\\"';
                }
            }
            continue;
        }

        if (inString) {
            if (ch === '\n') { result += '\\n'; continue; }
            if (ch === '\r') { continue; }
            if (ch === '\t') { result += '\\t'; continue; }
        }

        result += ch;
    }

    result = result.replace(/,\s*([}\]])/g, '$1');
    return result;
}
