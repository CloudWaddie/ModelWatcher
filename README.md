# Model Watcher

Hourly scanner for OpenAI-compatible API endpoints with Discord notifications.

## Features

- Scans multiple OpenAI-compatible APIs hourly
- Detects new, removed, and updated models
- Sends Discord notifications via webhook
- JSON logging with full change diffs
- API key sanitization in all logs

## Supported Endpoints

| Provider | Env Variable | Base URL |
|----------|--------------|----------|
| OpenAI | `OPENAI_API_KEY` | `https://api.openai.com/v1` |
| Anthropic | `ANTHROPIC_API_KEY` | `https://api.anthropic.com/v1` |
| Google Gemini | `GEMINI_API_KEY` | `https://generativelanguage.googleapis.com/v1beta/openai` |
| Groq | `GROQ_API_KEY` | `https://api.groq.com/openai/v1` |
| Mistral | `MISTRAL_API_KEY` | `https://api.mistral.ai/v1` |
| Cohere | `COHERE_API_KEY` | `https://api.cohere.ai/v1` |
| Together AI | `TOGETHER_API_KEY` | `https://api.together.ai/v1` |
| DeepInfra | `DEEPINFRA_API_KEY` | `https://api.deepinfra.com/v1/openai` |
| Fireworks AI | `FIREWORKS_API_KEY` | `https://api.fireworks.ai/inference/v1` |

## Quick Start

1. **Fork or clone this repo**

2. **Add secrets to GitHub** (Settings → Secrets and variables → Actions):
   - `DISCORD_WEBHOOK` - Your Discord webhook URL
   - `OPENAI_API_KEY` - Your OpenAI API key
   - Add any other API keys for providers you want to scan

3. **Customize config.json** - Edit endpoints to add/remove providers

4. **Run manually** - Use GitHub Actions "Run workflow" button

## Configuration

Edit `config.json`:

```json
{
  "endpoints": [
    {
      "name": "OpenAI",
      "baseUrl": "https://api.openai.com/v1",
      "apiKeyEnv": "OPENAI_API_KEY",
      "modelsEndpoint": "/models"
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
    "webhookEnv": "WEBHOOK",
    "notifyOn": ["new_model", "removed_model", "model_updated", "endpoint_error"]
  }
}
```

### Notification Options

`notifyOn` supports:
- `new_model` - New models detected
- `removed_model` - Models removed
- `model_updated` - Model properties changed
- `endpoint_error` - API endpoint errors
- `summary_always` - Send summary even when no changes

## Adding Custom Endpoints

Add any OpenAI-compatible endpoint:

```json
{
  "name": "My Provider",
  "baseUrl": "https://api.myprovider.com/v1",
  "apiKeyEnv": "MY_PROVIDER_API_KEY",
  "modelsEndpoint": "/models"
}
```

## Local Development

```bash
# Install dependencies
npm install

# Run locally (requires env vars)
WEBHOOK=https://discord.com/api/webhooks/... \
OPENAI_API_KEY=sk-... \
npm run scan
```

## Security

- All API keys are stored as GitHub Secrets
- API keys are redacted in all log output
- Runs in an isolated GitHub Actions environment

## License

MIT
