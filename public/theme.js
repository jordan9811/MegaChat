/** In-page theme state — no localStorage. */
(function () {
  'use strict';
  let theme = 'dark';

  function applyTheme(next) {
    theme = next === 'light' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', theme);
    document.querySelectorAll('[data-theme-label]').forEach((el) => {
      el.textContent = theme === 'dark' ? 'Light' : 'Dark';
    });
  }

  window.getAppTheme = function () { return theme; };
  window.toggleAppTheme = function () {
    applyTheme(theme === 'dark' ? 'light' : 'dark');
  };

  document.addEventListener('DOMContentLoaded', () => {
    const btn = document.getElementById('themeToggle');
    if (btn) btn.addEventListener('click', window.toggleAppTheme);
    applyTheme('dark');
  });
})();
