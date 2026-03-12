# Model Watcher

 scanners for AI APIs, USPTO trademarks, and releases with Discord notifications.

## Features

- **API Scanner** - Scans multiple OpenAI-compatible APIs hourly, detects new/removed/updated models
- **USPTO Watcher** - Tracks trademark filings from tech companies
- **Releases Watcher** - Tracks GitHub releases and npm package updates
- **RSS/X Watcher** - Monitors RSS feeds and X.com accounts
- Discord notifications via webhooks (with group support)
- JSON logging with full change diffs
- API key sanitization in all logs

## Trackers

### API Scanner (`npm run scan`)
Scans OpenAI-compatible API endpoints for model changes.

### USPTO Watcher (`npm run uspto`)
Tracks trademark filings from uspto.report. Requires `USPTO_WEBHOOK` secret.

### Releases Watcher (`npm run releases`)
Tracks GitHub releases and npm package updates. Requires `RELEASES_WEBHOOK` secret.

### RSS/X Watcher (`npm run rss`, `npm run posts`)
Monitors RSS feeds and X.com accounts.

## Quick Start

1. **Fork or clone this repo**

2. **Add secrets to GitHub** (Settings → Secrets and variables → Actions):
   - `WEBHOOK` - Discord webhook for API scanner
   - `USPTO_WEBHOOK` - Discord webhook for USPTO tracker
   - `RELEASES_WEBHOOK` - Discord webhook for releases tracker
   - `RSS_WEBHOOK` - Discord webhook for RSS/X watcher
   - API keys for providers you want to scan

3. **Customize config files** - Edit `config.json`, `uspto-config.json`, `releases-config.json`

4. **Run manually** - Use GitHub Actions "Run workflow" button

## Configuration

### API Scanner
Edit `config.json`:
```json
{
  "endpoints": [
    {
      "name": "OpenAI",
      "baseUrl": "https://api.openai.com/v1",
      "apiKeyEnv": "OPENAI_API_KEY",
      "modelsEndpoint": "/models",
      "group": "default"
    }
  ]
}
```

### USPTO Watcher
Edit `uspto-config.json`:
```json
{
  "companies": [
    { "name": "Google LLC", "slug": "Google-L-L-C" },
    { "name": "OpenAI OpCo LLC", "slug": "Openai-Opco-L-L-C" }
  ]
}
```

### Releases Watcher
Edit `releases-config.json`:
```json
{
  "github": {
    "repositories": [
      { "owner": "openai", "repo": "openai-python" }
    ]
  },
  "npm": {
    "packages": ["openai", "anthropic"]
  }
}
```

## Local Development

```bash
# Install dependencies
npm install

# Run scanners (requires appropriate env vars)
npm run scan        # API scanner
npm run uspto       # USPTO tracker
npm run releases    # GitHub/npm tracker
npm run rss        # RSS watcher
npm run posts      # X.com watcher
```

## Security

- All API keys are stored as GitHub Secrets
- API keys are redacted in all log output
- Runs in an isolated GitHub Actions environment

## License

MIT
