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

## 📊 Supported Endpoints

| Provider | Env Variable | Base URL |
|----------|--------------|----------|
| OpenAI | `OPENAI_API_KEY` | `https://api.openai.com/v1` |
| Anthropic | `ANTHROPIC_API_KEY` | `https://api.anthropic.com/v1` |
| Google Gemini | `GEMINI_API_KEY` | `https://generativelanguage.googleapis.com/v1beta/openai` |
| GitHub Models | `GH_MODELS_API_KEY` | `https://models.github.ai` |
| Groq | `GROQ_API_KEY` | `https://api.groq.com/openai/v1` |
| Mistral | `MISTRAL_API_KEY` | `https://api.mistral.ai/v1` |
| Cohere | `COHERE_API_KEY` | `https://api.cohere.ai/v1` |
| Together AI | `TOGETHER_API_KEY` | `https://api.together.ai/v1` |
| OpenRouter | `OPENROUTER_API_KEY` | `https://openrouter.ai/api/v1` |
| xAI (Grok) | `XAI_API_KEY` | `https://api.x.ai/v1` |

## 🛠️ Configuration

### Webhook Groups
Route different alerts to specific Discord channels by grouping endpoints in `config.json`:
- `default`: High-priority providers.
- `small`: Community or niche providers.
- Custom groups for App Watchers or USPTO alerts.

### Notification Triggers
Configure `notifyOn` for granular control:
- `new_model`, `removed_model`, `model_updated`
- `endpoint_error`
- `summary_with_changes`

## 🏁 Quick Start

1. **Fork the Repository**
2. **Setup GitHub Secrets**:
   - `WEBHOOK`: Your primary Discord webhook URL.
   - `OPENAI_API_KEY`, etc.: API keys for the services you wish to track.
3. **Customize `config.json`**: Define your endpoints, groups, and scan intervals.
4. **Deploy**: Runs automatically every hour via GitHub Actions.

## 🔒 Security
- **Automatic Redaction**: Built-in sanitizer prevents API keys or sensitive tokens from leaking into logs or Discord embeds.
- **Encrypted Secrets**: Leverages GitHub Actions Secrets for all sensitive credentials.

## 📜 License
MIT
