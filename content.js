// Injected both by the popup (activeTab) and by the auto-highlight content
// script, so guard against running twice in the same page.
if (!window.__betterFinderLoaded) {
  window.__betterFinderLoaded = true;

  let activeKeywords = []; // Keyword configs currently applied to the page
  let highlightsByKeyword = {}; // Track highlights per keyword, in document order
  let currentIndexByKeyword = {}; // Track current position per keyword
  const pendingRoots = new Set(); // Nodes added by the page since the last pass
  let pendingTimer = null;

  // Letters, marks and digits of every script, not just ASCII like \b
  const WORD_CHAR = /[\p{L}\p{M}\p{N}_]/u;
  // Scripts written without spaces: word edges come from Intl.Segmenter
  const NO_SPACE_CHAR = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;
  const segmenter = typeof Intl.Segmenter === 'function'
    ? new Intl.Segmenter(undefined, { granularity: 'word' })
    : null;

  const SKIPPED_TAGS = new Set(['script', 'style', 'noscript', 'textarea', 'template', 'select', 'option']);

  // Highlight content the page adds later (infinite scroll, SPA navigation)
  const observer = new MutationObserver(mutations => {
    mutations.forEach(mutation => {
      mutation.addedNodes.forEach(node => {
        if (node.nodeType === Node.ELEMENT_NODE && node.classList.contains('better-finder-highlight')) return;
        if (node.nodeType === Node.ELEMENT_NODE || node.nodeType === Node.TEXT_NODE) {
          pendingRoots.add(node);
        }
      });
    });
    if (pendingRoots.size === 0) return;
    clearTimeout(pendingTimer);
    pendingTimer = setTimeout(highlightPending, 300);
  });

  // Listen for messages from popup
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'ping') {
      sendResponse({ success: true });
    } else if (request.action === 'highlight') {
      // keepIfSame: the popup just opened, don't redo what the page already shows
      if (!(request.keepIfSame && sameKeywords(request.keywords, activeKeywords))) {
        applyKeywords(request.keywords, { scroll: request.scroll });
      }
      sendResponse({ success: true, matchCounts: getMatchCounts() });
    } else if (request.action === 'clear') {
      applyKeywords([], { scroll: false });
      sendResponse({ success: true });
    } else if (request.action === 'navigateToMatch') {
      const result = navigateToMatch(request.keywordId, request.direction);
      sendResponse({ success: true, ...result });
    } else if (request.action === 'getMatchCounts') {
      sendResponse({ success: true, matchCounts: getMatchCounts() });
    } else {
      return false;
    }
    return true;
  });

  function sameKeywords(a, b) {
    return JSON.stringify(a || []) === JSON.stringify(b || []);
  }

  function getMatchCounts() {
    pruneDetached();
    const counts = {};
    Object.keys(highlightsByKeyword).forEach(id => {
      const total = highlightsByKeyword[id].length;
      counts[id] = { total, current: total > 0 ? currentIndexByKeyword[id] + 1 : 0 };
    });
    return counts;
  }

  // Navigate to next/previous match for a keyword
  function navigateToMatch(keywordId, direction) {
    pruneDetached();
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
    currentHighlight.classList.add('better-finder-active');
    currentHighlight.scrollIntoView({ behavior: 'smooth', block: 'center' });

    return {
      current: currentIndex + 1,
      total: highlights.length
    };
  }

  // Replace all highlights with the given keywords
  function applyKeywords(keywords, { scroll }) {
    clearAllHighlights();
    activeKeywords = (keywords || []).filter(k => k.keyword && k.keyword.trim() !== '');

    if (activeKeywords.length === 0 || !document.body) {
      observer.disconnect();
      return;
    }

    injectStyles();

    activeKeywords.forEach(config => {
      const id = String(config.id);
      highlightsByKeyword[id] = [];
      currentIndexByKeyword[id] = 0;
    });

    highlightIn(document.body);

    // Mark first match of each keyword as active
    Object.values(highlightsByKeyword).forEach(highlights => {
      if (highlights.length > 0) {
        highlights[0].classList.add('better-finder-active');
      }
    });

    // Scroll to first highlight of first keyword with matches
    if (scroll) {
      for (const config of activeKeywords) {
        const highlights = highlightsByKeyword[String(config.id)];
        if (highlights.length > 0) {
          highlights[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
          break;
        }
      }
    }

    observer.observe(document.body, { childList: true, subtree: true });
    // Our own <mark> insertions are not page changes
    observer.takeRecords();
  }

  // Highlight every active keyword inside root
  function highlightIn(root) {
    activeKeywords.forEach(config => {
      const id = String(config.id);
      const regex = buildRegex(config.keyword.trim(), config.matchCase);
      const marks = [];

      collectTextNodes(root).forEach(textNode => {
        const text = textNode.textContent;
        let boundaries = null;
        const matches = [...text.matchAll(regex)].filter(match => {
          if (!config.wholeWord) return true;
          const start = match.index;
          const end = start + match[0].length;
          if (!boundaries && (needsSegmenter(text, start) || needsSegmenter(text, end))) {
            boundaries = segmentBoundaries(text);
          }
          return isWordEdge(text, start, boundaries) && isWordEdge(text, end, boundaries);
        });

        if (matches.length === 0) return;

        const fragment = document.createDocumentFragment();
        let lastIndex = 0;

        matches.forEach(match => {
          if (match.index > lastIndex) {
            fragment.appendChild(document.createTextNode(text.substring(lastIndex, match.index)));
          }

          const mark = document.createElement('mark');
          mark.className = 'better-finder-highlight';
          mark.dataset.keywordId = id;
          mark.style.backgroundColor = config.color;
          mark.style.color = getContrastColor(config.color);
          mark.textContent = match[0];
          fragment.appendChild(mark);
          marks.push(mark);

          lastIndex = match.index + match[0].length;
        });

        if (lastIndex < text.length) {
          fragment.appendChild(document.createTextNode(text.substring(lastIndex)));
        }

        textNode.parentNode.replaceChild(fragment, textNode);
      });

      highlightsByKeyword[id].push(...marks);
    });
  }

  function collectTextNodes(root) {
    if (root.nodeType === Node.TEXT_NODE) {
      return acceptTextNode(root) === NodeFilter.FILTER_ACCEPT ? [root] : [];
    }
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode: acceptTextNode });
    const textNodes = [];
    let node;
    while ((node = walker.nextNode())) {
      textNodes.push(node);
    }
    return textNodes;
  }

  function acceptTextNode(node) {
    const parent = node.parentElement;
    if (!parent) return NodeFilter.FILTER_REJECT;
    if (SKIPPED_TAGS.has(parent.tagName.toLowerCase())) return NodeFilter.FILTER_REJECT;
    if (parent.closest('.better-finder-highlight')) return NodeFilter.FILTER_REJECT;
    // Wrapping text inside an editor would corrupt what the user is typing
    if (parent.isContentEditable) return NodeFilter.FILTER_REJECT;
    return NodeFilter.FILTER_ACCEPT;
  }

  // Build a literal, Unicode-aware pattern for one keyword
  function buildRegex(keyword, matchCase) {
    let pattern = escapeRegExp(keyword);
    if (!matchCase) {
      // Unicode case folding keeps dotted and dotless i apart; Turkish readers expect them to match
      pattern = pattern.replace(/[iIıİ]/g, '[iIıİ]');
    }
    return new RegExp(pattern, matchCase ? 'gu' : 'giu');
  }

  function charBefore(text, index) {
    if (index <= 0) return '';
    const code = text.charCodeAt(index - 1);
    const isLowSurrogate = code >= 0xdc00 && code <= 0xdfff;
    return isLowSurrogate && index >= 2 ? text.slice(index - 2, index) : text[index - 1];
  }

  function charAt(text, index) {
    if (index >= text.length) return '';
    return String.fromCodePoint(text.codePointAt(index));
  }

  function needsSegmenter(text, index) {
    return NO_SPACE_CHAR.test(charBefore(text, index)) || NO_SPACE_CHAR.test(charAt(text, index));
  }

  function segmentBoundaries(text) {
    const boundaries = new Set([0, text.length]);
    if (segmenter) {
      for (const { index, segment } of segmenter.segment(text)) {
        boundaries.add(index);
        boundaries.add(index + segment.length);
      }
    }
    return boundaries;
  }

  // True when a word starts or ends at index
  function isWordEdge(text, index, boundaries) {
    const before = charBefore(text, index);
    const after = charAt(text, index);
    if (!before || !after) return true;
    if (NO_SPACE_CHAR.test(before) || NO_SPACE_CHAR.test(after)) {
      // Without Intl.Segmenter there is no way to tell, so don't drop the match
      return boundaries && segmenter ? boundaries.has(index) : true;
    }
    return !(WORD_CHAR.test(before) && WORD_CHAR.test(after));
  }

  function injectStyles() {
    if (document.getElementById('better-finder-styles')) return;
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
    (document.head || document.documentElement).appendChild(style);
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
    const parents = new Set();
    document.querySelectorAll('mark.better-finder-highlight').forEach(mark => {
      const parent = mark.parentNode;
      if (parent) {
        parent.replaceChild(document.createTextNode(mark.textContent), mark);
        parents.add(parent);
      }
    });
    parents.forEach(parent => parent.normalize());

    highlightsByKeyword = {};
    currentIndexByKeyword = {};
    pendingRoots.clear();
    clearTimeout(pendingTimer);
    observer.takeRecords();
  }

  // Forget marks the page removed, keeping each keyword's current match
  function pruneDetached() {
    Object.keys(highlightsByKeyword).forEach(id => {
      const highlights = highlightsByKeyword[id];
      if (highlights.every(mark => mark.isConnected)) return;
      const current = highlights[currentIndexByKeyword[id]];
      highlightsByKeyword[id] = highlights.filter(mark => mark.isConnected);
      const kept = highlightsByKeyword[id].indexOf(current);
      currentIndexByKeyword[id] = kept >= 0 ? kept : 0;
    });
  }

  function highlightPending() {
    const roots = [...pendingRoots].filter(node => node.isConnected);
    pendingRoots.clear();
    if (roots.length === 0 || activeKeywords.length === 0) return;

    const activeMarks = {};
    Object.keys(highlightsByKeyword).forEach(id => {
      activeMarks[id] = highlightsByKeyword[id][currentIndexByKeyword[id]];
    });

    // A root inside another root is covered when the outer one is walked
    roots
      .filter(node => !roots.some(other => other !== node && other.contains(node)))
      .forEach(node => highlightIn(node));
    observer.takeRecords();

    // Keep matches in document order so next/previous follow the page
    Object.keys(highlightsByKeyword).forEach(id => {
      const highlights = highlightsByKeyword[id]
        .filter(mark => mark.isConnected)
        .sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
      highlightsByKeyword[id] = highlights;
      let index = highlights.indexOf(activeMarks[id]);
      if (index < 0) {
        index = 0;
        if (highlights[0]) highlights[0].classList.add('better-finder-active');
      }
      currentIndexByKeyword[id] = index;
    });
  }

  // Escape special regex characters
  function escapeRegExp(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  // Same shape the popup sends, so the popup can tell nothing changed
  function toConfig(row) {
    return {
      id: row.id,
      keyword: (row.keyword || '').trim(),
      color: row.color,
      matchCase: !!row.matchCase,
      wholeWord: !!row.wholeWord
    };
  }

  // auto.js runs first on sites where the user turned on auto-highlight
  if (window.__betterFinderAuto) {
    const key = `keywords_${location.hostname}`;
    chrome.storage.local.get(key).then(result => {
      const saved = (result[key] || []).map(toConfig);
      if (activeKeywords.length === 0) {
        applyKeywords(saved, { scroll: false });
      }
    });
  }
}
