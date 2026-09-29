/* ── State ── */
const HISTORY_KEY = 'barneyChatHistory';
const history = loadHistory();
let voiceEnabled = true;
let isListening = false;
let isSending = false;
let currentAudio = null;
let ttsBackend = localStorage.getItem('ttsBackend') || 'chatterbox';

/* ── DOM refs ── */
const messagesEl     = document.getElementById('messages');
const textInput      = document.getElementById('textInput');
const sendBtn        = document.getElementById('sendBtn');
const micBtn         = document.getElementById('micBtn');
const voiceToggle    = document.getElementById('voiceToggle');
const backendToggle  = document.getElementById('backendToggle');
const welcomeEl      = document.getElementById('welcome');
const toastEl        = document.getElementById('toast');

/* ── Backend toggle (Chatterbox speech or Edge TTS) ── */
const BACKENDS = ['chatterbox', 'edge'];
const BACKEND_LABELS = {
  chatterbox: '🎙️ Chatterbox',
  edge:       '🎙️ Edge TTS',
};

function updateBackendBtn() {
  backendToggle.textContent = BACKEND_LABELS[ttsBackend] || '🎙️ Voice';
  backendToggle.title = `Current: ${ttsBackend} — click to switch`;
}
updateBackendBtn();

backendToggle.addEventListener('click', () => {
  const idx = BACKENDS.indexOf(ttsBackend);
  ttsBackend = BACKENDS[(idx + 1) % BACKENDS.length];
  localStorage.setItem('ttsBackend', ttsBackend);
  updateBackendBtn();
  showToast(`Voice: ${BACKEND_LABELS[ttsBackend]}`);
});

/* ── Voice toggle ── */
voiceToggle.addEventListener('click', () => {
  voiceEnabled = !voiceEnabled;
  voiceToggle.classList.toggle('active', voiceEnabled);
  voiceToggle.textContent = voiceEnabled ? '🔊 Voice' : '🔇 Voice';
  if (!voiceEnabled && currentAudio) {
    currentAudio.pause();
    currentAudio = null;
  }
});

/* ── Text input auto-resize + enable send ── */
textInput.addEventListener('input', () => {
  textInput.style.height = 'auto';
  textInput.style.height = Math.min(textInput.scrollHeight, 120) + 'px';
  sendBtn.disabled = !textInput.value.trim() || isSending;
});

textInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    if (!sendBtn.disabled) handleSend();
  }
});

sendBtn.addEventListener('click', handleSend);

/* ── Send starter chips ── */
function sendStarter(btn) {
  textInput.value = btn.textContent;
  handleSend();
}

/* ── Conversation persistence (localStorage) ── */
function loadHistory() {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveHistory() {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
  } catch {
    // storage full or unavailable — conversation just won't persist this time
  }
}

function restoreHistory() {
  if (!history.length) return;
  hideWelcome();
  for (const msg of history) {
    appendMessage(msg.role === 'user' ? 'user' : 'barney', msg.content);
  }
}
restoreHistory();

/* ── Main send flow ── */
async function handleSend() {
  const text = textInput.value.trim();
  if (!text || isSending) return;

  isSending = true;
  sendBtn.disabled = true;
  textInput.value = '';
  textInput.style.height = 'auto';

  hideWelcome();
  appendMessage('user', text);

  const typingRow = showTyping();

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text, history: [...history] }),
    });

    const data = await res.json();

    if (!res.ok) {
      typingRow.remove();
      showToast(data.error || 'Something went wrong. Even Barney needs a minute.');
      isSending = false;
      sendBtn.disabled = false;
      return;
    }

    const reply = data.reply;

    history.push({ role: 'user', content: text });
    history.push({ role: 'assistant', content: reply });
    if (history.length > 40) history.splice(0, history.length - 40);
    saveHistory();

    // Text and voice are revealed together, sentence by sentence, so the
    // bubble never sits there fully-typed while the audio is still catching up.
    if (voiceEnabled) {
      await speakAndRevealBarney(reply, typingRow);
    } else {
      typingRow.remove();
      appendMessage('barney', reply);
    }

  } catch (err) {
    typingRow.remove();
    showToast('Network error. The Bro Code doesn\'t cover this situation.');
    console.error(err);
  }

  isSending = false;
  sendBtn.disabled = !textInput.value.trim();
}

/* ── Append a message bubble ── */
function appendMessage(role, text, returnContentEl = false) {
  const row = document.createElement('div');
  row.className = `msg-row ${role}`;

  const avatarEl = document.createElement('div');
  avatarEl.className = 'msg-avatar';
  avatarEl.textContent = role === 'barney' ? '🕴️' : '👤';

  const bubble = document.createElement('div');
  bubble.className = 'bubble';

  const sender = document.createElement('div');
  sender.className = 'sender';
  sender.textContent = role === 'barney' ? 'Barney Stinson' : 'You';

  const content = document.createElement('div');
  content.textContent = text;

  bubble.appendChild(sender);
  bubble.appendChild(content);
  row.appendChild(avatarEl);
  row.appendChild(bubble);

  messagesEl.appendChild(row);
  scrollToBottom();
  return returnContentEl ? content : row;
}

/* ── Typing indicator ── */
function showTyping() {
  const row = document.createElement('div');
  row.className = 'msg-row barney';

  const avatarEl = document.createElement('div');
  avatarEl.className = 'msg-avatar';
  avatarEl.textContent = '🕴️';

  const indicator = document.createElement('div');
  indicator.className = 'typing-indicator';
  indicator.innerHTML = '<span></span><span></span><span></span>';

  row.appendChild(avatarEl);
  row.appendChild(indicator);
  messagesEl.appendChild(row);
  scrollToBottom();
  return row;
}

function hideWelcome() {
  if (welcomeEl) welcomeEl.style.display = 'none';
}

function scrollToBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

/* ── Toast ── */
let toastTimeout;
function showToast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => toastEl.classList.remove('show'), 4000);
}

/* ────────────────────────────────────────────
   SPEECH SYNTHESIS — synced sentence-by-sentence
   Chatterbox clones Barney's actual voice from reference audio.
   Text is revealed in the bubble in lockstep with each sentence's audio,
   so the transcript never gets ahead of the voice — the typing indicator
   stays up until the first sentence's audio is actually ready to play.
───────────────────────────────────────────── */

// AbortController for the current TTS run so stopCurrentAudio can cancel pending fetches
let _ttsAbort = null;

function splitSentences(text) {
  // Split on sentence-ending punctuation followed by whitespace or end
  const raw = text.match(/[^.!?…]+[.!?…]+(?:\s|$)|[^.!?…]+$/g) || [text];
  return raw.map(s => s.trim()).filter(s => s.length > 2);
}

async function speakAndRevealBarney(text, typingRow) {
  stopCurrentAudio();

  const cleanText = text
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/\*(.*?)\*/g, '$1')
    .replace(/—/g, '... ')
    .replace(/\n/g, ' ')
    .trim();

  const sentences = splitSentences(cleanText);
  if (sentences.length === 0) {
    typingRow.remove();
    appendMessage('barney', text);
    return;
  }

  _ttsAbort = new AbortController();

  // Pre-create one resolvable slot per sentence up front so playback can
  // await index i regardless of how far the background fetch loop has gotten.
  const resolvers = [];
  const blobPromises = sentences.map(() => new Promise(r => resolvers.push(r)));

  (async () => {
    for (let i = 0; i < sentences.length; i++) {
      try {
        const res = await fetch(`/api/tts/${ttsBackend}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: sentences[i] }),
          signal: _ttsAbort?.signal,
        });
        resolvers[i](res.ok ? await res.blob() : null);
      } catch {
        resolvers[i](null);
      }
    }
  })();

  let bubbleContentEl = null;
  let textSpan = null;
  let cursorEl = null;
  let revealedText = '';
  let anyAudioPlayed = false;

  for (let i = 0; i < sentences.length; i++) {
    if (!voiceEnabled) break;
    const blob = await blobPromises[i];

    // The moment the first sentence's audio is ready, swap the typing
    // indicator for the real message bubble — text and voice start together.
    if (i === 0) {
      typingRow.remove();
      bubbleContentEl = appendMessage('barney', '', true);
      textSpan = document.createElement('span');
      bubbleContentEl.appendChild(textSpan);
      cursorEl = document.createElement('span');
      cursorEl.className = 'reveal-cursor';
      cursorEl.innerHTML = '<span></span><span></span><span></span>';
      bubbleContentEl.appendChild(cursorEl);
    }

    revealedText += (revealedText ? ' ' : '') + sentences[i];
    textSpan.textContent = revealedText;
    // Keep the "more coming" cursor visible until this really is the last sentence.
    cursorEl.style.display = (i < sentences.length - 1) ? '' : 'none';
    scrollToBottom();

    if (blob) {
      anyAudioPlayed = true;
      await playBlob(blob);
    }
  }

  if (cursorEl) cursorEl.remove();

  if (!bubbleContentEl) {
    // Voice got disabled before the first sentence arrived — just show the text.
    typingRow.remove();
    appendMessage('barney', text);
  } else if (revealedText !== cleanText) {
    // Voice was toggled off mid-stream — make sure the transcript is complete.
    textSpan.textContent = cleanText;
  } else if (!anyAudioPlayed) {
    // TTS failed for every sentence — fall back to browser speech.
    speakBrowser(cleanText);
  }
}

// Play a Blob and wait until it finishes
function playBlob(blob) {
  return new Promise(resolve => {
    const url   = URL.createObjectURL(blob);
    const audio = new Audio(url);
    currentAudio = audio;
    audio.onended = () => { URL.revokeObjectURL(url); currentAudio = null; resolve(); };
    audio.onerror = resolve;
    audio.play().catch(() => {
      showToast("Click anywhere to enable Barney's voice.");
      resolve();
    });
  });
}

function stopCurrentAudio() {
  if (_ttsAbort) { _ttsAbort.abort(); _ttsAbort = null; }
  if (currentAudio) {
    currentAudio.pause();
    currentAudio = null;
  }
  if ('speechSynthesis' in window) speechSynthesis.cancel();
}

/* Browser TTS fallback (used only if the TTS server is completely down) */
function speakBrowser(text) {
  if (!('speechSynthesis' in window)) return;
  const utter = new SpeechSynthesisUtterance(text);
  utter.rate = 1.05;
  const voices = speechSynthesis.getVoices();
  utter.voice = voices.find(v => /david|mark|alex|james|ryan/i.test(v.name) && v.lang.startsWith('en'))
             || voices.find(v => v.lang.startsWith('en'))
             || null;
  speechSynthesis.speak(utter);
}

/* ────────────────────────────────────────────
   SPEECH RECOGNITION — voice input (browser)
───────────────────────────────────────────── */
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognition = null;

if (SpeechRecognition) {
  recognition = new SpeechRecognition();
  recognition.continuous = false;
  recognition.interimResults = true;
  recognition.lang = 'en-US';

  recognition.onresult = (event) => {
    const transcript = Array.from(event.results)
      .map(r => r[0].transcript)
      .join('');
    textInput.value = transcript;
    textInput.style.height = 'auto';
    textInput.style.height = Math.min(textInput.scrollHeight, 120) + 'px';
    sendBtn.disabled = !transcript.trim();
  };

  recognition.onend = () => {
    isListening = false;
    micBtn.classList.remove('listening');
    micBtn.textContent = '🎤';
    if (textInput.value.trim()) handleSend();
  };

  recognition.onerror = (e) => {
    isListening = false;
    micBtn.classList.remove('listening');
    micBtn.textContent = '🎤';
    if (e.error !== 'no-speech' && e.error !== 'aborted') {
      showToast('Mic error: ' + e.error + '. Even Barney can\'t fix that.');
    }
  };

  micBtn.addEventListener('click', () => {
    if (isListening) {
      recognition.stop();
    } else {
      stopCurrentAudio();  // stop Barney speaking before we listen
      isListening = true;
      micBtn.classList.add('listening');
      micBtn.textContent = '⏹';
      recognition.start();
    }
  });
} else {
  micBtn.title = 'Voice input not supported. Use Chrome.';
  micBtn.style.opacity = '0.35';
  micBtn.style.cursor = 'not-allowed';
}
