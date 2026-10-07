let keywordRows = [];
let keywordIdCounter = 0;
let matchCounts = {};

const defaultColors = ['#ffff00', '#ff0000', '#00ff00', '#0000ff', '#ff00ff', '#00ffff'];

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

document.addEventListener('DOMContentLoaded', async () => {
  await loadKeywords();
  renderKeywords();

  document.getElementById('addKeywordBtn').addEventListener('click', addKeywordRow);
  document.getElementById('clearBtn').addEventListener('click', clearHighlights);

  await refreshMatchCounts();
});

async function refreshMatchCounts() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://')) {
      return;
    }

    const isReady = await ensureContentScript(tab.id);
    if (!isReady) return;

    const response = await chrome.tabs.sendMessage(tab.id, { action: 'getMatchCounts' });
    if (response && response.matchCounts) {
      matchCounts = response.matchCounts;
      updateMatchCountsUI();
    }
  } catch (error) {
    console.error('Error refreshing match counts:', error);
  }
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
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const domain = new URL(tab.url).hostname;
    const result = await chrome.storage.local.get([`keywords_${domain}`]);
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
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const domain = new URL(tab.url).hostname;
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
    highlightKeywords();
  }, 300);
}

async function navigateMatch(keywordId, direction) {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://')) {
      return;
    }

    const isReady = await ensureContentScript(tab.id);
    if (!isReady) return;

    const response = await chrome.tabs.sendMessage(tab.id, {
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
    container.innerHTML = '<div class="empty-state">Click "Add Keyword" to start</div>';
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
        placeholder="Keyword..."
        value="${escapeHtml(row.keyword)}"
        data-id="${row.id}"
        data-field="keyword"
      />
      <div class="match-info">
        <span class="${countClass}" data-id="${row.id}">${countDisplay}</span>
        <button class="nav-btn nav-prev" data-id="${row.id}" title="Previous (Shift+Enter)">
          <svg viewBox="0 0 10 10" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M5 2L2 5L5 8M8 5H2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </button>
        <button class="nav-btn nav-next" data-id="${row.id}" title="Next (Enter)">
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
        title="Highlight color"
      />
      <div class="options">
        <button 
          class="option-btn ${row.matchCase ? 'active' : ''}"
          data-id="${row.id}"
          data-field="matchCase"
          title="Match case"
        >Aa</button>
        <button 
          class="option-btn ${row.wholeWord ? 'active' : ''}"
          data-id="${row.id}"
          data-field="wholeWord"
          title="Whole word"
        >W</button>
      </div>
      <button class="delete-btn" data-id="${row.id}" title="Remove">
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
      await new Promise(resolve => setTimeout(resolve, 150));
      await chrome.tabs.sendMessage(tabId, { action: 'ping' });
      return true;
    } catch (injectError) {
      console.error('Error injecting content script:', injectError);
      return false;
    }
  }
}

async function highlightKeywords() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://')) {
      return;
    }

    const isReady = await ensureContentScript(tab.id);
    if (!isReady) {
      alert('Could not connect to page. Please refresh and try again.');
      return;
    }

    const keywords = keywordRows
      .filter(row => row.keyword.trim() !== '')
      .map(row => ({
        id: row.id,
        keyword: row.keyword.trim(),
        color: row.color,
        matchCase: row.matchCase,
        wholeWord: row.wholeWord
      }));

    const response = await chrome.tabs.sendMessage(tab.id, {
      action: 'highlight',
      keywords
    });

    if (response && response.matchCounts) {
      matchCounts = response.matchCounts;
      updateMatchCountsUI();
    }
  } catch (error) {
    console.error('Error highlighting keywords:', error);
    if (!error.message.includes('Receiving end does not exist')) {
      alert('Error highlighting. Please refresh the page.');
    }
  }
}

async function clearHighlights() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (tab.url && !tab.url.startsWith('chrome://') && !tab.url.startsWith('chrome-extension://')) {
      const isReady = await ensureContentScript(tab.id);
      if (isReady) {
        try {
          await chrome.tabs.sendMessage(tab.id, { action: 'clear' });
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
  } catch (error) {
    console.error('Error clearing all:', error);
  }
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}
