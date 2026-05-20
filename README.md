# SNS Feed Text Extractor

Extract clean text from social media feeds in one click. Built for AI workflows.

Grab @handles, post text, and timestamps from your feed — paste directly into ChatGPT, Claude, or any LLM for reply targeting, content analysis, and marketing research.

## Supported Platforms

| Platform | Status |
|----------|--------|
| X (Twitter) | ✅ Supported |
| Threads | ✅ Supported |
| Reddit | ✅ Supported |
| Quora | ✅ Supported |

## Install

1. Download or clone this repo
2. Open `chrome://extensions` in Chrome
3. Enable **Developer mode** (top right)
4. Click **Load unpacked** and select the project folder

## How It Works

1. Open any supported platform in your browser
2. Scroll to load the posts you want
3. Click the extension icon → hit **Extract**
4. Review the output → **Copy** to clipboard → paste into your AI tool

## Output Format

```
@handle · 2h
Post body text here

@handle2 · 5m
Another post body text
```

## Options

| Option | Default | Description |
|--------|---------|-------------|
| Remove links | ON | Strip shortened URLs from text |
| Include ads | OFF | Include promoted/sponsored posts |
| Max count | 50 | Limit: 20 / 50 / 100 / 200 |
| Auto-scroll | OFF | Scroll and collect automatically |

## Architecture

```
sns-feed-extractor/
├── manifest.json
├── privacy.html
├── icons/
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
└── src/
    ├── background.js
    ├── content.js
    ├── popup.html
    ├── popup.css
    ├── popup.js
    ├── welcome.html
    ├── welcome.js
    └── platforms/
        ├── x.js
        ├── threads.js
        ├── reddit.js
        └── quora.js
```

- **Manifest V3** with minimal permissions
- Platform-specific parsers under `src/platforms/`
- Content script message bridge (`content.js`)
- Background service worker for onInstall welcome page
- All extraction runs locally — no data sent to external servers

## Privacy

All text extraction happens locally in your browser. No data is transmitted to any server. Optional email signup on the welcome page is the only network call (stored via Supabase).

Full policy: [Privacy Policy](https://ysajang.github.io/sns-feed-extractor/privacy)

## License

GPL-3.0
