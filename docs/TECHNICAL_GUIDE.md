[← Project overview](../README.md)

# Barney Voice Assistant

A character-inspired chat and voice demo with a browser interface, an Express API, Groq chat completions, and a persistent Python speech service. This is an unofficial fan project, not an affiliation with the show, its creators, or performers.

## Features

- Multi-turn chat with a limited recent-history window.
- Browser speech input where supported and switchable audio responses.
- Persistent Chatterbox speech model with optional reference audio, sentence-level expressiveness, silence trimming, and normalization.
- An alternative Edge TTS endpoint and browser-local chat history.
- Input validation and local-only server binding by default.

## Quick start: text chat

Requires Node.js 22 or 24 and a Groq API key.

~~~sh
npm ci
~~~

Copy .env.example to .env, set GROQ_API_KEY, and keep TTS_AUTOSTART=false for text-only evaluation. Configure GROQ_MODEL and GROQ_FALLBACK_MODEL to models available to your account.

~~~sh
npm start
~~~

Open http://localhost:3000 and turn off Voice for text-only use. Chat messages are sent to Groq. History is saved in this browser's local storage; clearing site data removes it.

## Optional voice setup

Use a separate Python 3.11 virtual environment and install requirements_voice.txt. Chatterbox depends on PyTorch; GPU support requires a compatible installation and driver. CPU operation can be slow. The first startup downloads model weights and can take substantial time and disk space.

~~~sh
python -m venv .venv
~~~

Activate the environment, then:

~~~sh
python -m pip install -r requirements_voice.txt
python tts_server.py
~~~

Wait for the model-ready message, then start the Node server. Alternatively set PYTHON_CMD to your virtual environment's Python executable and TTS_AUTOSTART=true. The speech service listens on 127.0.0.1:5050.

BARNEY_VOICE_REF is optional. Leave it empty for the model's default voice or supply a local recording you have permission to use. No performer recordings, generated audio, or model weights are distributed in this repository.

The current Python service loads Chatterbox on startup even when Edge is selected; Edge is an alternative synthesis backend, not an independent lightweight startup mode. Edge speech also requires network access. Voice output and timing vary by hardware and provider.

## API

- POST /api/chat — {"message":"Hello","history":[]} → {"reply":"..."}.
- POST /api/tts/chatterbox — {"text":"Hello"} → WAV audio.
- POST /api/tts/edge — the same request shape, using Edge speech.
- POST /api/tts — alias for Chatterbox.

Messages and speech requests are limited to 4,000 characters. History accepts user/assistant text messages only. Missing chat credentials return a configuration error without exposing a key.

## Tests

~~~sh
npm test
~~~

The tests validate malformed-input handling and missing-key behavior without calling a model or loading Python. They do not validate live provider availability, audio quality, or GPU compatibility.

## Structure and limitations

server.js serves the UI and proxies chat/speech calls; tts_server.py performs audio generation; public/ contains the interface; tests/ exercises the HTTP boundary. The app is intended for local demos. It has no user authentication or production rate limiting. Do not expose the paid-provider endpoints publicly without those controls. Never commit .env, voice recordings, or model files.

## Review results

See [publication validation](../VALIDATION.md) for the checks performed, fixes, and unverified integrations.

