// Runs in <head> before the first paint, so the popup opens in the saved theme
const THEMES = ['light', 'dark', 'vscode', 'darcula', 'claude', 'spotify', 'netflix', 'discord', 'instagram', 'duolingo'];

function applyTheme(theme) {
  if (THEMES.includes(theme)) {
    document.documentElement.dataset.theme = theme;
  } else {
    delete document.documentElement.dataset.theme; // "auto": follow the system
  }
}

try {
  applyTheme(localStorage.getItem('theme'));
} catch {
  // Storage unavailable: keep the system theme
}
