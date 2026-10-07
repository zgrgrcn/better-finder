// Store highlight markers for easy removal
let highlightMarkers = [];
let highlightsByKeyword = {}; // Track highlights per keyword
let currentIndexByKeyword = {}; // Track current position per keyword
let floatingUI = null;
let isCommandFListenerActive = true;

// Listen for messages from popup and background
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'ping') {
    sendResponse({ success: true });
    return true;
  } else if (request.action === 'highlight') {
    const matchCounts = highlightKeywords(request.keywords);
    sendResponse({ success: true, matchCounts });
    return true;
  } else if (request.action === 'clear') {
    clearAllHighlights();
    sendResponse({ success: true });
    return true;
  } else if (request.action === 'toggleFloatingUI') {
    toggleFloatingUI();
    sendResponse({ success: true });
    return true;
  } else if (request.action === 'navigateToMatch') {
    const result = navigateToMatch(request.keywordId, request.direction);
    sendResponse({ success: true, ...result });
    return true;
  } else if (request.action === 'getMatchCounts') {
    const counts = {};
    Object.keys(highlightsByKeyword).forEach(id => {
      counts[id] = {
        total: highlightsByKeyword[id].length,
        current: currentIndexByKeyword[id] + 1
      };
    });
    sendResponse({ success: true, matchCounts: counts });
    return true;
  }
  return false;
});

// Navigate to next/previous match for a keyword
function navigateToMatch(keywordId, direction) {
  // Ensure keywordId is string for consistent object key access
  const id = String(keywordId);
  const highlights = highlightsByKeyword[id];
  if (!highlights || highlights.length === 0) {
    return { current: 0, total: 0 };
  }

  let currentIndex = currentIndexByKeyword[id] || 0;

  // Remove active class from current
  if (highlights[currentIndex]) {
    highlights[currentIndex].classList.remove('better-finder-active');
  }

  // Calculate new index
  if (direction === 'next') {
    currentIndex = (currentIndex + 1) % highlights.length;
  } else if (direction === 'prev') {
    currentIndex = (currentIndex - 1 + highlights.length) % highlights.length;
  }

  currentIndexByKeyword[id] = currentIndex;

  // Add active class and scroll to new current
  const currentHighlight = highlights[currentIndex];
  if (currentHighlight) {
    currentHighlight.classList.add('better-finder-active');
    currentHighlight.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  return {
    current: currentIndex + 1,
    total: highlights.length
  };
}

// Highlight keywords in the page
function highlightKeywords(keywords) {
  // Clear existing highlights first
  clearAllHighlights();

  const matchCounts = {};

  if (!keywords || keywords.length === 0) {
    return matchCounts;
  }

  // Add CSS for active highlight if not exists
  if (!document.getElementById('better-finder-styles')) {
    const style = document.createElement('style');
    style.id = 'better-finder-styles';
    style.textContent = `
      .better-finder-highlight {
        padding: 2px 0;
        border-radius: 2px;
      }
      .better-finder-active {
        position: relative;
        border-radius: 3px;
      }
      .better-finder-active::before {
        content: '';
        position: absolute;
        top: -4px;
        left: -4px;
        right: -4px;
        bottom: -4px;
        border-radius: 5px;
        background: linear-gradient(90deg, #ff0000, #ff7300, #fffb00, #48ff00, #00ffd5, #002bff, #7a00ff, #ff00c8, #ff0000);
        background-size: 400% 400%;
        z-index: -1;
        animation: borderRotate 2s linear infinite, borderPulse 1s ease-in-out infinite;
      }
      .better-finder-active::after {
        content: '';
        position: absolute;
        top: -2px;
        left: -2px;
        right: -2px;
        bottom: -2px;
        background: inherit;
        border-radius: 3px;
        z-index: -1;
      }
      @keyframes borderRotate {
        0% { background-position: 0% 50%; }
        50% { background-position: 100% 50%; }
        100% { background-position: 0% 50%; }
      }
      @keyframes borderPulse {
        0%, 100% { 
          top: -4px; left: -4px; right: -4px; bottom: -4px;
          opacity: 1;
        }
        50% { 
          top: -6px; left: -6px; right: -6px; bottom: -6px;
          opacity: 0.7;
        }
      }
    `;
    document.head.appendChild(style);
  }

  // Process each keyword
  keywords.forEach(keywordConfig => {
    const { id: rawId, keyword, color, matchCase, wholeWord } = keywordConfig;
    // Ensure id is string for consistent object key access
    const id = String(rawId);

    if (!keyword || keyword.trim() === '') {
      matchCounts[id] = { total: 0, current: 0 };
      return;
    }

    highlightsByKeyword[id] = [];
    currentIndexByKeyword[id] = 0;

    // Build regex pattern
    let pattern = escapeRegExp(keyword);

    if (wholeWord) {
      pattern = `\\b${pattern}\\b`;
    }

    const flags = matchCase ? 'g' : 'gi';
    const regex = new RegExp(pattern, flags);

    // Find and highlight all matches
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode: function(node) {
          const parent = node.parentElement;
          if (!parent) return NodeFilter.FILTER_REJECT;

          const tagName = parent.tagName.toLowerCase();
          if (tagName === 'script' || tagName === 'style' || tagName === 'noscript') {
            return NodeFilter.FILTER_REJECT;
          }

          if (parent.classList.contains('better-finder-highlight')) {
            return NodeFilter.FILTER_REJECT;
          }

          return NodeFilter.FILTER_ACCEPT;
        }
      }
    );

    const textNodes = [];
    let node;
    while (node = walker.nextNode()) {
      textNodes.push(node);
    }

    // Process text nodes in reverse order to maintain DOM integrity
    textNodes.reverse().forEach(textNode => {
      const text = textNode.textContent;
      const matches = [...text.matchAll(regex)];

      if (matches.length > 0) {
        const parent = textNode.parentNode;
        const fragments = [];
        let lastIndex = 0;

        matches.forEach(match => {
          if (match.index > lastIndex) {
            fragments.push(document.createTextNode(text.substring(lastIndex, match.index)));
          }

          const mark = document.createElement('mark');
          mark.className = 'better-finder-highlight';
          mark.dataset.keywordId = id;
          mark.style.backgroundColor = color;
          mark.style.color = getContrastColor(color);
          mark.textContent = match[0];
          fragments.push(mark);
          highlightMarkers.push(mark);
          highlightsByKeyword[id].push(mark);

          lastIndex = match.index + match[0].length;
        });

        if (lastIndex < text.length) {
          fragments.push(document.createTextNode(text.substring(lastIndex)));
        }

        fragments.forEach(fragment => {
          parent.insertBefore(fragment, textNode);
        });
        parent.removeChild(textNode);
      }
    });

    // Reverse the highlights array so first match on page is index 0
    // (we processed text nodes in reverse order for DOM integrity)
    highlightsByKeyword[id].reverse();

    // Set match count for this keyword
    matchCounts[id] = {
      total: highlightsByKeyword[id].length,
      current: highlightsByKeyword[id].length > 0 ? 1 : 0
    };

    // Mark first match as active
    if (highlightsByKeyword[id].length > 0) {
      highlightsByKeyword[id][0].classList.add('better-finder-active');
    }
  });

  // Scroll to first highlight of first keyword with matches
  for (const keywordConfig of keywords) {
    const highlights = highlightsByKeyword[String(keywordConfig.id)];
    if (highlights && highlights.length > 0) {
      highlights[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
      break;
    }
  }

  return matchCounts;
}

// Get contrast color for text based on background
function getContrastColor(hexColor) {
  const hex = hexColor.replace('#', '');
  const r = parseInt(hex.substr(0, 2), 16);
  const g = parseInt(hex.substr(2, 2), 16);
  const b = parseInt(hex.substr(4, 2), 16);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.5 ? '#000000' : '#ffffff';
}

// Clear all highlights
function clearAllHighlights() {
  highlightMarkers.forEach(marker => {
    const parent = marker.parentNode;
    if (parent) {
      const textNode = document.createTextNode(marker.textContent);
      parent.replaceChild(textNode, marker);
      parent.normalize();
    }
  });

  highlightMarkers = [];
  highlightsByKeyword = {};
  currentIndexByKeyword = {};
}

// Escape special regex characters
function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Toggle floating UI for keyboard shortcut
async function toggleFloatingUI() {
  if (floatingUI) {
    floatingUI.remove();
    floatingUI = null;
    return;
  }

  floatingUI = document.createElement('div');
  floatingUI.id = 'better-finder-floating-ui';
  floatingUI.innerHTML = `
    <div style="
      position: fixed;
      top: 20px;
      right: 20px;
      width: 350px;
      background: white;
      border: 2px solid #4a4a4a;
      border-radius: 8px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.3);
      z-index: 999999;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    ">
      <div style="
        background: #4a4a4a;
        color: white;
        padding: 12px;
        font-weight: 600;
        border-radius: 6px 6px 0 0;
        display: flex;
        justify-content: space-between;
        align-items: center;
      ">
        <span>Find and Highlight</span>
        <button id="close-floating-ui" style="
          background: transparent;
          border: none;
          color: white;
          font-size: 20px;
          cursor: pointer;
          padding: 0;
          width: 24px;
          height: 24px;
          line-height: 24px;
        ">×</button>
      </div>
      <div style="padding: 15px;">
        <p style="margin: 0 0 15px 0; color: #666; font-size: 14px;">
          Click the extension icon to open the full popup with keyword management.
        </p>
        <button id="open-popup-btn" style="
          width: 100%;
          padding: 10px;
          background: #3498db;
          color: white;
          border: none;
          border-radius: 4px;
          cursor: pointer;
          font-size: 14px;
          font-weight: 500;
        ">Open Extension Popup</button>
      </div>
    </div>
  `;

  document.body.appendChild(floatingUI);

  floatingUI.querySelector('#close-floating-ui').addEventListener('click', () => {
    floatingUI.remove();
    floatingUI = null;
  });

  floatingUI.querySelector('#open-popup-btn').addEventListener('click', () => {
    floatingUI.remove();
    floatingUI = null;
    alert('Please click the Better Finder extension icon in the toolbar to open the popup.');
  });

  setTimeout(() => {
    document.addEventListener('click', function closeOnOutsideClick(e) {
      if (floatingUI && !floatingUI.contains(e.target)) {
        floatingUI.remove();
        floatingUI = null;
        document.removeEventListener('click', closeOnOutsideClick);
      }
    });
  }, 100);
}

// Listen for Command+F / Ctrl+F to open floating UI
if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id) {
  document.addEventListener('keydown', (e) => {
    const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
    const isCommandF = isMac ? (e.metaKey && e.key === 'f') : (e.ctrlKey && e.key === 'f');

    if (isCommandF && isCommandFListenerActive) {
      setTimeout(() => {
        if (!floatingUI) {
          toggleFloatingUI();
        }
      }, 100);
    }
  }, true);
}

// Handle dynamic content (e.g., SPAs)
const observer = new MutationObserver((mutations) => {
  // Optionally re-highlight when content changes
});

observer.observe(document.body, {
  childList: true,
  subtree: true
});
