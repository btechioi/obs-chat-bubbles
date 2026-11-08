/* Live model control panel. */
(() => {
  const DEFAULTS = {
    x: 0.99, y: 0.99, size: 0.94, flip: false,
    tts: true, mic: true, gain: 1.6, micDevice: '',
    colors: { hair: '#2b3049', hoodie: '#2f3d5c', eye: '#ffb347', skin: '#ffe6d5', ears: '#f7a8b8' },
  };

  const params = new URLSearchParams(location.search);
  const target = params.get('target') || '';

  const $ = (id) => document.getElementById(id);
  let cfg = JSON.parse(JSON.stringify(DEFAULTS));
  let saveTimer = null;

  const bind = (id, fn) => {
    const el = $(id);
    el.addEventListener('input', () => { fn(el); queueSave(); });
  };

  function setLabels() {
    $('x-val').textContent = Math.round(cfg.x * 100);
    $('y-val').textContent = Math.round(cfg.y * 100);
    $('size-val').textContent = Math.round(cfg.size * 100);
    $('gain-val').textContent = Number(cfg.gain).toFixed(1);
  }

  function fill(c) {
    cfg = JSON.parse(JSON.stringify(c));
    $('x').value = Math.round(cfg.x * 100);
    $('y').value = Math.round(cfg.y * 100);
    $('size').value = Math.round(cfg.size * 100);
    $('gain').value = cfg.gain;
    $('flip').checked = !!cfg.flip;
    $('tts').checked = cfg.tts !== false;
    $('mic').checked = cfg.mic !== false;
    $('c-hair').value = cfg.colors.hair;
    $('c-hoodie').value = cfg.colors.hoodie;
    $('c-eye').value = cfg.colors.eye;
    $('c-skin').value = cfg.colors.skin;
    $('c-ears').value = cfg.colors.ears;
    setLabels();
  }

  function pending() {
    const p = { ...cfg, colors: { ...cfg.colors } };
    return p;
  }

  function queueSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, 180);
  }

  async function save() {
    try {
      const res = await fetch('/api/avatar/config', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(pending()),
      });
      if (res.ok) {
        const c = await res.json();
        cfg = c;
        setLabels();
        status('live — applied to OBS', true);
      } else status('save failed', false);
    } catch {
      status('service unreachable', false);
    }
  }

  let statusTimer = null;
  function status(text, ok) {
    $('status-label').textContent = text;
    $('dot').className = 'dot' + (ok ? ' live' : ' off');
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => {
      $('dot').className = 'dot' + (ok ? ' live' : ' off');
    }, 2000);
  }

  /* --------------------------------------------------------------- inputs */

  bind('x', (el) => { cfg.x = el.value / 100; });
  bind('y', (el) => { cfg.y = el.value / 100; });
  bind('size', (el) => { cfg.size = el.value / 100; });
  bind('gain', (el) => { cfg.gain = Number(el.value); });
  bind('c-hair', (el) => { cfg.colors.hair = el.value; });
  bind('c-hoodie', (el) => { cfg.colors.hoodie = el.value; });
  bind('c-eye', (el) => { cfg.colors.eye = el.value; });
  bind('c-skin', (el) => { cfg.colors.skin = el.value; });
  bind('c-ears', (el) => { cfg.colors.ears = el.value; });

  $('flip').addEventListener('change', (e) => { cfg.flip = e.target.checked; queueSave(); });
  $('tts').addEventListener('change', (e) => { cfg.tts = e.target.checked; queueSave(); });
  $('mic').addEventListener('change', (e) => { cfg.mic = e.target.checked; queueSave(); });

  $('device').addEventListener('change', (e) => {
    cfg.micDevice = e.target.value;
    queueSave();
    status('switching microphone…', true);
  });

  for (const btn of ['test-happy', 'test-blink', 'test-talk']) {
    $(btn).addEventListener('click', () => {
      const action = btn.replace('test-', '');
      fetch('/api/avatar/action', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action }),
      }).catch(() => {});
    });
  }

  $('reset').addEventListener('click', () => {
    fill(DEFAULTS);
    save();
  });

  function avatarUrl() {
    const p = new URLSearchParams();
    if (target) p.set('target', target);
    const q = p.toString();
    return location.origin + '/avatar' + (q ? '?' + q : '');
  }

  $('copy-avatar').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(avatarUrl());
      const b = $('copy-avatar');
      const t = b.textContent;
      b.textContent = 'Copied ✓';
      setTimeout(() => (b.textContent = t), 1400);
    } catch {
      /* ignore */
    }
  });

  $('open-avatar').href = avatarUrl();
  $('avatar-url').textContent = avatarUrl();
  $('frame').src = avatarUrl();

  /* --------------------------------------------------------------- devices */

  async function loadDevices() {
    try {
      const res = await fetch('/api/mic/devices', { cache: 'no-store' });
      const data = await res.json();
      const sel = $('device');
      sel.innerHTML = '';
      const auto = document.createElement('option');
      auto.value = '';
      auto.textContent = 'Auto (first real input)';
      sel.appendChild(auto);
      for (const d of data.devices || []) {
        const o = document.createElement('option');
        o.value = d.name;
        o.textContent = (d.monitor ? '🔊 ' : '🎙 ') + d.label;
        sel.appendChild(o);
      }
      sel.value = cfg.micDevice || '';
    } catch {
      /* ignore */
    }
  }

  /* ----------------------------------------------------------------- meter */

  const meterES = new EventSource('/mic');
  meterES.addEventListener('level', (ev) => {
    try {
      const { level } = JSON.parse(ev.data);
      const pct = Math.min(100, Math.max(0, level * 420));
      $('meter').style.width = pct.toFixed(0) + '%';
    } catch {
      /* ignore */
    }
  });

  /* ------------------------------------------------------------------ boot */

  fetch('/api/avatar/config', { cache: 'no-store' })
    .then((r) => r.json())
    .then((c) => { fill(c); loadDevices(); status('ready — edits apply live', true); })
    .catch(() => status('service unreachable', false));
})();
