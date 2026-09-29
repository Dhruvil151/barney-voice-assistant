#!/usr/bin/env python3
"""
Persistent Chatterbox TTS server — loads model ONCE, stays in GPU memory.
Node.js calls POST /synthesize with {"text": "..."} and gets WAV bytes back.
"""
import os, re, sys, warnings, io, threading
import numpy as np
import soundfile as sf
import torch
from flask import Flask, request, Response

_gpu_lock = threading.Lock()  # serialise GPU ops across threads

warnings.filterwarnings("ignore")

# Load .env from the project directory
_HERE = os.path.dirname(os.path.abspath(__file__))
try:
    from dotenv import load_dotenv
    load_dotenv(os.path.join(_HERE, ".env"))
except ImportError:
    pass

# ── Config ─────────────────────────────────────────────────────────────
_raw_ref = os.environ.get("BARNEY_VOICE_REF", "").strip()
# Resolve relative paths relative to the script's directory
REFERENCE_AUDIO  = os.path.join(_HERE, _raw_ref) if _raw_ref and not os.path.isabs(_raw_ref) else _raw_ref
RVC_DEVICE       = os.environ.get("RVC_DEVICE", "cuda").strip()
BASE_EXAG        = float(os.environ.get("BARNEY_EXAGGERATION", "0.50"))
CFG_WEIGHT       = float(os.environ.get("BARNEY_CFG", "0.75"))
TEMPERATURE      = float(os.environ.get("BARNEY_TEMPERATURE", "0.9"))
TTS_PORT         = int(os.environ.get("TTS_PORT", "5050"))

app = Flask(__name__)

# ── Load model once at startup ─────────────────────────────────────────
print("[TTS] Loading Chatterbox model…", flush=True)
from chatterbox.tts import ChatterboxTTS

_device = "cuda" if (RVC_DEVICE.startswith("cuda") and torch.cuda.is_available()) else "cpu"
_model  = ChatterboxTTS.from_pretrained(device=_device)
_ref    = REFERENCE_AUDIO if REFERENCE_AUDIO and os.path.isfile(REFERENCE_AUDIO) else None
_sr     = _model.sr

# Embed the reference clip into speaker conditionals ONCE at startup.
# generate() would otherwise re-run the reference through the speaker-embedding
# network on every single call when given audio_prompt_path — pure waste since
# the reference never changes. Preparing conditionals once and calling
# generate(audio_prompt_path=None, ...) afterward reuses the cached embedding;
# generate() still updates the (cheap) exaggeration tensor per call, so the
# per-sentence emotion modulation keeps working. Measured ~30% faster per
# sentence with zero change to output quality.
if _ref:
    print("[TTS] Pre-embedding reference audio…", flush=True)
    _model.prepare_conditionals(_ref, exaggeration=BASE_EXAG)
    print("[TTS] Reference embedded — generate() calls will reuse it.", flush=True)

print(f"[TTS] Model ready on {_device} | sr={_sr} | ref={'yes' if _ref else 'none'}", flush=True)

# ── Emotion layer ──────────────────────────────────────────────────────
# Maps a sentence to an emotional register, then to a Chatterbox exaggeration
# delta + pause length. Keeps everything anchored to BASE_EXAG (tuned by ear
# against the reference clip) so no emotion ever overrides the base voice
# clone — it only nudges expressiveness up or down.
EMOTION_EXAG_DELTA = {
    'excited':   +0.15,
    'confident': +0.08,
    'angry':     +0.10,
    'sarcastic': -0.05,
    'serious':   -0.08,
    'sad':       -0.12,
    'default':    0.00,
}
EMOTION_PAUSE_MS = {
    'excited':   350,
    'confident': 380,
    'angry':     320,
    'sarcastic': 300,
    'serious':   550,
    'sad':       650,
    'default':   280,
}

def emotion_for(sentence: str) -> str:
    s = sentence.strip()
    if re.search(r'legen|legendary|awesome|amazing|incredible', s, re.I):
        return 'excited'
    if re.search(r'suit up|challenge accepted|new is always better', s, re.I):
        return 'confident'
    if re.search(r'miss you|missed you|sorry|hurts|lonely|my dad|wish he', s, re.I):
        return 'sad'
    if re.search(r'true story|bro code|the playbook', s, re.I):
        return 'serious'
    if s.endswith('!') and re.search(r'no+!|stop it|never|come on', s, re.I):
        return 'angry'
    if '?' in s:
        return 'sarcastic'
    if s.endswith('!'):
        return 'confident'
    if re.search(r'\.{2,}|—|…', s):
        return 'confident'
    return 'default'

def exaggeration_for(s: str) -> float:
    delta = EMOTION_EXAG_DELTA.get(emotion_for(s), 0.0)
    return min(max(BASE_EXAG + delta, 0.25), 0.75)

def split_sentences(text: str) -> list:
    text = re.sub(r'—', ' — ', text)
    chunks = re.split(r'(?<=[.!?])\s+', text.strip())
    result = []
    for c in chunks:
        result.extend(re.split(r'(?<=[;:])\s+', c))
    return [c.strip() for c in result if c.strip()]

def silence_for(s: str) -> np.ndarray:
    if re.search(r'wait for it', s, re.I):
        ms = 2500
    elif re.search(r'—|…', s):
        ms = 1800
    elif re.search(r'\.{2,}', s):
        ms = 900
    else:
        ms = EMOTION_PAUSE_MS.get(emotion_for(s), 280)
    return np.zeros(int(_sr * ms / 1000), dtype=np.float32)

def strip_trailing_silence(audio: np.ndarray, threshold_db: float = -45.0) -> np.ndarray:
    thr = 10 ** (threshold_db / 20.0)
    hop, frame = 256, 1024
    last = len(audio)
    for end in range(len(audio), frame, -hop):
        rms = np.sqrt(np.mean(audio[max(0, end - frame):end] ** 2))
        if rms > thr:
            last = end
            break
    return audio[:min(last + int(0.03 * _sr), len(audio))]

def cap_internal_silence(audio: np.ndarray, max_gap_ms: float = 450.0,
                          target_ms: float = 180.0, threshold_db: float = -36.0) -> np.ndarray:
    """Shrink any interior silence run longer than max_gap_ms down to target_ms.

    Chatterbox occasionally samples an unnaturally long pause mid-sentence
    (a hesitation, not a deliberate dramatic beat) — this happens more often
    at higher temperature. Measured up to ~30% of generations having a
    1-2s dead-air gap. This trims those without touching pitch or timbre,
    unlike the reference-clip's own scripted pauses which are added
    separately via silence_for() between sentences.
    """
    thr = 10 ** (threshold_db / 20.0)
    hop, frame = 256, 1024
    n_frames = 1 + max(0, (len(audio) - frame)) // hop
    if n_frames <= 0:
        return audio
    rms = np.array([np.sqrt(np.mean(audio[i*hop:i*hop+frame] ** 2)) for i in range(n_frames)])
    is_silent = rms < thr

    dur_ms = len(audio) / _sr * 1000
    trim_budget_ms = 0.5 * dur_ms  # never remove more than half the sentence
    target_samples = int(target_ms / 1000 * _sr)
    out = []
    last_cut = 0
    trimmed_ms = 0.0
    i = 0
    while i < n_frames:
        if is_silent[i]:
            j = i
            while j < n_frames and is_silent[j]:
                j += 1
            start_sample, end_sample = i * hop, j * hop
            gap_ms = (end_sample - start_sample) / _sr * 1000
            # Only trim a run that's sandwiched between real speech on both
            # sides. A run touching frame 0 or the last frame isn't a
            # mid-sentence hesitation — for a quiet/soft-spoken sentence
            # (lower exaggeration, e.g. "sad"/"serious" emotion) the ENTIRE
            # clip can register as "silent" against a fixed dB threshold,
            # and without this guard the whole sentence gets wiped to
            # near-nothing while its text is still shown — audible as a
            # missing sentence with no matching voice.
            is_interior = i > 0 and j < n_frames
            if gap_ms > max_gap_ms and is_interior and trimmed_ms + (gap_ms - target_ms) <= trim_budget_ms:
                out.append(audio[last_cut:start_sample])
                out.append(np.zeros(target_samples, dtype=audio.dtype))
                last_cut = end_sample
                trimmed_ms += gap_ms - target_ms
            i = j
        else:
            i += 1
    out.append(audio[last_cut:])
    return np.concatenate(out) if len(out) > 1 else audio

def loudnorm(audio: np.ndarray, target_lufs: float = -20.0) -> np.ndarray:
    rms = np.sqrt(np.mean(audio ** 2))
    if rms < 1e-9: return audio
    gain = (10 ** (target_lufs / 20.0)) / rms
    return np.clip(audio * gain, -1.0, 1.0)

def synthesize(text: str) -> bytes:
    sentences = split_sentences(text)
    print(f"[TTS] {len(sentences)} sentence(s)", flush=True)

    chunks = []
    for i, sentence in enumerate(sentences):
        exag = exaggeration_for(sentence)
        emo = emotion_for(sentence)
        preview = sentence[:55] + "…" if len(sentence) > 55 else sentence
        print(f"  [{i+1}] emotion={emo} exag={exag:.2f}  \"{preview}\"", flush=True)
        # audio_prompt_path=None reuses the conditionals embedded once at
        # startup instead of re-embedding the reference clip on every call.
        wav = _model.generate(sentence, audio_prompt_path=None,
                              exaggeration=exag, cfg_weight=CFG_WEIGHT,
                              temperature=TEMPERATURE)
        audio = wav.squeeze().cpu().numpy().astype(np.float32)
        audio = cap_internal_silence(audio)
        audio = strip_trailing_silence(audio)
        chunks.append(audio)
        if i < len(sentences) - 1:
            chunks.append(silence_for(sentence))

    combined = np.concatenate(chunks)
    combined = loudnorm(combined)
    # No pitch shift — Chatterbox clones voice directly from reference audio.
    # Pitch shifting was making it sound robotic.
    buf = io.BytesIO()
    sf.write(buf, combined, _sr, format="WAV")
    buf.seek(0)
    return buf.read()

# ── Routes ─────────────────────────────────────────────────────────────
@app.route("/synthesize", methods=["POST"])
def route_synthesize():
    data = request.get_json(force=True)
    text = data.get("text") if isinstance(data, dict) else None
    if not isinstance(text, str) or not text.strip() or len(text) > 4000:
        return Response("No text", status=400)
    try:
        with _gpu_lock:
            wav_bytes = synthesize(text)
        return Response(wav_bytes, mimetype="audio/wav")
    except Exception as e:
        print(f"[TTS] Error: {e}", flush=True)
        return Response("Voice generation failed", status=500)

@app.route("/synthesize/chatterbox", methods=["POST"])
def route_chatterbox():
    return route_synthesize()

@app.route("/health")
def health():
    return "ok"

# ── edge-tts backend (zero-GPU fallback — used if Chatterbox/CUDA is down) ──
EDGE_VOICE    = os.environ.get("EDGE_VOICE", "en-US-GuyNeural")
EDGE_RATE     = int(os.environ.get("EDGE_RATE", "10"))
EDGE_PRES_DB  = float(os.environ.get("EDGE_PRES_DB", "2"))

def synthesize_edge(text: str) -> bytes:
    import asyncio, edge_tts
    sentences = split_sentences(text)
    print(f"[Edge] {len(sentences)} sentence(s) voice={EDGE_VOICE}", flush=True)

    async def _gen(sentence: str) -> bytes:
        rate_str = f"+{EDGE_RATE}%" if EDGE_RATE >= 0 else f"{EDGE_RATE}%"
        comm = edge_tts.Communicate(sentence, EDGE_VOICE, rate=rate_str)
        buf = b""
        async for chunk in comm.stream():
            if chunk["type"] == "audio":
                buf += chunk["data"]
        return buf

    chunks = []
    sr_edge = None
    for i, sentence in enumerate(sentences):
        raw = asyncio.run(_gen(sentence))
        if not raw:
            continue
        import io as _io
        audio, sr = sf.read(_io.BytesIO(raw))
        if sr_edge is None:
            sr_edge = sr
        audio = audio.astype(np.float32)
        if audio.ndim > 1:
            audio = audio.mean(axis=1)
        audio = strip_trailing_silence(audio)
        chunks.append(audio)
        if i < len(sentences) - 1:
            chunks.append(silence_for(sentence))

    if not chunks:
        return b""

    combined = np.concatenate(chunks)
    combined = loudnorm(combined)

    # Presence boost (+2 dB around 1.5–3 kHz for presence/intelligibility)
    if abs(EDGE_PRES_DB) > 0.1:
        try:
            import scipy.signal as _ss
            low  = 1500 / (sr_edge / 2)
            high = min(3000 / (sr_edge / 2), 0.99)
            b, a = _ss.butter(2, [low, high], btype='band')
            presence = _ss.filtfilt(b, a, combined)
            combined = np.clip(combined + (10 ** (EDGE_PRES_DB / 20) - 1) * presence, -1.0, 1.0)
        except Exception as e:
            print(f"[Edge] EQ skipped: {e}", flush=True)

    combined = loudnorm(combined)
    buf = io.BytesIO()
    sf.write(buf, combined, sr_edge, format="WAV")
    buf.seek(0)
    return buf.read()

@app.route("/synthesize/edge", methods=["POST"])
def route_edge():
    data = request.get_json(force=True)
    text = data.get("text") if isinstance(data, dict) else None
    if not isinstance(text, str) or not text.strip() or len(text) > 4000:
        return Response("No text", status=400)
    try:
        wav_bytes = synthesize_edge(text)
        return Response(wav_bytes, mimetype="audio/wav")
    except Exception as e:
        print(f"[Edge] Error: {e}", flush=True)
        return Response("Voice generation failed", status=500)

if __name__ == "__main__":
    app.run(host="127.0.0.1", port=TTS_PORT, threaded=True)
