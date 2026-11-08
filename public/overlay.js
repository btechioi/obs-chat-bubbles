/* Overlay client: subscribes to SSE and renders chat bubbles. */
(() => {
  const params = new URLSearchParams(location.search);
  const target = params.get('target') || params.get('channel') || params.get('v') || '';
  const theme = (params.get('theme') || 'glass').toLowerCase();
  const pos = (params.get('pos') || 'bl').toLowerCase();
  const max = clampInt(params.get('max'), 3, 30, 8);
  const ttl = clampInt(params.get('ttl'), 0, 3600, 45);
  const showAvatars = params.get('avatars') !== '0';
  const size = clampInt(params.get('size'), 12, 48, 21);
  const width = clampInt(params.get('width'), 240, 1400, 440);
  const edge = clampInt(params.get('edge'), 8, 120, 32);
  const zoom = Number(params.get('zoom') || 1);
  const demoMode = params.get('demo') === '1';
  // Demo defaults to voice-on so checking "Demo bubbles" actually speaks.
  const ttsOn = params.get('tts') === '1' || (demoMode && params.get('tts') !== '0');
  const volume = clampFloat(params.get('vol'), 0, 1, 0.9);
  const statusMode = params.get('status') === '1';
  const baseHue = params.get('accent') || 'ff4d6d';

  const root = document.documentElement;
  root.style.setProperty('--msg-size', size + 'px');
  root.style.setProperty('--chat-width', width + 'px');
  root.style.setProperty('--edge', edge + 'px');
  root.style.setProperty('--name-size', Math.max(10, Math.round(size * 0.62)) + 'px');
  root.style.setProperty('--zoom', Number.isFinite(zoom) ? String(zoom) : '1');
  root.style.setProperty('--accent', normalizeAccent(baseHue));

  document.body.classList.add('theme-' + (['glass', 'light', 'neon'].includes(theme) ? theme : 'glass'));
  document.getElementById('stage').classList.add('pos-' + (['bl', 'br', 'tl', 'tr'].includes(pos) ? pos : 'bl'));
  const chatEl = document.getElementById('chat');
  const pill = document.getElementById('status-pill');
  const pillText = document.getElementById('status-text');

  /** @type {Map<string, HTMLElement>} */
  const byId = new Map();
  /** @type {HTMLElement[]} */
  let order = [];
  let stateLive = false;

  // Spoken donations queue (one clip at a time).
  const audioQueue = [];
  let audioPlaying = false;

  if (pill) pill.hidden = !statusMode;


  /* ------------------------------------------------------------------ demo */

  if (demoMode) {
    const names = ['@priya.codes', '@dev_arjun', '@mod_rahul', '@zoya', '@lurker42', '@BTech_IOI', '@sneha.k', '@kabir_dev'];
    const lines = [
      'the bubble animation is so clean 🔥',
      'chat overlay is live, let’s gooo 🚀',
      'is this reading the YouTube chat directly?',
      'be nice in chat ✌️',
      '👀',
      'the glass effect looks great on gameplay',
      'hi from Colombo 🇱🇰',
      'OBS + browser source — zero delay, love it',
    ];
    let i = 0;
    const tick = () => {
      const name = names[i % names.length];
      const roll = i % 6;
      const base = { id: 'demo-' + i, name, avatar: '', badges: [] };
      if (name === '@BTech_IOI') base.badges.push({ k: 'owner', label: 'OWNER' });
      if (name === '@mod_rahul') base.badges.push({ k: 'mod', label: 'MOD' });

      let msg;
      if (roll === 1) {
        msg = { ...base, kind: 'paid', amount: '₹250', parts: [{ t: 'x', v: 'keep the streams coming! 🎉' }] };
      } else if (roll === 4) {
        msg = { ...base, kind: 'member', parts: [{ t: 'x', v: 'New member — welcome to the channel!' }] };
      } else {
        msg = { ...base, kind: 'text', parts: [{ t: 'x', v: lines[i % lines.length] }] };
      }
      addMessage(msg);
      if (ttsOn && (msg.kind === 'paid' || msg.kind === 'member')) {
        const phrase =
          msg.kind === 'paid'
            ? `${name.replace(/^@/, '')} sent ${msg.amount}. ${lines[i % lines.length]}`
            : `${name.replace(/^@/, '')} just became a member.`;
        queueSpeech('/api/tts/test?text=' + encodeURIComponent(phrase));
      }
      i++;
      setTimeout(tick, 2100);
    };
    setStatus('live', true);
    hideStatus();
    tick();
    return;
  }

  if (!target) {
    setStatus('Set ?target=@yourhandle in the URL', false);
    return;
  }

  /* ------------------------------------------------------------- helpers */

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function hueOf(name) {
    let h = 0;
    for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
    return h;
  }

  function nameColor(name) {
    const h = hueOf(name);
    return theme === 'light' ? `hsl(${h} 62% 34%)` : `hsl(${h} 88% 74%)`;
  }

  function setStatus(text, live) {
    stateLive = !!live;
    if (!pill || !statusMode) return;
    pill.hidden = false;
    pillText.textContent = text;
    pill.classList.toggle('live', !!live);
  }

  function hideStatus() {
    if (pill) pill.hidden = true;
  }

  function initialOf(name) {
    return (name.replace(/^@/, '')[0] || '?').toUpperCase();
  }

  function removeNow(node) {
    if (!node || !node.isConnected) return;
    clearTimeout(node._ttl);
    node.remove();
    const id = node.dataset.id;
    if (id) byId.delete(id);
    order = order.filter((n) => n !== node);
  }

  function leave(node) {
    if (!node || !node.isConnected || node.classList.contains('leaving')) return;
    clearTimeout(node._ttl);
    node.classList.add('leaving');
    setTimeout(() => removeNow(node), 380);
  }

  function trim() {
    // Shift BEFORE leaving, otherwise this loop never terminates (leave() is async).
    while (order.length > max) {
      const oldest = order.shift();
      leave(oldest);
    }
  }

  /* ---------------------------------------------------------------- speech */

  function queueSpeech(url) {
    if (!ttsOn || !url) return;
    if (audioQueue.length > 4) audioQueue.shift();
    audioQueue.push(url);
    playNext();
  }

  function playNext() {
    if (!ttsOn || audioPlaying || !audioQueue.length) return;
    const src = audioQueue.shift();
    audioPlaying = true;
    const clip = new Audio(src);
    clip.volume = volume;
    const done = () => {
      audioPlaying = false;
      setTimeout(playNext, 220);
    };
    clip.addEventListener('ended', done);
    clip.addEventListener('error', done);
    clip
      .play()
      .then(() => fetch('/api/tts/ack?ok=1', { keepalive: true }).catch(() => {}))
      .catch((e) => {
        fetch('/api/tts/ack?ok=0&e=' + encodeURIComponent(e?.name || 'error'), { keepalive: true }).catch(() => {});
        done();
      });
  }

  /* ------------------------------------------------------------ rendering */

  function renderBubble(m) {
    const msg = el('div', 'msg ' + (m.kind || 'text'));
    msg.dataset.id = m.id;

    if (showAvatars) {
      const fallback = el('div', 'avatar fallback', initialOf(m.name || '?'));
      let avatarNode = fallback;
      if (m.avatar) {
        const img = new Image();
        img.className = 'avatar';
        img.referrerPolicy = 'no-referrer';
        img.alt = '';
        img.src = m.avatar;
        img.addEventListener('error', () => {
          if (img.isConnected) img.replaceWith(fallback);
        });
        avatarNode = img;
      }
      msg.appendChild(avatarNode);
    }

    const bubble = el('div', 'bubble');
    if (m.kind === 'paid' && m.colors && m.colors.bg) {
      bubble.style.backgroundImage =
        'linear-gradient(180deg, rgba(255,255,255,.22), rgba(255,255,255,0) 62%)';
      bubble.style.backgroundColor = m.colors.bg;
      bubble.style.borderColor = 'rgba(255,255,255,.4)';
    }

    const head = el('div', 'head');
    const name = el('span', 'name', m.name || 'viewer');
    name.style.color = m.color || nameColor(m.name || 'viewer');
    head.appendChild(name);

    for (const b of m.badges || []) {
      head.appendChild(el('span', 'badge ' + b.k, b.label));
    }
    if (m.kind === 'paid' && m.amount) {
      head.appendChild(el('span', 'amount', m.amount));
    }
    bubble.appendChild(head);

    const body = el('div', 'text');
    if (m.kind === 'paid' && m.colors && m.colors.fg) body.style.color = m.colors.fg;
    for (const part of m.parts || []) {
      if (part.t === 'e' && part.u) {
        const img = new Image();
        img.className = 'emote';
        img.src = part.u;
        img.alt = '';
        img.referrerPolicy = 'no-referrer';
        body.appendChild(img);
      } else if (part.t === 'x' && part.v) {
        body.appendChild(document.createTextNode(part.v));
      }
    }
    if (body.childNodes.length) bubble.appendChild(body);

    msg.appendChild(bubble);
    return msg;
  }

  function addMessage(m, opts = {}) {
    if (!m || !m.id) return;
    if (byId.has(m.id)) return;

    // Once real chat flows, get the status pill out of the bubbles' way.
    if (pill && !pill.hidden) hideStatus();

    const node = renderBubble(m);
    // Keep DOM order matching arrival; newest goes last (or first for top anchors
    // via CSS column-reverse).
    chatEl.appendChild(node);
    byId.set(m.id, node);
    order.push(node);

    if (m.kind === 'system') {
      setTimeout(() => leave(node), 8000);
    } else if (ttl > 0) {
      node._ttl = setTimeout(() => leave(node), ttl * 1000);
    }
    trim();
  }

  function clearAll() {
    for (const n of [...order]) removeNow(n);
    order = [];
    byId.clear();
  }

  /* ---------------------------------------------------------------- events */

  const qs = new URLSearchParams({ target });
  const es = new EventSource('/events?' + qs.toString());

  es.addEventListener('hello', (ev) => {
    const data = JSON.parse(ev.data);
    applyState(data);
    clearAll();
    const recent = (data.messages || []).slice(-max);
    recent.forEach((m, i) => setTimeout(() => addMessage(m), i * 60));
  });

  es.addEventListener('chat', (ev) => {
    addMessage(JSON.parse(ev.data));
  });

  es.addEventListener('delete', (ev) => {
    const { id } = JSON.parse(ev.data);
    const node = byId.get(id);
    if (node) {
      node.classList.add('leaving');
      setTimeout(() => removeNow(node), 380);
    }
  });

  es.addEventListener('tts', (ev) => {
    const { url } = JSON.parse(ev.data);
    if (url) queueSpeech(url);
  });

  es.addEventListener('state', (ev) => applyState(JSON.parse(ev.data)));

  es.onerror = () => setStatus('reconnecting to chat…', false);
  es.onopen = () => setStatus('connected', true);

  function applyState(s) {
    if (!s) return;
    if (s.state === 'live') {
      setStatus(s.title ? 'live · ' + s.title : 'live', true);
      if (!s.title) return;
      // Settle to just "live", then get out of the way.
      setTimeout(() => setStatus('live', true), 4000);
      setTimeout(() => hideStatus(), 8000);
    } else if (s.state === 'offline') {
      setStatus('waiting for ' + target + ' to go live', false);
    } else if (s.state === 'error') {
      setStatus('chat error — retrying…', false);
    } else {
      setStatus('connecting to chat…', false);
    }
  }

  function clampFloat(v, min, maxV, dflt) {
    const n = parseFloat(v);
    if (!Number.isFinite(n)) return dflt;
    return Math.min(maxV, Math.max(min, n));
  }

  function clampInt(v, min, maxV, dflt) {
    const n = parseInt(v, 10);
    if (!Number.isFinite(n)) return dflt;
    return Math.min(maxV, Math.max(min, n));
  }

  function normalizeAccent(v) {
    if (/^[0-9a-f]{6}$/i.test(v)) return '#' + v;
    if (/^#[0-9a-f]{6}$/i.test(v)) return v;
    return '#ff4d6d';
  }
})();
