// Runs in <head> before the first paint, so the popup opens in the saved theme
const THEMES = ['claude', 'vscode', 'darcula', 'spotify', 'netflix', 'discord', 'instagram', 'duolingo'];
const systemDark = window.matchMedia('(prefers-color-scheme: dark)');
let themeChoice = 'auto';

// "auto" follows the system: Claude when light, VS Code when dark
function applyTheme(choice) {
  themeChoice = THEMES.includes(choice) ? choice : 'auto';
  document.documentElement.dataset.theme = themeChoice === 'auto'
    ? (systemDark.matches ? 'vscode' : 'claude')
    : themeChoice;
}

systemDark.addEventListener('change', () => {
  if (themeChoice === 'auto') applyTheme('auto');
});

try {
  applyTheme(localStorage.getItem('theme'));
} catch {
  applyTheme('auto');
}
