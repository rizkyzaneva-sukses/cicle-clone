// Shared @mention autocomplete, used by task comments and project chat.
(function() {
  let activeMention = null;
  let requestSeq = 0;

  function getMentionQuery(input) {
    const cursor = input.selectionStart ?? input.value.length;
    const beforeCursor = input.value.slice(0, cursor);
    const atPos = beforeCursor.lastIndexOf('@');

    if (atPos === -1) return null;
    if (atPos > 0 && !/\s/.test(beforeCursor.charAt(atPos - 1))) return null;

    const query = beforeCursor.slice(atPos + 1);
    if (/\s/.test(query)) return null;

    return { atPos, query, cursor };
  }

  function normalizeMembers(members, query) {
    const seen = new Set();
    const normalized = [];
    const lowerQuery = String(query || '').toLowerCase();
    const shouldShowTeam = !lowerQuery || 'team'.startsWith(lowerQuery);

    if (shouldShowTeam) {
      normalized.push({ id: '__team__', name: 'team', email: 'Semua anggota tim' });
      seen.add('__team__');
    }

    for (const member of members || []) {
      if (!member || seen.has(member.id)) continue;
      if (member.id === '__team__' && !shouldShowTeam) continue;
      normalized.push(member);
      seen.add(member.id);
    }

    return normalized;
  }

  function setupMentionAutocomplete(inputId, buildSearchUrl) {
    const input = document.getElementById(inputId);
    if (!input || input.dataset.mentionReady === 'true') return;
    input.dataset.mentionReady = 'true';

    input.addEventListener('input', () => refreshMentionDropdown(input, buildSearchUrl));
    input.addEventListener('click', () => refreshMentionDropdown(input, buildSearchUrl));
    input.addEventListener('blur', () => {
      setTimeout(() => {
        if (activeMention?.input === input) removeMentionDropdown();
      }, 120);
    });
    input.addEventListener('keydown', (event) => handleMentionKeydown(event, input));
  }

  async function refreshMentionDropdown(input, buildSearchUrl) {
    const mention = getMentionQuery(input);
    if (!mention) {
      if (activeMention?.input === input) removeMentionDropdown();
      return;
    }

    const seq = ++requestSeq;
    const query = mention.query;

    try {
      const res = await fetch(buildSearchUrl(query));
      const members = await res.json();
      if (seq !== requestSeq) return;
      showMentionDropdown(normalizeMembers(members, query), input, mention.atPos, mention.cursor);
    } catch (e) {
      if (seq !== requestSeq) return;
      showMentionDropdown(normalizeMembers([], query), input, mention.atPos, mention.cursor);
    }
  }

  function handleMentionKeydown(event, input) {
    if (!activeMention || activeMention.input !== input) return;

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveMentionIndex(activeMention.index + 1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveMentionIndex(activeMention.index - 1);
    } else if (event.key === 'Tab' || event.key === 'Enter') {
      event.preventDefault();
      event.stopPropagation();
      chooseActiveMention();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      removeMentionDropdown();
    }
  }

  function showMentionDropdown(members, input, atPos, cursor) {
    removeMentionDropdown();
    if (!members.length) return;

    const escape = typeof escapeHtml === 'function' ? escapeHtml : (v => String(v || ''));
    const dd = document.createElement('div');
    dd.id = 'mention-dropdown';
    dd.className = 'absolute z-50 bg-white border rounded-xl shadow-lg max-h-48 overflow-y-auto py-1';
    dd.style.cssText = `bottom:100%;left:${input.offsetLeft}px;margin-bottom:6px;width:min(280px,calc(100vw - 32px));`;

    activeMention = { input, atPos, cursor, members, dropdown: dd, index: 0 };

    members.forEach((m, index) => {
      const isTeam = m.id === '__team__';
      const opt = document.createElement('button');
      opt.type = 'button';
      opt.className = 'mention-option w-full text-left px-3 py-2 text-sm flex items-center gap-2 transition';
      opt.dataset.index = index;

      if (isTeam) {
        opt.innerHTML = `
          <span class="w-6 h-6 bg-emerald-600 rounded-full flex items-center justify-center text-white text-[10px] font-bold shrink-0">T</span>
          <span class="min-w-0">
            <span class="block font-semibold text-emerald-700">@team</span>
            <span class="block text-xs text-gray-400 truncate">${escape(m.email || m.name)}</span>
          </span>`;
      } else {
        opt.innerHTML = `
          <span class="w-6 h-6 bg-blue-600 rounded-full flex items-center justify-center text-white text-[10px] font-bold shrink-0">${escape(m.name).charAt(0).toUpperCase()}</span>
          <span class="min-w-0">
            <span class="block font-semibold text-gray-800 truncate">${escape(m.name)}</span>
            ${m.email ? `<span class="block text-xs text-gray-400 truncate">${escape(m.email)}</span>` : ''}
          </span>`;
      }

      opt.addEventListener('mouseenter', () => setActiveMentionIndex(index));
      opt.addEventListener('mousedown', (event) => {
        event.preventDefault();
        chooseMention(index);
      });
      dd.appendChild(opt);
    });

    input.parentElement.style.position = 'relative';
    input.parentElement.appendChild(dd);
    setActiveMentionIndex(0);
  }

  function setActiveMentionIndex(index) {
    if (!activeMention) return;

    const total = activeMention.members.length;
    activeMention.index = (index + total) % total;

    activeMention.dropdown.querySelectorAll('.mention-option').forEach((option, optionIndex) => {
      const active = optionIndex === activeMention.index;
      option.classList.toggle('bg-blue-50', active);
      option.classList.toggle('text-blue-700', active);
      option.classList.toggle('hover:bg-blue-50', !active);
      if (active) option.scrollIntoView({ block: 'nearest' });
    });
  }

  function chooseActiveMention() {
    if (!activeMention) return;
    chooseMention(activeMention.index);
  }

  function chooseMention(index) {
    if (!activeMention) return;

    const { input, atPos, cursor, members } = activeMention;
    const member = members[index];
    if (!member) return;

    const mentionText = member.id === '__team__' ? '@team ' : `@${member.name} `;
    input.value = input.value.slice(0, atPos) + mentionText + input.value.slice(cursor);

    const nextCursor = atPos + mentionText.length;
    removeMentionDropdown();
    input.focus();
    input.setSelectionRange(nextCursor, nextCursor);
  }

  function removeMentionDropdown() {
    document.getElementById('mention-dropdown')?.remove();
    activeMention = null;
  }

  window.setupMentionAutocomplete = setupMentionAutocomplete;
  window.removeMentionDropdown = removeMentionDropdown;
})();
