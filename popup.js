let keywordRows = [];
let keywordIdCounter = 0;
let matchCounts = {};
let currentTab = null;

const defaultColors = ['#ffff00', '#ff0000', '#00ff00', '#0000ff', '#ff00ff', '#00ffff'];

const t = key => chrome.i18n.getMessage(key);

function getNextAvailableColor() {
  const usedColors = keywordRows.map(row => row.color);
  for (const color of defaultColors) {
    if (!usedColors.includes(color)) {
      return color;
    }
  }
  return defaultColors[keywordRows.length % defaultColors.length];
}

let highlightTimer = null;
let clearTimer = null;

document.addEventListener('DOMContentLoaded', async () => {
  localize();
  setupThemeSelect();

  [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });

  await loadKeywords();
  renderKeywords();

  document.getElementById('addKeywordBtn').addEventListener('click', () => addKeywordRow());
  document.getElementById('clearBtn').addEventListener('click', onClearClick);

  await setupAutoToggle();

  if (!isSearchable()) {
    showStatus('pageNotSupported');
    return;
  }

  // Show the saved keywords right away; if the page already has them, just read the counts
  await highlightKeywords({ scroll: false, keepIfSame: true });
});

function localize() {
  document.documentElement.lang = chrome.i18n.getUILanguage();
  document.documentElement.dir = t('@@bidi_dir') || 'ltr';
  document.querySelectorAll('[data-i18n]').forEach(element => {
    element.textContent = t(element.dataset.i18n);
  });
  document.querySelectorAll('[data-i18n-title]').forEach(element => {
    element.title = t(element.dataset.i18nTitle);
    element.setAttribute('aria-label', element.title);
  });
}

// theme.js already applied the saved theme; this keeps the picker in sync
function setupThemeSelect() {
  const select = document.getElementById('themeSelect');
  select.value = document.documentElement.dataset.theme || 'auto';
  select.addEventListener('change', () => {
    applyTheme(select.value);
    try {
      if (select.value === 'auto') {
        localStorage.removeItem('theme');
      } else {
        localStorage.setItem('theme', select.value);
      }
    } catch (error) {
      console.error('Error saving theme:', error);
    }
  });
}

function isSearchable() {
  return !!currentTab?.url && /^(https?|file):/.test(currentTab.url);
}

function getDomain() {
  try {
    return new URL(currentTab.url).hostname;
  } catch {
    return null;
  }
}

function showStatus(key) {
  const status = document.getElementById('status');
  status.textContent = t(key);
  status.hidden = false;
}

// Opt-in per site: granting the site's host permission makes background.js
// inject the highlighter on every page load there
async function setupAutoToggle() {
  if (!currentTab?.url || !/^https?:/.test(currentTab.url)) return;

  const url = new URL(currentTab.url);
  const origins = [`${url.protocol}//${url.hostname}/*`];
  const row = document.getElementById('autoToggleRow');
  const checkbox = document.getElementById('autoToggle');

  checkbox.checked = await chrome.permissions.contains({ origins });
  row.hidden = false;

  checkbox.addEventListener('change', async () => {
    try {
      if (checkbox.checked) {
        checkbox.checked = await chrome.permissions.request({ origins });
      } else {
        await chrome.permissions.remove({ origins });
      }
    } catch (error) {
      console.error('Error changing auto-highlight:', error);
      checkbox.checked = await chrome.permissions.contains({ origins });
    }
  });
}

function updateMatchCountsUI() {
  keywordRows.forEach(row => {
    const countElement = document.querySelector(`.match-count[data-id="${row.id}"]`);
    if (countElement) {
      // Check both number and string keys for compatibility
      const count = matchCounts[row.id] || matchCounts[String(row.id)];
      if (count && count.total > 0) {
        countElement.textContent = `${count.current}/${count.total}`;
        countElement.classList.remove('no-matches');
      } else if (row.keyword.trim() !== '') {
        countElement.textContent = '0';
        countElement.classList.add('no-matches');
      } else {
        countElement.textContent = '';
        countElement.classList.remove('no-matches');
      }
    }
  });
}

async function loadKeywords() {
  try {
    const domain = getDomain();
    const result = domain === null ? {} : await chrome.storage.local.get([`keywords_${domain}`]);
    const savedKeywords = result[`keywords_${domain}`] || [];

    if (savedKeywords.length > 0) {
      keywordRows = savedKeywords;
      keywordIdCounter = Math.max(...keywordRows.map(k => k.id || 0)) + 1;
    } else {
      addKeywordRow();
    }
  } catch (error) {
    console.error('Error loading keywords:', error);
    addKeywordRow();
  }
}

async function saveKeywords() {
  const domain = getDomain();
  if (domain === null) return;
  try {
    await chrome.storage.local.set({ [`keywords_${domain}`]: keywordRows });
  } catch (error) {
    console.error('Error saving keywords:', error);
  }
}

function addKeywordRow(keywordData = null) {
  const id = keywordIdCounter++;
  const row = {
    id,
    keyword: keywordData?.keyword || '',
    color: keywordData?.color || getNextAvailableColor(),
    matchCase: keywordData?.matchCase || false,
    wholeWord: keywordData?.wholeWord || false
  };

  keywordRows.push(row);
  renderKeywords();
  saveKeywords();

  setTimeout(() => {
    const newInput = document.querySelector(`.keyword-input[data-id="${id}"]`);
    if (newInput) {
      newInput.focus();
    }
  }, 100);
}

async function removeKeywordRow(id) {
  keywordRows = keywordRows.filter(row => row.id !== id);
  delete matchCounts[id];
  renderKeywords();
  saveKeywords();
  debouncedHighlight();
}

function updateKeyword(id, field, value) {
  const row = keywordRows.find(r => r.id === id);
  if (row) {
    row[field] = value;
    saveKeywords();

    if (field === 'keyword' || field === 'color' || field === 'matchCase' || field === 'wholeWord') {
      debouncedHighlight();
    }
  }
}

function debouncedHighlight() {
  clearTimeout(highlightTimer);
  highlightTimer = setTimeout(() => {
    highlightKeywords({ scroll: true });
  }, 300);
}

async function navigateMatch(keywordId, direction) {
  if (!isSearchable()) return;
  try {
    const isReady = await ensureContentScript(currentTab.id);
    if (!isReady) return;

    const response = await chrome.tabs.sendMessage(currentTab.id, {
      action: 'navigateToMatch',
      keywordId,
      direction
    });

    if (response && response.success) {
      // Store with string key for consistency
      matchCounts[String(keywordId)] = {
        current: response.current,
        total: response.total
      };
      updateMatchCountsUI();
    }
  } catch (error) {
    console.error('Error navigating:', error);
  }
}

function renderKeywords() {
  const container = document.getElementById('keywordsContainer');

  if (keywordRows.length === 0) {
    container.innerHTML = `<div class="empty-state">${escapeHtml(t('emptyState'))}</div>`;
    return;
  }

  container.innerHTML = keywordRows.map(row => {
    // Check both number and string keys for compatibility
    const count = matchCounts[row.id] || matchCounts[String(row.id)];
    let countDisplay = '';
    let countClass = 'match-count';

    if (count && count.total > 0) {
      countDisplay = `${count.current}/${count.total}`;
    } else if (row.keyword.trim() !== '') {
      countDisplay = '0';
      countClass += ' no-matches';
    }

    return `
    <div class="keyword-row" data-id="${row.id}">
      <input
        type="text"
        class="keyword-input"
        placeholder="${escapeHtml(t('keywordPlaceholder'))}"
        value="${escapeHtml(row.keyword)}"
        data-id="${row.id}"
        data-field="keyword"
        dir="auto"
      />
      <div class="match-info">
        <span class="${countClass}" data-id="${row.id}">${countDisplay}</span>
        <button class="nav-btn nav-prev" data-id="${row.id}" title="${escapeHtml(t('previousMatch'))}">
          <svg viewBox="0 0 10 10" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M5 2L2 5L5 8M8 5H2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </button>
        <button class="nav-btn nav-next" data-id="${row.id}" title="${escapeHtml(t('nextMatch'))}">
          <svg viewBox="0 0 10 10" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M5 8L8 5L5 2M2 5H8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </button>
      </div>
      <input
        type="color"
        class="color-input"
        value="${row.color}"
        data-id="${row.id}"
        data-field="color"
        title="${escapeHtml(t('highlightColor'))}"
      />
      <div class="options">
        <button
          class="option-btn ${row.matchCase ? 'active' : ''}"
          data-id="${row.id}"
          data-field="matchCase"
          title="${escapeHtml(t('matchCase'))}"
        >Aa</button>
        <button
          class="option-btn ${row.wholeWord ? 'active' : ''}"
          data-id="${row.id}"
          data-field="wholeWord"
          title="${escapeHtml(t('wholeWord'))}"
        >W</button>
      </div>
      <button class="delete-btn" data-id="${row.id}" title="${escapeHtml(t('remove'))}">
        <svg viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M11 3L3 11M3 3L11 11" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
        </svg>
      </button>
    </div>
  `}).join('');

  // Event listeners
  container.querySelectorAll('.keyword-input').forEach(input => {
    input.addEventListener('input', (e) => {
      updateKeyword(parseInt(e.target.dataset.id), e.target.dataset.field, e.target.value);
    });

    input.addEventListener('keydown', (e) => {
      const id = parseInt(e.target.dataset.id);
      if (e.key === 'Enter') {
        e.preventDefault();
        navigateMatch(id, e.shiftKey ? 'prev' : 'next');
      }
    });
  });

  container.querySelectorAll('.color-input').forEach(input => {
    input.addEventListener('input', (e) => {
      updateKeyword(parseInt(e.target.dataset.id), e.target.dataset.field, e.target.value);
    });
  });

  container.querySelectorAll('.option-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const id = parseInt(e.target.dataset.id);
      const field = e.target.dataset.field;
      const row = keywordRows.find(r => r.id === id);
      if (row) {
        const newValue = !row[field];
        updateKeyword(id, field, newValue);
        e.target.classList.toggle('active', newValue);
      }
    });
  });

  container.querySelectorAll('.delete-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      removeKeywordRow(parseInt(e.currentTarget.dataset.id));
    });
  });

  container.querySelectorAll('.nav-prev').forEach(btn => {
    btn.addEventListener('click', (e) => {
      navigateMatch(parseInt(e.currentTarget.dataset.id), 'prev');
    });
  });

  container.querySelectorAll('.nav-next').forEach(btn => {
    btn.addEventListener('click', (e) => {
      navigateMatch(parseInt(e.currentTarget.dataset.id), 'next');
    });
  });
}

async function ensureContentScript(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { action: 'ping' });
    return true;
  } catch (error) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['content.js']
      });
      await chrome.tabs.sendMessage(tabId, { action: 'ping' });
      return true;
    } catch (injectError) {
      console.error('Error injecting content script:', injectError);
      return false;
    }
  }
}

// Same shape content.js builds from storage, so it can tell nothing changed
function keywordPayload() {
  return keywordRows
    .filter(row => row.keyword.trim() !== '')
    .map(row => ({
      id: row.id,
      keyword: row.keyword.trim(),
      color: row.color,
      matchCase: !!row.matchCase,
      wholeWord: !!row.wholeWord
    }));
}

async function highlightKeywords({ scroll, keepIfSame = false }) {
  if (!isSearchable()) return;
  try {
    const isReady = await ensureContentScript(currentTab.id);
    if (!isReady) {
      showStatus('connectError');
      return;
    }

    const response = await chrome.tabs.sendMessage(currentTab.id, {
      action: 'highlight',
      keywords: keywordPayload(),
      scroll,
      keepIfSame
    });

    if (response && response.matchCounts) {
      matchCounts = response.matchCounts;
      updateMatchCountsUI();
    }
  } catch (error) {
    console.error('Error highlighting keywords:', error);
    showStatus('connectError');
  }
}

// Clearing deletes this site's saved keywords, so it takes a second click
function onClearClick() {
  const button = document.getElementById('clearBtn');
  if (!button.classList.contains('confirm')) {
    button.classList.add('confirm');
    button.textContent = t('clearConfirm');
    clearTimer = setTimeout(resetClearButton, 3000);
    return;
  }
  resetClearButton();
  clearHighlights();
}

function resetClearButton() {
  clearTimeout(clearTimer);
  const button = document.getElementById('clearBtn');
  button.classList.remove('confirm');
  button.textContent = t('clearAll');
}

async function clearHighlights() {
  if (isSearchable()) {
    const isReady = await ensureContentScript(currentTab.id);
    if (isReady) {
      try {
        await chrome.tabs.sendMessage(currentTab.id, { action: 'clear' });
      } catch (error) {
        console.error('Error clearing highlights:', error);
      }
    }
  }

  keywordRows = [];
  keywordIdCounter = 0;
  matchCounts = {};
  renderKeywords();
  saveKeywords();
  addKeywordRow();
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
