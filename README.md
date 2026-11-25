# NullBeat for Revera

A Revera extension that uses a NullBeat add-on for music streaming and downloads.

[![Downloads](https://img.shields.io/github/downloads/frasersimpson126/nullbeat/total?label=downloads)](https://github.com/frasersimpson126/nullbeat/releases)

## Features

- Stream and download music through NullBeat.
- Match tracks using artist, title and ISRC.
- Prepare upcoming tracks to improve playback.
- Prefer cached tracks where possible.
- Track playback, downloads, skips and listening time.
- View or reset statistics in the extension settings.

## Setup

1. Install the extension in Revera.
2. Open **NullBeat for Revera** settings.
3. Paste your complete HTTPS NullBeat `manifest.json` URL.
4. Test the connection.
5. Enable the extension as an audio and download source.

**Keep your manifest URL private.** It contains a private token.

## Notes

- Audio quality is controlled by your NullBeat configuration.
- A new cache may take around 20 seconds to prepare.
- Revera handles Spotify scrobbling through its own Spotify mirroring option.
