// Auto-highlight is opt-in per site: the popup asks for that site's host
// permission, and every granted origin gets the content script at page load.
const SCRIPT_ID = 'better-finder-auto';

async function syncAutoHighlight() {
  const { origins = [] } = await chrome.permissions.getAll();
  const matches = origins.filter(origin => origin !== '<all_urls>');

  const registered = await chrome.scripting.getRegisteredContentScripts({ ids: [SCRIPT_ID] });
  if (registered.length > 0) {
    await chrome.scripting.unregisterContentScripts({ ids: [SCRIPT_ID] });
  }
  if (matches.length === 0) return;

  await chrome.scripting.registerContentScripts([{
    id: SCRIPT_ID,
    matches,
    js: ['auto.js', 'content.js'],
    runAt: 'document_idle'
  }]);
}

// Events can arrive together; run one sync at a time so ids don't collide
let queue = Promise.resolve();
function scheduleSync() {
  queue = queue.then(syncAutoHighlight).catch(error => console.error('Auto-highlight sync failed:', error));
}

// Registered scripts don't survive an extension update, so re-register then too
chrome.runtime.onInstalled.addListener(scheduleSync);
chrome.runtime.onStartup.addListener(scheduleSync);
chrome.permissions.onAdded.addListener(scheduleSync);
chrome.permissions.onRemoved.addListener(scheduleSync);
