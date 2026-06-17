// Shared @mention autocomplete, used by task comments and project chat.
function setupMentionAutocomplete(inputId, buildSearchUrl) {
  const input = document.getElementById(inputId);
  if (!input) return;
  input.addEventListener('input', async () => {
    const val = input.value;
    const atPos = val.lastIndexOf('@');
    if (atPos === -1) { removeMentionDropdown(); return; }
    const query = val.slice(atPos + 1);
    if (query.length < 1) { removeMentionDropdown(); return; }

    // Check if query starts with "team" - show @team option
    if ('team'.startsWith(query.toLowerCase())) {
      try {
        const res = await fetch(buildSearchUrl(query));
        const members = await res.json();
        // Prepend @team option
        showMentionDropdown([{ id: '__team__', name: 'Tim (Semua Anggota)' }, ...members], input, atPos);
      } catch (e) {
        // Show just @team option on error
        showMentionDropdown([{ id: '__team__', name: 'Tim (Semua Anggota)' }], input, atPos);
      }
      return;
    }

    try {
      const res = await fetch(buildSearchUrl(query));
      const members = await res.json();
      showMentionDropdown(members, input, atPos);
    } catch (e) {
      removeMentionDropdown();
    }
  });
}

function showMentionDropdown(members, input, atPos) {
  removeMentionDropdown();
  if (!members.length) return;
  const escape = typeof escapeHtml === 'function' ? escapeHtml : (v => String(v || ''));
  const dd = document.createElement('div');
  dd.id = 'mention-dropdown';
  dd.className = 'absolute z-50 bg-white border rounded-xl shadow-lg max-h-40 overflow-y-auto';
  dd.style.cssText = 'bottom:100%;left:0;margin-bottom:4px;width:220px;';
  members.forEach(m => {
    const isTeam = m.id === '__team__';
    const opt = document.createElement('button');
    opt.type = 'button';
    opt.className = 'w-full text-left px-3 py-2 hover:bg-blue-50 text-sm flex items-center gap-2';
    if (isTeam) {
      opt.innerHTML = `<span class="w-5 h-5 bg-emerald-600 rounded-full flex items-center justify-center text-white text-[10px] font-bold">T</span><span class="font-semibold text-emerald-700">${escape(m.name)}</span>`;
    } else {
      opt.innerHTML = `<span class="w-5 h-5 bg-blue-600 rounded-full flex items-center justify-center text-white text-[10px] font-bold">${m.name.charAt(0)}</span>${escape(m.name)}`;
    }
    opt.onclick = () => {
      const val = input.value;
      if (isTeam) {
        input.value = val.slice(0, atPos) + '@team ';
      } else {
        input.value = val.slice(0, atPos) + '@' + m.name + ' ';
      }
      removeMentionDropdown();
      input.focus();
    };
    dd.appendChild(opt);
  });
  input.parentElement.style.position = 'relative';
  input.parentElement.appendChild(dd);
}

function removeMentionDropdown() {
  document.getElementById('mention-dropdown')?.remove();
}
