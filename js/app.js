/* ================== 工具函数 ================== */
function localDateStr(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

const $ = (id) => document.getElementById(id);
const dayKey = () => localDateStr();

// 防抖
function debounce(fn, delay = 200) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), delay);
  };
}

// 安全转义
const esc = s => (s || '').replace(/'/g, "\\'");

/* ================== IndexedDB 封装 ================== */
class EnglishTyperDatabase {
  constructor() {
    this.dbName = 'EnglishTyperPro';
    this.version = 5;
    this.db = null;
  }

  async init() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, this.version);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        this.db = request.result;
        resolve(this.db);
      };
      request.onblocked = () => {
        alert('数据库正在升级，请关闭其它打开本应用的页面后重试。');
      };
      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains('practiceRecords')) {
          const store = db.createObjectStore('practiceRecords', {keyPath: 'id', autoIncrement: true});
          store.createIndex('date', 'date', {unique: false});
          store.createIndex('library', 'library', {unique: false});
        }
        if (!db.objectStoreNames.contains('userStats')) db.createObjectStore('userStats', {keyPath: 'id'});
        if (!db.objectStoreNames.contains('wordLibraries')) db.createObjectStore('wordLibraries', {keyPath: 'name'});
        if (!db.objectStoreNames.contains('learningProgress')) {
          const ps = db.createObjectStore('learningProgress', {keyPath: 'wordKey'});
          ps.createIndex('bucket', 'bucket', {unique: false});
        }
        if (!db.objectStoreNames.contains('achievements')) db.createObjectStore('achievements', {keyPath: 'id'});
      };
    });
  }

  async saveProgress(word, isRight) {
    const transaction = this.db.transaction(['learningProgress'], 'readwrite');
    const store = transaction.objectStore('learningProgress');
    const wordKey = `${word.en}::${word.zh}`;
    const existing = await this.getProgress(wordKey);
    const progress = existing || {
      wordKey,
      word: word.en,
      meaning: word.zh,
      bucket: 0,
      seen: 0,
      correct: 0,
      wrong: 0,
      lastSeen: null,
      nextReview: null
    };
    progress.seen += 1;
    progress.lastSeen = new Date().toISOString();
    if (isRight) {
      progress.correct += 1;
      progress.bucket = Math.min(4, progress.bucket + 1);
    } else {
      progress.wrong += 1;
      progress.bucket = Math.max(0, progress.bucket - 1);
    }
    const intervals = [1, 3, 7, 14, 30];
    const nextDays = intervals[Math.min(progress.bucket, intervals.length - 1)];
    const nextDate = new Date();
    nextDate.setDate(nextDate.getDate() + nextDays);
    progress.nextReview = nextDate.toISOString();
    return new Promise((resolve, reject) => {
      const request = store.put(progress);
      request.onsuccess = () => resolve(progress);
      request.onerror = () => reject(request.error);
    });
  }

  async getProgress(wordKey) {
    const transaction = this.db.transaction(['learningProgress'], 'readonly');
    const store = transaction.objectStore('learningProgress');
    return new Promise((resolve, reject) => {
      const request = store.get(wordKey);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async getAllProgress() {
    const transaction = this.db.transaction(['learningProgress'], 'readonly');
    const store = transaction.objectStore('learningProgress');
    return new Promise((resolve, reject) => {
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
  }

  async getDueWords(limit = 50) {
    const transaction = this.db.transaction(['learningProgress'], 'readonly');
    const store = transaction.objectStore('learningProgress');
    return new Promise((resolve, reject) => {
      const request = store.getAll();
      request.onsuccess = () => {
        const now = new Date();
        const dueWords = request.result
            .filter(p => !p.nextReview || new Date(p.nextReview) <= now)
            .sort((a, b) => a.bucket - b.bucket)
            .slice(0, limit);
        resolve(dueWords);
      };
      request.onerror = () => reject(request.error);
    });
  }

  async importWordLibrary(name, words) {
    const transaction = this.db.transaction(['wordLibraries'], 'readwrite');
    const store = transaction.objectStore('wordLibraries');
    const library = {name, words, importDate: new Date().toISOString(), wordCount: (words || []).length};
    return new Promise((resolve, reject) => {
      const request = store.put(library);
      request.onsuccess = () => resolve(library);
      request.onerror = () => reject(request.error);
    });
  }

  async getWordLibrary(name) {
    const transaction = this.db.transaction(['wordLibraries'], 'readonly');
    const store = transaction.objectStore('wordLibraries');
    return new Promise((resolve, reject) => {
      const request = store.get(name);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async getAllLibraries() {
    const transaction = this.db.transaction(['wordLibraries'], 'readonly');
    const store = transaction.objectStore('wordLibraries');
    return new Promise((resolve, reject) => {
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
  }

  async searchWords(query) {
    const q = (query || '').trim();
    if (!q) return [];
    const libraries = await this.getAllLibraries();
    const results = [];
    for (const library of libraries) {
      const matches = (library.words || []).filter(word =>
          word.en?.toLowerCase().includes(q.toLowerCase()) || word.zh?.includes(q)
      );
      results.push(...matches.map(word => ({word: word.en, meaning: word.zh, library: library.name})));
    }
    return results.slice(0, 200);
  }

  /* === 打卡记录 + 统计 === */
  async addPracticeRecord({word, meaning, library, ok, chars}) {
    const tx = this.db.transaction(['practiceRecords'], 'readwrite');
    const store = tx.objectStore('practiceRecords');
    const rec = {
      date: localDateStr(),
      time: Date.now(),
      word, meaning, library,
      ok: !!ok,
      chars: Number(chars) || 0
    };
    return new Promise((resolve, reject) => {
      const req = store.add(rec);
      req.onsuccess = () => resolve(rec);
      req.onerror = () => reject(req.error);
    });
  }

  async getDailySummary(dateStr = localDateStr(), libraryFilter = null) {
    const tx = this.db.transaction(['practiceRecords'], 'readonly');
    const store = tx.objectStore('practiceRecords');
    const idx = store.index('date');
    return new Promise((resolve, reject) => {
      const range = IDBKeyRange.only(dateStr);
      const req = idx.openCursor(range);
      let total = 0, right = 0;
      req.onsuccess = (e) => {
        const cur = e.target.result;
        if (!cur) {
          const accuracy = total ? Math.round(right / total * 100) : 100;
          resolve({total, right, wrong: total - right, accuracy});
          return;
        }
        const r = cur.value;
        if (!libraryFilter || r.library === libraryFilter) {
          total += 1;
          if (r.ok) right += 1;
        }
        cur.continue();
      };
      req.onerror = () => reject(req.error);
    });
  }

  async getStatsByLibrary(libraryName = null) {
    const [libs, progress] = await Promise.all([this.getAllLibraries(), this.getAllProgress()]);
    let scopeWords = [];
    if (!libraryName || libraryName === '__ALL__') {
      for (const lib of libs) scopeWords.push(...(lib.words || []));
    } else {
      const lib = libs.find(l => l.name === libraryName);
      scopeWords = lib?.words || [];
    }
    const scopeSet = new Set(scopeWords.map(w => `${w.en}::${w.zh}`));

    const inScopeProgress = progress.filter(p => scopeSet.has(`${p.word}::${p.meaning}`));
    const totalImported = scopeWords.length;
    const seen = inScopeProgress.filter(p => (p.seen || 0) > 0).length;

    const mastered = inScopeProgress.filter(p => (p.bucket >= 4) || (p.seen >= 3 && (p.correct / (p.seen || 1)) >= 0.85)).length;
    const learning = Math.max(0, seen - mastered);

    const coverage = totalImported ? Math.round(seen / totalImported * 100) : 0;

    const sumCorrect = inScopeProgress.reduce((s, p) => s + (p.correct || 0), 0);
    const sumTotal = inScopeProgress.reduce((s, p) => s + ((p.correct || 0) + (p.wrong || 0)), 0);
    const accuracyAll = sumTotal ? Math.round(sumCorrect / sumTotal * 100) : 100;

    return {totalImported, seen, mastered, learning, coverage, accuracyAll};
  }

  async getLearningStats() {
    const progress = await this.getAllProgress();
    const totalWords = progress.length;
    const sumCorrect = progress.reduce((s, p) => s + (p.correct || 0), 0);
    const sumTotal = progress.reduce((s, p) => s + ((p.correct || 0) + (p.wrong || 0)), 0);
    const accuracy = sumTotal ? Math.round((sumCorrect / sumTotal) * 100) : 100;
    const masteredWords = progress.filter(p => (p.bucket >= 4) || (p.seen >= 3 && (p.correct / (p.seen || 1)) >= 0.85)).length;
    const learningWords = Math.max(0, totalWords - masteredWords);
    return {totalWords, accuracy, masteredWords, learningWords};
  }

  /* 成就系统 */
  async getAchievements() {
    const transaction = this.db.transaction(['achievements'], 'readwrite');
    const store = transaction.objectStore('achievements');
    return new Promise((resolve, reject) => {
      const request = store.getAll();
      request.onsuccess = async () => {
        const achievements = request.result || [];
        if (achievements.length === 0) {
          const defaultAchievements = [
            {
              id: 'first_word',
              title: '初试锋芒',
              description: '完成第一个单词练习',
              progress: 0,
              maxProgress: 1,
              unlocked: false
            },
            {
              id: 'daily_goal',
              title: '持之以恒',
              description: '连续7天完成每日目标',
              progress: 0,
              maxProgress: 7,
              unlocked: false
            },
            {
              id: 'word_master',
              title: '词汇大师',
              description: '掌握100个单词',
              progress: 0,
              maxProgress: 100,
              unlocked: false
            },
            {
              id: 'speed_typer',
              title: '打字高手',
              description: '达到50 WPM的打字速度',
              progress: 0,
              maxProgress: 50,
              unlocked: false
            },
            {
              id: 'perfect_day',
              title: '完美一天',
              description: '单日正确率达到100%',
              progress: 0,
              maxProgress: 1,
              unlocked: false
            }
          ];
          await Promise.all(defaultAchievements.map(ach => new Promise((res, rej) => {
            const addReq = store.add(ach);
            addReq.onsuccess = () => res();
            addReq.onerror = () => rej(addReq.error);
          })));
          resolve(defaultAchievements);
        } else {
          resolve(achievements);
        }
      };
      request.onerror = () => reject(request.error);
    });
  }

  async updateAchievement(id, progress) {
    const transaction = this.db.transaction(['achievements'], 'readwrite');
    const store = transaction.objectStore('achievements');
    const achievement = await new Promise((resolve, reject) => {
      const request = store.get(id);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });

    if (achievement) {
      achievement.progress = Math.min(progress, achievement.maxProgress);
      if (achievement.progress >= achievement.maxProgress) {
        achievement.unlocked = true;
      }

      return new Promise((resolve, reject) => {
        const request = store.put(achievement);
        request.onsuccess = () => resolve(achievement);
        request.onerror = () => reject(request.error);
      });
    }
  }
}

const db = new EnglishTyperDatabase();

/* 导入模式 */
async function ensureBaseLibrariesOnce() { /* 兼容占位 */
}

async function ensureLibraryLoaded(name, customText) {
  if (name === 'custom') {
    const words = parseCustomLines(customText || '');
    await db.importWordLibrary('custom', dedupWords(words || []));
  }
}

/* 简便工具 */
function parseCustomLines(text) {
  return text.split("\n").map(l => l.trim()).filter(Boolean).map(l => {
    const idx = l.indexOf(":");
    if (idx > 0) return {en: l.slice(0, idx).trim(), zh: l.slice(idx + 1).trim()};
    return null;
  }).filter(Boolean);
}

//  CSV 解析
function parseCSV(text) {
  const rows = [];
  let field = '', row = [], inQuotes = false, i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    } else {
      if (ch === '"') {
        inQuotes = true;
        i++;
        continue;
      }
      if (ch === ',') {
        row.push(field.trim());
        field = '';
        i++;
        continue;
      }
      if (ch === '\n' || ch === '\r') {
        if (field.length || row.length) {
          row.push(field.trim());
          rows.push(row);
          row = [];
          field = '';
        }
        if (ch === '\r' && text[i + 1] === '\n') i += 2; else i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
  }
  if (field.length || row.length) {
    row.push(field.trim());
    rows.push(row);
  }
  return rows.map(parts => {
    if (parts.length >= 2) return {en: parts[0], zh: parts.slice(1).join(',')};
    return null;
  }).filter(Boolean);
}

// 词库去重
function dedupWords(list) {
  const seen = new Set();
  const out = [];
  for (const w of (list || [])) {
    if (!w) continue;
    const en = (w.en || '').trim();
    const zh = (w.zh || '').trim();
    if (!en || !zh) continue;
    const key = `${en.toLowerCase()}::${zh}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push({en, zh});
    }
  }
  return out;
}

/* TTS 语音朗读 */
const TTS = {
  ready: false, voices: [], pref: {lang: 'en-US', name: ''},
  loadVoices() {
    return new Promise(resolve => {
      const synth = window.speechSynthesis;
      const tryLoad = () => {
        const v = synth.getVoices();
        if (v && v.length) {
          this.voices = v;
          this.ready = true;
          const us = v.find(x => /en[-_]US/i.test(x.lang));
          const en = v.find(x => /^en/i.test(x.lang));
          this.pref.name = (us || en || v[0]).name;
          resolve(v);
        } else setTimeout(tryLoad, 100);
      };
      tryLoad();
    });
  },
  speak(text, options = {}) {
    if (!('speechSynthesis' in window)) {
      alert('浏览器不支持语音合成');
      return;
    }
    if (!text) return;
    const rate = parseFloat(localStorage.getItem('speechRate') || 0.95);
    const pitch = parseFloat(localStorage.getItem('speechPitch') || 1);
    const synth = window.speechSynthesis;
    try {
      synth.cancel();
    } catch {
    }
    const u = new SpeechSynthesisUtterance(text);
    u.lang = this.pref.lang;
    u.rate = options.rate || rate;
    u.pitch = options.pitch || pitch;
    u.volume = options.volume || 1;
    if (this.ready && this.voices.length) {
      const pick = this.voices.find(v => v.name === this.pref.name) || this.voices.find(v => /en/i.test(v.lang));
      if (pick) u.voice = pick;
    }
    synth.speak(u);
  }
};
(function initTTS() {
  if (!('speechSynthesis' in window)) return;
  let primed = false;
  const prime = () => {
    if (primed) return;
    primed = true;
    try {
      window.speechSynthesis.cancel();
    } catch {
    }
  };
  document.addEventListener('click', prime, {once: true});
  const ensure = () => {
    TTS.loadVoices();
  };
  window.speechSynthesis.onvoiceschanged = ensure;
  setTimeout(ensure, 800);
  // 超时兜底提示
  setTimeout(() => {
    if (!TTS.ready) console.warn('TTS voice list still empty, using default voice.');
  }, 3000);
})();

/* ===== 动态统计：数值动画 + 实时刷新 ===== */
function animateNumber(el, toValue, {duration = 380, formatter = (v) => String(v)} = {}) {
  if (!el) return;
  const from = parseFloat((el.dataset.value) || '0');
  const to = Number(toValue);
  if (Number.isNaN(to)) {
    el.textContent = formatter(toValue);
    return;
  }
  const start = performance.now();

  function frame(now) {
    const t = Math.min(1, (now - start) / duration);
    const val = from + (to - from) * t;
    el.textContent = formatter(Math.round(val));
    if (t < 1) requestAnimationFrame(frame);
    else el.dataset.value = String(to);
  }

  requestAnimationFrame(frame);
}

/* 近N分钟滚动WPM（按字符数/5） */
async function getRollingWPM({windowMin = 5, libraryScope = null} = {}) {
  const tx = db.db.transaction(['practiceRecords'], 'readonly');
  const store = tx.objectStore('practiceRecords');
  const all = await new Promise((resolve, reject) => {
    const req = store.getAll();
    req.onsuccess = () => {
      const today = localDateStr();
      resolve((req.result || []).filter(r => r.date === today));
    };
    req.onerror = () => reject(req.error);
  });
  const now = Date.now();
  const since = now - windowMin * 60 * 1000;
  const rows = all.filter(r => r.time >= since && (!libraryScope || libraryScope === '__ALL__' || r.library === libraryScope));
  const minutes = Math.max(0.25, (now - since) / 60000);
  const chars = rows.reduce((s, r) => s + (Number(r.chars) || 0), 0);
  const wpm = (chars ? (chars / 5) : rows.length) / minutes; // 兼容旧数据
  return wpm;
}

/* ======= 刷新统计 ======= */
const BEST_WPM_PREFIX = 'etp_best_wpm_';

function bestWpmKey(scope) {
  return BEST_WPM_PREFIX + (scope || '__ALL__');
}

async function refreshAdvancedStats(libraryScope = '__ALL__') {
  try {
    const today = localDateStr();
    const todaySum = await db.getDailySummary(today, libraryScope === '__ALL__' ? null : libraryScope);
    animateNumber(document.getElementById('todayCount'), todaySum.total);
    animateNumber(document.getElementById('accuracy'), todaySum.accuracy, {formatter: (v) => `${v}%`});

    const wpm = await getRollingWPM({windowMin: 5, libraryScope});
    const cur = Math.max(0, Math.round(wpm));
    const key = bestWpmKey(libraryScope);
    const prevBest = parseInt(localStorage.getItem(key) || '0');
    const best = Math.max(cur, prevBest);
    if (best !== prevBest) localStorage.setItem(key, String(best));
    animateNumber(document.getElementById('bestWPM'), best);

    const s = parseInt(localStorage.getItem('etp_streak') || '0');
    animateNumber(document.getElementById('practiceDays'), s);
  } catch (e) {
    console.warn('刷新高级统计失败：', e);
  }
}

async function refreshSidebarStats() {
  try {
    const s = parseInt(localStorage.getItem('etp_streak') || '0');
    const elStreak = document.getElementById('streak');
    if (elStreak) elStreak.textContent = String(s);

    const stats = await db.getLearningStats();
    const elMastered = document.getElementById('masteredWords');
    const elLearning = document.getElementById('learningWords');
    if (elMastered) elMastered.textContent = String(stats.masteredWords || 0);
    if (elLearning) elLearning.textContent = String(stats.learningWords || 0);
  } catch (e) {
    console.warn('刷新侧栏统计失败：', e);
  }
}

/* 成就系统 */
async function updateAchievements() {
  try {
    const achievements = await db.getAchievements();
    const achievementsList = document.getElementById('achievementsList');
    if (!achievementsList) return;

    const stats = await db.getLearningStats();
    const streak = parseInt(localStorage.getItem('etp_streak') || '0');
    const todaySum = await db.getDailySummary();

    await db.updateAchievement('first_word', stats.totalWords > 0 ? 1 : 0);
    await db.updateAchievement('daily_goal', Math.min(streak, 7));
    await db.updateAchievement('word_master', stats.masteredWords);

    // 统一读取 ALL 范围的 bestWPM
    await db.updateAchievement('speed_typer', parseInt(localStorage.getItem(bestWpmKey('__ALL__')) || '0'));
    await db.updateAchievement('perfect_day', todaySum.accuracy === 100 ? 1 : 0);

    const updatedAchievements = await db.getAchievements();
    achievementsList.innerHTML = updatedAchievements.map(ach => `
        <div class="achievement-item ${ach.unlocked ? 'achievement-unlocked' : ''}">
          <div class="achievement-icon">
            <i class="fas ${ach.unlocked ? 'fa-check-circle' : 'fa-lock'}"></i>
          </div>
          <div class="achievement-info">
            <div class="achievement-title">${ach.title}</div>
            <div class="achievement-desc">${ach.description}</div>
            <div class="achievement-progress">
              <div class="achievement-progress-bar" style="width: ${(ach.progress / ach.maxProgress) * 100}%"></div>
            </div>
          </div>
          <div class="achievement-status">
            ${ach.unlocked ? '<span class="badge">已解锁</span>' : `${ach.progress}/${ach.maxProgress}`}
          </div>
        </div>
      `).join('');
  } catch (error) {
    console.error('更新成就失败:', error);
  }
}

/* 当页面可见时定时刷新，隐藏时暂停 */
let statsTimer = null;

function startStatsAutorefresh(getScope) {
  stopStatsAutorefresh();
  const loop = async () => {
    if (document.hidden) return;
    const scope = (typeof getScope === 'function') ? getScope() : '__ALL__';
    await refreshAdvancedStats(scope);
    await refreshSidebarStats();
    await updateAchievements();
  };
  loop();
  statsTimer = setInterval(loop, 5000);
}

function stopStatsAutorefresh() {
  if (statsTimer) {
    clearInterval(statsTimer);
    statsTimer = null;
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopStatsAutorefresh();
  else startStatsAutorefresh(() => currentStatsScopeGetter ? currentStatsScopeGetter() : '__ALL__');
});
let currentStatsScopeGetter = null;

/* 练习引擎（三模式 + SRS） */
let currentMode = 'follow';
let currentLibrary = 'cet4';
let currentWord = null;
let reviewRevealed = false;

// 防双计分断路器 + 展示答案监听句柄
let answeredLock = false;
let revealEnterHandler = null;

async function pickNextFromLibrary(name) {
  const lib = await db.getWordLibrary(name);
  if (!lib || !lib.words || !lib.words.length) return null;

  const due = await db.getDueWords(200);
  const set = new Set(lib.words.map(w => `${w.en}::${w.zh}`));
  const inLib = due.filter(d => set.has(`${d.word}::${d.meaning}`));
  if (inLib.length) {
    inLib.sort((a, b) => a.bucket - b.bucket);
    const pick = inLib[0];
    return {en: pick.word, zh: pick.meaning};
  }
  return lib.words[Math.floor(Math.random() * lib.words.length)];
}

function renderCurrent() {
  const disp = $('textDisplay'), hint = $('hintText');

  if (!currentWord) {
    disp.innerHTML = `
        <div style="color:#6c757d;">
          当前词库为空。请前往 <strong>词库管理</strong> 导入（或加载 <code>
            /static/cet4.json</code> / <code>/static/cet6.json</code>）。
        </div>
        <div style="margin-top:10px;display:flex;gap:10px;flex-wrap:wrap;">
          <button class="btn-primary" type="button" onclick="document.querySelector('.tab-button[data-tab=\\'library\\']').click()">去导入词库</button>
        </div>
      `;
    hint.textContent = '';
    $('typingInput').value = '';
    $('typingInput').disabled = true;
    $('btnNext') && ($('btnNext').disabled = true);
    $('progressBar').style.width = '0%';
    return;
  }

  $('typingInput').disabled = false;
  $('btnNext') && ($('btnNext').disabled = false);

  if (currentMode === 'follow') {
    disp.innerHTML = '';
    currentWord.en.split('').forEach((ch, i) => {
      const s = document.createElement('span');
      s.className = 'char';
      s.textContent = ch;
      if (i === 0) s.classList.add('current');
      disp.appendChild(s);
    });
    hint.textContent = `释义：${currentWord.zh}`;
    $('typingInput').value = '';
    $('typingInput').placeholder = '逐个字母跟打英文单词…';
    $('typingInput').focus();
  } else if (currentMode === 'review') {
    reviewRevealed = false;
    disp.textContent = currentWord.en;
    hint.textContent = '按空格显示中文； [=不掌握/ ]=掌握';
    $('typingInput').value = '';
    $('typingInput').placeholder = '复习模式无需输入…';
    $('typingInput').blur();
  } else {
    disp.textContent = currentWord.zh;
    hint.textContent = '根据中文默写英文，回车判断';
    $('typingInput').value = '';
    $('typingInput').placeholder = '输入英文单词…';
    $('typingInput').focus();
  }

  const speakBtn = document.createElement('button');
  speakBtn.className = 'btn-secondary';
  speakBtn.style.marginTop = '10px';
  speakBtn.type = 'button';
  speakBtn.textContent = '🔊 听发音';
  speakBtn.onclick = () => TTS.speak(currentWord.en);
  const spacer = document.createElement('div');
  spacer.style.height = '8px';
  disp.appendChild(spacer);
  disp.appendChild(speakBtn);

  if (localStorage.getItem('autoSpeak') === 'true') {
    TTS.speak(currentWord.en);
  }

  updateProgressBar();
}

async function nextQuestion() {
  if (revealEnterHandler) {
    document.removeEventListener('keydown', revealEnterHandler);
    revealEnterHandler = null;
  }
  currentWord = await pickNextFromLibrary(currentLibrary);
  renderCurrent();
}

function switchMode(m) {
  currentMode = m;
  document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
  const btn = document.querySelector(`.mode-btn[data-mode="${m}"]`);
  btn && btn.classList.add('active');
  renderCurrent();
}

function judgeFollow() {
  if (answeredLock) return;
  const chars = document.querySelectorAll('.char');
  const val = $('typingInput').value;
  chars.forEach(c => c.classList.remove('correct', 'incorrect', 'current'));
  for (let i = 0; i < chars.length; i++) {
    if (i < val.length) {
      if (val[i] === currentWord.en[i]) chars[i].classList.add('correct');
      else chars[i].classList.add('incorrect');
    }
    if (i === val.length) chars[i].classList.add('current');
  }
  if (val.length === currentWord.en.length) {
    const ok = (val.toLowerCase() === currentWord.en.toLowerCase());
    onAnswer(ok);
  }
}

function judgeDictation() {
  if (answeredLock) return;
  const val = ($('typingInput').value || '').trim();
  if (!val) return;
  const ok = (val.toLowerCase() === currentWord.en.toLowerCase());
  onAnswer(ok, true);
}

function handleReviewHotkeys(e) {
  if (e.code === 'Space') {
    e.preventDefault();
    if (!reviewRevealed) {
      $('hintText').textContent = `释义：${currentWord.zh}；]=掌握 / [=不掌握`;
      reviewRevealed = true;
    }
  } else if (e.key === ']' || e.key === 'Enter') {
    onAnswer(true);
  } else if (e.key === '[') {
    onAnswer(false);
  }
}

async function onAnswer(ok, showAnswer = false) {
  if (answeredLock) return;
  answeredLock = true;

  try {
    await db.saveProgress(currentWord, ok);
  } catch {
  }
  try {
    await db.addPracticeRecord({
      word: currentWord.en,
      meaning: currentWord.zh,
      library: currentLibrary,
      ok,
      chars: (currentWord.en || '').length
    });
  } catch {
  }

  const selNow = document.getElementById('statsLibrarySelect');
  const scopeNow = selNow ? selNow.value : currentLibrary;
  await refreshAdvancedStats(scopeNow);
  await refreshSidebarStats();
  await updateAchievements();

  addToday(ok);
  settleStreak();

  const relax = () => {
    answeredLock = false;
  };

  if (!ok && showAnswer) {
    $('hintText').textContent = `正确答案：${currentWord.en}（按 Enter / ] 下一词）`;
    TTS.speak(currentWord.en);
    revealEnterHandler = (e) => {
      if (e.key === 'Enter' || e.key === ']') {
        document.removeEventListener('keydown', revealEnterHandler);
        revealEnterHandler = null;
        relax();
        nextQuestion();
      }
    };
    document.addEventListener('keydown', revealEnterHandler);

    const onceNext = () => {
      relax();
      btnNext?.removeEventListener('click', onceNext);
    };
    const btnNext = $('btnNext');
    btnNext?.addEventListener('click', onceNext, {once: true});
  } else {
    relax();
    nextQuestion();
  }
}

/* 今日统计 / 进度条 / 打卡 */
const TODAY_KEY = 'etp_today_' + dayKey();

function getToday() {
  try {
    return JSON.parse(localStorage.getItem(TODAY_KEY) || '{"right":0,"wrong":0}');
  } catch {
    return {right: 0, wrong: 0};
  }
}

function setToday(t) {
  localStorage.setItem(TODAY_KEY, JSON.stringify(t));
}

function addToday(ok) {
  const t = getToday();
  ok ? t.right++ : t.wrong++;
  setToday(t);
  $('todayCount') && ($('todayCount').textContent = (t.right + t.wrong));
  const acc = (t.right + t.wrong) ? Math.round(t.right / (t.right + t.wrong) * 100) : 100;
  $('accuracy') && ($('accuracy').textContent = acc + '%');
  const item = document.createElement('div');
  item.className = 'history-item';
  item.innerHTML = `<strong>${new Date().toLocaleTimeString()}</strong> - ${currentWord.en} / ${currentWord.zh} - ${ok ? '✅ 正确' : '❌ 错误'}`;
  $('historyList') && $('historyList').insertBefore(item, $('historyList').firstChild);
  if ($('historyList')) while ($('historyList').children.length > 5) $('historyList').removeChild($('historyList').lastChild);
  updateProgressBar();
}

function updateProgressBar() {
  const t = getToday();
  const target = parseInt(localStorage.getItem('dailyGoal') || 50);
  const pct = Math.min(100, Math.floor((t.right + t.wrong) / target * 100));
  if ($('progressBar')) {
    $('progressBar').style.width = pct + '%';
    if (pct === 100) {
      $('progressBar').classList.add('success-animation');
      setTimeout(() => $('progressBar').classList.remove('success-animation'), 800);
    }
  }
  if ($('progressText')) {
    $('progressText').textContent = `${t.right + t.wrong}/${target}`;
  }
}

async function resetToday() {
  localStorage.removeItem(TODAY_KEY);
  $('historyList') && ($('historyList').innerHTML = '');
  $('todayCount') && ($('todayCount').textContent = '0');
  $('accuracy') && ($('accuracy').textContent = '100%');
  updateProgressBar();
}

function settleStreak() {
  const STREAK_KEY = 'etp_streak', LAST_KEY = 'etp_last_day';
  const today = dayKey(), last = localStorage.getItem(LAST_KEY);
  let s = parseInt(localStorage.getItem(STREAK_KEY) || '0');
  if (last) {
    const missed = Math.floor((new Date(today) - new Date(last)) / (1000 * 3600 * 24));
    if (missed >= 2) s = 0; // 中断归零
  }
  if (last !== today) {
    s += 1;
  }
  localStorage.setItem(STREAK_KEY, String(s));
  localStorage.setItem(LAST_KEY, today);
  $('streak') && ($('streak').textContent = String(s));
}

async function updateStatistics(selectedLib = null) {
  try {
    const statsTab = document.getElementById('statistics-tab');

    // 注入选择范围下拉（若未注入）
    if (statsTab && !document.getElementById('statsLibrarySelect')) {
      const wrap = document.createElement('div');
      wrap.id = 'statsLibrarySelectContainer';
      wrap.style = 'margin: 10px 0 16px; display:flex; gap:8px; align-items:center;';
      wrap.innerHTML = `
        <label style="font-size:14px;color:#6c757d;">统计范围：</label>
        <select id="statsLibrarySelect" class="library-select" aria-label="统计范围"></select>
      `;
      statsTab.insertBefore(wrap, statsTab.firstChild);
      wrap.querySelector('#statsLibrarySelect').addEventListener('change', (e) => {
        updateStatistics(e.target.value);
      });
    }

    // 下拉选项每次刷新
    const sel = document.getElementById('statsLibrarySelect');
    const libs = await db.getAllLibraries();
    if (sel) {
      const keep = selectedLib || sel.value || '__ALL__';
      sel.innerHTML = '';
      const optAll = document.createElement('option');
      optAll.value = '__ALL__';
      optAll.textContent = '全部词库';
      sel.appendChild(optAll);
      libs.forEach(l => {
        const o = document.createElement('option');
        o.value = l.name;
        o.textContent = l.name;
        sel.appendChild(o);
      });
      sel.value = libs.some(l => l.name === keep) ? keep : (libs.some(l => l.name === currentLibrary) ? currentLibrary : '__ALL__');
    }

    const libScope = sel ? sel.value : (selectedLib || currentLibrary || '__ALL__');

    const scopeStats = await db.getStatsByLibrary(libScope);

    const today = localDateStr();
    const todaySum = await db.getDailySummary(today, libScope === '__ALL__' ? null : libScope);
    animateNumber(document.getElementById('todayCount'), todaySum.total);
    animateNumber(document.getElementById('accuracy'), todaySum.accuracy, {formatter: (v) => `${v}%`});
    animateNumber(document.getElementById('bestWPM'),
        Math.max(Math.round(await getRollingWPM({windowMin: 5, libraryScope: libScope})), 0)
    );
    animateNumber(document.getElementById('practiceDays'), parseInt(localStorage.getItem('etp_streak') || '0'));

    document.getElementById('totalWords').textContent = scopeStats.totalImported || 0;
    animateNumber(document.getElementById('masteredWords'), scopeStats.mastered || 0);
    animateNumber(document.getElementById('learningWords'), scopeStats.learning || 0);

    let extra = document.getElementById('statsExtraLine');
    if (!extra) {
      extra = document.createElement('div');
      extra.id = 'statsExtraLine';
      extra.style = 'margin:10px 0 6px;color:#6c757d;font-size:14px;';
      const achPanel = statsTab.querySelector('.achievement-panel');
      statsTab.insertBefore(extra, achPanel);
    }
    if (scopeStats.totalImported === 0) {
      extra.innerHTML = `当前统计范围没有导入词库数据（覆盖率=0）。请在"词库管理"导入，或切换为"全部词库"。`;
    } else {
      extra.innerHTML = `
        覆盖率（已见过/导入）：<strong>${scopeStats.coverage}%</strong>，
        历史正确率（该范围）：<strong>${scopeStats.accuracyAll}%</strong>
      `;
    }

    currentStatsScopeGetter = () => {
      const selNow = document.getElementById('statsLibrarySelect');
      return selNow ? selNow.value : '__ALL__';
    };
    startStatsAutorefresh(currentStatsScopeGetter);
  } catch (error) {
    console.error('更新统计失败:', error);
  }
}

/* 词库统计 & 导入 */
async function updateLibraryStats() {
  try {
    const libs = await db.getAllLibraries();
    const el = $('libraryStats');
    if (!el) return;
    if (!libs.length) {
      el.innerHTML = '<div class="word-item">尚未导入任何词库</div>';
      return;
    }
    el.innerHTML = libs.map(lib => `<div class="word-item">${lib.name}: ${lib.wordCount || (lib.words?.length || 0)} 单词</div>`).join('');
  } catch (error) {
    console.error('更新词库统计失败:', error);
  }
}

async function importFromJsonUrl(urlOrList, libName) {
  const candidates = Array.isArray(urlOrList) ? urlOrList : [urlOrList];
  for (const url of candidates) {
    try {
      const res = await fetch(url, {cache: 'no-store'});
      if (!res.ok) continue;
      const data = await res.json();
      if (Array.isArray(data) && data.length) {
        await db.importWordLibrary(libName, dedupWords(data));
        alert(`${libName.toUpperCase()} 导入完成：共 ${data.length} 条`);
        updateLibraryStats();
        if (document.getElementById('librarySelect')?.value === libName) await nextQuestion();
        return;
      }
    } catch (e) {
      if (location.protocol === 'file:') {
        alert('本地文件模式下无法通过 fetch 读取 /static/*.json。\n请使用本地服务器运行（如 XAMPP / VSCode Live Server），或在“词库管理”使用“导入自定义词库文件”。');
        break;
      }
    }
  }
  alert(`无法导入 ${libName} 词库，请检查网络或文件路径`);
}

async function importCET4() {
  await importFromJsonUrl([
    '../static/cet4.json',
    '../static/CET4.json',
    '../static/CET4-顺序.json',
    '../cet4.json',
    '../CET4.json'
  ], 'cet4');
}

async function importCET6() {
  await importFromJsonUrl([
    '../static/cet6.json',
    '../static/CET6.json',
    '../static/CET6-顺序.json',
    '../cet6.json',
    '../CET6.json'
  ], 'cet6');
}

/* 文件导入：TXT / CSV / JSON */
document.addEventListener('change', async function (e) {
  const t = e.target;
  if (t && t.id === 'fileInput') {
    const file = t.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const name = file.name.toLowerCase();
      let words = [];
      if (name.endsWith('.json')) {
        const data = JSON.parse(text);
        if (Array.isArray(data)) words = data; else throw new Error('JSON 需为数组：[{en,zh}]');
      } else if (name.endsWith('.csv')) {
        words = parseCSV(text);
      } else {
        words = parseCustomLines(text);
      }
      words = dedupWords(words);
      if (!words.length) {
        alert('未找到有效的单词数据');
        return;
      }
      const libName = prompt('给这个词库起个名字：', 'custom_import') || 'custom_import';
      await db.importWordLibrary(libName, words);
      alert(`导入成功：${libName} 共 ${words.length} 条`);
      updateLibraryStats();
      if (document.getElementById('librarySelect')?.value === libName) await nextQuestion();
    } catch (error) {
      alert('文件导入失败: ' + error.message);
    }
  }
});

/* 查询页（加防抖） */
async function initDictionary() {
  const searchInput = $('searchInput');
  const wordList = $('wordList');
  if (!searchInput || !wordList) return;
  searchInput.oninput = debounce(async (e) => {
    const q = e.target.value.trim();
    if (!q) {
      wordList.innerHTML = '<div class="word-item">输入单词开始搜索</div>';
      return;
    }
    try {
      const results = await db.searchWords(q);
      if (!results.length) {
        wordList.innerHTML = '<div class="word-item">未找到相关单词</div>';
        return;
      }
      wordList.innerHTML = results.map(r => `
          <div class="word-item" data-word="${r.word}" data-meaning="${r.meaning}">
            <strong>${r.word}</strong>
            <span style="float:right;color:#6c757d;font-size:.9em;">${r.library}</span>
            <div style="font-size:.9em;color:#6c757d;">${r.meaning}</div>
          </div>`).join('');
      wordList.querySelectorAll('.word-item').forEach(item => {
        item.addEventListener('click', () => showWordDetail(item.dataset.word, item.dataset.meaning));
      });
    } catch {
      wordList.innerHTML = '<div class="word-item">搜索出错</div>';
    }
  }, 200);
}

function showWordDetail(word, meaning) {
  const el = $('wordDetail');
  if (!el) return;
  el.innerHTML = `
      <h4 style="display:flex;align-items:center;gap:8px;">
        <span>${word}</span>
        <button class="btn-secondary" type="button" onclick="TTS.speak('${esc(word)}')" style="flex:0 0 auto;">🔊 听发音</button>
      </h4>
      <p><strong>释义:</strong> ${meaning}</p>
      <button class="btn-secondary" type="button" onclick="addToPractice('${esc(word)}', '${esc(meaning)}')">加入练习</button>
    `;
}

function addToPractice(word, meaning) {
  document.querySelector('.tab-button[data-tab="practice"]')?.click();
  (async () => {
    const exist = await db.getWordLibrary('custom');
    const list = dedupWords(exist?.words || []);
    if (!list.some(w => w.en === word && w.zh === meaning)) list.push({en: word, zh: meaning});
    await db.importWordLibrary('custom', dedupWords(list));
    currentLibrary = 'custom';
    const sel = document.getElementById('librarySelect');
    if (sel) sel.value = 'custom';
    const ta = document.getElementById('customTextarea');
    if (ta) {
      ta.style.display = 'block';
      ta.value = list.map(w => `${w.en}:${w.zh}`).join('\n');
    }
    await ensureLibraryLoaded('custom', ta ? ta.value : '');
    await nextQuestion();
  })();
}

/* 数据导出/导入/清空/同步 */
async function exportData() {
  try {
    const [libraries, stats] = await Promise.all([db.getAllLibraries(), db.getLearningStats()]);
    const data = {libraries, progressStats: stats, exportDate: new Date().toISOString(), version: '1.0'};
    const blob = new Blob([JSON.stringify(data, null, 2)], {type: 'application/json'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `english-typer-data-${localDateStr()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    alert('数据导出成功！');
  } catch (e) {
    alert('数据导出失败: ' + e.message);
  }
}

async function importData() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json';
  input.onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      if (Array.isArray(data.libraries)) {
        for (const lib of data.libraries) {
          await db.importWordLibrary(lib.name, dedupWords(lib.words || []));
        }
      }
      alert('数据导入成功！');
      location.reload();
    } catch (err) {
      alert('数据导入失败: ' + err.message);
    }
  };
  input.click();
}

async function syncWithCloud() {
  const el = $('syncStatus');
  if (el) el.textContent = '同步中...';
  setTimeout(() => {
    if (el) el.textContent = `上次同步: ${new Date().toLocaleTimeString()}`;
    alert('云端同步完成！（占位）');
  }, 1000);
}

async function clearData() {
  if (!confirm('确定清空所有本地数据吗？此操作不可恢复！')) return;
  indexedDB.deleteDatabase('EnglishTyperPro');
  Object.keys(localStorage).forEach(k => {
    if (k.startsWith('etp_')) localStorage.removeItem(k);
  });
  alert('数据已清空');
  location.reload();
}

/* 设置功能（加入系统偏好） */
function initSettings() {
  // 语音设置
  const speechRate = document.getElementById('speechRate');
  const speechPitch = document.getElementById('speechPitch');
  const autoSpeak = document.getElementById('autoSpeak');

  // 加载保存的设置
  speechRate.value = localStorage.getItem('speechRate') || 0.95;
  speechPitch.value = localStorage.getItem('speechPitch') || 1;
  autoSpeak.checked = localStorage.getItem('autoSpeak') === 'true';

  // 更新显示值
  document.getElementById('rateValue').textContent = speechRate.value;
  document.getElementById('pitchValue').textContent = speechPitch.value;

  // 监听设置变化
  speechRate.addEventListener('input', function () {
    document.getElementById('rateValue').textContent = this.value;
    localStorage.setItem('speechRate', this.value);
  });

  speechPitch.addEventListener('input', function () {
    document.getElementById('pitchValue').textContent = this.value;
    localStorage.setItem('speechPitch', this.value);
  });

  autoSpeak.addEventListener('change', function () {
    localStorage.setItem('autoSpeak', this.checked);
  });

  // 学习目标
  const dailyGoal = document.getElementById('dailyGoal');
  const accuracyGoal = document.getElementById('accuracyGoal');

  dailyGoal.value = localStorage.getItem('dailyGoal') || 50;
  accuracyGoal.value = localStorage.getItem('accuracyGoal') || 85;

  dailyGoal.addEventListener('change', function () {
    localStorage.setItem('dailyGoal', this.value);
    updateProgressBar();
  });

  accuracyGoal.addEventListener('change', function () {
    localStorage.setItem('accuracyGoal', this.value);
  });

  // 界面设置
  const darkMode = document.getElementById('darkMode');
  const fontSize = document.getElementById('fontSize');

  if (localStorage.getItem('darkMode') === null) {
    const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    applyDarkMode(prefersDark);
    darkMode.checked = prefersDark;
  } else {
    const dm = localStorage.getItem('darkMode') === 'true';
    applyDarkMode(dm);
    darkMode.checked = dm;
  }
  fontSize.value = localStorage.getItem('fontSize') || 'medium';

  darkMode.addEventListener('change', function () {
    localStorage.setItem('darkMode', this.checked);
    applyDarkMode(this.checked);
  });

  fontSize.addEventListener('change', function () {
    localStorage.setItem('fontSize', this.value);
    applyFontSize(this.value);
  });

  // 应用设置
  applyFontSize(fontSize.value);
}

function applyDarkMode(enabled) {
  if (enabled) {
    document.body.classList.add('dark-mode');
  } else {
    document.body.classList.remove('dark-mode');
  }
}

function applyFontSize(size) {
  const sizes = {
    small: '14px',
    medium: '16px',
    large: '18px'
  };
  document.body.style.fontSize = sizes[size];
}

/* —— 标签页切换 —— */
function setupTabSwitching() {
  const tabButtons = document.querySelectorAll('.tab-button');
  const tabContents = document.querySelectorAll('.tab-content');

  function activate(tabName) {
    if (typeof revealEnterHandler === 'function') {
      document.removeEventListener('keydown', revealEnterHandler);
      revealEnterHandler = null;
    }

    tabButtons.forEach(btn => {
      const isActive = btn.dataset.tab === tabName;
      btn.classList.toggle('active', isActive);
      btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
    });

    tabContents.forEach(sec => {
      sec.classList.toggle('active', sec.id === `${tabName}-tab`);
    });

    localStorage.setItem('etp_last_tab', tabName);

    switch (tabName) {
      case 'dictionary':
        initDictionary && initDictionary();
        break;
      case 'statistics':
        updateStatistics && updateStatistics();
        break;
      case 'library':
        updateLibraryStats && updateLibraryStats();
        break;
      case 'settings':
        initSettings && initSettings();
        break;
      default:
        break;
    }
  }

  tabButtons.forEach(btn => {
    btn.addEventListener('click', () => activate(btn.dataset.tab));
  });

  const remembered = localStorage.getItem('etp_last_tab');
  const defaultTab = remembered || document.querySelector('.tab-button.active')?.dataset.tab || 'practice';
  activate(defaultTab);
}

/* 绑定练习区 UI */
(function bindPracticeUI() {
  const libSel = $('librarySelect');
  const customTa = $('customTextarea');
  const modeBtns = document.querySelectorAll('.mode-btn');
  const btnReset = $('btnReset');
  const btnNext = $('btnNext');
  const input = $('typingInput');

  $('btnExport')?.addEventListener('click', exportData);
  $('btnImport')?.addEventListener('click', importData);
  $('btnSync')?.addEventListener('click', syncWithCloud);
  $('btnClear')?.addEventListener('click', clearData);
  $('btnImportCET4')?.addEventListener('click', importCET4);
  $('btnImportCET6')?.addEventListener('click', importCET6);
  $('btnImportCustom')?.addEventListener('click', () => document.getElementById('fileInput')?.click());

  libSel?.addEventListener('change', async () => {
    currentLibrary = libSel.value;
    if (customTa) customTa.style.display = currentLibrary === 'custom' ? 'block' : 'none';
    await ensureLibraryLoaded(currentLibrary, customTa ? customTa.value : '');
    await nextQuestion();
    updateStatistics();
  });
  modeBtns.forEach(b => {
    b.addEventListener('click', () => {
      modeBtns.forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      currentMode = b.dataset.mode;
      renderCurrent();
    });
  });
  btnReset?.addEventListener('click', async () => {
    await resetToday();
    await nextQuestion();
  });
  btnNext?.addEventListener('click', () => nextQuestion());
  input?.addEventListener('input', () => {
    if (currentMode === 'follow') judgeFollow();
  });
  input?.addEventListener('keydown', (e) => {
    if (currentMode === 'dictation' && e.key === 'Enter') {
      e.preventDefault();
      judgeDictation();
    }
  });

  document.addEventListener('keydown', async (e) => {
    if (e.key === '1') switchMode('follow');
    if (e.key === '2') switchMode('review');
    if (e.key === '3') switchMode('dictation');
    if (currentMode === 'review') handleReviewHotkeys(e);
    if (e.key === '5') {
      e.preventDefault();
      if (currentWord) TTS.speak(currentWord.en);
    }
    if (e.key === ']') {
      e.preventDefault();
      nextQuestion();
    }

    // 统一处理 Enter：三模式全部判题并记分
    if (e.key === 'Enter') {
      e.preventDefault();
      if (currentMode === 'dictation') {
        judgeDictation();
      } else if (currentMode === 'review') {
        onAnswer(true);
      } else if (currentMode === 'follow') {
        const val = (document.getElementById('typingInput').value || '').trim();
        if (!currentWord || !val) return;
        const ok = (val.toLowerCase() === currentWord.en.toLowerCase());
        onAnswer(ok, true);
      }
    }
  });
})();

/* 初始化 */
document.addEventListener('DOMContentLoaded', async () => {
  try {
    await db.init();
    await ensureBaseLibrariesOnce();
    setupTabSwitching();  // ← 关键：恢复所有 Tab 的点击切换

    // 首次自动尝试导入本地 JSON
    const autoKey = 'etp_auto_import_once';
    if (!localStorage.getItem(autoKey)) {
      try {
        await importCET4();
      } catch (_) {
      }
      try {
        await importCET6();
      } catch (_) {
      }
      localStorage.setItem(autoKey, '1');
    }

    currentLibrary = 'cet4';
    await ensureLibraryLoaded('cet4', '');
    await nextQuestion();

    updateStatistics();
    updateLibraryStats();
    await updateAchievements();
    settleStreak();
    await refreshSidebarStats();

    // 初始化设置
    initSettings();
    // 初始进度条
    updateProgressBar();
  } catch (error) {
    console.error('应用初始化失败:', error);
    alert('应用初始化失败，请刷新页面重试');
  }
});
document.getElementById('feedbackBtn').addEventListener('click', () => {
  // 跳转到留言页（新窗口打开）
  window.open('/liuyan', '_blank');
});