# InterviewAI Pro v2.0
### Stealth AI Interview Assistant for Windows

> Real-time AI answers, floating on your screen — **completely invisible during screen share.**

---

## ⚡ Quick Start

1. Install [Node.js LTS](https://nodejs.org) if not already installed
2. Unzip this folder anywhere on your PC
3. Double-click **`START.bat`**
4. Enter your [Anthropic API key](https://console.anthropic.com) in the app
5. Fill your profile (CV summary + target company)
6. Click **Start Listening** before your interview begins

---

## Features

### 🎙 Live Mic Transcription
- Detects when the interviewer finishes speaking (1.5s silence detection)
- Auto-triggers AI answer generation immediately
- Works in Chrome's Chromium engine built into the app

### 🤖 AI-Powered Answers
- Powered by Claude Sonnet (Anthropic)
- Optional Z.AI GLM-4.7-Flash provider through Z.AI's official OpenAI-compatible API
- Existing Grok and Deepgram integrations remain available
- Streams answers word-by-word in real time
- Personalized to your CV, target role, and company
- 4 answer styles: STAR, Concise, Detailed, Casual

### Reference Material
- Attach multiple PDF, DOCX, TXT, Markdown, CSV, PNG, JPG, or JPEG files
- Drag-and-drop or click-to-upload from the Live tab
- Extracted text is chunked locally and only the most relevant sections are added to answer prompts
- Image files are tracked as attachments; OCR is not bundled in this local build

### 👤 Profile System
- Upload your experience summary — AI answers reference your actual background
- Set target company — answers align with that company's culture
- Choose your role mode: SWE, PM, Data Analyst, Sales, Marketing, Finance, General
- Set job description keywords for extra relevance

### 🕵️ Stealth Overlay
- **Invisible in Zoom, Google Meet, Microsoft Teams, OBS, and all screen recorders**
- Uses Windows `SetContentProtection` API — same tech used by Netflix and banking apps
- Draggable — position it anywhere on any monitor
- Adjustable opacity (10%–100%)
- 3 themes: Dark, Midnight, Light
- Adjustable font size (11px–20px)
- Multi-monitor support — send overlay to any connected display

### 📋 Session History
- Every interview session is automatically saved
- Export any session as a `.txt` report file
- Review all Q&As after the interview for follow-up prep
- Stores up to 50 sessions locally

### ⌨️ Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl+Shift+H` | Hide / show overlay instantly |
| `Ctrl+Shift+C` | Focus control panel |
| `Ctrl+Shift+↑` | Increase overlay opacity |
| `Ctrl+Shift+↓` | Decrease overlay opacity |
| `Ctrl+Shift+←` | Nudge overlay left |
| `Ctrl+Shift+→` | Nudge overlay right |

---

## Architecture

```
interviewai-pro/
├── START.bat           ← Double-click to launch
├── package.json        ← Node/Electron config
└── src/
    ├── main.js         ← Electron main process
    │                      Manages windows, IPC, shortcuts,
    │                      session storage, file export
    ├── control.html    ← Control panel UI
    │                      API key, mic, profile, settings,
    │                      session history tabs
    └── overlay.html    ← Stealth floating overlay
                           Renders Q&A, bookmark, themes
```

**How stealth works:**
```
overlayWin.setContentProtection(true)
```
This single line tells Windows to exclude the window from all DirectX/GDI capture operations. Screen sharing software (Zoom, Teams, OBS) captures the screen at the DirectX level — they receive a black/empty region where this window sits. Your physical GPU still renders it to your monitor normally.

---

## Selling This Product

### Recommended Pricing
| Tier | Price | Limits |
|---|---|---|
| Free | $0 | 10 questions/day |
| Pro | $19/month | Unlimited, all features |
| Lifetime | $79 once | Everything forever |

### Recommended Sales Channels
- **Gumroad** — sell license keys, instant setup, handles GST/VAT
- **LemonSqueezy** — better for subscriptions, built-in license key system
- **ProductHunt** — launch for initial traction
- **Reddit** — r/cscareerquestions, r/jobs, r/interviews
- **LinkedIn** — target job seekers, recently laid off professionals

### To Add License Key Protection
1. Generate keys on LemonSqueezy or Gumroad
2. On app launch, call their validation API with the user's key
3. If invalid → show paywall screen, disable features
4. Keys can be set to expire monthly for subscription enforcement

---

## Requirements
- Windows 10 / 11 (64-bit)
- Node.js 18+ (LTS recommended)
- Anthropic, xAI, Deepgram, or Z.AI API key depending on selected provider
- Internet connection
- Chrome/Edge-based mic support (built into Electron)

## Z.AI Setup
1. Create a Z.AI API key in the Z.AI developer console
2. Either paste the key into the app after selecting **Z.AI GLM-4.7**, or set `ZAI_API_KEY`
3. Optional: set `ZAI_API_BASE` to override the default `https://api.z.ai/api/paas/v4`
4. Start the app with `npm start` or `START.bat`

The app uses the `glm-4.7-flash` model id, streaming chat completions, conversation/session history, and the same profile/system prompt context as existing providers.

---

## Privacy
- API key stored locally in `%APPDATA%/interviewai-pro/settings.json`
- Session history stored locally in `%APPDATA%/interviewai-pro/sessions.json`
- Questions are sent only to the provider selected in the app
- Reference files are processed locally; extracted snippets are sent only as prompt context to the selected answer provider
- No analytics, no tracking, no account required

---

## Troubleshooting

**Overlay still visible in screen share?**
Share a specific *application window* (e.g. "Chrome - Google Meet") rather than "Entire Screen". Application window sharing never captures protected windows.

**Mic not working?**
Use the Manual Input textarea. Type the question and press Enter or click Ask.

**"npm not found" error?**
Install Node.js from nodejs.org, restart your PC, then run START.bat again.

**Slow first answer?**
The first API call warms up the connection. Subsequent answers are faster.
