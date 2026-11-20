# NullBeat for Revera

An Revera / Myspoti extension that uses one configured Eclipse-compatible NullBeat addon for streaming and downloads.

## Features

- One private **NullBeat manifest URL** setting.
- Optional **Cache-only mode**: download requests are resolved through NullBeat to trigger its normal cache preparation, but the extension deliberately returns no file URL to Revera.
- Streaming through NullBeat's token-scoped `/search` and `/stream/{trackId}` endpoints.
- Downloads through the same `/stream/{trackId}` resolver; NullBeat does not expose a separate download endpoint.
- Expanded track matching: exact ISRC first (including the addon's ISRC resolver), exact artist + title, then cleaned artist + title. If the primary search still fails, it makes at most two additional searches (cleaned artist + title, then title-only), merges duplicate-free results and re-runs strict matching. Expanded candidates must still match the cleaned artist and title and have a plausible duration; album agreement and duration similarity rank otherwise valid candidates. It stops extra searching immediately on HTTP 429 and does not add fallback requests to time-limited queue preparation.
- Direct stream URLs are used when present in search results only if they are still returned by the stream endpoint; the stream endpoint remains the final resolver.
- Connection test checks the manifest and sample search endpoint.
- Playback origin diagnostics distinguish NullBeat streams from downloaded tracks.
- Download diagnostics log when Revera invokes the download hook, whether NullBeat resolves a media URL, the resolver HTTP status and response metadata, and whether one file descriptor is handed back to Revera. Media URLs and token paths are never logged. Revera performs the actual file transfer outside the extension, so transfer progress, HTTP status and received bytes cannot be observed from this extension hook.
- Persistent playback statistics: counts all starts, NullBeat streams, NullBeat downloads, completed tracks, skips, and listening time. Statistics survive app restarts and can be viewed or reset from extension settings.
- Cache-aware matching: playback inspects up to five search results and prefers a cached exact ISRC match, then a cached strict title/artist match. Downloads inspect up to ten results. Uncached exact matches remain a fallback.
- Configurable automatic queue preparation: listens for Revera's `queue` event and processes the default next track plus 0–5 additional upcoming tracks, controlled by **Additional tracks to precache** in settings. It reads Revera's standard `title`, `artist`, `artists`, `durationMs` and `uri` fields, matches them against NullBeat in parallel batches, and calls `/stream/{trackId}` to trigger the backend's normal preparation/cache path. It retains only matched track IDs in memory, not short-lived media URLs. The existing `audio.ahead` path consumes those matches when playback approaches; if a track was not prepared or the match cache is unavailable, normal resolution remains the fallback.
- One-track-ahead fallback: Revera's `audio.ahead` request for the next queue track (normally about 10 seconds after the current song starts) still resolves the stream before playback when no manual queue preparation was run. The ahead request gets one longer, bounded stream-resolution attempt; normal playback retains its two-attempt retry.
- Bounded stream retry: retries one transient stream-resolution failure (network error, rate limit, selected server errors, or an unusable response) without retrying authentication or permanent client errors.
- Bounded search retry: retries one transient track-search/network failure (connection errors, timeouts, and selected server errors) and logs whether a failed resolution was caused by an HTTP error or by no matching catalogue result. Authentication, rate-limit and permanent client errors are not blindly retried.
- Cache visibility: uses NullBeat's `infotext` cache badge from search results and the stream response's `Torbox Cached`, `infohash`, or `cached` fields. Download file size is passed to Revera when NullBeat reports it.

## Cache-only mode

Enable **Cache-only mode** in the extension settings before starting downloads. For each track Revera asks this extension to download, NullBeat resolves the track and calls its normal `/stream/{trackId}` endpoint, which is the backend's existing cache-preparation path. The extension then returns no downloadable file, so Revera treats that track as unavailable from NullBeat. Turn the setting off again to download normally. This does not add a separate TorBox API integration and cannot guarantee that an entire playlist is queued: Revera controls how many per-track download hooks it invokes and whether it continues after an unavailable result. Actual cache completion remains controlled by NullBeat/TorBox.

## Playback statistics

Statistics are stored locally using Revera's extension storage and persist across app restarts. A play is counted when playback starts; stream and download counts are attributed only when Revera reports this extension as the provider. Completed tracks count when Revera reports a finished end event, skips count on skip events, and listening time uses Revera's `playedMs` value (which excludes pauses and seeks). Other playback sources are excluded. Use the two settings buttons to view or reset the counters. Resetting is permanent.

These figures describe playback events observed by Revera; they are not server-side request totals or proof that a track was fully cached.

## Quality

NullBeat controls quality. This extension intentionally has **no quality selector** and does not override NullBeat's configured quality or duplicate its settings. If your NullBeat manifest URL contains a token that encodes quality, keep using the complete URL generated by NullBeat.

## Install / configure

1. Install the extension in Revera.
2. Open **NullBeat for Revera** settings.
3. Paste the complete HTTPS `manifest.json` URL generated by the NullBeat configurator into **NullBeat manifest URL**. It has the form `https://your-nullbeat-host/<private-token>/manifest.json`. The token path contains your TorBox API key and selected quality, so treat the entire URL as a password and do not share it publicly.
4. Press **Test NullBeat connection**.
5. Enable this extension as an audio source and download source in Revera.
6. Use **View playback statistics** in the extension settings to inspect usage, or **Reset playback statistics** to clear the counters.

The URL field is a secret setting and is not written to logs. The extension keeps the token path intact for every endpoint request. NullBeat's configured quality is encoded in that token; the extension deliberately does not append a `quality` override or add another quality setting. The extension requests the configured host over HTTPS. The extension's network permission is broad because a self-hosted NullBeat instance can use a custom domain; install only if you trust the URL you enter.

## Queue preparation and cache behaviour

NullBeat listens to Revera's automatic `queue` event. Whenever the published upcoming queue changes, Revera sends upcoming tracks (current track excluded). The **Additional tracks to precache** setting controls how many tracks beyond the default one-track-ahead preparation are bulk-prepared (0–5; maximum six total), using the same Track shape as audio hooks (`uri`, `title`, `artist`, `artists`, `durationMs`, optional `isrc`). NullBeat maps those fields, matches the tracks against its catalogue in parallel batches, and calls the addon's normal `/stream/{trackId}` endpoint to trigger the backend's cache-preparation path. No manual setting or separate Spotify queue-read prompt is needed: the event uses the `playback.events` permission already declared for playback statistics.

The setting defaults to 0 additional tracks, preserving the default one-track-ahead behaviour; increase it to 1–5 to prepare further into the queue. The event has a three-second execution limit, so preparation uses short bounded requests and the host's parallel HTTP feature. Logs report how many queue entries arrived, how many were accepted, how many matched, and how many stream requests returned a URL. It is best-effort: slow searches or stream responses may not finish inside that limit, and older hosts without parallel HTTP skip bulk preparation. Matched track IDs are kept in memory; short-lived media URLs are discarded. If a track is not prepared or the queue changes before playback, the normal audio resolver and its `ahead: true` path remain the fallback. NullBeat/TorBox controls actual cache completion; a successful stream response is not proof that the full audio has finished caching. This process does not download audio files to the device.

## Cache reporting limitation

NullBeat can report cache state in search-result `infotext` badges (for example, `⚡ Cached - HiFi CD - 123MB`) and in stream responses (a title containing `Torbox Cached`, an `infohash`, or a `cached` flag). The extension surfaces these indicators when present. It does not claim to know whether an arbitrary track is cached before requesting its stream. Revera playback events also expose whether the current audio origin is a stream, a download, or a local file.

## First-play delay

NullBeat documents that a new cache fill can take around 15–20 seconds. Revera's audio-source hook has a 15-second budget, so an uncached first attempt may fall back before NullBeat finishes preparing it. The extension retries transient stream failures once automatically. This retry is bounded by Revera's hook deadline; it cannot wait out a full 15–20 second first-time cache fill. If NullBeat is still preparing a new cache, retry the track after about 20 seconds. Downloads have a longer Revera hook budget.

## Compatibility

- Requires a public HTTPS Eclipse-compatible NullBeat manifest URL. Revera's extension HTTP client does not follow redirects or send browser cookies.
- Supports direct HTTPS audio URLs in FLAC, M4A/MP4, AAC (mapped to M4A), and MP3 formats. Dolby Atmos is passed through as M4A with its reported codec metadata.
- HLS/DASH manifests and redirect-only stream URLs are not passed through. NullBeat's public `/stream` endpoint is expected to return a JSON object containing a direct `url`.
- Playback inspects up to five results and downloads up to ten, preferring cached results only among exact ISRC or strict title/artist matches. Normal playback makes at most two bounded stream-resolution attempts; an ahead-of-time queue request makes one longer attempt within the 15-second audio hook budget.
- Matching prioritises exact ISRC and exact artist + title results, then cleaned artist + title. When needed, playback/download resolution performs at most two extra searches (cleaned artist + title, then title-only); candidates still need a cleaned artist/title match and a duration within 12 seconds when both durations are available. Album agreement and duration similarity rank valid candidates. Extra searches stop on HTTP 429 and are not used in queue preparation.
- Spotify scrobbling is left to Revera's built-in Spotify mirroring option; this extension does not implement a second scrobbling path.
