# LM Arena Model Watcher — Notification Reference

## Model Changes

| Icon | Section | Meaning |
|------|---------|---------|
| 🥷 | New Stealth Models | A model appeared with **no organization** — could be an internal test or unannounced model |
| 🆕 | New Models | A model appeared with a known organization (openai, google, etc.) |
| 🗑️ | Removed Models | A model was removed from the arena listing |
| 🔄 | Updated Models | An existing model changed properties (capabilities, rank, selectable, etc.) |

## Identity Tracking

| Icon | Section | Meaning |
|------|---------|---------|
| 🕵️ | Revealed Models | A stealth model (no org) **gained an organization** — confirmed identity. Shows codename → real name by org |
| 🔎 | Possible Reveals | A stealth model disappeared and a **new model with identical capabilities** appeared in the same scan. Not confirmed — same UUID wasn't preserved |

## Variant Tracking

Some models exist as **multiple entries** (variants) — different deployments with slightly different capabilities or providers.

| Icon | Section | Meaning |
|------|---------|---------|
| 📦 | New Model Groups | A model name appeared that wasn't tracked before |
| 📭 | Removed Groups | All variants of a model name were removed |
| 🔀 | Variant Changes | The number of variants changed (e.g., 8 → 10). Includes rank/provider changes and a **capability matrix** showing per-capability adoption |
| 🎯 | Capability Convergence | A capability is now available across **all** variants (2+) — previously only some had it |

## Capability Emoji Legend

| Emoji | Meaning |
|-------|---------|
| 📝 | Text input |
| 💬 | Text output |
| 🖼️ | Image input |
| 🎨 | Image output |
| 🌐 | Web / internet output |
| 📎 | File input |
| 🔍 | Search / grounding |
| 🎬 | Video input |
| 📹 | Video output |
| 🎤 | Audio input |

## Other Indicators

| Icon | Meaning |
|------|---------|
| ✅ | User-selectable (appears in arena UI) |
| 🔒 | Not user-selectable (internal / unreleased) |
| `#N` | Arena rank position |
| ▲/▼ | Variant count changes |
| ⚠️ | Possible reveal — not 100% confirmed |
