/* Cat-boy avatar rig: live config from the control panel, mic + TTS lip-sync. */
(() => {
  const params = new URLSearchParams(location.search);
  const target = params.get('target') || params.get('channel') || params.get('v') || '';
  const demo = params.get('demo') === '1';

  const root = document.documentElement;
  const charEl = document.getElementById('char');
  const rig = document.getElementById('rig');
  const mouthOpen = document.getElementById('mouth-open');
  const mouthClosed = document.getElementById('mouth-closed');
  const eyes = ['eye-l', 'eye-r'].map((id) => document.getElementById(id));

  let useMic = params.get('mic') !== '0';
  let ttsEnabled = true;
  let micGain = 1.6;
  let micES = null;

  let ttsUntil = 0;
  let micTarget = 0;
  let micLevel = 0;
  let speaking = false;

  /* --------------------------------------------------------------- colors */

  const hexOk = (v) => /^#[0-9a-f]{6}$/i.test(v || '');

  function mix(hex, toward, t) {
    const n = parseInt(hex.slice(1), 16);
    const r = (n >> 16) & 255;
    const g = (n >> 8) & 255;
    const b = n & 255;
    const mr = Math.round(r + (toward[0] - r) * t);
    const mg = Math.round(g + (toward[1] - g) * t);
    const mb = Math.round(b + (toward[2] - b) * t);
    return '#' + ((1 << 24) + (mr << 16) + (mg << 8) + mb).toString(16).slice(1);
  }

  function applyColors(c = {}) {
    if (hexOk(c.hair)) {
      root.style.setProperty('--hair', c.hair);
      root.style.setProperty('--hair-light', mix(c.hair, [255, 255, 255], 0.3));
      root.style.setProperty('--hair-dark', mix(c.hair, [0, 0, 0], 0.45));
    }
    if (hexOk(c.hoodie)) {
      root.style.setProperty('--hoodie', c.hoodie);
      root.style.setProperty('--hoodie-dark', mix(c.hoodie, [0, 0, 0], 0.4));
      root.style.setProperty('--hoodie-light', mix(c.hoodie, [255, 255, 255], 0.4));
    }
    if (hexOk(c.skin)) root.style.setProperty('--skin', c.skin);
    if (hexOk(c.ears)) root.style.setProperty('--ear-inner', c.ears);
    if (hexOk(c.eye)) {
      root.style.setProperty('--eye', c.eye);
      root.style.setProperty('--eye-dark', mix(c.eye, [0, 0, 0], 0.42));
    }
  }

  /* -------------------------------------------------------------- config */

  function applyConfig(cfg) {
    if (!cfg) return;
    if (Number.isFinite(+cfg.x)) root.style.setProperty('--x', String(cfg.x));
    if (Number.isFinite(+cfg.y)) root.style.setProperty('--y', String(cfg.y));
    if (Number.isFinite(+cfg.size)) root.style.setProperty('--size', String(cfg.size));
    charEl.classList.toggle('flip', !!cfg.flip);
    if (cfg.colors) applyColors(cfg.colors);
    if (Number.isFinite(+cfg.gain)) micGain = +cfg.gain;

    ttsEnabled = cfg.tts !== false;
    useMic = cfg.mic !== false && params.get('mic') !== '0';

    if (useMic) startMic();
    else stopMic();
  }

  /* ---------------------------------------------------------------- mouth */

  function speakFor(ms) {
    if (!ttsEnabled) return;
    ttsUntil = performance.now() + Math.max(500, Math.min(20000, ms || 2500));
  }

  function setSpeaking(on) {
    if (speaking === on) return;
    speaking = on;
    rig.classList.toggle('speaking', on);
  }

  let rafId = null;
  function frame(t) {
    micLevel += (micTarget - micLevel) * 0.35;

    let open = 0;
    if (t < ttsUntil) open = 0.45 + Math.abs(Math.sin(t / 78)) * 0.55;

    if (useMic) {
      const m = Math.min(1, Math.max(0, (micLevel - 0.004) * 9 * micGain));
      if (m > 0.07) open = Math.max(open, 0.22 + m * 0.78);
    }

    if (open > 0.07) {
      mouthOpen.style.opacity = '1';
      mouthOpen.style.transform = `scaleY(${Math.min(1, open).toFixed(2)})`;
      mouthClosed.style.opacity = '0';
      setSpeaking(true);
    } else {
      mouthOpen.style.opacity = '0';
      mouthClosed.style.opacity = '1';
      setSpeaking(false);
    }

    rafId = requestAnimationFrame(frame);
  }
  function startAnim() {
    if (rafId == null) rafId = requestAnimationFrame(frame);
  }
  startAnim();
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (rafId != null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
    } else {
      startAnim();
    }
  });

  function happy() {
    rig.classList.remove('happy');
    void rig.getBoundingClientRect();
    rig.classList.add('happy');
    setTimeout(() => rig.classList.remove('happy'), 1500);
    speakFor(900);
  }

  function blinkOnce() {
    for (const e of eyes) e.classList.add('blink');
    setTimeout(() => eyes.forEach((e) => e.classList.remove('blink')), 200);
  }

  /* ------------------------------------------------------------------ mic */

  function startMic() {
    if (micES) return;
    micES = new EventSource('/mic');
    micES.addEventListener('level', (ev) => {
      try {
        micTarget = Number(JSON.parse(ev.data).level) || 0;
      } catch {
        /* ignore */
      }
    });
  }

  function stopMic() {
    if (micES) micES.close();
    micES = null;
    micTarget = 0;
  }

  /* --------------------------------------------------------------- idle fx */

  function scheduleBlink() {
    setTimeout(() => {
      blinkOnce();
      scheduleBlink();
    }, 2400 + Math.random() * 3200);
  }
  setTimeout(scheduleBlink, 1200);

  let earSide = 0;
  function triggerTwitch() {
    const ear = document.getElementById(earSide++ % 2 ? 'ear-r' : 'ear-l');
    ear.classList.add('twitch');
    setTimeout(() => ear.classList.remove('twitch'), 600);
  }
  function scheduleTwitch() {
    setTimeout(() => {
      triggerTwitch();
      scheduleTwitch();
    }, 5000 + Math.random() * 6000);
  }
  setTimeout(scheduleTwitch, 3500);

  /* ---------------------------------------------------------------- events */

  if (demo) {
    setTimeout(() => speakFor(2600), 900);
    setInterval(() => {
      happy();
      setTimeout(() => speakFor(2400), 1700);
    }, 9000);
  }

  // Live config + actions from the model control panel.
  const cfgES = new EventSource('/avatar/events');
  cfgES.addEventListener('config', (ev) => {
    try {
      applyConfig(JSON.parse(ev.data));
    } catch {
      /* ignore */
    }
  });
  cfgES.addEventListener('action', (ev) => {
    try {
      const { action } = JSON.parse(ev.data);
      if (action === 'happy') happy();
      else if (action === 'blink') blinkOnce();
      else if (action === 'talk') speakFor(2000);
    } catch {
      /* ignore */
    }
  });

  fetch('/api/avatar/config')
    .then((r) => r.json())
    .then(applyConfig)
    .catch(() => {});

  if (!demo && target) {
    const es = new EventSource('/events?' + new URLSearchParams({ target, tts: '1' }).toString());
    es.addEventListener('tts', (ev) => {
      try {
        const d = JSON.parse(ev.data);
        speakFor(d.duration || 2500);
      } catch {
        /* ignore */
      }
    });
    es.addEventListener('chat', (ev) => {
      try {
        const m = JSON.parse(ev.data);
        if (m.kind === 'paid' || m.kind === 'member') happy();
        else if (Math.random() < 0.12) triggerTwitch();
      } catch {
        /* ignore */
      }
    });
    es.addEventListener('state', (ev) => {
      try {
        const s = JSON.parse(ev.data);
        charEl.dataset.state = s.state || '';
      } catch {
        /* ignore */
      }
    });
  }
})();
