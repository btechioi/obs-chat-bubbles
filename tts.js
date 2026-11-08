/**
 * Offline TTS for donations / superchats / memberships.
 *
 * Prefers Piper (neural, offline) if a binary + voice are present under
 * <app>/piper, otherwise falls back to espeak-ng, then gives up quietly.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';

const CURRENCY_WORDS = {
  '₹': 'rupees',
  $: 'dollars',
  '€': 'euros',
  '£': 'pounds',
  '¥': 'yen',
  '₩': 'won',
  '₽': 'rubles',
  '₺': 'lira',
  'R$': 'reais',
};

const MAX_CHARS = 280;

function which(bin) {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, bin);
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

export function wavDurationMs(buf) {
  if (!buf || buf.length < 44) return 0;
  let pos = 12;
  let byteRate = 0;
  let dataSize = 0;
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    if (id === 'fmt ') byteRate = buf.readUInt32LE(pos + 16);
    else if (id === 'data') {
      dataSize = size;
      break;
    }
    pos += 8 + size + (size % 2);
  }
  return byteRate ? Math.round((dataSize / byteRate) * 1000) : 0;
}

export function cleanForSpeech(input) {
  let s = String(input || '');

  // Currency symbols read badly; turn "₹250.00" into "250.00 rupees".
  s = s.replace(/([₹$€£¥₩₽₺])\s?([\d.,]+)/g, (_m, sym, num) => {
    const clean = num.replace(/,/g, '').replace(/\.00$/, '');
    return `${clean} ${CURRENCY_WORDS[sym] || ''}`.trim();
  });

  s = s
    .replace(/https?:\/\/\S+/gi, ' link ')
    .replace(/www\.\S+/gi, ' link ')
    .replace(/[`*_~|<>@#]/g, ' ')
    .replace(/[\u{1F000}-\u{1FAFF}\u{1F1E6}-\u{1F1FF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}\u{2B00}-\u{2BFF}]/gu, ' ')
    .replace(/[\u{2190}-\u{21FF}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (s.length > MAX_CHARS) {
    s = s.slice(0, MAX_CHARS);
    const cut = s.lastIndexOf(' ');
    if (cut > 120) s = s.slice(0, cut);
    s = s.trim() + '…';
  }
  return s;
}

export function nameForSpeech(name) {
  return String(name || 'someone')
    .replace(/^@+/, '')
    .replace(/[_.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function createTts(appDir, log = console.log) {
  const cacheDir =
    process.env.TTS_CACHE_DIR ||
    path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'obs-chat-bubbles', 'tts');
  fs.mkdirSync(cacheDir, { recursive: true });

  const piperDir = process.env.TTS_PIPER_DIR || path.join(appDir, 'piper');
  const piperBin = process.env.TTS_PIPER_BIN || path.join(piperDir, 'piper');

  let piperModel = process.env.TTS_PIPER_MODEL || '';
  if (!piperModel) {
    const voicesDir = path.join(piperDir, 'voices');
    try {
      const onnx = fs.readdirSync(voicesDir).filter((f) => f.endsWith('.onnx')).sort()[0];
      if (onnx) piperModel = path.join(voicesDir, onnx);
    } catch {
      /* no voices */
    }
  }

  const espeakBin = which('espeak-ng');
  const piperOk = fs.existsSync(piperBin) && piperModel && fs.existsSync(piperModel);

  const engine = piperOk ? 'piper' : espeakBin ? 'espeak' : null;
  const voiceLabel = piperOk ? path.basename(piperModel, '.onnx') : espeakBin ? 'espeak-ng' : 'none';

  log(
    engine
      ? `[tts] engine: ${engine} (${voiceLabel}), cache: ${cacheDir}`
      : '[tts] no TTS engine found (install piper or espeak-ng) — donations will be silent'
  );

  // Serialize synthesis: one voice process at a time keeps CPU flat.
  let chain = Promise.resolve();

  function run(cmd, args, text, outFile, env) {
    return new Promise((resolve, reject) => {
      const child = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ['pipe', 'ignore', 'pipe'] });
      let stderr = '';
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error('tts timeout'));
      }, 20_000);

      child.stderr.on('data', (d) => {
        stderr += d.toString();
      });
      child.on('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0 && fs.existsSync(outFile) && fs.statSync(outFile).size > 44) resolve();
        else reject(new Error(`tts exited ${code}: ${stderr.slice(0, 200)}`));
      });
      child.stdin.end(text);
    });
  }

  async function generate(text, outFile) {
    if (engine === 'piper') {
      const env = fs.existsSync(path.join(piperDir, 'lib'))
        ? { LD_LIBRARY_PATH: [path.join(piperDir, 'lib'), process.env.LD_LIBRARY_PATH].filter(Boolean).join(':') }
        : {};
      await run(piperBin, ['--model', piperModel, '--output_file', outFile], text, outFile, env);
      return;
    }
    if (engine === 'espeak') {
      await run(espeakBin, ['-v', 'en-us', '-s', '160', '-p', '45', '-w', outFile, '--stdin'], text, outFile, {});
    }
  }

  function synthesize(rawText) {
    const text = cleanForSpeech(rawText);
    if (!text || !engine) return Promise.resolve(null);

    const hash = crypto.createHash('sha1').update(`${engine}:${voiceLabel}:${text}`).digest('hex');
    const file = path.join(cacheDir, `${hash}.wav`);
    const url = `/tts/${hash}.wav`;

    if (fs.existsSync(file)) {
      let durationMs = 0;
      try {
        durationMs = wavDurationMs(fs.readFileSync(file));
      } catch {
        /* ignore */
      }
      return Promise.resolve({ file, url, text, durationMs });
    }

    const job = chain.then(async () => {
      if (fs.existsSync(file)) {
        let durationMs = 0;
        try {
          durationMs = wavDurationMs(fs.readFileSync(file));
        } catch {
          /* ignore */
        }
        return { file, url, text, durationMs };
      }
      const tmp = path.join(cacheDir, `.tmp-${hash}-${process.pid}.wav`);
      try {
        await generate(text, tmp);
        fs.renameSync(tmp, file);
        return { file, url, text, durationMs: wavDurationMs(fs.readFileSync(file)) };
      } catch (e) {
        try {
          fs.unlinkSync(tmp);
        } catch {
          /* ignore */
        }
        log('[tts] synthesis failed:', String(e?.message || e).slice(0, 200));
        return null;
      }
    });

    chain = job.catch(() => {});
    return job;
  }

  // Drop stale cached clips after a week.
  try {
    const cutoff = Date.now() - 7 * 24 * 3600 * 1000;
    for (const f of fs.readdirSync(cacheDir)) {
      const p = path.join(cacheDir, f);
      if (!f.endsWith('.wav') || f.startsWith('.tmp-')) continue;
      if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p);
    }
  } catch {
    /* ignore */
  }

  return {
    ok: !!engine,
    engine,
    voice: voiceLabel,
    cacheDir,
    synthesize,
    cleanForSpeech,
  };
}
