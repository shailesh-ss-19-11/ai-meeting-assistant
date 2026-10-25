# AI Meeting Assistant

Electron assistant window with screen/window capture and local OCR, a Node.js API that calls your AI provider, microphone transcription, and a Chrome extension that syncs meeting notes to the desktop app. The UI is plain HTML/CSS/JS (no React).

## Requirements

- Node.js 20+
- macOS, Windows or Linux
- An OpenAI-compatible API key (chat model + transcription model)

## Quick start

```bash
npm run install:all   # once
npm start             # opens the app (it starts its own local server)
```

1. In **AI provider**, choose a provider and model, paste your API key, click **Save provider**. The key is encrypted with your OS keychain and remembered, so you only do this once.
2. Choose a screen/window and click **Capture & analyze**, or click **Start transcription** to transcribe the microphone. You will be asked to confirm before either sends anything to your provider.

No `.env` file or token setup is needed; the app generates its own local token. (`server/.env` is optional and only supplies defaults when you run `npm run server` by hand.)

## Choosing a provider and model

In the desktop app's **AI provider** card pick a provider (27 presets including OpenAI, Anthropic, Gemini, Groq, Mistral, DeepSeek, xAI, OpenRouter, Together, Fireworks, Cerebras, Cohere, Perplexity, NVIDIA, Hugging Face, GitHub Models, Kimi, Qwen, GLM, local Ollama and LM Studio, or Custom for any OpenAI-compatible URL), pick a model (or **Custom…**), paste your API key and click **Save provider**. The ⟳ button saves and then loads the provider's live model list. The key is sent only to the built-in local server and stored encrypted via the OS keychain. Microphone transcription works only with providers that offer a transcription endpoint (OpenAI and Groq presets); others are chat-only.

## Using it

1. **Screen capture**: pick a screen/window, click **Capture & analyze** or press `Cmd/Ctrl+Shift+Space`. Text is read locally by OCR, then sent to your AI provider to generate a suggestion.
2. **Periodic scanning**: the toggle asks for confirmation, shows a "SCANNING" badge, and re-asks the provider only when the screen text changed.
3. **Transcription**: **Start transcription** asks for confirmation, shows a "RECORDING MIC" badge, and sends 8-second microphone segments to your provider until you click **Stop**. Spoken questions can be answered with **Suggest answer to latest question**.
4. **Extension (optional)**: Chrome → `chrome://extensions` → Developer mode → **Load unpacked** → select `extension/`. In the desktop app open **Chrome extension (optional)** and click **Copy token**, paste it in the extension popup, write notes, **Send to desktop**. Context appears within ~3 seconds.

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
- **"Port 8787 is already in use"**: close any separately started `npm run server` and restart.
- **"Bridge token…" in the extension**: copy the token again from the desktop app.
- **401 from "AI provider"**: wrong `OPENAI_API_KEY`/`AI_BASE_URL`. A 404/400 usually means the model name isn't available; fix `AI_MODEL`.
- **First OCR is slow or fails offline**: it downloads English language data once, then caches it.
- **Shortcut does nothing**: another app owns it; use the button.
- **Extension "Failed to fetch"**: the server isn't running, or Chrome blocked local network access; allow it.

## Standalone Chrome extension (`chrome-assistant/`)

Works without the desktop app, also on Windows. It hears the other side of a call in the current tab, transcribes it with Groq Whisper and shows a suggested reply in a floating panel on the page. One Groq key is all it needs.

1. Chrome → `chrome://extensions` → Developer mode → **Load unpacked** → select `chrome-assistant/`.
2. Open the meeting tab, click the extension icon, paste your Groq key and press **Save & start on this tab**.
3. Use **Pause / Start** and **✕** on the panel. The key is stored in `chrome.storage.local` (not encrypted).

The panel lives inside the page, so sharing that tab shows it to others; share a different window or tab to keep it private. It does not read the screen.
