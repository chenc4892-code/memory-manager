// ==================== 回忆世界书管理器 v2.6.0 (SillyTavern Extension) ====================
// 核心修复: 使用 /createentry + /setentryfield 斜杠命令操作世界书条目
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
};

// ==================== 配置 ====================
const CONFIG = {
  LOREBOOK_SUFFIX: '的回忆',
  LOREBOOK_BRANCH_SEPARATOR: '-',
  SUMMARY_TAG: 'Plot Summary',
  OPERATION_DELAY: 300,
  DOCK_THRESHOLD: 60,
  // position 数值映射（/setentryfield field=position 用数字）
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
};

// ==================== 工具 ====================
function getSettings() {
  return extension_settings[MODULE_NAME];
}

function log(msg, data = null) {
  if (getSettings()?.debug) console.log(`[回忆管理器] ${msg}`, data ?? '');
}

function error(msg, err = null) {
  console.error(`[回忆管理器] ${msg}`, err ?? '');
}

const wait = (ms) => new Promise(r => setTimeout(r, ms));

// ==================== SillyTavern API 适配层 ====================
const ST = {
  getCharName() {
    const ctx = getContext();
    return ctx?.name2 || '未知角色';
  },

  getChat() {
    const ctx = getContext();
    return ctx?.chat || [];
  },

  getLastMessage() {
    const chat = this.getChat();
    return chat.length > 0 ? chat[chat.length - 1] : null;
  },

  getMessage(index) {
    const chat = this.getChat();
    return (index >= 0 && index < chat.length) ? chat[index] : null;
  },

  getLastMessageId() {
    return Math.max(0, this.getChat().length - 1);
  },

  /**
   * 执行斜杠命令并返回管道结果
   */
  async execSlash(command) {
    const ctx = getContext();
    if (!ctx) throw new Error('SillyTavern context 不可用');

    if (typeof ctx.executeSlashCommandsWithOptions === 'function') {
      try {
        const result = await ctx.executeSlashCommandsWithOptions(command, {
          handleParserErrors: true,
          handleExecutionErrors: true,
        });
        return result?.pipe ?? '';
      } catch (e) {
        error(`execSlash(WithOptions) 失败: ${command.substring(0, 80)}`, e);
        throw e;
      }
    }

    if (typeof ctx.executeSlashCommands === 'function') {
      try {
        const result = await ctx.executeSlashCommands(command);
        return typeof result === 'string' ? result : '';
      } catch (e) {
        error(`execSlash 失败: ${command.substring(0, 80)}`, e);
        throw e;
      }
    }

    throw new Error('executeSlashCommands 不可用');
  },

  async toast(msg) {
    try {
      await this.execSlash(`/echo ${msg}`);
    } catch {
      const el = document.getElementById('mem-toast-fallback');
      if (el) {
        el.textContent = msg;
        el.style.display = 'block';
        setTimeout(() => { el.style.display = 'none'; }, 3000);
      }
      console.log('[回忆管理器]', msg);
    }
  },

  /**
   * 获取所有世界书名称 — 多种方法尝试
   */
  async getAllWorldNames() {
    // 方法1: 直接从 window/jQuery 获取（SillyTavern 全局变量）
    try {
      if (typeof window.world_names !== 'undefined' && Array.isArray(window.world_names)) {
        return [...window.world_names];
      }
    } catch (e) { /* ignore */ }

    // 方法2: 从 API 获取
    try {
      const response = await fetch('/api/worldinfo', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({}),
      });
      if (response.ok) {
        const data = await response.json();
        if (Array.isArray(data)) return data;
        if (data?.world_names) return data.world_names;
      }
    } catch (e) { log('API /api/worldinfo 失败', e); }

    // 方法3: 旧版端点
    try {
      const response = await fetch('/getworldnames', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({}),
      });
      if (response.ok) {
        const data = await response.json();
        if (Array.isArray(data)) return data;
      }
    } catch (e) { log('/getworldnames 失败', e); }

    // 方法4: 用 /world 命令获取当前世界书名（有限）
    // 这不能列出全部，但作为最终手段
    error('所有获取世界书列表的方法都失败了，尝试备用搜索...');

    // 方法5: 尝试动态导入
    try {
      const wi = await import('../../../world-info.js');
      if (wi?.world_names && Array.isArray(wi.world_names)) {
        return [...wi.world_names];
      }
    } catch (e) { log('动态导入 world-info 失败', e); }

    return [];
  },

  /**
   * 创建新世界书
   */
  async createWorld(name) {
    log(`创建世界书: "${name}"`);

    // 方法1: REST API（最常见的端点）
    const endpoints = [
      '/api/worldinfo/create',
      '/createworldinfo',
    ];

    for (const endpoint of endpoints) {
      try {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: getRequestHeaders(),
          body: JSON.stringify({ name }),
        });
        if (response.ok) {
          log(`通过 ${endpoint} 创建成功`);
          return true;
        }
        log(`${endpoint} 返回: ${response.status}`);
      } catch (e) { log(`${endpoint} 失败`, e); }
    }

    // 方法2: 动态导入 world-info 模块
    try {
      const wi = await import('../../../world-info.js');
      if (wi?.createNewWorldInfo) {
        await wi.createNewWorldInfo(name);
        log('通过 world-info 模块创建成功');
        return true;
      }
    } catch (e) { log('world-info 模块创建失败', e); }

    error(`所有创建方法都失败: "${name}"`);
    return false;
  },

  /**
   * 激活/关闭世界书
   */
  async setWorldActive(name, active = true) {
    try {
      if (active) {
        await this.execSlash(`/world ${name}`);
      } else {
        await this.execSlash(`/world state=off silent=true ${name}`);
      }
      return true;
    } catch (e) {
      log(`设置世界书 "${name}" 激活=${active} 失败`, e);
      return false;
    }
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
    log(`[队列] ▶ ${item.name}`);
    try {
      const r = await item.fn();
      await wait(CONFIG.OPERATION_DELAY);
      log(`[队列] ✓ ${item.name}`);
      item.resolve(r);
    } catch (e) {
      error(`[队列] ✗ ${item.name}`, e);
      item.reject(e);
    } finally {
      this.processing = false;
      this.currentOp = null;
      if (this.queue.length) this._run();
    }
  }
}

const opQueue = new OperationQueue();

// ==================== LorebookManager (核心修复) ====================
class LorebookManager {
  constructor() {
    this.lorebookName = null;
    this.charName = null;
    this.entryUids = {};   // comment → uid 映射
    this.initialized = false;
  }

  // ===== 条目操作：全部使用斜杠命令 =====

  /**
   * 通过 /findentry 查找条目 UID
   * @returns {number|null}
   */
  async _findUid(bookName, comment) {
    try {
      const result = await ST.execSlash(`/findentry file=${bookName} field=comment ${comment}`);
      const trimmed = result?.trim();
      if (trimmed && trimmed !== '' && !isNaN(trimmed)) {
        return parseInt(trimmed);
      }
    } catch (e) {
      // findentry 找不到时可能会报错，这是正常的
      log(`查找条目 "${comment}" 未找到（正常）`);
    }
    return null;
  }

  /**
   * 通过 /createentry + /setentryfield 创建条目
   * @returns {number|null} 新条目的 UID
   */
  async _createEntry(bookName, comment, content, config = {}) {
    const entryConfig = CONFIG.ENTRIES[comment] || config;
    const posNum = CONFIG.POSITION_MAP[entryConfig.position] ?? 1;

    try {
      // 第一步：创建条目（/createentry 返回 UID）
      log(`[创建条目] "${comment}" → "${bookName}"`);
      const uidStr = await ST.execSlash(`/createentry file=${bookName} ${content}`);
      const uid = uidStr?.trim();

      if (!uid || uid === '' || isNaN(uid)) {
        error(`创建条目失败: "${comment}", /createentry 返回: "${uidStr}"`);
        return null;
      }

      log(`[创建条目] UID=${uid}, 开始设置字段...`);

      // 第二步：设置 comment
      await ST.execSlash(`/setentryfield file=${bookName} uid=${uid} field=comment ${comment}`);

      // 第三步：设置 constant
      if (entryConfig.type === 'constant') {
        await ST.execSlash(`/setentryfield file=${bookName} uid=${uid} field=constant true`);
      }

      // 第四步：设置 position
      await ST.execSlash(`/setentryfield file=${bookName} uid=${uid} field=position ${posNum}`);

      // 第五步：设置 order
      if (entryConfig.order !== undefined) {
        await ST.execSlash(`/setentryfield file=${bookName} uid=${uid} field=order ${entryConfig.order}`);
      }

      // 第六步：设置 depth（仅对 at_depth 类型有效）
      if (posNum >= 4 && entryConfig.depth) {
        await ST.execSlash(`/setentryfield file=${bookName} uid=${uid} field=depth ${entryConfig.depth}`);
      }

      // 第七步：禁用关键词匹配（对 constant 类型，不需要关键词）
      if (entryConfig.type === 'constant') {
        await ST.execSlash(`/setentryfield file=${bookName} uid=${uid} field=disable false`);
      }

      log(`[创建条目] "${comment}" 完成, UID=${uid}`);
      return parseInt(uid);

    } catch (e) {
      error(`创建条目 "${comment}" 失败`, e);
      return null;
    }
  }

  /**
   * 通过 /setentryfield 更新条目内容
   */
  async _updateContent(bookName, uid, content) {
    try {
      log(`[更新条目] UID=${uid} 内容长度=${content.length}`);
      await ST.execSlash(`/setentryfield file=${bookName} uid=${uid} field=content ${content}`);
      return true;
    } catch (e) {
      error(`更新条目 UID=${uid} 失败`, e);
      return false;
    }
  }

  /**
   * 创建或更新条目（核心方法）
   */
  async _upsertEntry(comment, content, config = {}) {
    if (!this.lorebookName) {
      error('upsertEntry: 没有绑定世界书');
      return;
    }

    // 先检查缓存
    let uid = this.entryUids[comment];

    // 缓存没有，用 /findentry 查找
    if (uid === undefined || uid === null) {
      uid = await this._findUid(this.lorebookName, comment);
      if (uid !== null) {
        this.entryUids[comment] = uid;
        log(`缓存命中(远程): "${comment}" → UID ${uid}`);
      }
    }

    if (uid !== null && uid !== undefined) {
      // 已存在 → 更新内容
      await this._updateContent(this.lorebookName, uid, content);
    } else {
      // 不存在 → 创建
      const newUid = await this._createEntry(this.lorebookName, comment, content, config);
      if (newUid !== null) {
        this.entryUids[comment] = newUid;
      }
    }
  }

  /**
   * 加载条目映射（comment → uid）
   */
  async _loadEntryMap() {
    this.entryUids = {};

    if (!this.lorebookName) return;

    log(`加载条目映射: "${this.lorebookName}"`);

    for (const name of Object.keys(CONFIG.ENTRIES)) {
      const uid = await this._findUid(this.lorebookName, name);
      if (uid !== null) {
        this.entryUids[name] = uid;
      }
      await wait(50); // 避免请求太快
    }

    const found = Object.keys(this.entryUids).length;
    const total = Object.keys(CONFIG.ENTRIES).length;
    log(`条目映射: ${found}/${total} 已找到`, this.entryUids);

    // 补建缺失条目
    const missing = Object.keys(CONFIG.ENTRIES).filter(n => this.entryUids[n] === undefined);
    if (missing.length > 0) {
      log(`补建 ${missing.length} 个缺失条目: ${missing.join(', ')}`);
      for (const name of missing) {
        const cfg = CONFIG.ENTRIES[name];
        const uid = await this._createEntry(this.lorebookName, name, cfg.content, cfg);
        if (uid !== null) {
          this.entryUids[name] = uid;
        }
        await wait(150);
      }
    }
  }

  // ===== 初始化 =====

  async init(force = false) {
    return opQueue.enqueue('初始化', async () => {
      if (!force && this.initialized) return;

      this.charName = ST.getCharName();
      log('角色:', this.charName);

      if (!this.charName || this.charName === '未知角色' || this.charName === 'undefined') {
        this.lorebookName = null;
        this.entryUids = {};
        this.initialized = false;
        updateSettingsStatus('⚠️ 请先选择角色');
        return;
      }

      const books = await this.getCharMemoryBooks();
      const baseName = `${this.charName}${CONFIG.LOREBOOK_SUFFIX}`;

      if (books.length > 0) {
        this.lorebookName = books.includes(baseName) ? baseName : books[0];
      } else {
        this.lorebookName = null;
      }

      if (this.lorebookName) {
        await this._loadEntryMap();
      } else {
        this.entryUids = {};
      }

      this.initialized = true;
      log('初始化完成:', this.lorebookName);
      updateSettingsStatus(this.lorebookName ? '✅ 运行中' : '⏳ 未绑定世界书');
      updateSettingsBook(this.lorebookName || '无');
      updateSettingsChar(this.charName);
    });
  }

  // ===== 世界书列表 =====

  async getCharMemoryBooks() {
    try {
      const allBooks = await ST.getAllWorldNames();
      let cn = this.charName || ST.getCharName();
      if (!cn || cn === '未知角色') return [];
      this.charName = cn;

      const pattern = `${cn}${CONFIG.LOREBOOK_SUFFIX}`;
      const result = allBooks.filter(b => b.startsWith(pattern));
      result.sort((a, b) => a === pattern ? -1 : b === pattern ? 1 : a.localeCompare(b));
      log(`找到 ${result.length} 个回忆世界书:`, result);
      return result;
    } catch (e) {
      error('获取列表失败', e);
      return [];
    }
  }

  async deactivateOthers(except = null) {
    try {
      const books = await this.getCharMemoryBooks();
      for (const b of books) {
        if (b !== except) {
          await ST.setWorldActive(b, false);
          await wait(100);
        }
      }
    } catch (e) { log('取消激活失败', e); }
  }

  // ===== 创建世界书 =====

  async createMain() {
    return opQueue.enqueue('创建主线', async () => {
      const cn = ST.getCharName();
      if (!cn || cn === '未知角色') {
        await ST.toast('⚠️ 请先选择角色');
        return null;
      }

      const name = `${cn}${CONFIG.LOREBOOK_SUFFIX}`;
      const all = await ST.getAllWorldNames();

      if (all.includes(name)) {
        // 已存在，直接激活
        await this.deactivateOthers(name);
        await ST.setWorldActive(name, true);
        this.lorebookName = name;
        this.charName = cn;
        await this._loadEntryMap();
        await ST.toast(`✅ "${name}" 已激活`);
        updateSettingsBook(name);
        return name;
      }

      // 创建新世界书
      const ok = await ST.createWorld(name);
      if (!ok) {
        await ST.toast('❌ 创建世界书失败');
        return null;
      }

      this.lorebookName = name;
      this.charName = cn;
      this.entryUids = {};

      await wait(800); // 等待文件系统就绪

      // 激活世界书（必须先激活才能用 /createentry）
      await this.deactivateOthers(name);
      await ST.setWorldActive(name, true);
      await wait(500);

      // 创建默认条目
      log('开始创建默认条目...');
      for (const [n, cfg] of Object.entries(CONFIG.ENTRIES)) {
        const uid = await this._createEntry(name, n, cfg.content, cfg);
        if (uid !== null) this.entryUids[n] = uid;
        await wait(200);
      }

      log('默认条目创建完成:', this.entryUids);
      await ST.toast(`✅ "${name}" 创建成功，含 ${Object.keys(this.entryUids).length} 个条目`);
      updateSettingsBook(name);
      return name;
    });
  }

  async createCustom(suffix) {
    return opQueue.enqueue(`创建分支: ${suffix}`, async () => {
      const cn = ST.getCharName();
      if (!cn || cn === '未知角色') {
        await ST.toast('⚠️ 请先选择角色');
        return null;
      }

      const newName = `${cn}${CONFIG.LOREBOOK_SUFFIX}${CONFIG.LOREBOOK_BRANCH_SEPARATOR}${suffix}`;
      const all = await ST.getAllWorldNames();

      if (all.includes(newName)) {
        await ST.toast(`⚠️ "${newName}" 已存在`);
        return null;
      }

      const ok = await ST.createWorld(newName);
      if (!ok) {
        await ST.toast('❌ 创建失败');
        return null;
      }

      this.lorebookName = newName;
      this.charName = cn;
      this.entryUids = {};

      await wait(800);
      await this.deactivateOthers(newName);
      await ST.setWorldActive(newName, true);
      await wait(500);

      for (const [n, cfg] of Object.entries(CONFIG.ENTRIES)) {
        const uid = await this._createEntry(newName, n, cfg.content, cfg);
        if (uid !== null) this.entryUids[n] = uid;
        await wait(200);
      }

      await ST.toast(`✅ "${newName}" 创建成功`);
      updateSettingsBook(newName);
      return newName;
    });
  }

  // ===== 切换 & 复制 =====

  async switchTo(bookName) {
    return opQueue.enqueue(`切换: ${bookName}`, async () => {
      await this.deactivateOthers(bookName);
      await wait(200);
      await ST.setWorldActive(bookName, true);
      this.lorebookName = bookName;
      this.entryUids = {};
      await wait(300);
      await this._loadEntryMap();
      await ST.toast(`✅ 已切换: ${bookName}`);
      updateSettingsBook(bookName);
      return true;
    });
  }

  async copyTo(newSuffix) {
    return opQueue.enqueue(`复制: ${newSuffix}`, async () => {
      if (!this.lorebookName) {
        await ST.toast('⚠️ 没有可复制的世界书');
        return false;
      }

      const cn = ST.getCharName();
      const newName = `${cn}${CONFIG.LOREBOOK_SUFFIX}${CONFIG.LOREBOOK_BRANCH_SEPARATOR}${newSuffix}`;
      const all = await ST.getAllWorldNames();
      if (all.includes(newName)) {
        await ST.toast(`⚠️ "${newName}" 已存在`);
        return false;
      }

      const ok = await ST.createWorld(newName);
      if (!ok) {
        await ST.toast('❌ 创建失败');
        return false;
      }

      await wait(800);
      await this.deactivateOthers(newName);
      await ST.setWorldActive(newName, true);
      await wait(500);

      // 从旧世界书读取条目内容，复制到新世界书
      const oldBook = this.lorebookName;
      const oldUids = { ...this.entryUids };

      for (const [comment, uid] of Object.entries(oldUids)) {
        try {
          // 读取旧条目内容
          const content = await ST.execSlash(`/getentryfield file=${oldBook} field=content ${uid}`);
          const cfg = CONFIG.ENTRIES[comment] || {};

          // 在新世界书创建
          const newUid = await this._createEntry(newName, comment, content || cfg.content || '', cfg);
          if (newUid !== null) {
            this.entryUids[comment] = newUid;
          }
          await wait(150);
        } catch (e) {
          error(`复制条目 "${comment}" 失败`, e);
        }
      }

      this.lorebookName = newName;
      await ST.toast(`✅ 已复制到 "${newName}"`);
      updateSettingsBook(newName);
      return true;
    });
  }

  // ===== 辅助 =====

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

  // ===== 解析 =====

  _extractBetween(text, startTitles, endTitles) {
    const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const startPat = startTitles.map(t => `#{1,6}\\s*${esc(t)}`).join('|');
    const endPat = endTitles.length > 0
      ? endTitles.map(t => `#{1,6}\\s*${esc(t)}`).join('|')
      : null;
    const regex = endPat
      ? new RegExp(`((?:${startPat})[\\s\\S]*?)(?=(?:${endPat})|$)`, 'i')
      : new RegExp(`((?:${startPat})[\\s\\S]*)$`, 'i');
    const m = text.match(regex);
    return m?.[1]?.trim() || null;
  }

  extractSections(text) {
    const s = {};
    s.newCharacters = this._extractBetween(text,
      ['新增角色信息', '新增角色'],
      ['角色变化总结', '角色变化', '回忆', '重要物品记录', '重要物品', '主要角色关键事件记录', '关键事件记录', '当前剧情提示']
    );
    s.characterChanges = this._extractBetween(text,
      ['角色变化总结', '角色变化'],
      ['回忆', '重要物品记录', '重要物品', '主要角色关键事件记录', '关键事件记录', '当前剧情提示']
    );
    s.memory = this._extractBetween(text,
      ['回忆'],
      ['重要物品记录', '重要物品', '主要角色关键事件记录', '关键事件记录', '当前剧情提示']
    );
    s.items = this._extractBetween(text,
      ['重要物品记录', '重要物品'],
      ['主要角色关键事件记录', '关键事件记录', '当前剧情提示']
    );
    s.keyEvents = this._extractBetween(text,
      ['主要角色关键事件记录', '关键事件记录', '关键事件'],
      ['当前剧情提示']
    );
    log('提取结果:', Object.fromEntries(
      Object.entries(s).map(([k, v]) => [k, v ? `✓(${v.length})` : '✗'])
    ));
    return s;
  }

  async updateFromSummary(summaryText) {
    if (!this.lorebookName) {
      await ST.toast('⚠️ 请先创建或选择世界书');
      return;
    }
    return opQueue.enqueue('写入总结', async () => {
      const sec = this.extractSections(summaryText);
      const map = {
        newCharacters: '新增角色',
        characterChanges: '角色变化',
        memory: '回忆',
        items: '物品记录',
        keyEvents: 'keyevents',
      };
      let count = 0;
      for (const [key, entryName] of Object.entries(map)) {
        if (sec[key]) {
          await this._upsertEntry(entryName, sec[key]);
          await wait(200);
          count++;
        }
      }
      if (count) await ST.toast(`✅ ${count}个部分已更新到 ${this.lorebookName}`);
      else await ST.toast('⚠️ 未提取到有效内容');
    });
  }

  async updateSingle(sectionName, content) {
    if (!this.lorebookName) {
      await ST.toast('⚠️ 请先创建世界书');
      return;
    }
    const map = {
      new_characters: '新增角色',
      character_changes: '角色变化',
      memory: '回忆',
      items: '物品记录',
      key_events: 'keyevents',
    };
    const entryName = map[sectionName] || sectionName;
    return opQueue.enqueue(`更新: ${entryName}`, async () => {
      await this._upsertEntry(entryName, content);
      await ST.toast(`✅ ${entryName} 已更新`);
    });
  }
}

// ==================== FloorManager ====================
class FloorManager {
  async trimAndSendPlot(msgIndex, options = {}) {
    const { saveToVar = true, sendAsMessage = true, messageMode = 'sys', hideOriginal = false } = options;
    return opQueue.enqueue('裁剪发送', async () => {
      const targetIdx = msgIndex ?? ST.getLastMessageId();
      const msg = ST.getMessage(targetIdx);
      if (!msg) { await ST.toast('❌ 未找到消息'); return false; }

      const content = msg.mes || msg.message || '';
      const match = content.match(/(#{1,6}\s*当前剧情提示[\s\S]*)/i);
      if (!match) { await ST.toast('❌ 未找到"当前剧情提示"'); return false; }

      const plot = match[1].trim();

      if (saveToVar) {
        try {
          const escaped = plot.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
            .replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t');
          if (escaped.length < 5000) {
            await ST.execSlash(`/setvar key=current_plot_prompt "${escaped}"`);
          }
        } catch (e) { log('保存变量失败', e); }
      }

      if (sendAsMessage) {
        try {
          switch (messageMode) {
            case 'sys': await ST.execSlash(`/sys ${plot}`); break;
            case 'narrator': await ST.execSlash(`/sendas name=📜剧情提示 ${plot}`); break;
            case 'user': await ST.execSlash(`/send ${plot}`); break;
            default: await ST.execSlash(`/sys ${plot}`);
          }
        } catch (e) { error('发送失败', e); }
      }

      if (hideOriginal) {
        try { await ST.execSlash(`/hide ${targetIdx}`); } catch (e) { log('隐藏失败', e); }
      }

      await ST.toast('✅ 操作完成');
      return true;
    });
  }

  async hideMessages(mode) {
    return opQueue.enqueue(`隐藏: ${mode}`, async () => {
      const lastId = ST.getLastMessageId();
      if (lastId < 2) { await ST.toast('⚠️ 消息不足'); return false; }

      let cmd = '', desc = '';
      switch (mode) {
        case 'keep_last_ai_and_prompt':
          cmd = `/hide 0-${lastId - 3}`; desc = '保留最近AI回复+剧情提示'; break;
        case 'keep_greeting_last_ai_and_prompt':
          if (lastId < 3) { await ST.toast('⚠️ 消息不足'); return false; }
          cmd = `/hide 1-${lastId - 3}`; desc = '保留开场白+最近AI回复+剧情提示'; break;
        case 'keep_prompt_only':
          cmd = `/hide 0-${lastId - 1}`; desc = '仅保留剧情提示'; break;
        case 'keep_greeting_and_prompt':
          cmd = `/hide 1-${lastId - 1}`; desc = '保留开场白+剧情提示'; break;
        default: await ST.toast('❌ 未知模式'); return false;
      }

      await ST.execSlash(cmd);
      await ST.toast(`✅ ${desc}`);
      return true;
    });
  }
}

// ==================== 实例 ====================
const manager = new LorebookManager();
const floorMgr = new FloorManager();
let uiState = { menuOpen: false, processing: false, bookList: [] };

// ==================== Settings 面板 ====================
function updateSettingsStatus(text) {
  const el = document.getElementById('mem_mgr_status_text');
  if (el) el.textContent = text;
}
function updateSettingsBook(text) {
  const el = document.getElementById('mem_mgr_current_book');
  if (el) el.textContent = text;
}
function updateSettingsChar(text) {
  const el = document.getElementById('mem_mgr_current_char');
  if (el) el.textContent = text;
}

// ==================== 解析 ====================
async function ensureBound() {
  if (!manager.lorebookName) {
    await manager.init(true);
    if (!manager.lorebookName) {
      await ST.toast('⚠️ 请先创建或选择世界书');
      return false;
    }
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
    if (m) {
      await ST.toast(`📝 正在写入: ${manager.lorebookName}`);
      await manager.updateFromSummary(m[1]);
    }
  } else {
    await ST.toast(`⚠️ 最后一条消息不含 <${tag}> 标签`);
  }
}

async function parseSingle(section) {
  if (!await ensureBound()) return;
  const lastMsg = ST.getLastMessage();
  if (!lastMsg) { await ST.toast('❌ 没有消息'); return; }
  const text = lastMsg.mes || lastMsg.message || '';

  const patterns = {
    parse_new_characters: { regex: /#{1,6}\s*新增角色(?:信息)?[\s\S]*?(?=#{1,6}\s*(?:角色变化|回忆|重要物品|主要角色关键事件|当前剧情提示)|$)/i, name: 'new_characters' },
    parse_character_changes: { regex: /#{1,6}\s*角色变化(?:总结)?[\s\S]*?(?=#{1,6}\s*(?:回忆|重要物品|主要角色关键事件|当前剧情提示)|$)/i, name: 'character_changes' },
    parse_memory: { regex: /#{1,6}\s*回忆[\s\S]*?(?=#{1,6}\s*(?:重要物品|主要角色关键事件|当前剧情提示)|$)/i, name: 'memory' },
    parse_items: { regex: /#{1,6}\s*重要物品(?:记录)?[\s\S]*?(?=#{1,6}\s*(?:主要角色关键事件|关键事件|当前剧情提示)|$)/i, name: 'items' },
    parse_key_events: { regex: /#{1,6}\s*(?:主要角色)?关键事件(?:记录)?[\s\S]*?(?=#{1,6}\s*当前剧情提示|$)/i, name: 'key_events' },
  };

  const p = patterns[section];
  if (!p) return;
  const m = text.match(p.regex);
  if (m) await manager.updateSingle(p.name, m[0].trim());
  else await ST.toast('⚠️ 未找到对应内容');
}

// ==================== UI构建 ====================
function buildFabHTML() {
  return `
<div id="mem-fab-root">
  <div class="mem-dock-handle" id="memDockHandle"><span>›</span></div>
  <div class="mem-fab-main" id="memFabMain">
    <div class="mem-fab-icon"></div>
  </div>
  <div class="mem-fab-menu">
    <div class="mem-fab-menu-item" data-action="open_settings"><span>⚙️</span><div class="mem-fab-tooltip">存档设置</div></div>
    <div class="mem-fab-menu-item" data-action="open_write"><span>✍️</span><div class="mem-fab-tooltip">写入世界书</div></div>
    <div class="mem-fab-menu-item" data-action="open_floor"><span>📋</span><div class="mem-fab-tooltip">楼层管理</div></div>
    <div class="mem-fab-menu-item" data-action="open_help"><span>📖</span><div class="mem-fab-tooltip">使用说明</div></div>
    <div class="mem-fab-menu-item" data-action="parse_all"><span>🔄</span><div class="mem-fab-tooltip">解析全部</div></div>
    <div class="mem-fab-menu-item" data-action="create_book"><span>📚</span><div class="mem-fab-tooltip">创建世界书</div></div>
  </div>
</div>
<div class="mem-fab-overlay" id="memFabOverlay"></div>
<div id="mem-toast-fallback" style="
  display:none; position:fixed; bottom:80px; left:50%; transform:translateX(-50%);
  background:rgba(30,30,40,0.92); color:#fff; padding:12px 24px; border-radius:12px;
  font-size:13px; z-index:999999; pointer-events:none; backdrop-filter:blur(8px);
  box-shadow:0 4px 20px rgba(0,0,0,0.3); max-width:80vw; text-align:center;
"></div>`;
}

function buildPanelsHTML() {
  return `
<!-- 设置面板 -->
<div class="mem-panel-overlay" id="memSettingsPanel">
  <div class="mem-panel">
    <div class="mem-panel-header">
      <div class="mem-panel-title">⚙️ 存档管理</div>
      <button class="mem-panel-close" id="memCloseSettings">×</button>
    </div>
    <div class="mem-info-card">
      <div class="mem-info-label">当前绑定</div>
      <div class="mem-info-value" id="memPanelBookName">点击刷新</div>
    </div>
    <div class="mem-btn-grid" style="margin-bottom:20px">
      <button class="mem-btn mem-btn-primary mem-btn-full" id="memRefreshBooks">🔍 刷新/搜索</button>
    </div>
    <div class="mem-group">
      <div class="mem-list-title">📖 回忆存档</div>
      <div id="memBookList"><div class="mem-book-item" style="color:#888;">点击上方刷新按钮</div></div>
    </div>
    <div class="mem-divider"></div>
    <div class="mem-group">
      <div class="mem-group-title">🆕 创建新存档</div>
      <label class="mem-input-label">存档后缀</label>
      <input type="text" class="mem-input" id="memNewSuffix" placeholder="例如：第二章、HE路线">
      <div class="mem-btn-grid" style="margin-top:10px">
        <button class="mem-btn mem-btn-primary mem-btn-full" id="memCreateBook">➕ 创建新存档</button>
      </div>
    </div>
    <div class="mem-divider"></div>
    <div class="mem-group">
      <div class="mem-group-title">📋 复制当前存档</div>
      <label class="mem-input-label">新存档后缀</label>
      <input type="text" class="mem-input" id="memCopySuffix" placeholder="例如：备份">
      <div class="mem-btn-grid" style="margin-top:10px">
        <button class="mem-btn mem-btn-secondary mem-btn-full" id="memCopyBook">📋 复制</button>
      </div>
    </div>
  </div>
</div>
<!-- 写入面板 -->
<div class="mem-panel-overlay" id="memWritePanel">
  <div class="mem-panel">
    <div class="mem-panel-header">
      <div class="mem-panel-title">✍️ 写入世界书</div>
      <button class="mem-panel-close" id="memCloseWrite">×</button>
    </div>
    <div class="mem-info-card">
      <div class="mem-info-label">写入到</div>
      <div class="mem-info-value" id="memWriteTarget">点击刷新</div>
    </div>
    <div class="mem-btn-grid" style="margin-bottom:20px">
      <button class="mem-btn mem-btn-secondary" id="memWriteRefresh">🔍 刷新</button>
      <button class="mem-btn mem-btn-secondary" id="memWriteSwitch">📚 切换世界书</button>
    </div>
    <div class="mem-write-grid">
      <button class="mem-write-btn" data-parse="parse_new_characters"><span class="mem-write-btn-icon">👥</span><span class="mem-write-btn-text">新增角色</span></button>
      <button class="mem-write-btn" data-parse="parse_character_changes"><span class="mem-write-btn-icon">🔄</span><span class="mem-write-btn-text">角色变化</span></button>
      <button class="mem-write-btn" data-parse="parse_memory"><span class="mem-write-btn-icon">📖</span><span class="mem-write-btn-text">回忆</span></button>
      <button class="mem-write-btn" data-parse="parse_items"><span class="mem-write-btn-icon">🎒</span><span class="mem-write-btn-text">物品记录</span></button>
      <button class="mem-write-btn" data-parse="parse_key_events"><span class="mem-write-btn-icon">⭐</span><span class="mem-write-btn-text">关键事件</span></button>
      <button class="mem-write-btn" data-parse="parse_summary"><span class="mem-write-btn-icon">📑</span><span class="mem-write-btn-text">全部解析</span></button>
    </div>
  </div>
</div>
<!-- 楼层面板 -->
<div class="mem-panel-overlay" id="memFloorPanel">
  <div class="mem-panel">
    <div class="mem-panel-header">
      <div class="mem-panel-title">📋 楼层管理</div>
      <button class="mem-panel-close" id="memCloseFloor">×</button>
    </div>
    <div class="mem-group">
      <div class="mem-group-title">👁️ 隐藏历史消息</div>
      <div class="mem-hide-option" data-hide="keep_last_ai_and_prompt">
        <div class="mem-hide-option-title">🔹 保留最近AI回复 + 当前剧情提示</div>
        <div class="mem-hide-option-desc">隐藏第0层到当前层-3</div>
      </div>
      <div class="mem-hide-option" data-hide="keep_greeting_last_ai_and_prompt">
        <div class="mem-hide-option-title">🔹 保留开场白 + 最近AI回复 + 当前剧情提示</div>
        <div class="mem-hide-option-desc">隐藏第1层到当前层-3</div>
      </div>
      <div class="mem-hide-option" data-hide="keep_prompt_only">
        <div class="mem-hide-option-title">🔹 仅保留当前剧情提示</div>
        <div class="mem-hide-option-desc">隐藏第0层到当前层-1</div>
      </div>
      <div class="mem-hide-option" data-hide="keep_greeting_and_prompt">
        <div class="mem-hide-option-title">🔹 保留开场白 + 当前剧情提示</div>
        <div class="mem-hide-option-desc">隐藏第1层到当前层-1</div>
      </div>
    </div>
    <div class="mem-divider"></div>
    <div class="mem-group">
      <div class="mem-group-title">✂️ 提取当前剧情提示</div>
      <div class="mem-option-card"><label><input type="checkbox" id="memTrimSaveVar" checked><span>💾 保存到变量</span></label></div>
      <div class="mem-option-card"><label><input type="checkbox" id="memTrimSendMsg" checked><span>📤 发送为新楼层</span></label></div>
      <div class="mem-option-card"><label><input type="checkbox" id="memTrimHideOrig"><span>👁️ 隐藏原总结消息</span></label></div>
      <div class="mem-send-mode-group" id="memSendModeGroup">
        <div class="mem-send-mode-title">发送模式：</div>
        <div class="mem-send-mode-options">
          <label><input type="radio" name="memSendMode" value="sys" checked><span>📜 系统旁白</span></label>
          <label><input type="radio" name="memSendMode" value="narrator"><span>🎭 叙述者</span></label>
          <label><input type="radio" name="memSendMode" value="user"><span>👤 用户消息</span></label>
        </div>
      </div>
      <div class="mem-btn-grid">
        <button class="mem-btn mem-btn-warning mem-btn-full" id="memTrimSend">✂️ 提取并发送</button>
      </div>
    </div>
  </div>
</div>
<!-- 帮助面板 -->
<div class="mem-panel-overlay" id="memHelpPanel">
  <div class="mem-panel">
    <div class="mem-panel-header">
      <div class="mem-panel-title">📖 使用说明</div>
      <button class="mem-panel-close" id="memCloseHelp">×</button>
    </div>
    <div class="mem-help-content">
      <div class="mem-help-section">
        <div class="mem-help-section-title">🎯 功能介绍</div>
        <div class="mem-help-section-content">
          <ul>
            <li><strong>存档管理</strong>：创建、切换、复制回忆世界书</li>
            <li><strong>写入世界书</strong>：从AI总结中解析并写入</li>
            <li><strong>楼层管理</strong>：提取剧情提示、隐藏历史消息</li>
          </ul>
        </div>
      </div>
      <div class="mem-help-section">
        <div class="mem-help-section-title">📝 使用流程</div>
        <div class="mem-help-section-content">
          <ol>
            <li>首次使用，点📚创建世界书</li>
            <li>手动点🔄解析或进入✍️分别解析各部分</li>
            <li>📋楼层管理隐藏历史 + 提取剧情提示</li>
            <li>⚙️设置里可快捷切换存档</li>
          </ol>
          <p style="margin-top:8px">💡 悬浮球可<strong>拖拽</strong>，拖到边缘自动收起</p>
        </div>
      </div>
      <div class="mem-warning-box">
        <div class="mem-warning-box-title">🚨 重要警告</div>
        <div class="mem-warning-box-content">此为福利群特供内容，请勿二传二改！</div>
      </div>
      <div class="mem-author-box">
        <div class="mem-author-name">👤 作者：金瓜瓜</div>
        <div class="mem-author-contact">📧 gua.guagua.uk &nbsp; 💬 QQ: 787849315</div>
        <div class="mem-author-warning">🎁 举报二传可获至少10元API额度！</div>
      </div>
    </div>
  </div>
</div>`;
}

// ==================== 拖拽 & 停靠 ====================
class DragDock {
  constructor(fabRoot, onTapCallback) {
    this.el = fabRoot;
    this.dragging = false;
    this.hasMoved = false;
    this.moveThreshold = 8;
    this.startClientX = 0;
    this.startClientY = 0;
    this.startX = 0;
    this.startY = 0;
    this.posX = 0;
    this.posY = 0;
    this.onTap = onTapCallback;

    this._onDown = this._onDown.bind(this);
    this._onMove = this._onMove.bind(this);
    this._onUp = this._onUp.bind(this);

    const main = this.el.querySelector('.mem-fab-main');
    main.addEventListener('pointerdown', this._onDown);
    document.addEventListener('pointermove', this._onMove);
    document.addEventListener('pointerup', this._onUp);
  }

  setPosition(x, y) {
    this.posX = x; this.posY = y;
    this.el.style.left = `${x}px`;
    this.el.style.top = `${y}px`;
  }

  _onDown(e) {
    if (uiState.menuOpen) return;
    this.dragging = true;
    this.hasMoved = false;
    this.startClientX = e.clientX;
    this.startClientY = e.clientY;
    this.startX = e.clientX - this.posX;
    this.startY = e.clientY - this.posY;
    this.el.classList.add('mem-dragging');
    this.el.classList.remove('mem-docked-left', 'mem-docked-right');
  }

  _onMove(e) {
    if (!this.dragging) return;
    if (!this.hasMoved) {
      const dx = Math.abs(e.clientX - this.startClientX);
      const dy = Math.abs(e.clientY - this.startClientY);
      if (dx > this.moveThreshold || dy > this.moveThreshold) this.hasMoved = true;
    }
    if (this.hasMoved) {
      const x = Math.max(-20, Math.min(window.innerWidth - 60, e.clientX - this.startX));
      const y = Math.max(0, Math.min(window.innerHeight - 80, e.clientY - this.startY));
      this.setPosition(x, y);
    }
  }

  _onUp() {
    if (!this.dragging) return;
    this.dragging = false;
    this.el.classList.remove('mem-dragging');

    if (!this.hasMoved) {
      if (this.onTap) this.onTap();
      return;
    }

    const settings = getSettings();
    if (this.posX < CONFIG.DOCK_THRESHOLD) {
      this.el.classList.add('mem-docked-left');
      this.el.style.left = '0px'; this.posX = 0;
      settings.isDocked = true; settings.dockedSide = 'left';
      this._updateHandle('left');
    } else if (this.posX > window.innerWidth - 80 - CONFIG.DOCK_THRESHOLD) {
      const rx = window.innerWidth - 80;
      this.setPosition(rx, this.posY);
      this.el.classList.add('mem-docked-right');
      settings.isDocked = true; settings.dockedSide = 'right';
      this._updateHandle('right');
    } else {
      settings.isDocked = false; settings.dockedSide = null;
      this._updateHandle(null);
    }
    settings.fabPosX = this.posX; settings.fabPosY = this.posY;
    saveSettingsDebounced();
  }

  _updateHandle(side) {
    const h = this.el.querySelector('.mem-dock-handle span');
    if (!h) return;
    h.textContent = side === 'left' ? '›' : side === 'right' ? '‹' : '';
  }

  undock() {
    const s = getSettings();
    this.el.classList.remove('mem-docked-left', 'mem-docked-right');
    const nx = Math.min(window.innerWidth - 120, Math.max(60, window.innerWidth / 2));
    this.setPosition(nx, this.posY);
    s.isDocked = false; s.dockedSide = null; s.fabPosX = nx; s.fabPosY = this.posY;
    saveSettingsDebounced();
  }

  restorePosition() {
    const s = getSettings();
    let x = s.fabPosX, y = s.fabPosY;
    if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) {
      x = window.innerWidth - 120; y = window.innerHeight / 2 - 40;
    }
    this.setPosition(x, y);
    if (s.isDocked && s.dockedSide) {
      this.el.classList.add(`mem-docked-${s.dockedSide}`);
      this._updateHandle(s.dockedSide);
    }
  }
}

// ==================== 面板数据刷新 ====================
async function refreshPanelData() {
  const bookName = manager.lorebookName;
  const display = manager.getDisplayName();
  const el1 = document.getElementById('memPanelBookName');
  const el2 = document.getElementById('memWriteTarget');
  if (el1) el1.textContent = bookName ? display : '⚠️ 未绑定';
  if (el2) el2.textContent = bookName || '请先刷新或选择';
  updateSettingsBook(bookName || '无');
  updateSettingsChar(manager.charName || '无');

  const books = await manager.getCharMemoryBooks();
  uiState.bookList = books;

  const container = document.getElementById('memBookList');
  if (!container) return;
  if (!books.length) {
    container.innerHTML = '<div class="mem-book-item" style="color:#888;">暂无回忆世界书</div>';
    return;
  }

  const baseName = manager.charName ? `${manager.charName}${CONFIG.LOREBOOK_SUFFIX}` : null;
  container.innerHTML = books.map((b, i) => {
    const cur = b === manager.lorebookName;
    const main = baseName && b === baseName;
    let badge = '';
    if (cur && main) badge = '<span class="mem-book-badge">当前·主线</span>';
    else if (cur) badge = '<span class="mem-book-badge">当前</span>';
    else if (main) badge = '<span class="mem-book-badge" style="background:#27ae60">主线</span>';
    return `<div class="mem-book-item ${cur ? 'mem-current' : ''}" data-bi="${i}"><span>${escHTML(b)}</span>${badge}</div>`;
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
function bindEvents(fabRoot, dragDock) {
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  fabRoot.querySelector('.mem-dock-handle').addEventListener('click', (e) => {
    e.stopPropagation(); dragDock.undock();
  });

  $('#memFabOverlay').addEventListener('click', () => {
    uiState.menuOpen = false;
    fabRoot.classList.remove('mem-active');
    $('#memFabOverlay').classList.remove('mem-visible');
  });

  const closePanel = (id) => $(`#${id}`)?.classList.remove('mem-active');
  const openPanel = (id) => {
    uiState.menuOpen = false;
    fabRoot.classList.remove('mem-active');
    $('#memFabOverlay').classList.remove('mem-visible');
    $(`#${id}`)?.classList.add('mem-active');
    if (id === 'memSettingsPanel' || id === 'memWritePanel') refreshPanelData();
  };

  $('#memCloseSettings')?.addEventListener('click', () => closePanel('memSettingsPanel'));
  $('#memCloseWrite')?.addEventListener('click', () => closePanel('memWritePanel'));
  $('#memCloseFloor')?.addEventListener('click', () => closePanel('memFloorPanel'));
  $('#memCloseHelp')?.addEventListener('click', () => closePanel('memHelpPanel'));

  $$('.mem-panel-overlay').forEach(ov => {
    ov.addEventListener('click', (e) => { if (e.target === ov) ov.classList.remove('mem-active'); });
  });

  // 菜单子按钮
  $$('.mem-fab-menu-item').forEach(item => {
    item.addEventListener('pointerup', async (e) => {
      e.stopPropagation();
      if (uiState.processing) return;
      const action = item.dataset.action;

      switch (action) {
        case 'open_settings': openPanel('memSettingsPanel'); break;
        case 'open_write': openPanel('memWritePanel'); break;
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
          const suffix = prompt('输入后缀（留空=主线）\n例如：第二章、分支线');
          if (suffix === null) break;
          setProcessing(true);
          try {
            if (suffix.trim()) await manager.createCustom(suffix.trim());
            else await manager.createMain();
            await refreshPanelData();
          } finally { setProcessing(false); }
          break;
      }
    });
  });

  // 设置面板
  $('#memRefreshBooks')?.addEventListener('click', async () => {
    setProcessing(true);
    try { await manager.init(true); await refreshPanelData(); }
    finally { setProcessing(false); }
  });

  $('#memCreateBook')?.addEventListener('click', async () => {
    const v = $('#memNewSuffix')?.value?.trim();
    if (!v) { await ST.toast('请输入后缀'); return; }
    setProcessing(true);
    try {
      await manager.createCustom(v);
      if ($('#memNewSuffix')) $('#memNewSuffix').value = '';
      await refreshPanelData();
    } finally { setProcessing(false); }
  });

  $('#memCopyBook')?.addEventListener('click', async () => {
    const v = $('#memCopySuffix')?.value?.trim();
    if (!v) { await ST.toast('请输入后缀'); return; }
    setProcessing(true);
    try {
      await manager.copyTo(v);
      if ($('#memCopySuffix')) $('#memCopySuffix').value = '';
      await refreshPanelData();
    } finally { setProcessing(false); }
  });

  // 写入面板
  $('#memWriteRefresh')?.addEventListener('click', async () => {
    setProcessing(true);
    try { await manager.init(true); await refreshPanelData(); }
    finally { setProcessing(false); }
  });

  $('#memWriteSwitch')?.addEventListener('click', () => {
    closePanel('memWritePanel'); openPanel('memSettingsPanel');
  });

  $$('.mem-write-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (uiState.processing) return;
      setProcessing(true);
      try {
        const act = btn.dataset.parse;
        if (act === 'parse_summary') await parseFull();
        else await parseSingle(act);
      } finally { setProcessing(false); }
    });
  });

  // 楼层面板
  $$('.mem-hide-option').forEach(opt => {
    opt.addEventListener('click', async () => {
      if (uiState.processing) return;
      setProcessing(true);
      try { await floorMgr.hideMessages(opt.dataset.hide); closePanel('memFloorPanel'); }
      finally { setProcessing(false); }
    });
  });

  $('#memTrimSendMsg')?.addEventListener('change', function () {
    const g = $('#memSendModeGroup');
    if (g) g.style.display = this.checked ? 'block' : 'none';
  });

  $('#memTrimSend')?.addEventListener('click', async () => {
    if (uiState.processing) return;
    const saveToVar = $('#memTrimSaveVar')?.checked ?? true;
    const sendAsMessage = $('#memTrimSendMsg')?.checked ?? true;
    const hideOriginal = $('#memTrimHideOrig')?.checked ?? false;
    let messageMode = 'sys';
    document.querySelectorAll('input[name="memSendMode"]').forEach(r => { if (r.checked) messageMode = r.value; });
    if (!saveToVar && !sendAsMessage) { await ST.toast('请至少选一个操作'); return; }
    setProcessing(true);
    try {
      await floorMgr.trimAndSendPlot(null, { saveToVar, sendAsMessage, messageMode, hideOriginal });
      closePanel('memFloorPanel');
    } finally { setProcessing(false); }
  });
}

// ==================== Settings面板 ====================
function bindSettingsPanel() {
  const enabledCb = document.getElementById('mem_mgr_enabled');
  const debugCb = document.getElementById('mem_mgr_debug');
  const resetBtn = document.getElementById('mem_mgr_reset_pos');
  const settings = getSettings();

  if (enabledCb) {
    enabledCb.checked = settings.enabled;
    enabledCb.addEventListener('change', () => {
      settings.enabled = enabledCb.checked;
      saveSettingsDebounced();
      const root = document.getElementById('mem-fab-root');
      if (root) root.classList.toggle('mem-hidden', !settings.enabled);
      updateSettingsStatus(settings.enabled ? '✅ 运行中' : '⏸ 已禁用');
    });
  }

  if (debugCb) {
    debugCb.checked = settings.debug;
    debugCb.addEventListener('change', () => {
      settings.debug = debugCb.checked;
      saveSettingsDebounced();
    });
  }

  if (resetBtn) {
    resetBtn.addEventListener('click', () => {
      settings.fabPosX = window.innerWidth - 120;
      settings.fabPosY = window.innerHeight / 2 - 40;
      settings.isDocked = false; settings.dockedSide = null;
      saveSettingsDebounced();
      const root = document.getElementById('mem-fab-root');
      if (root) {
        root.classList.remove('mem-docked-left', 'mem-docked-right');
        root.style.left = `${settings.fabPosX}px`;
        root.style.top = `${settings.fabPosY}px`;
      }
      ST.toast('✅ 位置已重置');
    });
  }
}

// ==================== 主初始化 ====================
jQuery(async () => {
  console.log('[回忆管理器] 开始初始化 v2.6.0...');

  // 1. 设置
  if (!extension_settings[MODULE_NAME]) extension_settings[MODULE_NAME] = {};
  const settings = extension_settings[MODULE_NAME];
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
    if (settings[k] === undefined) settings[k] = v;
  }

  // 2. 加载 settings.html
  try {
    const settingsHtml = await $.get(`${EXTENSION_PATH}/settings.html`);
    $('#extensions_settings2').append(settingsHtml);
    bindSettingsPanel();
  } catch (e) { console.error('[回忆管理器] settings.html加载失败', e); }

  // 3. 注入 UI
  const fabWrapper = document.createElement('div');
  fabWrapper.id = 'mem-manager-root';
  fabWrapper.innerHTML = buildFabHTML() + buildPanelsHTML();
  document.body.appendChild(fabWrapper);

  const fabRoot = document.getElementById('mem-fab-root');
  if (!settings.enabled) {
    fabRoot.classList.add('mem-hidden');
    updateSettingsStatus('⏸ 已禁用');
  } else {
    updateSettingsStatus('✅ 运行中');
  }

  // 4. 拖拽
  const dragDock = new DragDock(fabRoot, () => {
    if (uiState.processing) return;
    if (getSettings().isDocked) { dragDock.undock(); return; }
    uiState.menuOpen = !uiState.menuOpen;
    fabRoot.classList.toggle('mem-active', uiState.menuOpen);
    const ov = document.getElementById('memFabOverlay');
    if (ov) ov.classList.toggle('mem-visible', uiState.menuOpen);
  });
  dragDock.restorePosition();

  // 5. 绑定事件
  bindEvents(fabRoot, dragDock);

  // 6. resize
  window.addEventListener('resize', () => {
    if (fabRoot.classList.contains('mem-docked-right')) {
      dragDock.setPosition(window.innerWidth - 80, dragDock.posY);
    }
  });

  // 7. debug ref
  window._memoryManager = manager;
  window._floorManager = floorMgr;
  window._memOpQueue = opQueue;

  console.log('[回忆管理器] ✅ v2.6.0 初始化完成');
});
