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
2. Click the extension icon → set your filters → hit **Extract**
3. If the visible feed has fewer posts than requested, the extension
   auto-scrolls and keeps collecting until it hits the target or the end
   of the feed. Collection continues even if you close the popup.
4. The result is **copied to your clipboard automatically** → paste into your AI tool

Filters are applied as an AND condition: a post is kept only if it matches
the keyword filter *and* meets the minimum character length.

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
| Max count | 50 | How many posts to collect (1–1000, ±5 per step) |
| Keyword filter | — | Comma-separated, OR match, case-insensitive |
| Min characters | 0 | Keep posts whose body is **at least** N characters. `0` disables it |
| Max replies | 15 | Drop posts with **at least** N replies. `0` disables it |
| Max age | 24h | Drop posts older than N hours. `0` disables it |
| Skip replied accounts | ON | Drop accounts you already replied to today |
| Include ads | OFF | Include promoted/sponsored posts |

Notes:

- **Min characters** counts code points after collapsing whitespace, so one
  emoji counts as one character. Quoted post text is not counted.
- **1000 posts is realistic on X only.** Quora caps out around 110 posts due to
  a server-side rate limit, and Threads/Reddit usually reach the end of the feed
  first. Collection stops cleanly and returns whatever was gathered.
- Large targets take minutes. The popup can be closed while it runs.
- **Max replies / Max age** need data the platform exposes. Posts where the
  reply count or timestamp can't be read are kept rather than dropped.
- **Skip replied accounts** is recorded automatically: the extension watches for
  reply submissions on X and stores the target handle for the current day.
  The list resets daily.

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

## Changelog

### 1.13.0
- Reply-count filter, post-age filter, and same-day replied-account exclusion
- "Show more" is now expanded during scroll collection, so long posts are no
  longer truncated when they scroll out of the virtualized feed

### 1.12.0
- Popup UI is fixed to English regardless of browser language

### 1.11.x
- Minimum character length filter (always visible, `0` = off)
- Max count raised from 200 to 1000, with a scroll budget that scales to the target
- Stepper buttons move in increments of 5
- Copy button removed — results are copied automatically on completion
- Include-ads toggle moved to the bottom; popup uses the full available height
- Settings saved by the previous toggle-based build are migrated on load

### 1.9.2
- Fixed X ad filtering: the promoted marker sits on an ancestor of the tweet
  element, not inside it, so ads were slipping through

## Privacy

All text extraction happens locally in your browser. No data is transmitted to any server. Optional email signup on the welcome page is the only network call (stored via Supabase).

Full policy: [Privacy Policy](https://ysajang.github.io/sns-feed-extractor/privacy)

## License

GPL-3.0
