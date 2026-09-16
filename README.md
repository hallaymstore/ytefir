# YT Shield Live

Mobile-first PWA control room for vertical YouTube LIVE streams and suspicious-traffic monitoring.

## Features

- 9:16 camera canvas (540x960, 720x1280, 1080x1920)
- Browser camera + microphone -> secure WebSocket -> bundled FFmpeg -> YouTube RTMPS
- Live concurrent viewer / views / likes monitor via YouTube Data API
- Rolling baseline + spike / engagement anomaly scoring
- Incident evidence stored in MongoDB
- Support-ready report text and direct Creator Support handoff
- PWA install + web push notifications
- AES-256-GCM encryption for stored YouTube Stream Key and API key
- HttpOnly session cookie and rate-limited admin login

## Important limitation

This application cannot firewall YouTube viewers or block third-party viewbot traffic at YouTube's network edge. It detects suspicious patterns, preserves evidence, alerts the operator, and provides incident-report workflow. YouTube makes the final determination of invalid traffic.

## Shorts / vertical feed

The app emits a true portrait 9:16 stream. YouTube may surface eligible vertical LIVE streams in the vertical live / Shorts feed. Distribution is controlled by YouTube and is not guaranteed.

## Setup

1. Copy `.env.example` to `.env` and set secrets.
2. `npm install`
3. `npm start`
4. Login, open Settings, add the YouTube Stream Key.
5. Add a YouTube Data API v3 key and active LIVE Video ID for realtime monitoring.
6. Preview camera, then press LIVE.

## Security

Never commit real stream keys, API keys or MongoDB credentials. Production secrets belong in Render environment variables.
