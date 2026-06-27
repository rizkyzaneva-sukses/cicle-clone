/**
 * Dark Mode Toggle for Maulana Corp
 * Stores preference in localStorage and syncs across tabs
 */
(function() {
  'use strict';

  const STORAGE_KEY = 'theme';

  function getPreferredTheme() {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) return saved;
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  function applyTheme(theme) {
    if (theme === 'dark') {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
    localStorage.setItem(STORAGE_KEY, theme);
    updateIcon();
  }

  function updateIcon() {
    const icon = document.getElementById('theme-icon');
    if (!icon) return;
    const isDark = document.documentElement.classList.contains('dark');
    icon.className = isDark ? 'fas fa-sun text-lg' : 'fas fa-moon text-lg';
  }

  // Apply on load
  applyTheme(getPreferredTheme());

  // Sync across tabs
  window.addEventListener('storage', (e) => {
    if (e.key === STORAGE_KEY) applyTheme(e.newValue);
  });

  // Expose toggle function
  window.toggleTheme = function() {
    const isDark = document.documentElement.classList.contains('dark');
    applyTheme(isDark ? 'light' : 'dark');
  };

  // Update icon on DOMContentLoaded
  document.addEventListener('DOMContentLoaded', updateIcon);
})();
