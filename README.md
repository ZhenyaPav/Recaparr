# Recaparr

Recaparr generates detailed, spoiler-filled movie and episode recaps from existing text subtitles. It stores recaps in SQLite and serves them through a Streamable HTTP MCP tool.

Media stays local. Recaparr extracts embedded or sidecar subtitle text with `ffprobe`/`ffmpeg`, then sends only the cleaned text to the configured OpenAI-compatible endpoint through the [`summarize`](https://github.com/steipete/summarize) CLI. It does not perform speech-to-text.

## Features

- Stateless Streamable HTTP MCP at `/mcp`
- Sonarr and Radarr import webhooks
- Per-item, per-language recap cache
- Persistent asynchronous generation and retries
- Forced regeneration without discarding the last successful recap
- SQLite storage suitable for small personal libraries
- Read-only access to the media library

## Configuration

Copy `.env.example` to `.env` for local development. The following values are required:

| Variable | Purpose |
| --- | --- |
| `RECAPARR_API_TOKEN` | Bearer token required by MCP and webhook routes |
| `RECAPARR_LLM_API_KEY` | API key for the OpenAI-compatible endpoint |
| `JELLYFIN_API_KEY` | Jellyfin API key used to resolve item IDs and paths |

The default LLM endpoint is `https://openrouter.ai/api/v1`, and the default model is `deepseek/deepseek-v4-flash-latest`. `RECAPARR_PREFERRED_SUBTITLE_LANGUAGE` controls subtitle selection; `RECAPARR_SUMMARY_LANGUAGE` controls eager recap output and the MCP default. Both default to `en`.

Boolean settings `RECAPARR_EAGER_GENERATION` and `RECAPARR_LAZY_GENERATION` default to `true`. If lazy generation is disabled, both cache-miss generation and `force_regenerate` are rejected.

## MCP

Connect an MCP client to `http://HOST:8182/mcp` and send `Authorization: Bearer TOKEN`. The server exposes one tool:

```json
{
  "name": "get_recap",
  "arguments": {
    "jellyfin_id": "JELLYFIN_ITEM_ID",
    "force_regenerate": false,
    "language": "en"
  }
}
```

`force_regenerate` and `language` are optional. Cache misses and refreshes are asynchronous: the result reports `queued`, `generating`, or `retrying` and includes `retryAfterSeconds`. Call the tool again after that interval. During forced regeneration, the previous recap is returned with `stale: true` until its replacement succeeds.

## Webhooks

Webhook connections are stored in Sonarr/Radarr configuration and cannot be declared through their supported Docker environment variables.

### Sonarr

1. Open **Settings → Connect → + → Webhook**.
2. Set the URL to `http://recaparr:8080/webhooks/sonarr` and method to `POST`.
3. Enable only **On Import Complete**.
4. Under advanced headers, add `Authorization` with value `Bearer YOUR_RECAPARR_API_TOKEN`.
5. Test and save.

### Radarr

1. Open **Settings → Connect → + → Webhook**.
2. Set the URL to `http://recaparr:8080/webhooks/radarr` and method to `POST`.
3. Enable **On Import** and **On Upgrade**.
4. Add the same Authorization header.
5. Test and save.

## Subtitle selection

Tracks are attempted in this order:

1. Preferred-language embedded subtitles
2. Preferred-language external subtitles
3. Other embedded subtitles
4. Other external subtitles

Recaparr supports text-based embedded tracks and matching `.srt`, `.vtt`, `.ass`, and `.ssa` files. Bitmap and commentary tracks are ignored. Forced tracks are used only if no fuller candidate is available. Missing subtitles are retried after 5 minutes, 30 minutes, 2 hours, 8 hours, and 24 hours.

## Development

Node.js 24 is required for the real `summarize` CLI.

```bash
npm ci
npm run check
npm test
npm run build
```

Build the production image with `docker build -t recaparr:local .`. Tagged releases publish multi-architecture images to GHCR.
