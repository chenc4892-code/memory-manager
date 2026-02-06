// ==================== 回忆世界书管理器 v2.9.0 (SillyTavern Extension) ====================
// v2.9.0:
// - ★ 新增：总结指令面板（替换写入面板）
// - ★ 大总结 / 二次总结 一键发送
// - 保留 🔄 解析全部按钮用于手动写入世界书
import { extension_settings, getContext } from '../../../extensions.js';
import { saveSettingsDebounced, getRequestHeaders } from '../../../../script.js';

const MODULE_NAME = 'memory-manager';
const EXTENSION_PATH = `scripts/extensions/third-party/${MODULE_NAME}`;

// ==================== 默认设置 ====================
const DEFAULT_SETTINGS = {
  enabled: true,
  debug: false,
  fabPosX: -1,
  fabPosY: -1,
  isDocked: false,
  dockedSide: null,
  lastUsedBooks: {},
};

// ==================== 配置 ====================
const CONFIG = {
  LOREBOOK_SUFFIX: '的回忆',
  LOREBOOK_BRANCH_SEPARATOR: '-',
  SUMMARY_TAG: 'Plot Summary',
  OPERATION_DELAY: 300,
  DOCK_THRESHOLD: 90,
  POSITION_MAP: {
    'before_character_definition': 0,
    'after_character_definition': 1,
    'before_example_messages': 2,
    'after_example_messages': 3,
    'at_depth_as_system': 4,
    'at_depth_as_assistant': 5,
    'at_depth_as_user': 6,
  },
  ENTRIES: {
    'keyevents': { comment: 'keyevents', type: 'constant', position: 'at_depth_as_system', depth: 4, order: 100, content: '# 主要角色关键事件记录\n' },
    '新增角色': { comment: '新增角色', type: 'constant', position: 'after_character_definition', order: 1001, content: '# 新增角色\n' },
    '角色变化': { comment: '角色变化', type: 'constant', position: 'after_character_definition', order: 1002, content: '# 角色变化总结\n' },
    '物品记录': { comment: '物品记录', type: 'constant', position: 'after_character_definition', order: 1003, content: '# 重要物品记录\n' },
    '===开始===': { comment: '===开始===', type: 'constant', position: 'after_character_definition', order: 1004, content: '<memory>' },
    '回忆': { comment: '回忆', type: 'constant', position: 'after_character_definition', order: 1005, content: '# 回忆\n' },
    '===结束===': { comment: '===结束===', type: 'constant', position: 'after_character_definition', order: 1200, content: '</memory>' },
  },

  // ★ 新增：总结指令模板
  SUMMARY_PROMPTS: {
    full: `[OOC: 停止角色扮演。请从第一天开始，对到目前为止的所有剧情进行完整总结。
    ]`,

    compress: `[OOC: 停止角色扮演。请从第一天开始，对到目前为止的所有剧情进行二次压缩总结。

**压缩原则（务必遵守）：**
1. 对于「## 回忆」部分：尽量不要写入角色的主观感受。格外关注事件因果逻辑，尽可能不丢失事件因果链以及关键信息。
2. 对于无法进一步压缩的已有 <memory> 内容：可以改写成英文或文言文来节约token。
3. 合并同类事件，删除冗余描述和修饰性语句，只保留核心事实。
]`,
  },
};

// ==================== 工具 ====================
function getSettings() { return extension_settings[MODULE_NAME]; }

function log(msg, data = null) {
  if (getSettings()?.debug) console.log(`[回忆管理器] ${msg}`, data ?? '');
}

function error(msg, err = null) {
  console.error(`[回忆管理器] ${msg}`, err ?? '');
}

const wait = (ms) => new Promise(r => setTimeout(r, ms));

function saveLastUsedBook(charName, bookName) {
  const settings = getSettings();
  if (!settings.lastUsedBooks) settings.lastUsedBooks = {};
  settings.lastUsedBooks[charName] = bookName;
  saveSettingsDebounced();
  log(`已记住 ${charName} → ${bookName}`);
}

// ==================== world-info 模块缓存 ====================
let _wiModule = null;

async function getWiModule() {
  if (_wiModule) return _wiModule;
  const paths = [
    '../../../world-info.js',
    '../../world-info.js',
    '../../../../scripts/world-info.js',
  ];
  for (const p of paths) {
    try {
      _wiModule = await import(p);
      log('world-info 模块加载成功');
      return _wiModule;
    } catch { /* try next */ }
  }
  console.warn('[回忆管理器] world-info 模块所有路径都失败');
  return null;
}

// ==================== SillyTavern API ====================
const ST = {
  getCharName() {
    return getContext()?.name2 || '未知角色';
  },

  getChat() {
    return getContext()?.chat || [];
  },

  getLastMessage() {
    const c = this.getChat();
    return c.length > 0 ? c[c.length - 1] : null;
  },

  getMessage(i) {
    const c = this.getChat();
    return (i >= 0 && i < c.length) ? c[i] : null;
  },

  getLastMessageId() {
    return Math.max(0, this.getChat().length - 1);
  },

  async execSlash(command) {
    const ctx = getContext();
    if (!ctx) throw new Error('context 不可用');
    if (typeof ctx.executeSlashCommandsWithOptions === 'function') {
      try {
        const r = await ctx.executeSlashCommandsWithOptions(command, {
          handleParserErrors: true, handleExecutionErrors: true,
        });
        return r?.pipe ?? '';
      } catch (e) {
        error(`slash: ${command.substring(0, 80)}`, e);
        throw e;
      }
    }
    if (typeof ctx.executeSlashCommands === 'function') {
      const r = await ctx.executeSlashCommands(command);
      return typeof r === 'string' ? r : '';
    }
    throw new Error('executeSlashCommands 不可用');
  },

  async toast(msg) {
    try { await this.execSlash(`/echo ${msg}`); }
    catch {
      const el = document.getElementById('mem-toast-fallback');
      if (el) { el.textContent = msg; el.style.display = 'block'; setTimeout(() => { el.style.display = 'none'; }, 3000); }
    }
  },

  async getAllWorldNames() {
    try {
      if (typeof window.world_names !== 'undefined' && Array.isArray(window.world_names) && window.world_names.length > 0) {
        return [...window.world_names];
      }
    } catch { }
    try {
      const wi = await getWiModule();
      if (wi?.world_names && Array.isArray(wi.world_names) && wi.world_names.length > 0) {
        return [...wi.world_names];
      }
    } catch { }
    for (const ep of ['/api/worldinfo', '/getworldnames']) {
      try {
        const r = await fetch(ep, { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify({}) });
        if (r.ok) {
          const d = await r.json();
          if (Array.isArray(d) && d.length > 0) return d;
          if (d?.world_names) return d.world_names;
        }
      } catch { }
    }
    return [];
  },

  async getActiveWorldBooks() {
    log('正在检测已激活的世界书...');
    try {
      const wi = await getWiModule();
      if (wi) {
        const candidates = [wi.selected_world_info, wi.getActiveWorldNames?.(), wi.active_world];
        for (const c of candidates) {
          if (c) {
            let result = null;
            if (Array.isArray(c) && c.length > 0) result = [...c];
            else if (c instanceof Set && c.size > 0) result = [...c];
            else if (typeof c === 'string' && c.trim()) result = c.split(',').map(s => s.trim()).filter(Boolean);
            if (result && result.length > 0) { log('检测到已激活世界书:', result); return result; }
          }
        }
      }
    } catch (e) { log('方法1失败', e); }
    try { if (typeof window.selected_world_info !== 'undefined') { const swi = window.selected_world_info; if (Array.isArray(swi) && swi.length > 0) return [...swi]; } } catch { }
    try { if (typeof window.power_user !== 'undefined' && window.power_user?.world_info) { const wi = window.power_user.world_info; if (typeof wi === 'string' && wi.trim()) { const r = wi.split(',').map(s => s.trim()).filter(Boolean); if (r.length > 0) return r; } } } catch { }
    try { const ctx = getContext(); if (ctx?.worldInfoActivated && Array.isArray(ctx.worldInfoActivated)) return [...ctx.worldInfoActivated]; } catch { }
    log('所有方法都未检测到已激活世界书');
    return [];
  },

  async createWorld(name) {
    log(`创建世界书: "${name}"`);
    try { const wi = await getWiModule(); if (wi?.createNewWorldInfo) { await wi.createNewWorldInfo(name); return true; } } catch (e) { log('模块创建失败', e); }
    for (const ep of ['/api/worldinfo/create', '/createworldinfo']) {
      try { const r = await fetch(ep, { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify({ name }) }); if (r.ok) return true; } catch { }
    }
    error(`创建失败: "${name}"`); return false;
  },

  async setWorldActive(name, active = true) {
    try { await this.execSlash(active ? `/world ${name}` : `/world state=off silent=true ${name}`); return true; }
    catch (e) { log(`激活 "${name}"=${active} 失败`, e); return false; }
  },
};

// ==================== 操作队列 ====================
class OperationQueue {
  constructor() { this.queue = []; this.processing = false; this.currentOp = null; }
  async enqueue(name, fn) {
    return new Promise((resolve, reject) => {
      log(`[队列] +${name} (等待=${this.queue.length})`);
      this.queue.push({ name, fn, resolve, reject });
      this._run();
    });
  }
  async _run() {
    if (this.processing || !this.queue.length) return;
    this.processing = true;
    const item = this.queue.shift();
    this.currentOp = item.name;
    try { const r = await item.fn(); await wait(CONFIG.OPERATION_DELAY); item.resolve(r); }
    catch (e) { error(`[队列] ✗ ${item.name}`, e); item.reject(e); }
    finally { this.processing = false; this.currentOp = null; if (this.queue.length) this._run(); }
  }
}
const opQueue = new OperationQueue();

// ==================== LorebookManager ====================
class LorebookManager {
  constructor() {
    this.lorebookName = null;
    this.charName = null;
    this.entryUids = {};
    this.initialized = false;
  }

  async _findUid(bookName, comment) {
    try { const r = await ST.execSlash(`/findentry file="${bookName}" field=comment ${comment}`); const t = r?.trim(); if (t && t !== '' && !isNaN(t)) return parseInt(t); } catch { }
    return null;
  }

  async _createEntry(bookName, comment, content, config = {}) {
    const entryConfig = CONFIG.ENTRIES[comment] || config;
    const posNum = CONFIG.POSITION_MAP[entryConfig.position] ?? 1;
    try {
      log(`[创建] "${comment}" → "${bookName}"`);
      const uidStr = await ST.execSlash(`/createentry file="${bookName}" ${content}`);
      const uid = uidStr?.trim();
      if (!uid || uid === '' || isNaN(uid)) { error(`创建失败: "${comment}"`); return null; }
      await ST.execSlash(`/setentryfield file="${bookName}" uid=${uid} field=comment ${comment}`);
      if (entryConfig.type === 'constant') await ST.execSlash(`/setentryfield file="${bookName}" uid=${uid} field=constant true`);
      await ST.execSlash(`/setentryfield file="${bookName}" uid=${uid} field=position ${posNum}`);
      if (entryConfig.order !== undefined) await ST.execSlash(`/setentryfield file="${bookName}" uid=${uid} field=order ${entryConfig.order}`);
      if (posNum >= 4 && entryConfig.depth) await ST.execSlash(`/setentryfield file="${bookName}" uid=${uid} field=depth ${entryConfig.depth}`);
      log(`[创建] "${comment}" UID=${uid} ✓`);
      return parseInt(uid);
    } catch (e) { error(`创建 "${comment}" 异常`, e); return null; }
  }

  async _updateContent(bookName, uid, content) {
    try { await ST.execSlash(`/setentryfield file="${bookName}" uid=${uid} field=content ${content}`); return true; }
    catch (e) { error(`更新 UID=${uid} 失败`, e); return false; }
  }

  async _upsertEntry(comment, content, config = {}) {
    if (!this.lorebookName) return;
    let uid = this.entryUids[comment];
    if (uid === undefined || uid === null) {
      uid = await this._findUid(this.lorebookName, comment);
      if (uid !== null) this.entryUids[comment] = uid;
    }
    if (uid !== null && uid !== undefined) { await this._updateContent(this.lorebookName, uid, content); }
    else {
      const newUid = await this._createEntry(this.lorebookName, comment, content, config);
      if (newUid !== null) this.entryUids[comment] = newUid;
    }
  }

  async _loadEntryMap() {
    this.entryUids = {};
    if (!this.lorebookName) return;
    log(`加载条目: "${this.lorebookName}"`);
    for (const name of Object.keys(CONFIG.ENTRIES)) {
      const uid = await this._findUid(this.lorebookName, name);
      if (uid !== null) this.entryUids[name] = uid;
      await wait(50);
    }
    const missing = Object.keys(CONFIG.ENTRIES).filter(n => this.entryUids[n] === undefined);
    if (missing.length > 0) {
      log(`补建 ${missing.length} 个: ${missing.join(', ')}`);
      for (const name of missing) {
        const cfg = CONFIG.ENTRIES[name];
        const uid = await this._createEntry(this.lorebookName, name, cfg.content, cfg);
        if (uid !== null) this.entryUids[name] = uid;
        await wait(150);
      }
    }
  }

  async init(force = false) {
    return opQueue.enqueue('初始化', async () => {
      if (!force && this.initialized) return;
      this.charName = ST.getCharName();
      if (!this.charName || this.charName === '未知角色' || this.charName === 'undefined') {
        this.lorebookName = null; this.entryUids = {}; this.initialized = false;
        updateSettingsStatus('⚠️ 请先选择角色'); return;
      }
      const books = await this.getCharMemoryBooks();
      const baseName = `${this.charName}${CONFIG.LOREBOOK_SUFFIX}`;
      const savedBook = getSettings().lastUsedBooks?.[this.charName];
      const activeWorlds = await ST.getActiveWorldBooks();
      const activeMemBook = books.find(b => activeWorlds.includes(b));

      if (activeMemBook) { this.lorebookName = activeMemBook; log(`✓ 已激活: ${activeMemBook}`); }
      else if (savedBook && books.includes(savedBook)) { this.lorebookName = savedBook; }
      else if (books.includes(baseName)) { this.lorebookName = baseName; }
      else if (books.length > 0) { this.lorebookName = books[0]; }
      else { this.lorebookName = null; }

      if (this.lorebookName) { await this._loadEntryMap(); saveLastUsedBook(this.charName, this.lorebookName); }
      else { this.entryUids = {}; }

      this.initialized = true;
      updateSettingsStatus(this.lorebookName ? '✅ 运行中' : '⏳ 未绑定');
      updateSettingsBook(this.lorebookName || '无');
      updateSettingsChar(this.charName);
    });
  }

  async getCharMemoryBooks() {
    try {
      const allBooks = await ST.getAllWorldNames();
      let cn = this.charName || ST.getCharName();
      if (!cn || cn === '未知角色') return [];
      this.charName = cn;
      const pattern = `${cn}${CONFIG.LOREBOOK_SUFFIX}`;
      const result = allBooks.filter(b => b.startsWith(pattern));
      result.sort((a, b) => a === pattern ? -1 : b === pattern ? 1 : a.localeCompare(b));
      return result;
    } catch (e) { error('获取列表失败', e); return []; }
  }

  async deactivateOthers(except = null) {
    try {
      const books = await this.getCharMemoryBooks();
      for (const b of books) { if (b !== except) { await ST.setWorldActive(b, false); await wait(100); } }
    } catch (e) { log('取消激活失败', e); }
  }

  async createMain() {
    return opQueue.enqueue('创建主线', async () => {
      const cn = ST.getCharName();
      if (!cn || cn === '未知角色') { await ST.toast('⚠️ 请先选择角色'); return null; }
      const name = `${cn}${CONFIG.LOREBOOK_SUFFIX}`;
      const all = await ST.getAllWorldNames();
      if (all.includes(name)) {
        await this.deactivateOthers(name); await ST.setWorldActive(name, true);
        this.lorebookName = name; this.charName = cn; await this._loadEntryMap();
        saveLastUsedBook(cn, name); await ST.toast(`✅ "${name}" 已激活`);
        updateSettingsBook(name); return name;
      }
      const ok = await ST.createWorld(name);
      if (!ok) { await ST.toast('❌ 创建失败'); return null; }
      this.lorebookName = name; this.charName = cn; this.entryUids = {};
      await wait(800); await this.deactivateOthers(name); await ST.setWorldActive(name, true); await wait(500);
      for (const [n, cfg] of Object.entries(CONFIG.ENTRIES)) {
        const uid = await this._createEntry(name, n, cfg.content, cfg);
        if (uid !== null) this.entryUids[n] = uid; await wait(200);
      }
      saveLastUsedBook(cn, name); await ST.toast(`✅ "${name}" 创建成功`);
      updateSettingsBook(name); return name;
    });
  }

  async createCustom(suffix) {
    return opQueue.enqueue(`创建: ${suffix}`, async () => {
      const cn = ST.getCharName();
      if (!cn || cn === '未知角色') { await ST.toast('⚠️ 请先选择角色'); return null; }
      const newName = `${cn}${CONFIG.LOREBOOK_SUFFIX}${CONFIG.LOREBOOK_BRANCH_SEPARATOR}${suffix}`;
      const all = await ST.getAllWorldNames();
      if (all.includes(newName)) { await ST.toast(`⚠️ "${newName}" 已存在`); return null; }
      const ok = await ST.createWorld(newName);
      if (!ok) { await ST.toast('❌ 创建失败'); return null; }
      this.lorebookName = newName; this.charName = cn; this.entryUids = {};
      await wait(800); await this.deactivateOthers(newName); await ST.setWorldActive(newName, true); await wait(500);
      for (const [n, cfg] of Object.entries(CONFIG.ENTRIES)) {
        const uid = await this._createEntry(newName, n, cfg.content, cfg);
        if (uid !== null) this.entryUids[n] = uid; await wait(200);
      }
      saveLastUsedBook(cn, newName); await ST.toast(`✅ "${newName}" 创建成功`);
      updateSettingsBook(newName); return newName;
    });
  }

  async switchTo(bookName) {
    return opQueue.enqueue(`切换: ${bookName}`, async () => {
      await this.deactivateOthers(bookName); await wait(200);
      await ST.setWorldActive(bookName, true);
      this.lorebookName = bookName; this.entryUids = {};
      await wait(300); await this._loadEntryMap();
      saveLastUsedBook(this.charName, bookName);
      await ST.toast(`✅ 已切换: ${bookName}`);
      updateSettingsBook(bookName); return true;
    });
  }

  async copyTo(newSuffix) {
    return opQueue.enqueue(`复制: ${newSuffix}`, async () => {
      if (!this.lorebookName) { await ST.toast('⚠️ 没有可复制的'); return false; }
      const cn = ST.getCharName();
      const newName = `${cn}${CONFIG.LOREBOOK_SUFFIX}${CONFIG.LOREBOOK_BRANCH_SEPARATOR}${newSuffix}`;
      const all = await ST.getAllWorldNames();
      if (all.includes(newName)) { await ST.toast(`⚠️ "${newName}" 已存在`); return false; }
      const ok = await ST.createWorld(newName);
      if (!ok) { await ST.toast('❌ 创建失败'); return false; }
      await wait(800); await this.deactivateOthers(newName); await ST.setWorldActive(newName, true); await wait(500);
      const oldBook = this.lorebookName;
      const oldUids = { ...this.entryUids };
      this.entryUids = {};
      for (const [comment, uid] of Object.entries(oldUids)) {
        try {
          const content = await ST.execSlash(`/getentryfield file="${oldBook}" field=content ${uid}`);
          const cfg = CONFIG.ENTRIES[comment] || {};
          const newUid = await this._createEntry(newName, comment, content || cfg.content || '', cfg);
          if (newUid !== null) this.entryUids[comment] = newUid; await wait(150);
        } catch (e) { error(`复制 "${comment}" 失败`, e); }
      }
      this.lorebookName = newName; saveLastUsedBook(cn, newName);
      await ST.toast(`✅ 已复制到 "${newName}"`);
      updateSettingsBook(newName); return true;
    });
  }

  getDisplayName() {
    if (!this.lorebookName) return '未绑定';
    const base = `${this.charName}${CONFIG.LOREBOOK_SUFFIX}`;
    if (this.lorebookName === base) return `${this.lorebookName} (主线)`;
    if (this.lorebookName.startsWith(base + CONFIG.LOREBOOK_BRANCH_SEPARATOR)) {
      const branch = this.lorebookName.substring(base.length + CONFIG.LOREBOOK_BRANCH_SEPARATOR.length);
      return `${this.lorebookName} (分支: ${branch})`;
    }
    return this.lorebookName;
  }

  _extractBetween(text, startTitles, endTitles) {
    const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const sp = startTitles.map(t => `#{1,6}\\s*${esc(t)}`).join('|');
    const ep = endTitles.length > 0 ? endTitles.map(t => `#{1,6}\\s*${esc(t)}`).join('|') : null;
    const re = ep ? new RegExp(`((?:${sp})[\\s\\S]*?)(?=(?:${ep})|$)`, 'i') : new RegExp(`((?:${sp})[\\s\\S]*)$`, 'i');
    return text.match(re)?.[1]?.trim() || null;
  }

  extractSections(text) {
    const s = {};
    s.newCharacters = this._extractBetween(text, ['新增角色信息', '新增角色'], ['角色变化总结', '角色变化', '回忆', '重要物品记录', '重要物品', '主要角色关键事件记录', '关键事件记录', '当前剧情提示']);
    s.characterChanges = this._extractBetween(text, ['角色变化总结', '角色变化'], ['回忆', '重要物品记录', '重要物品', '主要角色关键事件记录', '关键事件记录', '当前剧情提示']);
    s.memory = this._extractBetween(text, ['回忆'], ['重要物品记录', '重要物品', '主要角色关键事件记录', '关键事件记录', '当前剧情提示']);
    s.items = this._extractBetween(text, ['重要物品记录', '重要物品'], ['主要角色关键事件记录', '关键事件记录', '当前剧情提示']);
    s.keyEvents = this._extractBetween(text, ['主要角色关键事件记录', '关键事件记录', '关键事件'], ['当前剧情提示']);
    log('提取:', Object.fromEntries(Object.entries(s).map(([k, v]) => [k, v ? `✓(${v.length})` : '✗'])));
    return s;
  }

  async updateFromSummary(summaryText) {
    if (!this.lorebookName) { await ST.toast('⚠️ 请先创建或选择世界书'); return; }
    return opQueue.enqueue('写入总结', async () => {
      const sec = this.extractSections(summaryText);
      const map = { newCharacters: '新增角色', characterChanges: '角色变化', memory: '回忆', items: '物品记录', keyEvents: 'keyevents' };
      let count = 0;
      for (const [key, name] of Object.entries(map)) {
        if (sec[key]) { await this._upsertEntry(name, sec[key]); await wait(200); count++; }
      }
      await ST.toast(count ? `✅ ${count}部分 → ${this.lorebookName}` : '⚠️ 未提取到内容');
    });
  }

  async updateSingle(sectionName, content) {
    if (!this.lorebookName) { await ST.toast('⚠️ 请先创建世界书'); return; }
    const map = { new_characters: '新增角色', character_changes: '角色变化', memory: '回忆', items: '物品记录', key_events: 'keyevents' };
    const entryName = map[sectionName] || sectionName;
    return opQueue.enqueue(`更新: ${entryName}`, async () => {
      await this._upsertEntry(entryName, content);
      await ST.toast(`✅ ${entryName} → ${this.lorebookName}`);
    });
  }
}

// ==================== FloorManager ====================
class FloorManager {
  async trimAndSendPlot(msgIndex, options = {}) {
    const { saveToVar = true, sendAsMessage = true, messageMode = 'sys', hideOriginal = false } = options;
    return opQueue.enqueue('裁剪发送', async () => {
      const idx = msgIndex ?? ST.getLastMessageId();
      const msg = ST.getMessage(idx);
      if (!msg) { await ST.toast('❌ 未找到消息'); return false; }
      const content = msg.mes || msg.message || '';
      const match = content.match(/(#{1,6}\s*当前剧情提示[\s\S]*)/i);
      if (!match) { await ST.toast('❌ 未找到"当前剧情提示"'); return false; }
      const plot = match[1].trim();
      if (saveToVar) {
        try { const esc = plot.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r'); if (esc.length < 5000) await ST.execSlash(`/setvar key=current_plot_prompt "${esc}"`); } catch { }
      }
      if (sendAsMessage) {
        try { const cmds = { sys: `/sys ${plot}`, narrator: `/sendas name=📜剧情提示 ${plot}`, user: `/send ${plot}` }; await ST.execSlash(cmds[messageMode] || cmds.sys); } catch (e) { error('发送失败', e); }
      }
      if (hideOriginal) { try { await ST.execSlash(`/hide ${idx}`); } catch { } }
      await ST.toast('✅ 完成'); return true;
    });
  }

  async hideMessages(mode) {
    return opQueue.enqueue(`隐藏: ${mode}`, async () => {
      const lastId = ST.getLastMessageId();
      if (lastId < 2) { await ST.toast('⚠️ 消息不足'); return false; }
      const modes = {
        keep_last_ai_and_prompt: { cmd: `/hide 0-${lastId - 3}`, desc: '保留最近AI+剧情提示' },
        keep_greeting_last_ai_and_prompt: { cmd: `/hide 1-${lastId - 3}`, desc: '保留开场白+最近AI+剧情提示', min: 3 },
        keep_prompt_only: { cmd: `/hide 0-${lastId - 1}`, desc: '仅保留剧情提示' },
        keep_greeting_and_prompt: { cmd: `/hide 1-${lastId - 1}`, desc: '保留开场白+剧情提示' },
      };
      const m = modes[mode];
      if (!m) { await ST.toast('❌ 未知模式'); return false; }
      if (m.min && lastId < m.min) { await ST.toast('⚠️ 消息不足'); return false; }
      await ST.execSlash(m.cmd);
      await ST.toast(`✅ ${m.desc}`); return true;
    });
  }
}

// ==================== 实例 ====================
const manager = new LorebookManager();
const floorMgr = new FloorManager();
let uiState = { menuOpen: false, processing: false, bookList: [] };

// ==================== Settings 显示 ====================
function updateSettingsStatus(t) { const e = document.getElementById('mem_mgr_status_text'); if (e) e.textContent = t; }
function updateSettingsBook(t) { const e = document.getElementById('mem_mgr_current_book'); if (e) e.textContent = t; }
function updateSettingsChar(t) { const e = document.getElementById('mem_mgr_current_char'); if (e) e.textContent = t; }

// ==================== 解析 ====================
async function ensureBound() {
  if (!manager.lorebookName) {
    await manager.init(true);
    if (!manager.lorebookName) { await ST.toast('⚠️ 请先创建或选择世界书'); return false; }
  }
  return true;
}

async function parseFull() {
  if (!await ensureBound()) return;
  const lastMsg = ST.getLastMessage();
  if (!lastMsg) { await ST.toast('❌ 没有消息'); return; }
  const content = lastMsg.mes || lastMsg.message || '';
  const tag = CONFIG.SUMMARY_TAG;
  if (content.includes(`<${tag}>`) && content.includes(`</${tag}>`)) {
    const m = content.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i'));
    if (m) { await ST.toast(`📝 写入: ${manager.lorebookName}`); await manager.updateFromSummary(m[1]); }
  } else {
    await ST.toast(`⚠️ 最后消息不含 <${tag}>`);
  }
}

// ★★★ 新增：发送总结指令 ★★★
async function sendSummaryCommand(type) {
  const prompt = CONFIG.SUMMARY_PROMPTS[type];
  if (!prompt) {
    await ST.toast('❌ 未知的总结类型');
    return;
  }

  try {
    log(`发送总结指令: ${type}`);
    await ST.execSlash(`/send ${prompt}`);

    const typeNames = { full: '📋 大总结', compress: '🗜️ 二次总结' };
    await ST.toast(`✅ ${typeNames[type] || type} 指令已发送！请等待AI回复后点击🔄解析写入`);
  } catch (e) {
    error('发送总结指令失败', e);
    await ST.toast('❌ 发送失败，请查看控制台');
  }
}

// ==================== UI ====================
function buildFabHTML() {
  return `
<div id="mem-fab-root">
  <div class="mem-dock-handle" id="memDockHandle"></div>
  <div class="mem-fab-main" id="memFabMain"><div class="mem-fab-icon"></div></div>
  <div class="mem-fab-menu">
    <div class="mem-fab-menu-item" data-action="open_settings"><span>⚙️</span><div class="mem-fab-tooltip">存档设置</div></div>
    <div class="mem-fab-menu-item" data-action="open_summary"><span>📝</span><div class="mem-fab-tooltip">总结指令</div></div>
    <div class="mem-fab-menu-item" data-action="open_floor"><span>📋</span><div class="mem-fab-tooltip">楼层管理</div></div>
    <div class="mem-fab-menu-item" data-action="open_help"><span>📖</span><div class="mem-fab-tooltip">使用说明</div></div>
    <div class="mem-fab-menu-item" data-action="parse_all"><span>🔄</span><div class="mem-fab-tooltip">解析写入</div></div>
    <div class="mem-fab-menu-item" data-action="create_book"><span>📚</span><div class="mem-fab-tooltip">创建世界书</div></div>
  </div>
</div>
<div class="mem-fab-overlay" id="memFabOverlay"></div>
<div id="mem-toast-fallback" style="display:none;position:fixed;bottom:80px;left:50%;transform:translateX(-50%);background:rgba(30,30,40,.92);color:#fff;padding:12px 24px;border-radius:12px;font-size:13px;z-index:999999;pointer-events:none;backdrop-filter:blur(8px);box-shadow:0 4px 20px rgba(0,0,0,.3);max-width:80vw;text-align:center"></div>`;
}

function buildPanelsHTML() {
  return `
<div class="mem-panel-overlay" id="memSettingsPanel">
  <div class="mem-panel">
    <div class="mem-panel-header"><div class="mem-panel-title">⚙️ 存档管理</div><button class="mem-panel-close" id="memCloseSettings">×</button></div>
    <div class="mem-info-card"><div class="mem-info-label">当前绑定</div><div class="mem-info-value" id="memPanelBookName">点击刷新</div></div>
    <div class="mem-btn-grid" style="margin-bottom:20px"><button class="mem-btn mem-btn-primary mem-btn-full" id="memRefreshBooks">🔍 刷新（自动检测已激活的世界书）</button></div>
    <div class="mem-group"><div class="mem-list-title">📖 回忆存档</div><div id="memBookList"><div class="mem-book-item" style="color:#888">点击刷新</div></div></div>
    <div class="mem-divider"></div>
    <div class="mem-group"><div class="mem-group-title">🆕 创建</div><label class="mem-input-label">存档后缀</label><input type="text" class="mem-input" id="memNewSuffix" placeholder="例如：第二章、HE路线"><div class="mem-btn-grid" style="margin-top:10px"><button class="mem-btn mem-btn-primary mem-btn-full" id="memCreateBook">➕ 创建</button></div></div>
    <div class="mem-divider"></div>
    <div class="mem-group"><div class="mem-group-title">📋 复制当前</div><label class="mem-input-label">新后缀</label><input type="text" class="mem-input" id="memCopySuffix" placeholder="例如：备份"><div class="mem-btn-grid" style="margin-top:10px"><button class="mem-btn mem-btn-secondary mem-btn-full" id="memCopyBook">📋 复制</button></div></div>
  </div>
</div>

<!-- ★★★ 新增：总结指令面板（替代原写入面板）★★★ -->
<div class="mem-panel-overlay" id="memSummaryPanel">
  <div class="mem-panel">
    <div class="mem-panel-header">
      <div class="mem-panel-title">📝 总结指令</div>
      <button class="mem-panel-close" id="memCloseSummary">×</button>
    </div>

    <p style="font-size:13px;color:#666;margin:0 0 20px 0;line-height:1.6;">
      选择总结类型，指令将以用户消息发送。<br>AI回复后点击 <b>🔄解析写入</b> 写入世界书。
    </p>

    <!-- 大总结卡片 -->
    <div class="mem-summary-card" id="memSummaryFull">
      <div class="mem-summary-card-icon">📋</div>
      <div class="mem-summary-card-body">
        <div class="mem-summary-card-title">大总结</div>
        <div class="mem-summary-card-desc">
          停止角色扮演，从第一天开始<br>对所有剧情进行完整总结
        </div>
      </div>
      <div class="mem-summary-card-arrow">→</div>
    </div>

    <!-- 二次总结卡片 -->
    <div class="mem-summary-card mem-summary-card-compress" id="memSummaryCompress">
      <div class="mem-summary-card-icon">🗜️</div>
      <div class="mem-summary-card-body">
        <div class="mem-summary-card-title">二次总结（压缩）</div>
        <div class="mem-summary-card-desc">
          停止角色扮演，对已有内容深度压缩
        </div>
        <div class="mem-summary-card-rules">
          <span>📌 回忆去主观感受，保因果链</span>
          <span>📌 不可压缩 → 英文/文言文</span>
        </div>
      </div>
      <div class="mem-summary-card-arrow">→</div>
    </div>

    <div class="mem-divider"></div>

    <!-- 当前绑定的世界书 -->
    <div style="display:flex;align-items:center;gap:10px;padding:12px 16px;background:rgba(0,0,0,0.02);border-radius:12px;">
      <span style="font-size:12px;color:#888;">写入目标：</span>
      <span style="font-size:13px;font-weight:600;color:#667eea;" id="memSummaryTarget">点击🔄刷新</span>
    </div>
  </div>
</div>

<div class="mem-panel-overlay" id="memFloorPanel">
  <div class="mem-panel">
    <div class="mem-panel-header"><div class="mem-panel-title">📋 楼层管理</div><button class="mem-panel-close" id="memCloseFloor">×</button></div>
    <div class="mem-group"><div class="mem-group-title">👁️ 隐藏历史</div>
      <div class="mem-hide-option" data-hide="keep_last_ai_and_prompt"><div class="mem-hide-option-title">🔹 保留最近AI+剧情提示</div><div class="mem-hide-option-desc">隐藏0→当前-3</div></div>
      <div class="mem-hide-option" data-hide="keep_greeting_last_ai_and_prompt"><div class="mem-hide-option-title">🔹 保留开场白+最近AI+剧情提示</div><div class="mem-hide-option-desc">隐藏1→当前-3</div></div>
      <div class="mem-hide-option" data-hide="keep_prompt_only"><div class="mem-hide-option-title">🔹 仅保留剧情提示</div><div class="mem-hide-option-desc">隐藏0→当前-1</div></div>
      <div class="mem-hide-option" data-hide="keep_greeting_and_prompt"><div class="mem-hide-option-title">🔹 保留开场白+剧情提示</div><div class="mem-hide-option-desc">隐藏1→当前-1</div></div>
    </div>
    <div class="mem-divider"></div>
    <div class="mem-group"><div class="mem-group-title">✂️ 提取当前剧情提示</div>
      <div class="mem-option-card"><label><input type="checkbox" id="memTrimSaveVar" checked><span>💾 保存到变量</span></label></div>
      <div class="mem-option-card"><label><input type="checkbox" id="memTrimSendMsg" checked><span>📤 发送为新楼层</span></label></div>
      <div class="mem-option-card"><label><input type="checkbox" id="memTrimHideOrig"><span>👁️ 隐藏原消息</span></label></div>
      <div class="mem-send-mode-group" id="memSendModeGroup"><div class="mem-send-mode-title">发送模式：</div><div class="mem-send-mode-options"><label><input type="radio" name="memSendMode" value="sys" checked><span>📜 系统旁白</span></label><label><input type="radio" name="memSendMode" value="narrator"><span>🎭 叙述者</span></label><label><input type="radio" name="memSendMode" value="user"><span>👤 用户</span></label></div></div>
      <div class="mem-btn-grid"><button class="mem-btn mem-btn-warning mem-btn-full" id="memTrimSend">✂️ 提取并发送</button></div>
    </div>
  </div>
</div>
<div class="mem-panel-overlay" id="memHelpPanel">
  <div class="mem-panel">
    <div class="mem-panel-header"><div class="mem-panel-title">📖 使用说明</div><button class="mem-panel-close" id="memCloseHelp">×</button></div>
    <div class="mem-help-content">
      <div class="mem-help-section"><div class="mem-help-section-title">🎯 功能</div><div class="mem-help-section-content"><ul>
        <li><b>存档管理</b>：创建、切换、复制回忆世界书</li>
        <li><b>📝 总结指令</b>：一键发送大总结/二次压缩指令</li>
        <li><b>🔄 解析写入</b>：AI回复后解析总结并写入世界书</li>
        <li><b>楼层管理</b>：提取剧情提示、隐藏历史消息</li>
      </ul></div></div>
      <div class="mem-help-section"><div class="mem-help-section-title">📝 使用流程</div><div class="mem-help-section-content"><ol>
        <li>📚 创建世界书</li>
        <li>📝 发送总结指令（大总结或二次总结）</li>
        <li>等待AI回复完成</li>
        <li>🔄 点击解析写入，自动写入世界书</li>
        <li>📋 楼层管理 → 隐藏历史 + 提取剧情提示</li>
        <li>继续角色扮演！</li>
      </ol>
      <p>💡 悬浮球可<b>拖拽</b>，拖到边缘自动收起</p>
      <p>🔍 刷新会自动检测你在酒馆全局世界书面板里激活的世界书</p>
      </div></div>
      <div class="mem-help-section"><div class="mem-help-section-title">🗜️ 二次总结说明</div><div class="mem-help-section-content">
        <p>当总结内容过长消耗太多token时，使用二次总结进行深度压缩：</p>
        <ul>
          <li>回忆部分去除主观感受，只保留事件因果链</li>
          <li>无法压缩的内容改写为英文或文言文节约token</li>
          <li>合并同类事件，删除冗余描述</li>
        </ul>
      </div></div>
      <div class="mem-warning-box"><div class="mem-warning-box-title">🚨 警告</div><div class="mem-warning-box-content">此为福利群特供，请勿二传二改！</div></div>
      <div class="mem-author-box"><div class="mem-author-name">👤 金瓜瓜</div><div class="mem-author-contact">📧 gua.guagua.uk 💬 QQ: 787849315</div><div class="mem-author-warning">🎁 举报二传可获至少10元API额度！</div></div>
    </div>
  </div>
</div>`;
}

// ==================== 拖拽 ====================
class DragDock {
  constructor(fabRoot, onTapCallback) {
    this.el = fabRoot; this.dragging = false; this.hasMoved = false;
    this.moveThreshold = 6; this.startCX = 0; this.startCY = 0;
    this.offsetX = 0; this.offsetY = 0; this.posX = 0; this.posY = 0;
    this.onTap = onTapCallback; this.ballSize = 80;
    this._onDown = this._onDown.bind(this);
    this._onMove = this._onMove.bind(this);
    this._onUp = this._onUp.bind(this);
    this.el.querySelector('.mem-fab-main').addEventListener('pointerdown', this._onDown);
    document.addEventListener('pointermove', this._onMove);
    document.addEventListener('pointerup', this._onUp);
  }
  setPosition(x, y) { this.posX = x; this.posY = y; this.el.style.left = `${x}px`; this.el.style.top = `${y}px`; }
  _onDown(e) {
    if (uiState.menuOpen) return;
    this.dragging = true; this.hasMoved = false;
    this.startCX = e.clientX; this.startCY = e.clientY;
    this.offsetX = e.clientX - this.posX; this.offsetY = e.clientY - this.posY;
    this.el.classList.add('mem-dragging');
    this.el.classList.remove('mem-docked-left', 'mem-docked-right');
  }
  _onMove(e) {
    if (!this.dragging) return;
    if (!this.hasMoved && (Math.abs(e.clientX - this.startCX) > this.moveThreshold || Math.abs(e.clientY - this.startCY) > this.moveThreshold)) this.hasMoved = true;
    if (this.hasMoved) {
      const x = Math.max(-this.ballSize * 0.4, Math.min(window.innerWidth - this.ballSize * 0.6, e.clientX - this.offsetX));
      const y = Math.max(0, Math.min(window.innerHeight - this.ballSize, e.clientY - this.offsetY));
      this.setPosition(x, y);
    }
  }
  _onUp() {
    if (!this.dragging) return;
    this.dragging = false; this.el.classList.remove('mem-dragging');
    if (!this.hasMoved) { if (this.onTap) this.onTap(); return; }
    const cx = this.posX + this.ballSize / 2;
    const s = getSettings();
    if (cx < CONFIG.DOCK_THRESHOLD) {
      this.setPosition(0, this.posY); this.el.classList.add('mem-docked-left');
      s.isDocked = true; s.dockedSide = 'left';
    } else if (cx > window.innerWidth - CONFIG.DOCK_THRESHOLD) {
      this.setPosition(window.innerWidth - this.ballSize, this.posY);
      this.el.classList.add('mem-docked-right'); s.isDocked = true; s.dockedSide = 'right';
    } else { s.isDocked = false; s.dockedSide = null; }
    s.fabPosX = this.posX; s.fabPosY = this.posY; saveSettingsDebounced();
  }
  undock() {
    const s = getSettings();
    this.el.classList.remove('mem-docked-left', 'mem-docked-right');
    const nx = Math.min(window.innerWidth - this.ballSize - 20, Math.max(20, window.innerWidth / 2 - this.ballSize / 2));
    this.setPosition(nx, this.posY);
    s.isDocked = false; s.dockedSide = null; s.fabPosX = nx; s.fabPosY = this.posY; saveSettingsDebounced();
  }
  restorePosition() {
    const s = getSettings();
    let x = s.fabPosX, y = s.fabPosY;
    if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) { x = window.innerWidth - 120; y = window.innerHeight / 2 - 40; }
    this.setPosition(x, y);
    if (s.isDocked && s.dockedSide) this.el.classList.add(`mem-docked-${s.dockedSide}`);
  }
}

// ==================== 面板刷新 ====================
async function refreshPanelData() {
  const bookName = manager.lorebookName;
  const display = manager.getDisplayName();
  const el1 = document.getElementById('memPanelBookName');
  const el2 = document.getElementById('memSummaryTarget'); // ★ 改为总结面板的目标显示
  if (el1) el1.textContent = bookName ? display : '⚠️ 未绑定';
  if (el2) el2.textContent = bookName ? display : '⚠️ 请先创建世界书';
  updateSettingsBook(bookName || '无');
  updateSettingsChar(manager.charName || '无');

  const books = await manager.getCharMemoryBooks();
  uiState.bookList = books;
  const container = document.getElementById('memBookList');
  if (!container) return;
  if (!books.length) { container.innerHTML = '<div class="mem-book-item" style="color:#888">暂无</div>'; return; }

  const activeWorlds = await ST.getActiveWorldBooks();
  const baseName = manager.charName ? `${manager.charName}${CONFIG.LOREBOOK_SUFFIX}` : null;

  container.innerHTML = books.map((b, i) => {
    const cur = b === manager.lorebookName;
    const main = baseName && b === baseName;
    const active = activeWorlds.includes(b);
    let badge = '';
    if (cur && main) badge = '<span class="mem-book-badge">当前·主线</span>';
    else if (cur) badge = '<span class="mem-book-badge">当前</span>';
    else if (main) badge = '<span class="mem-book-badge" style="background:#27ae60">主线</span>';
    if (active && !cur) badge += '<span class="mem-book-badge" style="background:#e67e22;margin-left:4px">已激活</span>';
    return `<div class="mem-book-item ${cur ? 'mem-current' : ''}" data-bi="${i}"><span>${escHTML(b)}</span><div>${badge}</div></div>`;
  }).join('');

  container.querySelectorAll('.mem-book-item[data-bi]').forEach(item => {
    item.addEventListener('click', async () => {
      const idx = parseInt(item.dataset.bi);
      if (isNaN(idx) || !uiState.bookList[idx]) return;
      setProcessing(true);
      try { await manager.switchTo(uiState.bookList[idx]); await refreshPanelData(); }
      finally { setProcessing(false); }
    });
  });
}

function escHTML(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
function setProcessing(v) {
  uiState.processing = v;
  const m = document.querySelector('.mem-fab-main');
  if (m) m.classList.toggle('mem-processing', v);
}

// ==================== 事件绑定 ====================
// ==================== 事件绑定 ====================
function bindEvents(fabRoot, dragDock) {
  const $ = s => document.querySelector(s);
  const $$ = s => document.querySelectorAll(s);

  // ★ 修复2：面板刚打开的防抖标记
  let panelJustOpened = false;

  fabRoot.querySelector('.mem-dock-handle').addEventListener('click', e => { e.stopPropagation(); dragDock.undock(); });
  fabRoot.querySelector('.mem-dock-handle').addEventListener('touchend', e => { e.preventDefault(); e.stopPropagation(); dragDock.undock(); });
  $('#memFabOverlay').addEventListener('click', () => { uiState.menuOpen = false; fabRoot.classList.remove('mem-active'); $('#memFabOverlay').classList.remove('mem-visible'); });

  const closePanel = id => $(`#${id}`)?.classList.remove('mem-active');
  const openPanel = id => {
    uiState.menuOpen = false; fabRoot.classList.remove('mem-active');
    $('#memFabOverlay').classList.remove('mem-visible');

    // ★ 修复2：设置防抖，阻止 pointerup → click 穿透
    panelJustOpened = true;
    setTimeout(() => { panelJustOpened = false; }, 400);

    $(`#${id}`)?.classList.add('mem-active');
    if (id === 'memSettingsPanel' || id === 'memSummaryPanel') refreshPanelData();
  };

  $('#memCloseSettings')?.addEventListener('click', () => closePanel('memSettingsPanel'));
  $('#memCloseSummary')?.addEventListener('click', () => closePanel('memSummaryPanel'));
  $('#memCloseFloor')?.addEventListener('click', () => closePanel('memFloorPanel'));
  $('#memCloseHelp')?.addEventListener('click', () => closePanel('memHelpPanel'));
  $$('.mem-panel-overlay').forEach(ov => { ov.addEventListener('click', e => { if (e.target === ov) ov.classList.remove('mem-active'); }); });

  // ★★★ 修复2：总结指令按钮加防抖检查 ★★★
  $('#memSummaryFull')?.addEventListener('click', async (e) => {
    // ★ 面板刚打开时忽略这次点击（是穿透过来的）
    if (uiState.processing || panelJustOpened) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    setProcessing(true);
    try {
      await sendSummaryCommand('full');
      closePanel('memSummaryPanel');
    } finally { setProcessing(false); }
  });

  $('#memSummaryCompress')?.addEventListener('click', async (e) => {
    // ★ 面板刚打开时忽略这次点击
    if (uiState.processing || panelJustOpened) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    setProcessing(true);
    try {
      await sendSummaryCommand('compress');
      closePanel('memSummaryPanel');
    } finally { setProcessing(false); }
  });

  $$('.mem-fab-menu-item').forEach(item => {
    item.addEventListener('pointerup', async e => {
      e.stopPropagation();
      // ★ 修复2：阻止后续 click 事件冒泡穿透
      e.preventDefault();
      if (uiState.processing) return;
      const action = item.dataset.action;
      switch (action) {
        case 'open_settings': openPanel('memSettingsPanel'); break;
        case 'open_summary': openPanel('memSummaryPanel'); break;
        case 'open_floor': openPanel('memFloorPanel'); break;
        case 'open_help': openPanel('memHelpPanel'); break;
        case 'parse_all':
          uiState.menuOpen = false; fabRoot.classList.remove('mem-active');
          $('#memFabOverlay').classList.remove('mem-visible');
          setProcessing(true);
          try { await parseFull(); } finally { setProcessing(false); }
          break;
        case 'create_book':
          uiState.menuOpen = false; fabRoot.classList.remove('mem-active');
          $('#memFabOverlay').classList.remove('mem-visible');
          const suf = prompt('输入后缀（留空=主线）');
          if (suf === null) break;
          setProcessing(true);
          try {
            if (suf.trim()) await manager.createCustom(suf.trim());
            else await manager.createMain();
            await refreshPanelData();
          } finally { setProcessing(false); }
          break;
      }
    });
  });

  // 设置面板按钮
  $('#memRefreshBooks')?.addEventListener('click', async () => {
    setProcessing(true);
    try { await manager.init(true); await refreshPanelData(); }
    finally { setProcessing(false); }
  });
  $('#memCreateBook')?.addEventListener('click', async () => {
    const v = $('#memNewSuffix')?.value?.trim();
    if (!v) { await ST.toast('请输入后缀'); return; }
    setProcessing(true);
    try { await manager.createCustom(v); $('#memNewSuffix').value = ''; await refreshPanelData(); }
    finally { setProcessing(false); }
  });
  $('#memCopyBook')?.addEventListener('click', async () => {
    const v = $('#memCopySuffix')?.value?.trim();
    if (!v) { await ST.toast('请输入后缀'); return; }
    setProcessing(true);
    try { await manager.copyTo(v); $('#memCopySuffix').value = ''; await refreshPanelData(); }
    finally { setProcessing(false); }
  });

  // 楼层管理
  $$('.mem-hide-option').forEach(opt => {
    opt.addEventListener('click', async () => {
      if (uiState.processing) return;
      setProcessing(true);
      try { await floorMgr.hideMessages(opt.dataset.hide); closePanel('memFloorPanel'); }
      finally { setProcessing(false); }
    });
  });
  $('#memTrimSendMsg')?.addEventListener('change', function () {
    const g = $('#memSendModeGroup'); if (g) g.style.display = this.checked ? 'block' : 'none';
  });
  $('#memTrimSend')?.addEventListener('click', async () => {
    if (uiState.processing) return;
    const sv = $('#memTrimSaveVar')?.checked ?? true;
    const sm = $('#memTrimSendMsg')?.checked ?? true;
    const ho = $('#memTrimHideOrig')?.checked ?? false;
    let mode = 'sys';
    document.querySelectorAll('input[name="memSendMode"]').forEach(r => { if (r.checked) mode = r.value; });
    if (!sv && !sm) { await ST.toast('请至少选一个'); return; }
    setProcessing(true);
    try { await floorMgr.trimAndSendPlot(null, { saveToVar: sv, sendAsMessage: sm, messageMode: mode, hideOriginal: ho }); closePanel('memFloorPanel'); }
    finally { setProcessing(false); }
  });
}


// ==================== Settings 面板 ====================
function bindSettingsPanel() {
  const settings = getSettings();
  const cb1 = document.getElementById('mem_mgr_enabled');
  const cb2 = document.getElementById('mem_mgr_debug');
  const btn = document.getElementById('mem_mgr_reset_pos');
  if (cb1) {
    cb1.checked = settings.enabled;
    cb1.addEventListener('change', () => {
      settings.enabled = cb1.checked; saveSettingsDebounced();
      const r = document.getElementById('mem-fab-root');
      if (r) r.classList.toggle('mem-hidden', !settings.enabled);
      updateSettingsStatus(settings.enabled ? '✅ 运行中' : '⏸ 已禁用');
    });
  }
  if (cb2) { cb2.checked = settings.debug; cb2.addEventListener('change', () => { settings.debug = cb2.checked; saveSettingsDebounced(); }); }
  if (btn) {
    btn.addEventListener('click', () => {
      settings.fabPosX = window.innerWidth - 120; settings.fabPosY = window.innerHeight / 2 - 40;
      settings.isDocked = false; settings.dockedSide = null; saveSettingsDebounced();
      const r = document.getElementById('mem-fab-root');
      if (r) { r.classList.remove('mem-docked-left', 'mem-docked-right'); r.style.left = `${settings.fabPosX}px`; r.style.top = `${settings.fabPosY}px`; }
      ST.toast('✅ 已重置');
    });
  }
}

// ==================== 主初始化 ====================
jQuery(async () => {
  console.log('[回忆管理器] v2.9.0 初始化...');
  if (!extension_settings[MODULE_NAME]) extension_settings[MODULE_NAME] = {};
  const settings = extension_settings[MODULE_NAME];
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) { if (settings[k] === undefined) settings[k] = v; }

  try {
    const html = await $.get(`${EXTENSION_PATH}/settings.html`);
    $('#extensions_settings2').append(html);
    bindSettingsPanel();
  } catch (e) { error('settings.html 加载失败', e); }

  getWiModule();

  const wrap = document.createElement('div');
  wrap.id = 'mem-manager-root';
  wrap.innerHTML = buildFabHTML() + buildPanelsHTML();
  document.body.appendChild(wrap);

  const fabRoot = document.getElementById('mem-fab-root');
  if (!settings.enabled) { fabRoot.classList.add('mem-hidden'); updateSettingsStatus('⏸ 已禁用'); }
  else updateSettingsStatus('✅ 运行中');

  const dragDock = new DragDock(fabRoot, () => {
    if (uiState.processing) return;
    if (getSettings().isDocked) { dragDock.undock(); return; }
    uiState.menuOpen = !uiState.menuOpen;
    fabRoot.classList.toggle('mem-active', uiState.menuOpen);
    const ov = document.getElementById('memFabOverlay');
    if (ov) ov.classList.toggle('mem-visible', uiState.menuOpen);
  });
  dragDock.restorePosition();
  bindEvents(fabRoot, dragDock);

  window.addEventListener('resize', () => {
    if (fabRoot.classList.contains('mem-docked-right'))
      dragDock.setPosition(window.innerWidth - 80, dragDock.posY);
  });

  window._memoryManager = manager;
  window._floorManager = floorMgr;
  console.log('[回忆管理器] ✅ v2.9.0 就绪');
});
