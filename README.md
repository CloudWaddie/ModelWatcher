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
- **Deep Analysis**: Can be configured to track internal version string changes and metadata diffs.

### ⚖️ USPTO & IP Tracking
- **Trademark Monitoring**: Scans USPTO filings for new AI-related trademarks from major labs.
- **Status Alerts**: Notifies on status updates for existing filings.

### 🏆 Leaderboard & Community Watch
- **LM Arena (Chatbot Arena)**: Tracks ELO, rankings, and specific model metadata updates.
- **Design Arena**: Monitoring for design-related AI benchmarks.
- **Regex & File Watchers**: Generic watchers for tracking specific file changes or string patterns across the web.

## 🛠️ Setup & Configuration

### Environment Variables

ModelWatcher requires the following environment variables to be configured as **GitHub Secrets** (Settings → Secrets and variables → Actions):

#### Discord Webhooks (Required)
- `WEBHOOK`: Primary Discord webhook URL for high-priority alerts (OpenAI, Anthropic, Google, etc.)
- `WEBHOOK_SMALL`: Optional secondary webhook for lower-priority alerts (community/niche providers)

Example:
```
https://discord.com/api/webhooks/YOUR_WEBHOOK_ID/YOUR_TOKEN
```

#### API Keys for Model Scanning (Optional - add only the ones you want to track)
| Service | Environment Variable | Setup |
|---------|----------------------|-------|
| OpenAI | `OPENAI_API_KEY` | Get from [platform.openai.com/api-keys](https://platform.openai.com/api-keys) |
| Anthropic | `ANTHROPIC_API_KEY` | Get from [console.anthropic.com](https://console.anthropic.com) |
| Google Gemini | `GEMINI_API_KEY` | Get from [makersuite.google.com/app/apikey](https://makersuite.google.com/app/apikey) |
| GitHub Models | `GH_MODELS_API_KEY` | GitHub PAT with `models` scope |
| Groq | `GROQ_API_KEY` | Get from [console.groq.com](https://console.groq.com) |
| Mistral | `MISTRAL_API_KEY` | Get from [console.mistral.ai](https://console.mistral.ai) |
| Cohere | `COHERE_API_KEY` | Get from [dashboard.cohere.ai](https://dashboard.cohere.ai) |
| Together AI | `TOGETHER_API_KEY` | Get from [api.together.ai](https://api.together.ai) |
| DeepInfra | `DEEPINFRA_API_KEY` | Get from [deepinfra.com](https://deepinfra.com) |
| Fireworks AI | `FIREWORKS_API_KEY` | Get from [fireworks.ai](https://fireworks.ai) |
| OpenRouter | `OPENROUTER_API_KEY` | Get from [openrouter.ai](https://openrouter.ai) |
| xAI (Grok) | `XAI_API_KEY` | Get from [console.x.ai](https://console.x.ai) |

#### App Store Monitoring (Optional)
- `APPLE_APP_STORE_KEYS`: Comma-separated list of iOS app IDs to monitor (e.g., `com.openai.chat,com.anthropic.claude`)
- `GOOGLE_PLAY_KEYS`: Comma-separated list of Android package IDs to monitor (e.g., `com.openai.chatgpt,com.anthropic.mobile`)

#### USPTO Tracking (Optional)
- `USPTO_TRACKING_ENABLED`: Set to `true` to enable trademark monitoring
- `USPTO_KEYWORDS`: Comma-separated keywords to track (e.g., `claude,grok,gemini`)

### Configuration File (config.json)

Edit `config.json` to customize which endpoints to monitor and configure notification preferences:

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
      "name": "Anthropic",
      "baseUrl": "https://api.anthropic.com",
      "apiKeyEnv": "ANTHROPIC_API_KEY",
      "modelsEndpoint": "/v1/models",
      "group": "default"
    },
    {
      "name": "Google Gemini",
      "baseUrl": "https://generativelanguage.googleapis.com/v1beta/openai",
      "apiKeyEnv": "GEMINI_API_KEY",
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
  "logging": {
    "outputDir": "./logs",
    "historyDays": 30
  },
  "discord": {
    "enabled": true,
    "webhooks": {
      "default": {
        "webhookEnv": "WEBHOOK",
        "notifyOn": ["new_model", "removed_model", "model_updated", "endpoint_error", "summary_with_changes"]
      },
      "small": {
        "webhookEnv": "WEBHOOK_SMALL",
        "notifyOn": ["new_model", "removed_model", "model_updated", "endpoint_error", "summary_with_changes"]
      }
    },
    "url": "https://github.com/CloudWaddie/ModelWatcher"
  }
}
```

### Required Fields for Each Endpoint

Each endpoint in `config.json` **must** include:
- `name` (string): Human-readable name for the endpoint
- `baseUrl` (string): Base URL of the API (e.g., `https://api.openai.com/v1`)
- `apiKeyEnv` (string): Environment variable name containing the API key (e.g., `OPENAI_API_KEY`)
- `modelsEndpoint` (string, default: `/models`): Path to the models list endpoint
- `group` (string, default: `default`): Webhook group for routing notifications

### Webhook Groups

Route different alerts to different Discord channels by assigning endpoints to groups:
- `default`: High-priority providers (OpenAI, Anthropic, Google, etc.)
- `small`: Community or niche providers
- Custom groups for App Watchers, USPTO alerts, etc.

### Notification Triggers

Configure what events trigger Discord notifications with the `notifyOn` array:
- `new_model`: Alert when a new model is detected
- `removed_model`: Alert when a model is discontinued
- `model_updated`: Alert when a model's properties change (rank, capabilities, etc.)
- `endpoint_error`: Alert when an API endpoint is unreachable
- `summary_with_changes`: Send a summary embed only when changes are detected

## 🏁 Quick Start

1. **Fork or Clone the Repository**
   ```bash
   git clone https://github.com/yourusername/ModelWatcher.git
   cd ModelWatcher
   npm install
   ```

2. **Add GitHub Secrets** (Settings → Secrets and variables → Actions):
   - `WEBHOOK`: Your primary Discord webhook URL
   - `WEBHOOK_SMALL`: Optional secondary webhook
   - API keys for the services you want to monitor (see table above)

3. **Edit `config.json`**:
   - Remove or comment out endpoints you don't want to monitor
   - Adjust webhook groups as needed
   - Configure notification triggers

4. **Deploy**:
   - The scanner runs automatically every hour via GitHub Actions
   - Manually trigger via the "Actions" tab for immediate results

## 📊 Available Watchers

ModelWatcher provides multiple specialized watchers:

| Script | Purpose | Command |
|--------|---------|---------|
| `src/index.js` | OpenAI-compatible API scanning | `npm run scan` |
| `src/lmarena-watch.js` | LM Arena / Chatbot Arena tracking | `npm run lmarena` |
| `src/app-version-watch.js` | iOS & Android app version monitoring | `npm run app-version` |
| `src/uspto-watch.js` | USPTO trademark filing tracking | `npm run uspto` |
| `src/designarena-watch.js` | Design Arena benchmarks | `npm run designarena` |
| `src/github-file-watch.js` | GitHub file change detection | `npm run github-file` |
| `src/regex-watch.js` | Generic regex-based web monitoring | `npm run regex` |

## 🔒 Security

- **Automatic Redaction**: Built-in sanitizer prevents API keys or sensitive tokens from leaking into Discord embeds or logs.
- **Encrypted Secrets**: All credentials are stored as GitHub Actions Secrets and never exposed in logs.
- **Isolated Execution**: Runs in a sandboxed GitHub Actions environment.

## 📜 License

MIT
