// ============================================================
// Speakzilla — Pronunciation Assessment MVP
// ============================================================

// ------------------------------------------------------------
// Sentences (3 levels, hardcoded for MVP)
// ------------------------------------------------------------
const SENTENCES = [
  "I usually wake up around seven o'clock in the morning. After that, I drink a warm cup of coffee with milk and sugar, and then I get ready to leave the house and walk to work.",
  "Could you please let me know whether you are still planning to join our team meeting tonight at seven thirty? If something important has come up and you cannot make it on time, we can easily reschedule the entire discussion for tomorrow afternoon instead.",
  "I would have attended the international technology conference in San Francisco much earlier this year if I had realized in advance that the keynote speaker was going to focus on the recent breakthroughs in artificial intelligence, the ethical challenges these developments introduce, and the long-term implications for workers and businesses across the global economy.",
];

// ------------------------------------------------------------
// State
// ------------------------------------------------------------
let currentLevel = 0;
let isRecording = false;
let recognizer = null;
let recordTimer = null;

// Waveform visualization state
let audioCtx = null;
let analyserNode = null;
let visualStream = null;
let waveformRAF = null;
let pcmProcessor = null;       // ScriptProcessor pumping PCM → Azure
let azurePushStream = null;    // Azure PushAudioInputStream

// Recorded-audio playback state
let mediaRecorder = null;
let recordedChunks = [];
let recordedAudio = null;          // HTMLAudioElement
let recordedAudioReady = false;
let recordingStartTs = 0;          // performance.now() when MediaRecorder started
let recognizerStartTs = 0;         // performance.now() when Azure recognizer started
let playbackStopTimer = null;
let activePlayBtn = null;          // currently-playing button (for visual + toggle)

// ------------------------------------------------------------
// DOM
// ------------------------------------------------------------
const sentenceEl = document.getElementById('sentence');
const statusEl = document.getElementById('status');
const btnListen = document.getElementById('btnListen');
const btnRecord = document.getElementById('btnRecord');
const resultsEl = document.getElementById('results');
const wordDisplayEl = document.getElementById('wordDisplay');
const rawJsonEl = document.getElementById('rawJson');
const btnPlayMine = document.getElementById('btnPlayMine');
const btnPlayNativeFull = document.getElementById('btnPlayNativeFull');

// ------------------------------------------------------------
// Init
// ------------------------------------------------------------
window.addEventListener('DOMContentLoaded', () => {
  // Initialize sentence display from SENTENCES (single source of truth)
  sentenceEl.textContent = SENTENCES[currentLevel];

  // Show warning if config not set
  if (typeof AZURE_KEY === 'undefined' || AZURE_KEY === 'YOUR_AZURE_KEY_HERE' || !AZURE_KEY) {
    document.getElementById('configWarning').style.display = 'block';
  }

  // Level switching
  document.querySelectorAll('.level-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.level-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentLevel = parseInt(btn.dataset.level);
      sentenceEl.textContent = SENTENCES[currentLevel];
      resultsEl.classList.remove('show');
      // Invalidate previous recording — it's for a different sentence now
      stopAllPlayback();
      recordedAudioReady = false;
      updatePlaybackButtons();
      statusEl.textContent = 'Sentence changed. Listen first, then record.';
    });
  });

  btnListen.addEventListener('click', playNative);
  btnRecord.addEventListener('click', toggleRecord);
  btnPlayMine.addEventListener('click', () => playMyRecording(undefined, undefined, btnPlayMine));
  btnPlayNativeFull.addEventListener('click', () => speakText(SENTENCES[currentLevel], {}, btnPlayNativeFull));

  // Close any open phoneme popover on outside click / Escape
  document.addEventListener('click', (e) => {
    if (e.target.closest('.word-wrapper')) return;
    document.querySelectorAll('.phoneme-detail').forEach(d => {
      d.style.display = 'none';
      d.classList.remove('flip-left', 'flip-right');
    });
    document.querySelectorAll('.word').forEach(w => w.classList.remove('expanded'));
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    document.querySelectorAll('.phoneme-detail').forEach(d => {
      d.style.display = 'none';
      d.classList.remove('flip-left', 'flip-right');
    });
    document.querySelectorAll('.word').forEach(w => w.classList.remove('expanded'));
  });
});

// ------------------------------------------------------------
// Native voice — uses browser's built-in TTS (free)
// ------------------------------------------------------------
function playNative() {
  const text = SENTENCES[currentLevel];
  if (!('speechSynthesis' in window)) {
    statusEl.textContent = '❌ Your browser does not support speech synthesis.';
    return;
  }
  speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = 'en-US';
  utterance.rate = 0.95;

  // Try to pick an English voice
  const voices = speechSynthesis.getVoices();
  const englishVoice =
    voices.find(v => v.lang.startsWith('en-US')) ||
    voices.find(v => v.lang.startsWith('en'));
  if (englishVoice) utterance.voice = englishVoice;

  utterance.onstart = () => statusEl.textContent = '🔊 Playing native voice...';
  utterance.onend = () => statusEl.textContent = 'Now click "Record" and read the sentence aloud.';
  speechSynthesis.speak(utterance);
}

// ------------------------------------------------------------
// Recording + Pronunciation Assessment
// ------------------------------------------------------------
async function toggleRecord() {
  if (isRecording) {
    stopRecordingAndProcess();
    return;
  }
  if (btnRecord.disabled) return;
  await startRecording();
}

// Manual stop: cut audio input immediately, signal Azure end-of-stream,
// switch UI to Processing while we wait for the recognition result.
function stopRecordingAndProcess() {
  if (!isRecording) return;
  isRecording = false;
  if (recordTimer) { clearTimeout(recordTimer); recordTimer = null; }

  // Tear down the entire audio pipeline NOW (idempotent).
  // Closing the push stream signals Azure: "no more audio, finalize."
  stopWaveform();

  // UI: distinct "processing" state — not recording anymore
  btnRecord.classList.remove('recording');
  btnRecord.classList.add('processing');
  btnRecord.textContent = '⏳ Processing...';
  btnRecord.disabled = true;
  statusEl.innerHTML = '<span class="processing-status"><span class="spinner"></span>Analyzing your pronunciation...</span>';
}

async function startRecording() {
  // Validation
  if (typeof AZURE_KEY === 'undefined' || AZURE_KEY === 'YOUR_AZURE_KEY_HERE' || !AZURE_KEY) {
    statusEl.textContent = '❌ Azure key not configured. Edit config.js.';
    return;
  }
  if (typeof SpeechSDK === 'undefined') {
    statusEl.textContent = '❌ Azure Speech SDK failed to load. Check internet.';
    return;
  }

  try {
    const referenceText = SENTENCES[currentLevel];

    // 1. Speech config
    const speechConfig = SpeechSDK.SpeechConfig.fromSubscription(AZURE_KEY, AZURE_REGION);
    speechConfig.speechRecognitionLanguage = 'en-US';

    // Allow long pauses inside long sentences (default ~500ms is too short)
    speechConfig.setProperty(
      SpeechSDK.PropertyId.SpeechServiceConnection_InitialSilenceTimeoutMs, "10000"
    );
    speechConfig.setProperty(
      SpeechSDK.PropertyId.Speech_SegmentationSilenceTimeoutMs, "3000"
    );
    speechConfig.setProperty(
      SpeechSDK.PropertyId.SpeechServiceConnection_EndSilenceTimeoutMs, "3000"
    );

    // 2. SHARED mic stream — single getUserMedia for Azure + viz + MediaRecorder
    visualStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      }
    });

    // 3. Azure PushStream (16kHz mono PCM) — fed manually from our stream
    azurePushStream = SpeechSDK.AudioInputStream.createPushStream(
      SpeechSDK.AudioStreamFormat.getWaveFormatPCM(16000, 16, 1)
    );
    const audioConfig = SpeechSDK.AudioConfig.fromStreamInput(azurePushStream);

    // 4. AudioContext at 16kHz → resamples mic to what Azure expects
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    audioCtx = new AudioCtx({ sampleRate: 16000 });
    const source = audioCtx.createMediaStreamSource(visualStream);

    // 4a. Analyser for waveform viz (tap on same source)
    analyserNode = audioCtx.createAnalyser();
    analyserNode.fftSize = 2048;
    analyserNode.smoothingTimeConstant = 0.7;
    source.connect(analyserNode);

    // 4b. PCM extractor → Azure PushStream
    pcmProcessor = audioCtx.createScriptProcessor(4096, 1, 1);
    source.connect(pcmProcessor);
    pcmProcessor.connect(audioCtx.destination);
    pcmProcessor.onaudioprocess = (e) => {
      if (!azurePushStream) return;
      const f32 = e.inputBuffer.getChannelData(0);
      const i16 = new Int16Array(f32.length);
      for (let i = 0; i < f32.length; i++) {
        const s = Math.max(-1, Math.min(1, f32[i]));
        i16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      try { azurePushStream.write(i16.buffer); } catch (err) { /* stream closed */ }
    };

    // 5. Pronunciation assessment config
    const pronunciationConfig = new SpeechSDK.PronunciationAssessmentConfig(
      referenceText,
      SpeechSDK.PronunciationAssessmentGradingSystem.HundredMark,
      SpeechSDK.PronunciationAssessmentGranularity.Phoneme,
      true  // enableMiscue: detects insertions/omissions
    );
    pronunciationConfig.enableProsodyAssessment = true;
    pronunciationConfig.phonemeAlphabet = 'IPA';

    // 6. Recognizer
    recognizer = new SpeechSDK.SpeechRecognizer(speechConfig, audioConfig);
    pronunciationConfig.applyTo(recognizer);

    // 7. UI: recording state
    isRecording = true;
    btnRecord.textContent = '■ Recording...';
    btnRecord.classList.add('recording');
    btnListen.disabled = true;
    statusEl.textContent = '🎤 Recording... Read the sentence aloud now.';
    resultsEl.classList.remove('show');


    // Auto-stop safety timer (30s) — same teardown as manual stop
    recordTimer = setTimeout(() => {
      if (isRecording) {
        stopRecordingAndProcess();
        statusEl.innerHTML = '<span class="processing-status"><span class="spinner"></span>30s limit reached — analyzing...</span>';
      }
    }, 30000);

    // 8. Start visualization (uses existing analyserNode) and recorder
    startWaveformDraw();
    startMediaRecorderCapture();

    recordedAudioReady = false;
    updatePlaybackButtons();
    recognizerStartTs = performance.now();
    recognizer.recognizeOnceAsync(
      result => {
        clearTimeout(recordTimer);
        stopWaveform();
        handleResult(result);
        cleanupRecognizer();
        resetRecordButton();
      },
      err => {
        clearTimeout(recordTimer);
        stopWaveform();
        console.error('Recognition error:', err);
        statusEl.textContent = '❌ Recognition error: ' + err;
        cleanupRecognizer();
        resetRecordButton();
      }
    );

  } catch (e) {
    console.error(e);
    statusEl.textContent = '❌ Error: ' + e.message;
    resetRecordButton();
  }
}

function cleanupRecognizer() {
  if (recognizer) {
    try { recognizer.close(); } catch (e) {}
    recognizer = null;
  }
}

function resetRecordButton() {
  isRecording = false;
  btnRecord.textContent = '● Record (max 30s)';
  btnRecord.classList.remove('recording', 'processing');
  btnRecord.disabled = false;
  btnListen.disabled = false;
}

// ------------------------------------------------------------
// Result rendering
// ------------------------------------------------------------
function handleResult(result) {
  if (result.reason !== SpeechSDK.ResultReason.RecognizedSpeech) {
    let detail = 'No speech recognized.';
    try {
      if (result.reason === SpeechSDK.ResultReason.Canceled) {
        const c = SpeechSDK.CancellationDetails.fromResult(result);
        detail = `Canceled — ${c.reason}: ${c.errorDetails || '(no details)'}`;
      } else if (result.reason === SpeechSDK.ResultReason.NoMatch) {
        const n = SpeechSDK.NoMatchDetails.fromResult(result);
        const reasons = {
          0: 'Unknown', 1: 'NotRecognized', 2: 'InitialSilenceTimeout',
          3: 'InitialBabbleTimeout', 4: 'KeywordNotRecognized'
        };
        detail = `NoMatch — ${reasons[n.reason] || n.reason}`;
      } else {
        detail = `Reason code: ${result.reason}`;
      }
    } catch (e) { /* fall through */ }
    console.error('Recognition failed:', detail, result);
    statusEl.textContent = '❌ ' + detail + ' — try again, speak right after clicking Record.';
    return;
  }

  // Pronunciation assessment scores (typed accessor)
  const paResult = SpeechSDK.PronunciationAssessmentResult.fromResult(result);

  // Detailed JSON for word/phoneme data
  const jsonStr = result.properties.getProperty(
    SpeechSDK.PropertyId.SpeechServiceResponse_JsonResult
  );
  let jsonData = {};
  try {
    jsonData = JSON.parse(jsonStr);
  } catch (e) {
    console.warn('Failed to parse JSON result', e);
  }

  rawJsonEl.textContent = JSON.stringify(jsonData, null, 2);

  // Top-level scores
  setScore('scorePron', paResult.pronunciationScore);
  setScore('scoreAcc', paResult.accuracyScore);
  setScore('scoreFlu', paResult.fluencyScore);
  setScore('scoreProsody', paResult.prosodyScore);

  // Word-level color coding
  renderWords(jsonData);

  resultsEl.classList.add('show');
  updatePlaybackButtons();
  statusEl.textContent = '✅ Done! Click "Record" to try again.';
}

function setScore(id, score) {
  const el = document.getElementById(id);
  if (score === undefined || score === null || isNaN(score)) {
    el.textContent = '—';
    el.className = 'score-value';
    return;
  }
  const rounded = Math.round(score);
  el.textContent = rounded;
  el.className = 'score-value ' + scoreClass(rounded);
}

function scoreClass(score) {
  if (score >= 80) return 'good';
  if (score >= 60) return 'mid';
  return 'bad';
}

function renderWords(jsonData) {
  wordDisplayEl.innerHTML = '';

  const words = jsonData?.NBest?.[0]?.Words || [];
  if (words.length === 0) {
    wordDisplayEl.textContent = 'No word-level data available.';
    return;
  }

  words.forEach((w, idx) => {
    // Wrapper for word + its phoneme detail panel
    const wrapper = document.createElement('div');
    wrapper.className = 'word-wrapper';

    // The clickable word chip
    const wordBtn = document.createElement('button');
    wordBtn.type = 'button';
    const score = w.PronunciationAssessment?.AccuracyScore;
    const errorType = w.PronunciationAssessment?.ErrorType;

    wordBtn.className = 'word';
    wordBtn.textContent = w.Word;

    const phonemes = w.Phonemes || [];
    const hasPhonemes = phonemes.length > 0;

    if (errorType === 'Omission' || errorType === 'Insertion') {
      wordBtn.classList.add('miss');
      wordBtn.title = `${w.Word} — ${errorType}`;
    } else if (typeof score === 'number') {
      wordBtn.classList.add(scoreClass(score));
      wordBtn.title = `${w.Word} — ${Math.round(score)}/100 (click for details)`;
    }

    // Add chevron indicator if phonemes exist
    if (hasPhonemes) {
      const chevron = document.createElement('span');
      chevron.className = 'word-chevron';
      chevron.textContent = ' ▾';
      wordBtn.appendChild(chevron);
    }

    // Phoneme detail panel (hidden by default)
    const detail = document.createElement('div');
    detail.className = 'phoneme-detail';
    detail.style.display = 'none';

    if (hasPhonemes) {
      // Header with word info
      const header = document.createElement('div');
      header.className = 'phoneme-header';
      const wordScore = typeof score === 'number' ? Math.round(score) : '—';
      header.innerHTML = `<strong>${w.Word}</strong> · word score: <span class="${scoreClass(score || 0)}">${wordScore}/100</span>`;
      detail.appendChild(header);

      // Spelling-aligned syllable breakdown — shows WHERE in the word the problem is
      if (w.Syllables && w.Syllables.length > 0) {
        const chunks = splitWordIntoChunks(w.Word, w.Syllables.length);
        // Find weakest syllable index
        let worstIdx = -1, worstScore = 101;
        w.Syllables.forEach((s, i) => {
          const sc = s.PronunciationAssessment?.AccuracyScore;
          if (typeof sc === 'number' && sc < worstScore) {
            worstScore = sc;
            worstIdx = i;
          }
        });

        const breakdown = document.createElement('div');
        breakdown.className = 'word-breakdown';
        chunks.forEach((chunk, i) => {
          if (i > 0) {
            const sep = document.createElement('span');
            sep.className = 'chunk-sep';
            sep.textContent = '·';
            breakdown.appendChild(sep);
          }
          const span = document.createElement('span');
          const sc = w.Syllables[i].PronunciationAssessment?.AccuracyScore ?? 0;
          span.className = 'word-chunk ' + scoreClass(sc);
          if (i === worstIdx && worstScore < 60) {
            span.classList.add('worst');
          }
          span.textContent = chunk;
          breakdown.appendChild(span);
        });
        detail.appendChild(breakdown);

        const caption = document.createElement('div');
        caption.className = 'breakdown-caption';
        caption.textContent = worstScore < 60
          ? `↑ Focus on the underlined part`
          : `Spelling broken down by syllable`;
        detail.appendChild(caption);
      }

      // Syllables row (if available)
      if (w.Syllables && w.Syllables.length > 0) {
        const syllableRow = document.createElement('div');
        syllableRow.className = 'phoneme-row syllable-row';
        const label = document.createElement('span');
        label.className = 'phoneme-label';
        label.textContent = 'Syllables:';
        syllableRow.appendChild(label);

        w.Syllables.forEach(s => {
          const sScore = s.PronunciationAssessment?.AccuracyScore;
          const sChip = document.createElement('span');
          sChip.className = 'phoneme-chip ' + scoreClass(sScore || 0);
          sChip.innerHTML = `<span class="phoneme-symbol">${s.Syllable}</span><span class="phoneme-score">${Math.round(sScore || 0)}</span>`;
          syllableRow.appendChild(sChip);
        });
        detail.appendChild(syllableRow);
      }

      // Phonemes row
      const phonemeRow = document.createElement('div');
      phonemeRow.className = 'phoneme-row';
      const pLabel = document.createElement('span');
      pLabel.className = 'phoneme-label';
      pLabel.textContent = 'Phonemes:';
      phonemeRow.appendChild(pLabel);

      phonemes.forEach(p => {
        const pScore = p.PronunciationAssessment?.AccuracyScore;
        const chip = document.createElement('span');
        chip.className = 'phoneme-chip ' + scoreClass(pScore || 0);
        chip.innerHTML = `<span class="phoneme-symbol">${p.Phoneme}</span><span class="phoneme-score">${Math.round(pScore || 0)}</span>`;
        phonemeRow.appendChild(chip);
      });
      detail.appendChild(phonemeRow);

      // Worst phoneme hint — now anchored to the spelled chunk
      const worst = findWorstPhoneme(phonemes);
      if (worst && worst.score < 60) {
        // Find which syllable (and thus letter chunk) contains this phoneme
        let chunkLabel = '';
        if (w.Syllables && w.Syllables.length > 0) {
          const chunks = splitWordIntoChunks(w.Word, w.Syllables.length);
          let worstSylIdx = -1, worstSylScore = 101;
          w.Syllables.forEach((s, i) => {
            const sc = s.PronunciationAssessment?.AccuracyScore;
            if (typeof sc === 'number' && sc < worstSylScore) {
              worstSylScore = sc;
              worstSylIdx = i;
            }
          });
          if (worstSylIdx >= 0 && chunks[worstSylIdx]) {
            chunkLabel = ` — the "<strong>${chunks[worstSylIdx]}</strong>" part of <strong>${w.Word}</strong>`;
          }
        }
        const hint = document.createElement('div');
        hint.className = 'phoneme-hint';
        hint.innerHTML = `⚠️ Weakest sound: <strong>/${worst.symbol}/</strong> at ${worst.score}/100${chunkLabel}.`;
        detail.appendChild(hint);
      }

      // Native pronunciation button (per-word)
      const ab = document.createElement('div');
      ab.className = 'ab-buttons';

      const nativeBtn = document.createElement('button');
      nativeBtn.type = 'button';
      nativeBtn.className = 'ab-btn native';
      nativeBtn.textContent = '▶ Hear native pronunciation';
      nativeBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        speakText(w.Word, { rate: 0.85 }, nativeBtn);
      });

      ab.appendChild(nativeBtn);
      detail.appendChild(ab);
    } else {
      detail.textContent = 'No phoneme data for this word.';
    }

    // Toggle on click
    wordBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const isOpen = detail.style.display === 'block';
      // Close all other details (accordion behavior)
      document.querySelectorAll('.phoneme-detail').forEach(d => {
        d.style.display = 'none';
        d.classList.remove('flip-left', 'flip-right');
      });
      document.querySelectorAll('.word').forEach(w => w.classList.remove('expanded'));

      if (!isOpen) {
        detail.style.display = 'block';
        wordBtn.classList.add('expanded');
        // Edge-flip if popover overflows viewport
        const rect = detail.getBoundingClientRect();
        const margin = 8;
        if (rect.right > window.innerWidth - margin) {
          detail.classList.add('flip-left');
        } else if (rect.left < margin) {
          detail.classList.add('flip-right');
        }
      }
    });

    wrapper.appendChild(wordBtn);
    wrapper.appendChild(detail);
    wordDisplayEl.appendChild(wrapper);
  });
}

// ------------------------------------------------------------
// Playback helpers (A/B comparison)
// ------------------------------------------------------------
function updatePlaybackButtons() {
  if (btnPlayMine) btnPlayMine.disabled = !recordedAudioReady;
  if (btnPlayNativeFull) btnPlayNativeFull.disabled = false;
}

function setActivePlayBtn(btn) {
  clearActivePlayBtn();
  if (!btn) return;
  btn.dataset.label = btn.dataset.label || btn.textContent;
  btn.textContent = btn.dataset.label.replace('▶', '■');
  btn.classList.add('playing');
  activePlayBtn = btn;
}

function clearActivePlayBtn() {
  if (!activePlayBtn) return;
  if (activePlayBtn.dataset.label) {
    activePlayBtn.textContent = activePlayBtn.dataset.label;
  }
  activePlayBtn.classList.remove('playing');
  activePlayBtn = null;
}

function stopAllPlayback() {
  if (playbackStopTimer) { clearTimeout(playbackStopTimer); playbackStopTimer = null; }
  try { speechSynthesis.cancel(); } catch (e) {}
  if (recordedAudio) {
    try { recordedAudio.onended = null; } catch (e) {}
    try { recordedAudio.pause(); } catch (e) {}
  }
  clearActivePlayBtn();
}

// Convert Azure offset (100ns ticks) → ms, applying recorder/recognizer skew
function azureOffsetToAudioMs(offset100ns) {
  const azureMs = offset100ns / 10000;
  // Azure's t=0 is when its mic capture started; our MediaRecorder may have
  // started slightly later. Skew = recognizerStartTs - recordingStartTs.
  // (negative values mean recorder started after Azure → push the cursor forward)
  const skew = recognizerStartTs - recordingStartTs;
  return Math.max(0, azureMs - skew);
}

function playMyRecording(offsetMs, durationMs, srcBtn) {
  // Toggle: if this button is already playing, stop instead
  if (srcBtn && activePlayBtn === srcBtn) {
    stopAllPlayback();
    return;
  }
  if (!recordedAudio || !recordedAudioReady) return;

  stopAllPlayback();

  const startSec = offsetMs ? Math.max(0, offsetMs / 1000) : 0;
  recordedAudio.currentTime = startSec;
  recordedAudio.playbackRate = 1.0;

  if (srcBtn) setActivePlayBtn(srcBtn);

  recordedAudio.onended = () => clearActivePlayBtn();
  recordedAudio.play().catch(err => {
    console.warn('Playback failed:', err);
    statusEl.textContent = '❌ Playback failed: ' + err.message;
    clearActivePlayBtn();
  });

  if (durationMs) {
    playbackStopTimer = setTimeout(() => {
      try { recordedAudio.pause(); } catch (e) {}
      clearActivePlayBtn();
    }, durationMs + 80); // small tail buffer
  }
}

function speakText(text, opts = {}, srcBtn) {
  // Toggle: if this button is already speaking, stop instead
  if (srcBtn && activePlayBtn === srcBtn) {
    stopAllPlayback();
    return;
  }
  if (!('speechSynthesis' in window)) return;

  stopAllPlayback();

  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'en-US';
  u.rate = opts.rate || 0.9;

  const voices = speechSynthesis.getVoices();
  const v =
    voices.find(x => x.lang.startsWith('en-US')) ||
    voices.find(x => x.lang.startsWith('en'));
  if (v) u.voice = v;

  if (srcBtn) setActivePlayBtn(srcBtn);

  u.onend = () => clearActivePlayBtn();
  u.onerror = () => clearActivePlayBtn();

  speechSynthesis.speak(u);
}

// ------------------------------------------------------------
// Real-time waveform visualization
// ------------------------------------------------------------
function startMediaRecorderCapture() {
  if (!visualStream) return;
  try {
    recordedChunks = [];
    const mime = pickRecorderMime();
    mediaRecorder = mime
      ? new MediaRecorder(visualStream, { mimeType: mime })
      : new MediaRecorder(visualStream);
    mediaRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) recordedChunks.push(e.data);
    };
    mediaRecorder.onstop = () => {
      const blob = new Blob(recordedChunks, { type: mediaRecorder.mimeType || 'audio/webm' });
      const url = URL.createObjectURL(blob);
      if (recordedAudio) {
        try { URL.revokeObjectURL(recordedAudio.src); } catch (e) {}
      }
      recordedAudio = new Audio(url);
      recordedAudio.preload = 'auto';
      recordedAudioReady = true;
      updatePlaybackButtons();
    };
    mediaRecorder.start();
    recordingStartTs = performance.now();
  } catch (e) {
    console.warn('MediaRecorder unavailable:', e);
    mediaRecorder = null;
  }
}

function startWaveformDraw() {
  const container = document.getElementById('waveformContainer');
  const canvas = document.getElementById('waveformCanvas');
  if (!container || !canvas || !analyserNode) return;

  container.classList.add('active');

  // HiDPI-aware canvas sizing
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  const w = rect.width;
  const h = rect.height;
  const bufferLength = analyserNode.fftSize;
  const dataArray = new Uint8Array(bufferLength);

  // Scrolling history of amplitude bars (right-to-left scroll like a spectrogram)
  const barWidth = 3;
  const barGap = 1;
  const barSlot = barWidth + barGap;
  const maxBars = Math.ceil(w / barSlot) + 2;
  const history = [];

  const draw = () => {
    if (!analyserNode) return;
    waveformRAF = requestAnimationFrame(draw);

    analyserNode.getByteTimeDomainData(dataArray);

    // Compute peak amplitude in this frame (0..1)
    let peak = 0;
    for (let i = 0; i < bufferLength; i++) {
      const v = Math.abs(dataArray[i] - 128) / 128;
      if (v > peak) peak = v;
    }
    history.push(peak);
    if (history.length > maxBars) history.shift();

    // Clear with subtle gradient bg
    ctx.clearRect(0, 0, w, h);

    // Center axis hint
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.15)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, h / 2);
    ctx.lineTo(w, h / 2);
    ctx.stroke();

    // Draw amplitude bars from right to left
    for (let i = 0; i < history.length; i++) {
      const amp = history[history.length - 1 - i];
      const barHeight = Math.max(2, amp * h * 0.92);
      const x = w - (i + 1) * barSlot;
      if (x + barWidth < 0) break;

      // Color by intensity
      let color;
      if (amp > 0.55) color = '#ef4444';
      else if (amp > 0.25) color = '#f59e0b';
      else color = '#22c55e';

      ctx.fillStyle = color;
      const y = (h - barHeight) / 2;
      ctx.fillRect(x, y, barWidth, barHeight);
    }

    // Live waveform overlay (oscilloscope) on top
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = 'rgba(96, 165, 250, 0.55)';
    ctx.beginPath();
    const sliceWidth = w / bufferLength;
    let x2 = 0;
    for (let i = 0; i < bufferLength; i++) {
      const v = dataArray[i] / 128.0;
      const y = (v * h) / 2;
      if (i === 0) ctx.moveTo(x2, y);
      else ctx.lineTo(x2, y);
      x2 += sliceWidth;
    }
    ctx.stroke();
  };

  draw();
}

function stopWaveform() {
  if (waveformRAF) {
    cancelAnimationFrame(waveformRAF);
    waveformRAF = null;
  }
  // Stop MediaRecorder (this triggers onstop → builds Blob/Audio)
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    try { mediaRecorder.stop(); } catch (e) {}
  }
  // Stop pumping PCM to Azure and close push stream
  if (pcmProcessor) {
    try { pcmProcessor.disconnect(); } catch (e) {}
    pcmProcessor.onaudioprocess = null;
    pcmProcessor = null;
  }
  if (azurePushStream) {
    try { azurePushStream.close(); } catch (e) {}
    azurePushStream = null;
  }
  if (visualStream) {
    visualStream.getTracks().forEach(t => t.stop());
    visualStream = null;
  }
  if (audioCtx) {
    audioCtx.close().catch(() => {});
    audioCtx = null;
  }
  analyserNode = null;
  const container = document.getElementById('waveformContainer');
  if (container) container.classList.remove('active');
}

function pickRecorderMime() {
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4',
    'audio/ogg;codecs=opus',
  ];
  if (typeof MediaRecorder === 'undefined') return null;
  for (const m of candidates) {
    if (MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(m)) return m;
  }
  return null;
}

// ------------------------------------------------------------
// Spelling-aligned syllable breakdown
// Splits a word into N letter chunks roughly aligned with N syllables,
// using vowel-group positions as nucleus markers.
// ------------------------------------------------------------
function splitWordIntoChunks(word, n) {
  const clean = (word || '').trim();
  if (!clean || n <= 1) return [clean];

  const vowels = 'aeiouyAEIOUY';
  const groupStarts = [];
  let inVowel = false;
  for (let i = 0; i < clean.length; i++) {
    const isV = vowels.includes(clean[i]);
    if (isV && !inVowel) groupStarts.push(i);
    inVowel = isV;
  }

  if (groupStarts.length >= n) {
    const chunks = [];
    let start = 0;
    for (let k = 0; k < n - 1; k++) {
      // Cut roughly midway between consecutive vowel-group starts
      const cut = Math.floor((groupStarts[k] + groupStarts[k + 1] + 1) / 2);
      chunks.push(clean.slice(start, cut));
      start = cut;
    }
    chunks.push(clean.slice(start));
    return chunks;
  }

  // Fallback: even split when we can't find enough vowel groups
  const chunks = [];
  for (let i = 0; i < n; i++) {
    chunks.push(clean.slice(
      Math.round(i * clean.length / n),
      Math.round((i + 1) * clean.length / n)
    ));
  }
  return chunks;
}

function findWorstPhoneme(phonemes) {
  let worst = null;
  phonemes.forEach(p => {
    const s = p.PronunciationAssessment?.AccuracyScore;
    if (typeof s === 'number' && (worst === null || s < worst.score)) {
      worst = { symbol: p.Phoneme, score: Math.round(s) };
    }
  });
  return worst;
}
