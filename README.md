# AI Meeting Assistant

Electron assistant window with screen/window capture and local OCR, a Node.js API that calls your AI provider, microphone transcription, and a Chrome extension that syncs meeting notes to the desktop app. The UI is plain HTML/CSS/JS (no React).

## Requirements

- Node.js 20+
- macOS, Windows or Linux
- An OpenAI-compatible API key (chat model + transcription model)

## Setup

```bash
npm run install:all                 # installs server/ and desktop/ (lockfiles included)
cp server/.env.example server/.env  # then edit it
```

Edit `server/.env`:

| Variable | Purpose |
| --- | --- |
| `OPENAI_API_KEY` | Your provider key. Stays in the server process only. |
| `AI_MODEL` | Chat model for suggestions (default `gpt-4o-mini`). |
| `AI_TRANSCRIPTION_MODEL` | Speech-to-text model (default `gpt-4o-mini-transcribe`). |
| `AI_BASE_URL` | Provider base URL for OpenAI-compatible APIs. |
| `BRIDGE_TOKEN` | Required, 32+ chars (`openssl rand -hex 32`). Protects every `/api` route. |

## Choosing a provider and model

In the desktop app's **AI provider** card pick a provider (27 presets including OpenAI, Anthropic, Gemini, Groq, Mistral, DeepSeek, xAI, OpenRouter, Together, Fireworks, Cerebras, Cohere, Perplexity, NVIDIA, Hugging Face, GitHub Models, Kimi, Qwen, GLM, local Ollama and LM Studio, or Custom for any OpenAI-compatible URL), pick a model (or **Custom…**), paste your API key and click **Save provider**. The ⟳ button saves and then loads the provider's live model list. The key is sent only to the local server and kept in memory (re-enter it after a server restart); `.env` values are just defaults. Microphone transcription works only with providers that offer a transcription endpoint (OpenAI and Groq presets); others are chat-only.

## Run

Terminal 1: `npm run server` (listens on `127.0.0.1:8787` only).
Terminal 2: `npm run desktop`.

The desktop app prefills the token from `server/.env` when run from this repo; otherwise paste it into the **Extension bridge token** field. It is needed for AI, transcription and sync.

1. **Screen capture**: pick a screen/window, click **Capture & analyze** or press `Cmd/Ctrl+Shift+Space`. Text is read locally by OCR, then sent to your AI provider to generate a suggestion.
2. **Periodic scanning**: the toggle asks for confirmation, shows a "SCANNING" badge, and re-asks the provider only when the screen text changed.
3. **Transcription**: **Start transcription** asks for confirmation, shows a "RECORDING MIC" badge, and sends 8-second microphone segments to your provider until you click **Stop**. Spoken questions can be answered with **Suggest answer to latest question**.
4. **Extension**: Chrome → `chrome://extensions` → Developer mode → **Load unpacked** → select `extension/`. Enter the same `BRIDGE_TOKEN`, write notes, **Send to desktop**. In the desktop app click **Connect extension**; context appears within ~3 seconds.

## Tests

`npm test` starts the server against a mock AI provider and checks token enforcement (valid and invalid), context sync, input validation, answer streaming and transcription. It uses no real key and sends nothing externally.

## Privacy

- Extracted screen text and microphone audio go to the provider configured in `AI_BASE_URL`. Get everyone's consent before transcribing a meeting.
- Nothing is recorded or scanned without a click; audio and transcripts are not written to disk.
- The API is bound to loopback, requires the token, and does not log meeting content.
- The assistant window may be visible in full-desktop shares. Test your sharing setup; this app does not promise invisibility.

## Troubleshooting

- **"Screen Recording permission is not granted"** (macOS): System Settings → Privacy & Security → Screen Recording → enable Electron (or your terminal), restart the app.
- **Microphone denied**: enable it under Privacy & Security → Microphone, then restart.
- **401 "Bridge token…"**: token in the app/extension differs from `server/.env`. **503**: `BRIDGE_TOKEN` missing or under 32 chars.
- **401 from "AI provider"**: wrong `OPENAI_API_KEY`/`AI_BASE_URL`. A 404/400 usually means the model name isn't available; fix `AI_MODEL`.
- **First OCR is slow or fails offline**: it downloads English language data once, then caches it.
- **Shortcut does nothing**: another app owns it; use the button.
- **Extension "Failed to fetch"**: the server isn't running, or Chrome blocked local network access; allow it.
