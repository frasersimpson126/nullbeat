'use strict';

/*
 * NullBeat for Orpheon
 * Orpheon API v1 / Eclipse addon HTTP protocol.
 * Keep this file ES6/Rhino compatible: no fetch, promises, timers or Node APIs.
 */

var SAMPLE_QUERY = 'Never Gonna Give You Up Rick Astley';
var manifestCache = null;
var manifestCacheUrl = '';
var manifestCacheAt = 0;

var STATS_KEY = 'playback_stats_v1';
var playbackStats = null;

function emptyStats() {
  return {
    plays: 0,
    streamPlays: 0,
    downloadPlays: 0,
    completed: 0,
    skipped: 0,
    playedMs: 0,
    lastPlayedAt: 0
  };
}

function getStats() {
  if (playbackStats) return playbackStats;
  try {
    var saved = myspoti.storage.get(STATS_KEY);
    playbackStats = saved && typeof saved === 'object' ? saved : emptyStats();
  } catch (e) {
    playbackStats = emptyStats();
    myspoti.log('NullBeat statistics storage unavailable: ' + cleanText(e.message || e));
  }
  var defaults = emptyStats();
  Object.keys(defaults).forEach(function (key) {
    if (typeof playbackStats[key] !== 'number' || !isFinite(playbackStats[key])) {
      playbackStats[key] = defaults[key];
    }
  });
  return playbackStats;
}

function saveStats() {
  try {
    myspoti.storage.set(STATS_KEY, getStats());
  } catch (e) {
    myspoti.log('NullBeat could not save playback statistics: ' + cleanText(e.message || e));
  }
}

function formatPlayTime(ms) {
  var totalMinutes = Math.floor(Math.max(0, Number(ms) || 0) / 60000);
  var hours = Math.floor(totalMinutes / 60);
  var minutes = totalMinutes % 60;
  return hours ? hours + 'h ' + minutes + 'm' : minutes + 'm';
}

function showStats() {
  var s = getStats();
  var summary = 'NullBeat stats: ' + s.plays + ' plays · ' + s.streamPlays +
    ' streams · ' + s.downloadPlays + ' downloads · ' + s.completed +
    ' completed · ' + s.skipped + ' skipped · ' + formatPlayTime(s.playedMs) + ' listened.';
  myspoti.notify(summary.substring(0, 200));
  myspoti.log('Playback statistics: ' + JSON.stringify(s));
}

function resetStats() {
  playbackStats = emptyStats();
  saveStats();
  myspoti.notify('NullBeat playback statistics reset.');
}

function feature(name) {
  return !!(myspoti.features && myspoti.features.indexOf(name) >= 0);
}

function cleanText(value) {
  return value == null ? '' : String(value).trim();
}

function configuredUrl() {
  return cleanText(myspoti.settings.get('addon_url'));
}

function splitUrl(url) {
  var value = cleanText(url);
  if (!/^https:\/\//i.test(value)) throw new Error('Use the complete HTTPS manifest URL.');
  if (/\s/.test(value)) throw new Error('The manifest URL contains whitespace.');
  var q = value.indexOf('?');
  var hash = value.indexOf('#');
  if (hash >= 0) value = value.substring(0, hash);
  q = value.indexOf('?');
  var query = q >= 0 ? value.substring(q + 1) : '';
  var path = q >= 0 ? value.substring(0, q) : value;
  path = path.replace(/\/manifest\.json$/i, '').replace(/\/manifest$/i, '');
  path = path.replace(/\/+$/, '');
  return { base: path, query: query };
}

function endpoint(url, path, params) {
  var p = splitUrl(url);
  var qs = params ? myspoti.query(params) : '';
  if (p.query) qs = qs ? qs + '&' + p.query : p.query;
  return p.base + path + (qs ? '?' + qs : '');
}

function requestJson(url, timeout) {
  var r = myspoti.http.get(url, { timeout: timeout || 10000 });
  if (!r.ok) return { status: r.status, data: null, headers: r.headers || {} };
  try {
    return { status: r.status, data: r.json(), headers: r.headers || {} };
  } catch (e) {
    return { status: r.status, data: null, headers: r.headers || {} };
  }
}

function manifestUrl() {
  var url = configuredUrl();
  if (!url) throw new Error('Add your NullBeat manifest URL in extension settings.');
  return url;
}

function getManifest(url, forceRefresh) {
  if (!forceRefresh && manifestCache && manifestCacheUrl === url && Date.now() - manifestCacheAt < 300000) {
    return manifestCache;
  }
  var r = requestJson(url, 1000);
  if (r.status !== 200 || !r.data || typeof r.data !== 'object') {
    throw new Error('Manifest request failed (HTTP ' + r.status + '). Check the URL and token.');
  }
  if (!r.data.id || !r.data.name || !r.data.resources) {
    throw new Error('The URL did not return a valid Eclipse addon manifest.');
  }
  manifestCache = r.data;
  manifestCacheUrl = url;
  manifestCacheAt = Date.now();
  return manifestCache;
}

function resource(manifest, name) {
  return Array.isArray(manifest.resources) && manifest.resources.indexOf(name) >= 0;
}

function normalize(value) {
  return cleanText(value).toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function sameRecording(track, candidate) {
  if (!candidate || !candidate.id) return false;
  var requestedIsrc = cleanText(track.isrc).toUpperCase();
  var candidateIsrc = cleanText(candidate.isrc).toUpperCase();
  if (requestedIsrc && candidateIsrc) return requestedIsrc === candidateIsrc;

  if (normalize(track.title) !== normalize(candidate.title)) return false;
  var wantedArtist = normalize(track.artist || (track.artists && track.artists[0]));
  var foundArtist = normalize(candidate.artist);
  if (!wantedArtist || wantedArtist !== foundArtist) return false;

  var wantedDuration = Number(track.durationMs || 0);
  var foundDuration = Number(candidate.durationMs || 0);
  if (!foundDuration && Number(candidate.duration || 0)) foundDuration = Number(candidate.duration) * 1000;
  if (wantedDuration > 0 && foundDuration > 0 &&
      Math.abs(wantedDuration - foundDuration) > 10000) return false;
  return true;
}

function candidateIsCached(candidate) {
  if (!candidate) return false;
  var text = cleanText(candidate.infotext);
  return !!candidate.cached || /cached|cache hit/i.test(text) || !!candidate.infohash;
}

function chooseCandidate(track, items) {
  var exactIsrc = [];
  var exactIdentity = [];
  var wantedIsrc = cleanText(track.isrc).toUpperCase();
  for (var i = 0; i < items.length; i++) {
    var item = items[i];
    if (!item || !item.id) continue;
    if (wantedIsrc && cleanText(item.isrc).toUpperCase() === wantedIsrc) {
      exactIsrc.push(item);
    } else if (sameRecording(track, item)) {
      exactIdentity.push(item);
    }
  }
  var pool = exactIsrc.length ? exactIsrc : exactIdentity;
  for (var j = 0; j < pool.length; j++) {
    if (candidateIsCached(pool[j])) return pool[j];
  }
  return pool.length ? pool[0] : null;
}

function sameArtistAndTitle(track, candidate) {
  if (!candidate || !candidate.id) return false;
  var wantedTitle = normalize(track.title);
  var foundTitle = normalize(candidate.title);
  if (!wantedTitle || wantedTitle !== foundTitle) return false;

  var wantedArtist = normalize(track.artist || (track.artists && track.artists[0]));
  var foundArtist = normalize(candidate.artist || (candidate.artists && candidate.artists[0]));
  return !!wantedArtist && wantedArtist === foundArtist;
}

function chooseArtistTitleCandidate(track, items) {
  var matches = [];
  for (var i = 0; i < items.length; i++) {
    if (sameArtistAndTitle(track, items[i])) matches.push(items[i]);
  }
  for (var j = 0; j < matches.length; j++) {
    if (candidateIsCached(matches[j])) return matches[j];
  }
  return matches.length ? matches[0] : null;
}

function trackArrays(data) {
  if (!data || typeof data !== 'object') return [];
  if (Array.isArray(data.tracks)) return data.tracks;
  if (data.data && Array.isArray(data.data.tracks)) return data.data.tracks;
  if (data.data && data.data.data && Array.isArray(data.data.data.tracks)) return data.data.data.tracks;
  if (Array.isArray(data.results)) return data.results;
  return [];
}


var preparedQueueMatches = {};

function httpBatchJson(urls, timeout) {
  if (!urls.length || !feature('http.all')) return [];
  try {
    var responses = myspoti.http.all(urls.map(function (url) {
      return { url: url, method: 'GET', timeout: timeout };
    }));
    return responses.map(function (response) {
      if (!response || response.error || response.status !== 200) {
        return { status: response && response.status ? response.status : 0, data: null };
      }
      try { return { status: response.status, data: response.json() }; }
      catch (e) { return { status: response.status, data: null }; }
    });
  } catch (e) {
    myspoti.log('NullBeat queue batch failed: ' + cleanText(e.message || e).substring(0, 120));
    return [];
  }
}

function queueTrack(item) {
  if (!item || !item.uri || !item.name) return null;
  var artists = Array.isArray(item.artists) ? item.artists : [];
  var names = artists.map(function (artist) {
    return cleanText(artist && (artist.name || artist));
  }).filter(function (name) { return !!name; });
  if (!names.length) return null;
  return {
    uri: cleanText(item.uri),
    title: cleanText(item.name),
    artist: names[0],
    artists: names,
    durationMs: Number(item.durationMs) || 0
  };
}

// Revera delivers the published upcoming queue automatically. Keep all work
// inside its three-second event budget: four requests per parallel batch,
// short network timeouts, and no serial fallback on older hosts.
function prepareSpotifyQueue(nextItems) {
  var url;
  try { url = manifestUrl(); } catch (e) { return; }
  if (!feature('http.all')) {
    myspoti.log('NullBeat automatic queue preparation needs Revera http.all; ahead-of-time playback fallback remains active.');
    return;
  }

  var tracks = [];
  var seen = {};
  var rawItems = Array.isArray(nextItems) ? nextItems : [];
  for (var i = 0; i < rawItems.length && tracks.length < 5; i++) {
    var t = queueTrack(rawItems[i]);
    if (!t || seen[t.uri]) continue;
    seen[t.uri] = true;
    tracks.push(t);
  }
  preparedQueueMatches = {};
  if (!tracks.length) return;

  var manifest;
  try { manifest = getManifest(url, false); } catch (e) {
    myspoti.log('NullBeat queue preparation skipped: manifest unavailable.');
    return;
  }
  if (!resource(manifest, 'search') || !resource(manifest, 'stream')) return;

  var searchUrls = tracks.map(function (track) {
    return endpoint(url, '/search', {
      q: track.artist + ' ' + track.title,
      limit: 10,
      type: 'track'
    });
  });
  var searchResults = [];
  for (var start = 0; start < searchUrls.length; start += 4) {
    searchResults = searchResults.concat(httpBatchJson(searchUrls.slice(start, start + 4), 550));
  }

  var matched = [];
  for (var j = 0; j < tracks.length; j++) {
    var response = searchResults[j];
    var items = response && response.status === 200 ? trackArrays(response.data) : [];
    var candidate = chooseCandidate(tracks[j], items);
    if (!candidate) candidate = chooseArtistTitleCandidate(tracks[j], items);
    if (!candidate) continue;
    preparedQueueMatches[tracks[j].uri] = {
      id: String(candidate.id),
      isrcMatched: false,
      candidate: candidate
    };
    matched.push({ track: tracks[j], id: String(candidate.id) });
  }

  // Calling the normal stream endpoint starts the backend's cache path.
  // Discard returned URLs: they may expire before the track is played.
  var streamUrls = matched.map(function (item) {
    return endpoint(url, '/stream/' + encodeURIComponent(item.id), null);
  });
  var prepared = 0;
  for (var k = 0; k < streamUrls.length; k += 4) {
    var streamResults = httpBatchJson(streamUrls.slice(k, k + 4), 550);
    for (var n = 0; n < streamResults.length; n++) {
      var result = streamResults[n];
      if (result && result.status === 200 && result.data &&
          typeof result.data.url === 'string' && /^https:\/\//i.test(cleanText(result.data.url))) {
        prepared++;
      }
    }
  }

  myspoti.log('NullBeat automatic queue preparation: matched ' + matched.length + '/' +
    tracks.length + '; stream endpoint responded for ' + prepared + '.');
}

function takePreparedQueueMatch(track) {
  var uri = cleanText(track && track.uri);
  if (!uri || !preparedQueueMatches[uri]) return null;
  var match = preparedQueueMatches[uri];
  delete preparedQueueMatches[uri];
  return match;
}

function resolveTrack(track, url, manifest, isDownload) {
  var isrc = cleanText(track.isrc);
  var resolvedIsrcId = '';

  if (isrc && resource(manifest, 'isrc')) {
    var ir = requestJson(endpoint(url, '/resolve-isrc', { isrc: isrc }), 900);
    if (ir.status === 200 && ir.data) {
      resolvedIsrcId = cleanText(ir.data.trackId || ir.data.id);
    }
  }

  // Inspect several results for cache badges. Keep an ISRC-resolved ID as
  // fallback if search is slow or does not return the same catalogue entry.
  var query = cleanText((track.artist || '') + ' ' + (track.title || ''));
  if (query && resource(manifest, 'search')) {
    var sr = requestJson(endpoint(url, '/search', {
      q: query,
      limit: isDownload ? 20 : 10,
      type: 'track'
    }), isDownload ? 2200 : 1000);
    if (sr.status === 200 && sr.data) {
      var items = trackArrays(sr.data);
      var match = chooseCandidate(track, items);
      // If exact ISRC/title/artist/duration matching fails, accept an exact
      // artist + title match as a fallback. This tolerates duration metadata
      // differences and alternate catalogue entries while preserving exact
      // matches as the first choice.
      if (!match) match = chooseArtistTitleCandidate(track, items);
      if (match) {
        return {
          id: String(match.id),
          isrcMatched: !!(isrc && cleanText(match.isrc).toUpperCase() === isrc.toUpperCase()),
          candidate: match
        };
      }
    }
  }

  if (resolvedIsrcId) {
    return { id: resolvedIsrcId, isrcMatched: true, candidate: null };
  }

  if (resource(manifest, 'resolve')) {
    var rr = requestJson(endpoint(url, '/resolve', {
      isrc: isrc || undefined,
      title: track.title,
      artist: track.artist || (track.artists && track.artists[0]),
      durationMs: track.durationMs || undefined
    }), 2200);
    if (rr.status === 200 && rr.data && rr.data.item && sameRecording(track, rr.data.item)) {
      return {
        id: String(rr.data.item.id),
        isrcMatched: !!(isrc && cleanText(rr.data.item.isrc).toUpperCase() === isrc.toUpperCase()),
        candidate: rr.data.item
      };
    }
  }
  return null;
}

function resolveStream(track, isDownload, isAhead) {
  var url = manifestUrl();
  var manifest = getManifest(url, false);
  if (!resource(manifest, 'stream')) return null;

  var match = takePreparedQueueMatch(track) || resolveTrack(track, url, manifest, isDownload);
  if (!match) return null;

  var streamPath = '/stream/' + encodeURIComponent(match.id);
  // NullBeat has one stream resolver for both playback and downloads. The quality
  // is encoded in the generated manifest URL; do not append a quality override.
  var streamUrl = endpoint(url, streamPath, null);
  // Orpheon asks for the next queue track about 10 seconds before it plays.
  // Use that ahead window to let NullBeat begin resolving/filling its cache.
  // Keep the total inside the 15-second audio hook budget.
  var attemptTimeout = isAhead ? 11000 : (isDownload ? 9000 : 4800);
  var maxAttempts = isAhead ? 1 : 2;
  var sr = { status: 0, data: null, headers: {} };
  for (var attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      sr = requestJson(streamUrl, attemptTimeout);
    } catch (streamError) {
      sr = { status: 0, data: null, headers: {} };
    }
    if (sr.status === 200 && sr.data && typeof sr.data.url === 'string' &&
        /^https:\/\//i.test(cleanText(sr.data.url))) break;
    var retryable = sr.status === 0 || sr.status === 408 || sr.status === 425 ||
      sr.status === 429 || sr.status === 500 || sr.status === 502 ||
      sr.status === 503 || sr.status === 504 ||
      (sr.status === 200 && (!sr.data || typeof sr.data.url !== 'string' ||
        !/^https:\/\//i.test(cleanText(sr.data.url))));
    if (!retryable || attempt === maxAttempts - 1) break;
  }
  if (sr.status === 401 || sr.status === 403) {
    if (feature('results')) return { outcome: 'sign-in', detail: 'Check the NullBeat manifest URL and access token in settings.' };
    return null;
  }
  if (sr.status === 429) {
    if (feature('results')) return { outcome: 'rate-limited', retryAfterMs: 60000 };
    return null;
  }
  if (sr.status !== 200 || !sr.data || typeof sr.data.url !== 'string') return null;

  var mediaUrl = cleanText(sr.data.url);
  if (!/^https:\/\//i.test(mediaUrl)) return null;

  var format = cleanText(sr.data.format).toLowerCase();
  if (!format) {
    if (/\.flac(?:[?#]|$)/i.test(mediaUrl)) format = 'flac';
    else if (/\.(?:m4a|mp4)(?:[?#]|$)/i.test(mediaUrl)) format = 'm4a';
    else if (/\.mp3(?:[?#]|$)/i.test(mediaUrl)) format = 'mp3';
  }
  if (format === 'aac' || format === 'mp4') format = 'm4a';
  if (format !== 'flac' && format !== 'm4a' && format !== 'mp3') return null;

  var title = cleanText(sr.data.title);
  var cacheText = cleanText(match.candidate && match.candidate.infotext);
  var cached = /torbox cached|cache hit|cached/i.test(title) ||
    /cached/i.test(cacheText) || !!sr.data.infohash || !!sr.data.cached;
  var quality = cleanText(sr.data.quality);
  var codec = cleanText(sr.data.codec).toLowerCase();
  if (!codec) codec = format === 'flac' ? 'flac' : (format === 'mp3' ? 'mp3' : 'aac');

  var expiresInMs;
  if (Number(sr.data.expiresAt) > 0) {
    expiresInMs = Math.max(0, Number(sr.data.expiresAt) * 1000 - Date.now());
  } else if (Number(sr.data.expiresInMs) >= 0 && sr.data.expiresInMs !== undefined) {
    expiresInMs = Number(sr.data.expiresInMs);
  }

  return {
    url: mediaUrl,
    format: format,
    codec: codec,
    bitDepth: Number(sr.data.bitDepth) || undefined,
    sampleRate: Number(sr.data.sampleRate) || undefined,
    durationMs: Number(track.durationMs) || undefined,
    expiresInMs: expiresInMs,
    quality: quality,
    cached: cached,
    cacheText: cacheText,
    sizeHint: Number(sr.data.sizeMb) > 0 ? Math.round(Number(sr.data.sizeMb) * 1048576) : undefined,
    isrcMatched: match.isrcMatched,
    title: title
  };
}

function cacheLabel(result) {
  if (result.cacheText) return 'NullBeat · ' + result.cacheText.replace(/\s+/g, ' ').substring(0, 70);
  if (result.cached) return 'NullBeat · TorBox cached' + (result.quality ? ' · ' + result.quality : '');
  if (result.quality) return 'NullBeat · ' + result.quality;
  if (result.title) return 'NullBeat · ' + result.title.replace(/\s+/g, ' ').substring(0, 55);
  return 'NullBeat · stream';
}

function audioAnswer(track) {
  try {
    var isAhead = !!(track && track.ahead === true);
    // Log on entry so the diagnostic still appears if NullBeat resolution later times out.
    if (isAhead) myspoti.log('NullBeat received an Orpheon ahead request for ' + cleanText(track.title).substring(0, 80) + '.');
    var result = resolveStream(track, false, isAhead);
    if (!result) {
      if (track && track.ahead === true) myspoti.log('NullBeat queue pre-resolution did not complete; playback will resolve the track normally.');
      return null;
    }
    if (result.outcome) return result;
    if (track && track.ahead === true) myspoti.log('NullBeat prepared the next queue track ahead of playback.');
    var answer = {
      url: result.url,
      source: cacheLabel(result),
      mimeType: result.format === 'flac' ? 'audio/flac' : (result.format === 'mp3' ? 'audio/mpeg' : 'audio/mp4'),
      durationMs: result.durationMs
    };
    if (feature('audio.expires') && result.expiresInMs !== undefined) answer.expiresInMs = result.expiresInMs;
    if (feature('audio.quality')) {
      if (result.codec) answer.codec = result.codec;
      if (result.bitDepth) answer.bitDepth = result.bitDepth;
      if (result.sampleRate) answer.sampleRate = result.sampleRate;
    }
    return answer;
  } catch (e) {
    myspoti.log('NullBeat stream error: ' + cleanText(e.message || e).substring(0, 160));
    if (feature('results')) return { outcome: 'network', detail: 'Could not reach the configured NullBeat addon.' };
    return null;
  }
}

function downloadAnswer(track) {
  try {
    var cacheOnly = myspoti.settings.get('cache_only') === true;
    var result = resolveStream(track, true);
    if (!result) return null;
    if (result.outcome) return result;
    if (cacheOnly) {
      // Resolving the stream asks NullBeat to prepare/cache the track. Do not
      // hand the playable URL to Revera in cache-only mode.
      myspoti.log('NullBeat cache-only: requested cache preparation for ' +
        cleanText(track && track.artist) + ' - ' + cleanText(track && track.title) + '.');
      return null;
    }
    return [{
      url: result.url,
      format: result.format,
      bitDepth: result.bitDepth,
      sampleRate: result.sampleRate,
      sizeHint: result.sizeHint,
      isrcMatched: result.isrcMatched
    }];
  } catch (e) {
    myspoti.log('NullBeat download error: ' + cleanText(e.message || e).substring(0, 160));
    if (feature('results')) return { outcome: 'network', detail: 'Could not reach the configured NullBeat addon.' };
    return null;
  }
}

myspoti.provide('audio-source', audioAnswer);
myspoti.provide('download-source', downloadAnswer);

myspoti.provide('status', function () {
  try {
    var url = manifestUrl();
    var manifest = getManifest(url, false);
    if (manifest && manifest.id) return { live: true };
    return { live: false, detail: 'NullBeat returned an invalid manifest. Check the URL and token.' };
  } catch (e) {
    return { live: false, detail: cleanText(e.message || e).substring(0, 120) };
  }
});

myspoti.on('queue', function (event) {
  try {
    prepareSpotifyQueue(event && event.next);
  } catch (e) {
    myspoti.log('NullBeat automatic queue preparation failed: ' + cleanText(e.message || e).substring(0, 160));
  }
});

myspoti.on('setting', function (event) {
  if (!event || event.key !== 'test_connection' || !event.pressed) return;
  try {
    var url = manifestUrl();
    var manifest = getManifest(url, true);
    if (!resource(manifest, 'search') || !resource(manifest, 'stream')) {
      myspoti.notify('Manifest loaded, but this addon does not advertise both search and stream.');
      return;
    }
    var sr = requestJson(endpoint(url, '/search', { q: SAMPLE_QUERY }), 9000);
    if (sr.status !== 200 || !sr.data) {
      myspoti.notify('Manifest OK; sample search failed (HTTP ' + sr.status + ').');
      return;
    }
    myspoti.notify('Connected to ' + cleanText(manifest.name).substring(0, 45) + '. Search endpoint responded.');
    myspoti.log('NullBeat connection test passed: ' + cleanText(manifest.id));
  } catch (e) {
    myspoti.notify('NullBeat test failed: ' + cleanText(e.message || e).substring(0, 140));
    myspoti.log('NullBeat connection test failed: ' + cleanText(e.message || e).substring(0, 180));
  }
});

myspoti.on('playback', function (event) {
  if (!event || !event.track) return;
  var ownDownload = event.origin === 'download' && event.providerId === myspoti.extension.id;
  var ownStream = event.origin === 'audio-source' && event.providerId === myspoti.extension.id;

  if (event.type === 'start') {
    if (!ownStream && !ownDownload) return;
    var stats = getStats();
    stats.plays += 1;
    stats.lastPlayedAt = Number(event.timestamp) || Date.now();
    if (ownStream) {
      stats.streamPlays += 1;
      myspoti.log('Playback origin: NullBeat stream.');
    } else if (ownDownload) {
      stats.downloadPlays += 1;
      myspoti.log('Playback origin: downloaded NullBeat track.');
    }
    saveStats();
    return;
  }

  if (!ownDownload && !ownStream) return;
  if (event.type === 'end' || event.type === 'skip') {
    var finalStats = getStats();
    if (event.type === 'end' && event.reason === 'finished') finalStats.completed += 1;
    if (event.type === 'skip') finalStats.skipped += 1;
    finalStats.playedMs += Math.max(0, Number(event.playedMs) || 0);
    saveStats();
  }
});

myspoti.on('setting', function (event) {
  if (!event || !event.pressed) return;
  if (event.key === 'show_stats') showStats();
  if (event.key === 'reset_stats') resetStats();
});
