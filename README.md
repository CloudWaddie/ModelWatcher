# Model Watcher

Hourly scanner for OpenAI-compatible API endpoints with Discord notifications. Now featuring a powerful deep comparison engine for granular tracking of model changes.

## Features

- **Hourly Scanning**: Automatically polls multiple OpenAI-compatible APIs every hour.
- **Deep Comparison Engine**: Beyond just detecting new or removed models, ModelWatcher performs a recursive deep-diff of model metadata including rankings, capabilities, and availability.
- **Rich Discord Alerts**:
  - **Emoji-Enhanced Capabilities**: Visual icons for model features (e.g., 📝 Text, 🖼️ Vision, 🎨 Generation, 🔍 Search).
  - **Detailed Change Logs**: Shows exactly what changed (e.g., `rank: 12 → 10` or `capabilities: 💬 → 💬 🖼️`).
  - **Group Support**: Route different providers to different Discord channels using webhook groups.
- **Sanitized Logging**: All API keys are automatically redacted from logs and notifications.
- **LM Arena Support**: Dedicated tracking for Chatbot Arena rankings and model metadata.

## Supported Endpoints

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
| DeepInfra | `DEEPINFRA_API_KEY` | `https://api.deepinfra.com/v1/openai` |
| Fireworks AI | `FIREWORKS_API_KEY` | `https://api.fireworks.ai/inference/v1` |
| OpenRouter | `OPENROUTER_API_KEY` | `https://openrouter.ai/api/v1` |
| xAI (Grok) | `XAI_API_KEY` | `https://api.x.ai/v1` |

*Note: GitHub Models requires a Personal Access Token (PAT) with `models` scope.*

## Quick Start

1. **Fork the Repository**
2. **Add GitHub Secrets** (Settings → Secrets and variables → Actions):
   - `WEBHOOK`: Main Discord webhook URL.
   - `WEBHOOK_SMALL`: Optional secondary webhook.
   - `OPENAI_API_KEY`, `GEMINI_API_KEY`, etc.: Your respective provider keys.
3. **Configure**: Edit `config.json` to customize endpoints and notification preferences.
4. **Deploy**: The scanner runs automatically via GitHub Actions. You can also trigger it manually from the "Actions" tab.

## Advanced Configuration

### Deep Comparison Tracking
ModelWatcher tracks changes across the following fields:
- **Ranking**: Overall `rank` and modality-specific rankings.
- **Availability**: `userSelectable` status changes.
- **Identity**: `displayName`, `publicName`, and `organization` updates.
- **Capabilities**: Recursive diffing of input/output capabilities with emoji summaries.

### Webhook Groups
Assign endpoints to groups in `config.json`:
```json
{
  "name": "OpenAI",
  "baseUrl": "https://api.openai.com/v1",
  "group": "default"
}
```

## Security
- **Redaction**: A built-in sanitizer ensures no API keys or sensitive tokens ever leak into Discord or logs.
- **GitHub Secrets**: Environment variables are managed securely through GitHub's encrypted secret store.

## License
MIT
