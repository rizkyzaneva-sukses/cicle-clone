/**
 * Keyboard Shortcuts Handler for Maulana Corp
 * K = Kanban view, C = create task, / = search, Escape = close modal, ? = help
 */
(function() {
  'use strict';

  const shortcuts = [
    { key: 'k', label: 'Buka Kanban', action: () => { const link = document.querySelector('a[href*="/projects/"]'); if (link) window.location.href = link.href; } },
    { key: 'c', label: 'Buat task baru', action: () => { if (typeof showCreateTaskModal === 'function') showCreateTaskModal(); } },
    { key: '/', label: 'Fokus pencarian', action: (e) => { e.preventDefault(); const input = document.querySelector('input[type="search"], input[name="q"]'); if (input) input.focus(); } },
    { key: 'Escape', label: 'Tutup modal/panel', action: () => { document.querySelectorAll('.fixed.inset-0:not(.hidden)').forEach(el => el.classList.add('hidden')); if (typeof closePreview === 'function') closePreview(); } },
    { key: 'd', label: 'My Day', action: () => { window.location.href = '/my-day'; } },
    { key: 't', label: 'Tugas Saya', action: () => { window.location.href = '/my-tasks'; } },
    { key: 'g', label: 'Dashboard', action: () => { window.location.href = '/'; } }
  ];

  function isInputFocused() {
    const tag = document.activeElement?.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || document.activeElement?.isContentEditable;
  }

  function createHelpOverlay() {
    if (document.getElementById('shortcuts-overlay')) return;
    const overlay = document.createElement('div');
    overlay.id = 'shortcuts-overlay';
    overlay.className = 'hidden fixed inset-0 z-[200] flex items-center justify-center';
    overlay.style.cssText = 'backdrop-filter:blur(4px); background:rgba(0,0,0,0.5);';
    overlay.onclick = (e) => { if (e.target === overlay) overlay.classList.add('hidden'); };
    overlay.innerHTML = `
      <div class="bg-white rounded-2xl shadow-2xl p-6 w-full max-w-md mx-4">
        <div class="flex items-center justify-between mb-4">
          <h3 class="text-lg font-bold text-gray-900">Keyboard Shortcuts</h3>
          <button onclick="document.getElementById('shortcuts-overlay').classList.add('hidden')" class="p-2 rounded-xl hover:bg-gray-100 text-gray-500">
            <i class="fas fa-times"></i>
          </button>
        </div>
        <div class="space-y-3">
          ${shortcuts.map(s => `
            <div class="flex items-center justify-between py-1.5">
              <span class="text-sm text-gray-600">${s.label}</span>
              <kbd class="bg-gray-100 border px-2.5 py-1 rounded-lg text-xs font-mono font-semibold text-gray-700">${s.key === '/' ? '/' : s.key.toUpperCase()}</kbd>
            </div>
          `).join('')}
        </div>
        <p class="text-xs text-gray-400 mt-4 text-center">Tekan <kbd class="bg-gray-100 px-1.5 py-0.5 rounded text-[10px] font-mono">?</kbd> untuk menampilkan bantuan ini</p>
      </div>
    `;
    document.body.appendChild(overlay);
  }

  document.addEventListener('keydown', (e) => {
    // ? key for help (only when not in input)
    if (e.key === '?' && !isInputFocused()) {
      e.preventDefault();
      createHelpOverlay();
      document.getElementById('shortcuts-overlay').classList.toggle('hidden');
      return;
    }

    // Skip if in input
    if (isInputFocused()) return;

    // Ctrl/Cmd + K for search
    if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
      e.preventDefault();
      const input = document.querySelector('input[type="search"], input[name="q"]');
      if (input) input.focus();
      return;
    }

    const shortcut = shortcuts.find(s => s.key === e.key);
    if (shortcut) {
      e.preventDefault();
      shortcut.action(e);
    }
  });
})();
