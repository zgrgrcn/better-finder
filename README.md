# Better Finder

Chrome extension for multi-keyword search and highlight. Each keyword gets its own color and its own match-case and whole-word options.

[Chrome Web Store](https://chromewebstore.google.com/detail/better-finder/fikdniaddopaldbdnjljmihalpaonhpm)

Plain JavaScript, Manifest V3, no build step. To run locally: `chrome://extensions` → Developer mode → Load unpacked → this folder.

Auto-highlight is opt-in per site. Turning it on in the popup asks Chrome for that site's permission, and `background.js` registers the content script for every site granted. No site access is requested at install.

UI strings live in `_locales/` (24 languages, Chrome's supported locale codes only).

The original source was lost. This repo was recovered from the published v1.0.1 package on the Chrome Web Store.
