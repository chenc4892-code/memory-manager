/**
 * Memory Manager — Slash Commands
 * Registration of /mm-* slash commands for SillyTavern.
 */

import { log, warn } from './utils.js';
import { getMemoryData } from './data.js';
import { sha256 } from './auth.js';
import { formatStoryIndex } from './formatting.js';
import { safeExtract } from './extraction.js';
import { safeCompress } from './compression.js';
import { getLastNarrative, getLastRecalledPages } from './retrieval.js';
import { onResetClick } from './ui-browser.js';

import { getContext } from '../../../../extensions.js';

export function registerSlashCommands() {
    const ctx = getContext();
    if (!ctx.SlashCommandParser || !ctx.SlashCommand) {
        log('SlashCommandParser not available, skipping command registration');
        return;
    }

    const { SlashCommandParser, SlashCommand } = ctx;

    try {
        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'mm-extract',
            callback: async () => {
                await safeExtract(true);
                return '记忆提取完成';
            },
            helpString: '强制执行记忆提取',
        }));

        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'mm-recall',
            callback: async () => {
                const narrative = getLastNarrative();
                if (!narrative) return '当前没有记忆召回';
                const pages = getLastRecalledPages();
                const sources = pages.map(p => `${p.day} ${p.title}`).join(', ');
                return narrative + (sources ? `\n\n来源: ${sources}` : '');
            },
            helpString: '显示当前记忆召回叙事',
        }));

        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'mm-index',
            callback: async () => {
                const data = getMemoryData();
                return formatStoryIndex(data) || '（故事索引为空）';
            },
            helpString: '显示当前故事索引',
        }));

        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'mm-pages',
            callback: async () => {
                const data = getMemoryData();
                if (data.pages.length === 0) return '没有故事页';
                return data.pages.map(p => {
                    const level = ['详细', '摘要', '归档'][p.compressionLevel] || '?';
                    return `[${p.day}] ${p.title} (${p.significance}, ${level}) keywords: ${(p.keywords || []).join(',')}`;
                }).join('\n');
            },
            helpString: '列出所有故事页',
        }));

        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'mm-compress',
            callback: async () => {
                await safeCompress(true);
                return '压缩完成';
            },
            helpString: '强制执行记忆压缩',
        }));

        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'mm-reset',
            callback: async () => {
                onResetClick();
                return '';
            },
            helpString: '重置当前聊天的记忆数据',
        }));

        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'mm-gen-auth',
            callback: async (_args, value) => {
                const code = value?.trim();
                if (!code) return '用法: /mm-gen-auth <授权码明文>';
                const hash = await sha256(code);
                return `授权码: ${code}\nSHA-256: '${hash}',`;
            },
            helpString: '生成授权码的 SHA-256 哈希（作者用）',
        }));

        log('Slash commands registered');
    } catch (err) {
        warn('Failed to register slash commands:', err);
    }
}
