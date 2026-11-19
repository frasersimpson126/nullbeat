'use strict';

/*
 * NullBeat for Orpheon
 * Orpheon API v1 / Eclipse addon HTTP protocol.
 * Keep this file ES6/Rhino compatible: no fetch, promises, timers or Node APIs.
 */

var EXTENSION_NAME = 'NullBeat';
var SAMPLE_QUERY = 'Never Gonna Give You Up Rick Astley';
var manifestCache = null;
var manifestCacheUrl = '';
var manifestCacheAt = 0;

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
  path = path.replace(/\/+$/, '');
  if (/\/manifest\.json$/i.test(path)) path = path.substring(0, path.length - 13);
  else if (/\/manifest$/i.test(path)) path = path.substring(0, path.length - 9);
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
  var r = requestJson(url, 1500);
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

function trackArrays(data) {
  if (!data || typeof data !== 'object') return [];
  if (Array.isArray(data.tracks)) return data.tracks;
  if (data.data && Array.isArray(data.data.tracks)) return data.data.tracks;
  if (data.data && data.data.data && Array.isArray(data.data.data.tracks)) return data.data.data.tracks;
  if (Array.isArray(data.results)) return data.results;
  return [];
}

function resolveTrack(track, url, manifest) {
  var isrc = cleanText(track.isrc);
  if (isrc && resource(manifest, 'isrc')) {
    var ir = requestJson(endpoint(url, '/resolve-isrc', { isrc: isrc }), 1500);
    if (ir.status === 200 && ir.data) {
      var resolvedId = cleanText(ir.data.trackId || ir.data.id);
      if (resolvedId) return { id: resolvedId, isrcMatched: true, candidate: null };
    }
  }

  if (resource(manifest, 'resolve')) {
    var rr = requestJson(endpoint(url, '/resolve', {
      isrc: isrc || undefined,
      title: track.title,
      artist: track.artist || (track.artists && track.artists[0]),
      durationMs: track.durationMs || undefined
    }), 3000);
    if (rr.status === 200 && rr.data && rr.data.item && sameRecording(track, rr.data.item)) {
      return {
        id: String(rr.data.item.id),
        isrcMatched: !!(isrc && cleanText(rr.data.item.isrc).toUpperCase() === isrc.toUpperCase()),
        candidate: rr.data.item
      };
    }
  }

  var query = cleanText((track.artist || '') + ' ' + (track.title || ''));
  if (!query) return null;
  var sr = requestJson(endpoint(url, '/search', { q: query }), 2000);
  if (sr.status !== 200 || !sr.data) return null;

  var items = trackArrays(sr.data);
  var exactIsrc = null;
  var exactIdentity = null;
  for (var i = 0; i < items.length; i++) {
    var item = items[i];
    if (!item || !item.id) continue;
    if (isrc && cleanText(item.isrc).toUpperCase() === isrc.toUpperCase()) {
      exactIsrc = item;
      break;
    }
    if (!exactIdentity && sameRecording(track, item)) exactIdentity = item;
  }
  var match = exactIsrc || exactIdentity;
  if (!match) return null;
  return {
    id: String(match.id),
    isrcMatched: !!(isrc && cleanText(match.isrc).toUpperCase() === isrc.toUpperCase()),
    candidate: match
  };
}

function resolveStream(track, isDownload) {
  var url = manifestUrl();
  var manifest = getManifest(url, false);
  if (!resource(manifest, 'stream')) return null;

  var match = resolveTrack(track, url, manifest);
  if (!match) return null;

  var streamPath = '/stream/' + encodeURIComponent(match.id);
  var streamUrl = endpoint(url, streamPath, isDownload ? { download: 'true' } : null);
  var sr = requestJson(streamUrl, isDownload ? 25000 : 11000);
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
  var cached = /torbox cached|cache hit|cached/i.test(title) ||
    !!sr.data.infohash || !!sr.data.cached;
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
    isrcMatched: match.isrcMatched,
    title: title
  };
}

function cacheLabel(result) {
  if (result.cached) return 'NullBeat · TorBox cached' + (result.quality ? ' · ' + result.quality : '');
  if (result.quality) return 'NullBeat · ' + result.quality;
  if (result.title) return 'NullBeat · ' + result.title.replace(/\s+/g, ' ').substring(0, 55);
  return 'NullBeat · stream';
}

function audioAnswer(track) {
  try {
    var result = resolveStream(track, false);
    if (!result) return null;
    if (result.outcome) return result;
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
    var result = resolveStream(track, true);
    if (!result) return null;
    if (result.outcome) return result;
    return [{
      url: result.url,
      format: result.format,
      provider: result.cached ? 'NullBeat · TorBox cached' : 'NullBeat',
      bitDepth: result.bitDepth,
      sampleRate: result.sampleRate,
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
  if (!event || event.type !== 'start' || !event.track) return;
  if (event.origin === 'download' && event.providerId === myspoti.extension.id) {
    myspoti.log('Playback origin: downloaded NullBeat track.');
  } else if (event.origin === 'audio-source' && event.providerId === myspoti.extension.id) {
    myspoti.log('Playback origin: NullBeat stream.');
  }
});
