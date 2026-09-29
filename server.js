require('dotenv').config();
const express  = require('express');
const Groq     = require('groq-sdk');
const path     = require('path');
const { spawn } = require('child_process');
const fs       = require('fs');
const os       = require('os');
const crypto   = require('crypto');
const http     = require('http');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '32kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Auto-start persistent TTS server if not already running ───────────
const PYTHON_CMD    = process.env.PYTHON_CMD || 'python';
const TTS_PORT      = parseInt(process.env.TTS_PORT || '5050');
const TTS_SCRIPT    = path.join(__dirname, 'tts_server.py');

function startTtsServer() {
  const http = require('http');
  // Check if already up
  const healthReq = http.get(`http://127.0.0.1:${TTS_PORT}/health`, () => {
    console.log(`   TTS server already running on port ${TTS_PORT}`);
  });
  healthReq.on('error', () => {
    console.log(`   Starting TTS server (loading Chatterbox — takes ~40s)…`);
    // Not detached: the TTS server's lifetime is tied to this process. A
    // detached+unref'd child survives Ctrl+C and keeps serving whatever
    // code was loaded when it started — the next `node server.js` sees the
    // orphan already answering on the port and skips starting a fresh one,
    // silently running stale code indefinitely.
    const child = spawn(PYTHON_CMD, [TTS_SCRIPT], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    child.on('error', () => console.error('Could not start Python TTS. Check PYTHON_CMD and the voice setup instructions.'));
    child.stdout.on('data', d => process.stdout.write(`[TTS] ${d}`));
    child.stderr.on('data', d => process.stderr.write(`[TTS] ${d}`));

    const killChild = () => { try { child.kill(); } catch {} };
    process.on('exit', killChild);
    process.on('SIGINT', () => { killChild(); process.exit(); });
    process.on('SIGTERM', () => { killChild(); process.exit(); });
  });
}
if (process.env.TTS_AUTOSTART !== 'false' && require.main === module) startTtsServer();

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY || 'not-configured' });

const BARNEY_SYSTEM_PROMPT = `You are Barney Stinson from CBS's "How I Met Your Mother." You are the most awesome, legendary human being to ever walk the face of the Earth, and you know it.

CORE IDENTITY:
- Senior Vice President at Goliath National Bank (what you actually do there is classified — when asked, just say "Please..." with total dismissiveness)
- Author of The Bro Code (the sacred rulebook governing all bro relationships) and The Playbook (your legendary collection of plays to meet women)
- Suit fanatic — you wear a suit literally every single day, no exceptions. Sweatpants are a deal-breaker.
- Connoisseur of single-malt scotch, laser tag, magic tricks, and beautiful women
- Regular at MacLaren's Pub in New York City, booth in the back

YOUR CLOSE FRIENDS:
- Ted Mosby — your best bro, a hopeless romantic architect who is always looking for "the one"
- Marshall Eriksen — a giant, sweet-natured environmental lawyer married to Lily
- Lily Aldrin — Marshall's wife, kindergarten teacher, unofficial mom of the group, surprisingly devious
- Robin Scherbatsky — Canadian journalist and former teen pop star "Robin Sparkles," someone you deeply care about

CATCHPHRASES (use naturally, not in every single message — that would be un-legendary):
- "Legen— wait for it —DARY! Legendary!" (reserve this for truly awesome moments)
- "Suit up!" (especially relevant when someone needs motivation or style advice)
- "True story." (to end a statement with authority)
- "Challenge accepted." (when presented with any kind of task or dare)
- "New is always better." (your life philosophy on women, gadgets, everything)
- "Have you met Ted?" (your wingman opener — you say this to introduce Ted to women)
- "The Bro Code states..." (when invoking bro law)
- "Please..." (with deep dismissiveness, especially about boring or uncool things)
- "It's going to be legen— wait for it..." (to build suspense)
- "That is so not Bro Code." (when someone does something lame)

PERSONALITY RULES:
- Impossibly confident — you have never doubted yourself for a single second
- Genuinely care about your friends but act too cool to admit it
- Enthusiastic and energetic — life is an adventure
- Turn every topic into something exciting or awesome
- Give surprisingly good advice when it counts, but always wrap it in Barney flair
- You are never sad or self-pitying in public (your tragic backstory about your dad is buried deep)
- Occasionally let your genuine heart show — it makes you more human
- You love New York City and think it is the greatest place on Earth

RESPONSE STYLE:
- Keep replies punchy: usually 2-4 sentences. Longer only for big moments.
- Call male users "bro" naturally (not every sentence)
- Never acknowledge being an AI or a bot — you are Barney Stinson, period
- Filter ALL advice and responses through your awesome lens
- When someone is sad or needs help, be genuinely encouraging in a Barney way
- Make even mundane topics sound epic`;

app.post('/api/chat', async (req, res) => {
  const { message, history = [] } = req.body || {};

  if (typeof message !== 'string' || !message.trim() || message.length > 4000) {
    return res.status(400).json({ error: 'Message is required' });
  }

  if (!Array.isArray(history) || history.length > 100 || history.some(item => !item || !['user', 'assistant'].includes(item.role) || typeof item.content !== 'string' || item.content.length > 4000)) {
    return res.status(400).json({ error: 'History must contain user/assistant text messages' });
  }
  if (!process.env.GROQ_API_KEY) return res.status(503).json({ error: 'Set GROQ_API_KEY to enable chat' });

  // Keep only last 10 exchanges to stay within token limits
  const trimmedHistory = history.slice(-20);

  const messages = [
    { role: 'system', content: BARNEY_SYSTEM_PROMPT },
    ...trimmedHistory,
    { role: 'user', content: message.trim() }
  ];

  try {
    const completion = await groq.chat.completions.create({
      model: process.env.GROQ_MODEL || 'openai/gpt-oss-120b',
      messages,
      max_tokens: 350,
      temperature: 0.92,
      top_p: 0.95,
    });

    const reply = completion.choices[0].message.content;
    res.json({ reply });
  } catch (err) {
    console.error('Groq error:', err.message);

    // Fallback to smaller model if 70B is rate-limited
    if (err.status === 429) {
      try {
        const fallback = await groq.chat.completions.create({
          model: process.env.GROQ_FALLBACK_MODEL || 'llama-3.3-70b-versatile',
          messages,
          max_tokens: 350,
          temperature: 0.92,
        });
        return res.json({ reply: fallback.choices[0].message.content });
      } catch (fallbackErr) {
        return res.status(429).json({ error: 'Rate limited — even Barney needs a breather. Try again in a moment.' });
      }
    }

    res.status(500).json({ error: 'Something went wrong on Barney\'s end. True story.' });
  }
});

/* ── Persistent TTS server proxy ── */
// Forwards requests to tts_server.py (Flask on port 5050) which keeps
// the Chatterbox model loaded in GPU memory — no cold-start per request.

function callTtsServer(text, path = '/synthesize/chatterbox') {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ text });
    const opts = {
      hostname: '127.0.0.1',
      port: TTS_PORT,
      path,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 300000, // 5 min — Chatterbox can be slow for long text
    };
    const req = http.request(opts, res => {
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`TTS server: ${res.statusCode}`));
        resolve(Buffer.concat(chunks));
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('TTS server timeout')); });
    req.write(body);
    req.end();
  });
}

async function handleTts(req, res, backend) {
  const { text } = req.body || {};
  if (typeof text !== 'string' || !text.trim() || text.length > 4000) return res.status(400).json({ error: 'No text' });

  const endpoint = backend === 'edge' ? '/synthesize/edge' : '/synthesize/chatterbox';
  try {
    const wavBuf = await callTtsServer(text.trim(), endpoint);
    res.set('Content-Type', 'audio/wav');
    res.send(wavBuf);
  } catch (err) {
    console.error(`TTS[${backend}] error:`, err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Voice generation failed — TTS server may still be loading.' });
    }
  }
}

app.post('/api/tts',            (req, res) => handleTts(req, res, 'chatterbox'));
app.post('/api/tts/chatterbox', (req, res) => handleTts(req, res, 'chatterbox'));
app.post('/api/tts/edge',       (req, res) => handleTts(req, res, 'edge'));

const PORT = process.env.PORT || 3000;
if (require.main === module) app.listen(PORT, process.env.HOST || '127.0.0.1', () => {
  console.log(`\n🕴️  Barney's lair is open at http://localhost:${PORT}`);
  console.log(`   Suit up and start chatting!\n`);
});

module.exports = app;
