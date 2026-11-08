/* Control panel logic. */
(() => {
  const DEFAULTS = {
    target: '@BTech_IOI',
    theme: 'glass',
    pos: 'bl',
    accent: '#ff4d6d',
    max: 8,
    width: 440,
    size: 16,
    ttl: 45,
    avatars: true,
    statusPill: false,
    demo: false,
    tts: true,
    vol: 90,
    avatarScale: 100,
    avatarMic: true,
  };

  const KEY = 'ytcb.settings.v1';
  let state = { ...DEFAULTS, ...read() };
  let refreshTimer = null;

  // OBS custom browser docks run in a narrow CEF panel; enable a compact layout.
  const params = new URLSearchParams(location.search);
  const dockMode = params.get('dock') === '1' || !!window.obsstudio;
  if (dockMode) document.body.classList.add('dock');

  const $ = (id) => document.getElementById(id);

  function read() {
    try {
      return JSON.parse(localStorage.getItem(KEY) || '{}');
    } catch {
      return {};
    }
  }

  function save() {
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
    } catch {
      /* ignore */
    }
  }

  /* ------------------------------------------------------------- binding */

  function bindText(id, key) {
    const input = $(id);
    input.value = state[key];
    input.addEventListener('input', () => {
      state[key] = input.value.trim();
      onChange();
    });
  }

  function bindRange(id, key, labelId) {
    const input = $(id);
    const label = $(labelId);
    input.value = state[key];
    label.textContent = String(state[key]);
    input.addEventListener('input', () => {
      state[key] = Number(input.value);
      label.textContent = input.value;
      onChange();
    });
  }

  function bindSeg(id, key) {
    const group = $(id);
    const sync = () => {
      for (const b of group.querySelectorAll('button')) {
        b.classList.toggle('on', b.dataset.value === state[key]);
      }
    };
    group.addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      state[key] = btn.dataset.value;
      sync();
      onChange();
    });
    sync();
  }

  function bindCheck(id, key) {
    const input = $(id);
    input.checked = !!state[key];
    input.addEventListener('change', () => {
      state[key] = input.checked;
      onChange();
    });
  }

  bindText('target', 'target');
  bindSeg('theme', 'theme');
  bindSeg('pos', 'pos');
  bindRange('max', 'max', 'max-val');
  bindRange('width', 'width', 'width-val');
  bindRange('size', 'size', 'size-val');
  bindRange('ttl', 'ttl', 'ttl-val');
  bindCheck('avatars', 'avatars');
  bindCheck('status-pill', 'statusPill');
  bindCheck('demo', 'demo');
  bindCheck('tts', 'tts');
  bindRange('vol', 'vol', 'vol-val');
  bindRange('av-scale', 'avatarScale', 'av-scale-val');
  bindCheck('av-mic', 'avatarMic');

  const accent = $('accent');
  accent.value = state.accent;
  accent.addEventListener('input', () => {
    state.accent = accent.value;
    onChange();
  });

  /* ---------------------------------------------------------------- URLs */

  function overlayUrl({ preview = false } = {}) {
    const p = new URLSearchParams();
    if (state.target) p.set('target', state.target);
    p.set('theme', state.theme);
    p.set('pos', state.pos);
    p.set('accent', state.accent.replace('#', ''));
    p.set('max', state.max);
    p.set('width', state.width);
    p.set('size', state.size);
    p.set('ttl', state.ttl);
    if (!state.avatars) p.set('avatars', '0');
    if (state.demo) p.set('demo', '1');
    if (state.statusPill || preview) p.set('status', '1');
    if (state.tts && (!preview || state.demo)) {
      p.set('tts', '1');
      p.set('vol', (state.vol / 100).toFixed(2));
    }
    return `${location.origin}/overlay?${p.toString()}`;
  }

  function onChange() {
    save();
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      updatePreview();
      updateUrlBox();
    }, 320);
    pollStatus();
  }

  function updatePreview() {
    const frame = $('frame');
    const empty = $('empty');
    const note = $('preview-note');

    if (!state.target && !state.demo) {
      frame.removeAttribute('src');
      empty.hidden = false;
      note.textContent = '';
      return;
    }
    empty.hidden = true;
    note.textContent = state.demo ? 'demo bubbles' : 'live feed';
    const url = overlayUrl({ preview: true });
    if (frame.src !== url) frame.src = url;
  }

  function avatarUrl() {
    const p = new URLSearchParams();
    if (state.target) p.set('target', state.target);
    p.set('pos', 'br');
    p.set('scale', (state.avatarScale / 100).toFixed(2));
    if (!state.avatarMic) p.set('mic', '0');
    return `${location.origin}/avatar?${p.toString()}`;
  }

  function updateUrlBox() {
    $('obs-url').textContent = overlayUrl();
    $('open').href = overlayUrl({ preview: true });
    const avatar = $('avatar-link');
    if (avatar) avatar.href = state.target ? avatarUrl() : avatarUrl() + '&demo=1';
    const model = $('model-link');
    if (model) model.href = '/model' + (state.target ? '?target=' + encodeURIComponent(state.target) : '');
  }

  /* -------------------------------------------------------------- status */

  let pollBusy = false;

  async function pollStatus() {
    if (pollBusy) return;
    pollBusy = true;
    try {
      const q = state.target ? `?target=${encodeURIComponent(state.target)}` : '';
      const res = await fetch('/api/status' + q, { cache: 'no-store' });
      const data = await res.json();
      const t = data.target;
      const dot = $('dot');
      const label = $('status-label');

      if (!state.target) {
        dot.className = 'dot';
        label.textContent = 'set a channel';
      } else if (t && t.state === 'live') {
        dot.className = 'dot live';
        label.textContent = t.title ? `live — ${t.title}` : 'live';
      } else if (t && t.state === 'offline') {
        dot.className = 'dot off';
        label.textContent = 'channel is offline — waiting';
      } else if (t && t.state === 'error') {
        dot.className = 'dot off';
        label.textContent = 'error — retrying';
      } else {
        dot.className = 'dot';
        label.textContent = 'connecting…';
      }

      if (data.tts) {
        const el = $('tts-engine');
        if (el) {
          el.textContent = data.tts.ok
            ? `voice: ${data.tts.engine} · ${data.tts.voice}`
            : 'voice unavailable — install piper or espeak-ng';
        }
      }
    } catch {
      $('dot').className = 'dot off';
      $('status-label').textContent = 'chat service unreachable';
    } finally {
      pollBusy = false;
    }
  }

  /* --------------------------------------------------------------- misc */

  $('copy').addEventListener('click', async () => {
    const url = overlayUrl();
    try {
      await navigator.clipboard.writeText(url);
      flash($('copy'), 'Copied ✓');
    } catch {
      $('obs-url').textContent = url;
      flash($('copy'), 'Copy failed — select the URL below');
    }
  });

  $('copy-avatar').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(avatarUrl());
      flash($('copy-avatar'), 'Copied ✓');
    } catch {
      flash($('copy-avatar'), 'Copy failed');
    }
  });

  $('copy-model').addEventListener('click', async () => {
    const url = '/model' + (state.target ? '?target=' + encodeURIComponent(state.target) : '');
    const full = location.origin + url;
    try {
      await navigator.clipboard.writeText(full);
      flash($('copy-model'), 'Copied ✓');
    } catch {
      flash($('copy-model'), 'Copy failed');
    }
  });

  $('test-donation').addEventListener('click', async () => {
    if (!state.target) return flash($('test-donation'), 'Set a channel first');
    try {
      const q = new URLSearchParams({ target: state.target, text: 'Testing the cat boy avatar!' });
      await fetch('/api/test/donation?' + q.toString(), { cache: 'no-store' });
      flash($('test-donation'), 'Sent ✓');
    } catch {
      flash($('test-donation'), 'Failed');
    }
  });

  $('test-tts').addEventListener('click', () => {
    const text = 'Priya sent 250 rupees. The bubble animation is so clean, keep it up!';
    const clip = new Audio('/api/tts/test?text=' + encodeURIComponent(text));
    clip.volume = state.vol / 100;
    clip.play().catch(() => flash($('test-tts'), 'Audio blocked — click again'));
  });

  function flash(btn, text) {
    const old = btn.textContent;
    btn.textContent = text;
    setTimeout(() => (btn.textContent = old), 1500);
  }

  updatePreview();
  updateUrlBox();
  pollStatus();
  let pollInterval = setInterval(pollStatus, 8000);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
    } else if (!pollInterval) {
      pollStatus();
      pollInterval = setInterval(pollStatus, 8000);
    }
  });
})();
