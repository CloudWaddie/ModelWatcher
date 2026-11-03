# Model Watcher

A comprehensive monitoring suite for the AI ecosystem. ModelWatcher tracks changes across OpenAI-compatible APIs, app stores, trademark filings, and leaderboard rankings with deep-diff analysis and instant Discord notifications.

## 🚀 Key Features

### 🧠 Model & API Monitoring
- **Deep Comparison Engine**: Beyond simple detection, ModelWatcher performs recursive diffing of model metadata.
- **Granular Field Tracking**: Monitors `rank`, `availability`, `identity`, and `modalities`.
- **Capability Emojis**: Visual shorthand for model features:
  - 📝 Text input | 🖼️ Image input | 📎 File input
  - 💬 Text output | 🎨 Image generation | 🌐 Web access | 🔍 Search

### 📱 App Store Intelligence
- **Platform Tracking**: Monitors iOS App Store and Google Play Store for version updates.
- **Change Detection**: Extracts release notes, version strings, and app descriptions.
- **Android String Diffing**: Detects changes in app internal string resources and generates diffs.

### ⚖️ USPTO & IP Tracking
- **Trademark Monitoring**: Scans USPTO filings for new AI-related trademarks from major labs.
- **Filing Details**: Captures serial numbers, dates, and trademark images.

### 🌐 Gemini Web App Tracker
`npm run gemini-web` · config: `gemini-web-config.json` · webhook: `TOMBSTONE_WEBHOOK` · workflow: `gemini-web-watch.yml` (every 3h)

Unauthenticated multi-target scanner. A change in a site's **backend build** (`boq_…_YYYYMMDD.NN_pN`) always sends its own alert first.

| Target | What is tracked |
|---|---|
| **Gemini Web App** (`gemini.google.com/app`) | server build + JS/islands build keys · **pre-release signals from the app code** (~390 chunks): *dark features* (feature/capability codenames such as `FEATURE_MODE_BLUEDOG`, `CAN_ENROLL_IN_AUREUS`, `CAN_USE_SUPERPROJECTS` that exist in code but have no UI text), the **GraphQL backend schema** (types, fields, persisted-query IDs), **server feature flags the client reads** (grouped by module), capability/tier gates, model-picker tiers, routes, internal hosts, banner/upsell IDs, server-driven response node types · ~140 UI string bundles + Gemini-in-Chrome (`glic/`) bundles · lazy pages · feature toggles · official **release notes**, **Gemini Drops**, **latest news**, **plans & prices**, **usage limits**, **roadmap language** ("rolling out", "beta", "coming months") across ~25 marketing pages, and both sitemaps |
| **AI Studio** (`aistudio.google.com/welcome` — `/app` redirects to sign-in) | server build · feature toggles · **RPC methods / backend services / routes / model IDs / announcement-like strings** from the main bundle · docs index (`llms.txt`) + changelog, deprecations, pricing, rate limits, model lists |
| **Google Flow** (`flow.google.com`; Whisk/ImageFX/VideoFX redirect here) | server build · feature toggles |
| **Google Labs** (`labs.google`) | experiment cards (CTA changes such as *Join Waitlist → Try it now*), featured and "graduated" products · sitemaps · build |
| **Labs FX** (`labs.google/fx`), **Flow Music** (`flowmusic.app`) | Next.js build ID · route table (incl. `/admin/*`) · i18n strings |

**Noise control**: the page is fetched several times per run; keys that differ between samples are ignored. Generic WIZ flags/config are *not* reported. Experiment IDs only alert on bursts (`experimentAlertMin`). The first run reports everything as new (capped); later runs report only real changes.

### 🛸 Antigravity Tracker
`npm run antigravity` · config: `antigravity-config.json` · webhook: `TOMBSTONE_WEBHOOK` · runs in `gemini-web-watch.yml`
- **Releases** (dedicated alert): CLI `agy` (public manifest API, all platforms), desktop app, IDE (from the download page's storage URLs), VS Code extension (Marketplace API). The Android app is in `app-version-config.json`.
- **Static scan of each new CLI / extension build** (downloaded, checksum-verified against the manifest, never executed): internal model enums (e.g. `MODEL_GOOGLE_GEMINI_<CODENAME>`), model IDs, `JETSKI_*` internal switches, extension commands/settings/changelog. The first run posts one compact baseline message; afterwards only changes are reported. Public docs don't name these; the binaries do.
- **Docs / blog**: `llms.txt` page index, changelog, models, plans, releases, sitemap, blog RSS.

### 🏆 Leaderboard & Community Watch
- **LM Arena (Chatbot Arena)**: Tracks ELO, rankings, and specific model metadata updates.
- **Design Arena**: Monitoring for design-related AI benchmarks.

## 🛠️ Setup & Configuration

### Environment Variables

ModelWatcher requires the following environment variables to be configured as **GitHub Secrets** (Settings → Secrets and variables → Actions):

#### Discord Webhooks (Required for Notifications)
| Variable | Purpose | Example |
|----------|---------|---------|
| `WEBHOOK` | Primary webhook for OpenAI, Anthropic, Google, etc. | `https://discord.com/api/webhooks/YOUR_ID/YOUR_TOKEN` |
| `WEBHOOK_SMALL` | Optional secondary webhook for community/niche providers | `https://discord.com/api/webhooks/YOUR_ID/YOUR_TOKEN` |
| `LMARENA_WEBHOOK` | LM Arena (Chatbot Arena) model updates | `https://discord.com/api/webhooks/YOUR_ID/YOUR_TOKEN` |

#### API Keys for Model Scanning (Optional - Add Only Services You Monitor)
| Service | Environment Variable | Get From |
|---------|----------------------|----------|
| OpenAI | `OPENAI_API_KEY` | [platform.openai.com/api-keys](https://platform.openai.com/api-keys) |
| Anthropic | `ANTHROPIC_API_KEY` | [console.anthropic.com](https://console.anthropic.com) |
| Google Gemini | `GEMINI_API_KEY` | [makersuite.google.com/app/apikey](https://makersuite.google.com/app/apikey) |
| GitHub Models | `GH_MODELS_API_KEY` | GitHub PAT with `models` scope |
| Groq | `GROQ_API_KEY` | [console.groq.com](https://console.groq.com) |
| Mistral | `MISTRAL_API_KEY` | [console.mistral.ai](https://console.mistral.ai) |
| Cohere | `COHERE_API_KEY` | [dashboard.cohere.ai](https://dashboard.cohere.ai) |
| Together AI | `TOGETHER_API_KEY` | [api.together.ai](https://api.together.ai) |
| DeepInfra | `DEEPINFRA_API_KEY` | [deepinfra.com](https://deepinfra.com) |
| Fireworks AI | `FIREWORKS_API_KEY` | [fireworks.ai](https://fireworks.ai) |
| OpenRouter | `OPENROUTER_API_KEY` | [openrouter.ai](https://openrouter.ai) |
| xAI (Grok) | `XAI_API_KEY` | [console.x.ai](https://console.x.ai) |
| ElevenLabs | `ELEVENLABS_API_KEY` | [elevenlabs.io/app/speech-synthesis](https://elevenlabs.io/app/speech-synthesis) |

#### App Store Monitoring (Optional)
| Variable | Purpose | Notes |
|----------|---------|-------|
| `AAS_TOKEN` | Android APK download token (required for Android string diffing) | From apkeep service |
| `APK_EMAIL` | Email address for APK extraction | Associated with AAS_TOKEN |

App version webhooks and which apps to monitor are configured in `app-version-config.json` (not env vars).

#### USPTO Trademark Monitoring (Optional)
| Variable | Purpose | Notes |
|----------|---------|-------|
| `WEBSHARE_PROXY_URL` (or custom) | Proxy URL for USPTO scraping | Optional - used if Cloudflare blocks direct access. Format: `http://user:pass@host:port` |

Trademark webhook URLs and company slugs to monitor are configured in `uspto-config.json` (not env vars).

### Configuration Files

ModelWatcher uses three main configuration files in the project root:

#### 1. `config.json` - Model API Endpoints
Edit to customize which OpenAI-compatible endpoints to scan:

```json
{
  "endpoints": [
    {
      "name": "OpenAI",
      "baseUrl": "https://api.openai.com/v1",
      "apiKeyEnv": "OPENAI_API_KEY",
      "modelsEndpoint": "/models",
      "group": "default"
    },
    {
      "name": "Groq",
      "baseUrl": "https://api.groq.com/openai/v1",
      "apiKeyEnv": "GROQ_API_KEY",
      "modelsEndpoint": "/models",
      "group": "small"
    }
  ],
  "scan": {
    "timeout": 30000,
    "retryAttempts": 2,
    "retryDelay": 1000
  },
  "discord": {
    "enabled": true,
    "webhooks": {
      "default": {
        "webhookEnv": "WEBHOOK",
        "notifyOn": ["new_model", "removed_model", "model_updated", "endpoint_error"]
      },
      "small": {
        "webhookEnv": "WEBHOOK_SMALL",
        "notifyOn": ["new_model", "removed_model", "model_updated", "endpoint_error"]
      }
    },
    "url": "https://github.com/CloudWaddie/ModelWatcher"
  }
}
```

**Required Fields for Each Endpoint:**
- `name` (string): Display name
- `baseUrl` (string): API base URL
- `apiKeyEnv` (string): Environment variable name for the API key
- `modelsEndpoint` (string, default: `/models`): Path to models list
- `group` (string, default: `default`): Webhook group for notifications

#### 2. `app-version-config.json` - iOS & Android App Monitoring (Optional)
```json
{
  "apps": [
    { "id": "com.openai.chatgpt", "platform": "android" },
    { "id": "548979808", "platform": "ios" }
  ],
  "webhooks": {
    "app": {
      "webhookEnv": "APP_WATCHER_WEBHOOK"
    }
  },
  "state": {
    "file": "logs/app-version-state.json"
  }
}
```

#### 3. `uspto-config.json` - Trademark Monitoring (Optional)
```json
{
  "companies": [
    { "name": "OpenAI", "slug": "openai" },
    { "name": "Anthropic", "slug": "anthropic" }
  ],
  "webhook": {
    "webhookEnv": "USPTO_WEBHOOK"
  },
  "proxy": {
    "enabled": false,
    "urlEnv": "WEBSHARE_PROXY_URL"
  },
  "state": {
    "file": "logs/uspto-state.json"
  }
}
```

### Webhook Groups

Route different providers to different Discord channels:
- `default`: High-priority (OpenAI, Anthropic, Google, etc.)
- `small`: Community/niche providers (Groq, DeepInfra, etc.)
- Custom groups: Create as needed in config.json webhooks

### Notification Triggers

Configure what events send alerts via `notifyOn`:
- `new_model`: New models detected
- `removed_model`: Models discontinued
- `model_updated`: Model properties changed (rank, capabilities, etc.)
- `endpoint_error`: API unreachable

`summary_with_changes` is deprecated and ignored if present in existing configs.

## 🏁 Quick Start

1. **Fork or Clone**
   ```bash
   git clone https://github.com/yourusername/ModelWatcher.git
   cd ModelWatcher
   npm install
   ```

2. **Add GitHub Secrets** (Settings → Secrets and variables → Actions):
   - `WEBHOOK`: Your Discord webhook URL
   - API keys for services you want to monitor

3. **Customize Configuration**:
   - Edit `config.json` to select endpoints
   - (Optional) Create `app-version-config.json` for app monitoring
   - (Optional) Create `uspto-config.json` for trademark tracking

4. **Deploy**:
   - Runs hourly via GitHub Actions automatically
   - Manually trigger via Actions tab for immediate results

## 📋 Available Watchers

| Script | Command | Purpose |
|--------|---------|---------|
| `src/index.js` | `npm run scan` | OpenAI-compatible API scanning |
| `src/lmarena-watch.js` | `npm run lmarena` | LM Arena / Chatbot Arena tracking |
| `src/app-version-watch.js` | `npm run app-version` | iOS & Android app updates |
| `src/uspto-watch.js` | `npm run uspto` | USPTO trademark filings |

## 🔒 Security

- **Automatic Redaction**: All API keys, tokens, and sensitive data are automatically redacted from logs and Discord embeds
- **GitHub Secrets**: Credentials stored securely as GitHub Actions Secrets, never exposed in logs
- **Isolated Execution**: Runs in sandboxed GitHub Actions environment

## 📜 License

MIT
