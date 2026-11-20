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

function requestJsonWithRetry(url, timeout, label) {
  var first;
  try {
    first = requestJson(url, timeout);
  } catch (e) {
    first = { status: 0, data: null, headers: {} };
    myspoti.log('NullBeat ' + label + ' request error: ' + cleanText(e.message || e).substring(0, 120));
  }
  var status = Number(first.status) || 0;
  var retryable = status === 0 || status === 408 || status === 425 ||
    status === 500 || status === 502 || status === 503 || status === 504 ||
    (status === 200 && !first.data);
  if (!retryable) return first;

  myspoti.log('NullBeat ' + label + ' request returned HTTP ' + status + '; retrying once.');
  try {
    return requestJson(url, Math.min(3500, Math.max(timeout || 1000, Math.round((timeout || 1000) * 1.5))));
  } catch (e) {
    myspoti.log('NullBeat ' + label + ' retry error: ' + cleanText(e.message || e).substring(0, 120));
    return { status: 0, data: null, headers: {} };
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

function artistNames(value) {
  var values = [];
  if (Array.isArray(value)) {
    values = value.map(function (artist) {
      return cleanText(artist && (artist.name || artist.artist || artist));
    });
  } else if (value && typeof value === 'object') {
    values = [cleanText(value.name || value.artist)];
  } else {
    values = [cleanText(value)];
  }
  return values.map(normalize).filter(function (name) { return !!name; });
}

function candidateArtists(candidate) {
  if (!candidate) return [];
  var names = artistNames(candidate.artists);
  names = names.concat(artistNames(candidate.artist));
  return names.filter(function (name, index, all) { return all.indexOf(name) === index; });
}

function requestedArtists(track) {
  var names = artistNames(track && track.artists);
  names = names.concat(artistNames(track && track.artist));
  return names.filter(function (name, index, all) { return all.indexOf(name) === index; });
}

function artistMatches(track, candidate) {
  var wanted = requestedArtists(track);
  var found = candidateArtists(candidate);
  if (!wanted.length || !found.length) return false;
  for (var i = 0; i < wanted.length; i++) {
    if (found.indexOf(wanted[i]) >= 0) return true;
  }
  return false;
}

function sameRecording(track, candidate) {
  if (!candidate || candidate.id == null || cleanText(candidate.id) === '') return false;
  var requestedIsrc = cleanText(track.isrc).toUpperCase();
  var candidateIsrc = cleanText(candidate.isrc).toUpperCase();
  if (requestedIsrc && candidateIsrc) return requestedIsrc === candidateIsrc;

  if (normalize(track.title) !== normalize(candidate.title)) return false;
  if (!artistMatches(track, candidate)) return false;

  var wantedDuration = Number(track.durationMs || 0);
  var foundDuration = Number(candidate.durationMs || candidate.duration_ms || 0);
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

function chooseIsrcCandidate(track, items) {
  var wantedIsrc = cleanText(track && track.isrc).toUpperCase();
  if (!wantedIsrc) return null;
  var matches = [];
  for (var i = 0; i < items.length; i++) {
    var item = items[i];
    if (item && item.id && cleanText(item.isrc).toUpperCase() === wantedIsrc) {
      matches.push(item);
    }
  }
  for (var j = 0; j < matches.length; j++) {
    if (candidateIsCached(matches[j])) return matches[j];
  }
  return matches.length ? matches[0] : null;
}

function sameArtistAndTitle(track, candidate) {
  if (!candidate || candidate.id == null || cleanText(candidate.id) === '') return false;
  var wantedTitle = normalize(track.title);
  var foundTitle = normalize(candidate.title || candidate.name);
  if (!wantedTitle || wantedTitle !== foundTitle) return false;
  return artistMatches(track, candidate);
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

function cleanTitleForMatch(value) {
  return normalize(value)
    .replace(/\b(?:feat|ft|featuring)\b.*$/g, '')
    .replace(/\b(?:remaster(?:ed)?|radio edit|single version|album version|explicit|clean version|official audio|lyrics)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanArtistForMatch(value) {
  return normalize(value)
    .replace(/\b(?:feat|ft|featuring)\b.*$/g, '')
    .trim();
}

function cleanedArtistMatches(track, candidate) {
  var wanted = requestedArtists(track).map(cleanArtistForMatch).filter(function (v) { return !!v; });
  var found = candidateArtists(candidate).map(cleanArtistForMatch).filter(function (v) { return !!v; });
  for (var i = 0; i < wanted.length; i++) {
    for (var j = 0; j < found.length; j++) {
      if (wanted[i] === found[j] || wanted[i].indexOf(found[j]) === 0 || found[j].indexOf(wanted[i]) === 0) return true;
    }
  }
  return false;
}

function chooseCleanedCandidate(track, items) {
  var wantedTitle = cleanTitleForMatch(track && track.title);
  if (!wantedTitle) return null;
  var matches = [];
  for (var i = 0; i < items.length; i++) {
    var item = items[i];
    if (!item || !item.id) continue;
    var foundTitle = cleanTitleForMatch(item.title || item.name);
    if (wantedTitle === foundTitle && cleanedArtistMatches(track, item)) matches.push(item);
  }
  for (var j = 0; j < matches.length; j++) {
    if (candidateIsCached(matches[j])) return matches[j];
  }
  return matches.length ? matches[0] : null;
}

function candidateDurationMs(candidate) {
  var duration = Number(candidate && (candidate.durationMs || candidate.duration_ms || 0));
  if (!duration && Number(candidate && candidate.duration || 0)) duration = Number(candidate.duration) * 1000;
  return duration;
}

function candidateAlbum(candidate) {
  var album = candidate && candidate.album;
  if (album && typeof album === 'object') album = album.name || album.title;
  return normalize(album);
}

function candidateDurationMatches(track, candidate, toleranceMs) {
  var wanted = Number(track && track.durationMs) || 0;
  var found = candidateDurationMs(candidate);
  if (!wanted || !found) return true;
  return Math.abs(wanted - found) <= (toleranceMs || 12000);
}

function chooseExpandedCandidate(track, items) {
  var wantedTitle = cleanTitleForMatch(track && track.title);
  var wantedAlbum = normalize(track && track.album && (track.album.name || track.album));
  var matches = [];
  for (var i = 0; i < items.length; i++) {
    var item = items[i];
    if (!item || !item.id) continue;
    if (wantedTitle !== cleanTitleForMatch(item.title || item.name)) continue;
    // A title-only result is not sufficient: require a matching artist and
    // a plausible duration to avoid selecting a different recording.
    if (!cleanedArtistMatches(track, item)) continue;
    if (!candidateDurationMatches(track, item, 12000)) continue;
    matches.push(item);
  }
  matches.sort(function (a, b) {
    var aAlbum = wantedAlbum && candidateAlbum(a) === wantedAlbum ? 1 : 0;
    var bAlbum = wantedAlbum && candidateAlbum(b) === wantedAlbum ? 1 : 0;
    if (aAlbum !== bAlbum) return bAlbum - aAlbum;
    var wantedDuration = Number(track && track.durationMs) || 0;
    var aDelta = wantedDuration && candidateDurationMs(a) ? Math.abs(wantedDuration - candidateDurationMs(a)) : 999999999;
    var bDelta = wantedDuration && candidateDurationMs(b) ? Math.abs(wantedDuration - candidateDurationMs(b)) : 999999999;
    if (aDelta !== bDelta) return aDelta - bDelta;
    return (candidateIsCached(b) ? 1 : 0) - (candidateIsCached(a) ? 1 : 0);
  });
  return matches.length ? matches[0] : null;
}

function expandedSearchQueries(track) {
  var artist = cleanArtistForMatch(track && (track.artist || (track.artists && track.artists[0])));
  var title = cleanTitleForMatch(track && track.title);
  var queries = [];
  if (artist && title) queries.push(artist + ' ' + title);
  if (title) queries.push(title);
  return queries.filter(function (query, index, all) {
    return !!query && all.indexOf(query) === index;
  });
}

function trackArrays(data) {
  if (!data || typeof data !== 'object') return [];
  if (Array.isArray(data)) return data;
  var current = data;
  // Addon versions have returned the same catalogue list under different
  // envelope keys. Unwrap only known container shapes; never treat metadata
  // objects as track candidates.
  for (var depth = 0; depth < 4 && current && typeof current === 'object'; depth++) {
    if (Array.isArray(current.tracks)) return current.tracks;
    if (Array.isArray(current.results)) return current.results;
    if (Array.isArray(current.items)) return current.items;
    if (Array.isArray(current.data)) return current.data;
    if (current.data && typeof current.data === 'object') current = current.data;
    else break;
  }
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
  // Revera queue events use the standard hook Track shape:
  // { id, uri, title, artist, artists, album, durationMs, isrc? }.
  if (!item || !item.uri) return null;
  var title = cleanText(item.title || item.name);
  if (!title) return null;
  var artists = Array.isArray(item.artists) ? item.artists : [];
  var names = artists.map(function (artist) {
    return cleanText(artist && (artist.name || artist));
  }).filter(function (name) { return !!name; });
  var primaryArtist = cleanText(item.artist) || (names.length ? names[0] : '');
  if (!primaryArtist) return null;
  if (!names.length) names = [primaryArtist];
  return {
    uri: cleanText(item.uri),
    title: title,
    artist: primaryArtist,
    artists: names,
    durationMs: Number(item.durationMs) || 0,
    isrc: cleanText(item.isrc)
  };
}

// Revera delivers the published upcoming queue automatically. Keep all work
// inside its three-second event budget: four requests per parallel batch,
// short network timeouts, and no serial fallback on older hosts.
function prepareSpotifyQueue(nextItems) {
  var url;
  try { url = manifestUrl(); } catch (e) {
    myspoti.log('NullBeat queue preparation skipped: configure the addon URL first.');
    return;
  }
  if (!feature('http.all')) {
    myspoti.log('NullBeat automatic queue preparation needs Revera http.all; ahead-of-time playback fallback remains active.');
    return;
  }

  var tracks = [];
  var seen = {};
  var rawItems = Array.isArray(nextItems) ? nextItems : [];
  myspoti.log('NullBeat queue update received: ' + rawItems.length + ' upcoming entries.');
  for (var i = 0; i < rawItems.length && tracks.length < 5; i++) {
    var t = queueTrack(rawItems[i]);
    if (!t || seen[t.uri]) continue;
    seen[t.uri] = true;
    tracks.push(t);
  }
  preparedQueueMatches = {};
  if (!tracks.length) {
    myspoti.log('NullBeat queue preparation found no usable tracks (expected uri, title and artist).');
    return;
  }
  myspoti.log('NullBeat queue preparation accepted ' + tracks.length + ' tracks.');

  var searchUrls = tracks.map(function (track) {
    return endpoint(url, '/search', {
      q: track.artist + ' ' + track.title,
      limit: 10,
      type: 'track'
    });
  });
  var searchResults = [];
  for (var start = 0; start < searchUrls.length; start += 4) {
    searchResults = searchResults.concat(httpBatchJson(searchUrls.slice(start, start + 4), 450));
  }

  var matched = [];
  for (var j = 0; j < tracks.length; j++) {
    var response = searchResults[j];
    var items = response && response.status === 200 ? trackArrays(response.data) : [];
    var candidate = chooseIsrcCandidate(tracks[j], items);
    if (!candidate) candidate = chooseArtistTitleCandidate(tracks[j], items);
    if (!candidate) candidate = chooseCleanedCandidate(tracks[j], items);
    if (!candidate) continue;
    preparedQueueMatches[tracks[j].uri] = {
      id: String(candidate.id),
      isrcMatched: false,
      candidate: candidate
    };
    matched.push({ track: tracks[j], id: String(candidate.id) });
  }

  if (!matched.length) {
    myspoti.log('NullBeat queue preparation matched 0/' + tracks.length + ' tracks; no cache requests sent.');
    return;
  }

  // Calling the normal stream endpoint starts the backend's cache path.
  // Discard returned URLs: they may expire before the track is played.
  var streamUrls = matched.map(function (item) {
    return endpoint(url, '/stream/' + encodeURIComponent(item.id), null);
  });
  var prepared = 0;
  for (var k = 0; k < streamUrls.length; k += 4) {
    var streamResults = httpBatchJson(streamUrls.slice(k, k + 4), 450);
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
    var sr = requestJsonWithRetry(endpoint(url, '/search', {
      q: query,
      limit: isDownload ? 20 : 10,
      type: 'track'
    }), isDownload ? 2200 : 1000, 'track search');
    if (sr.status === 200 && sr.data) {
      var items = trackArrays(sr.data);
      // Matching priority: exact ISRC, ISRC resolver ID, exact artist + title,
      // then cleaned artist + title. Never let a weaker title match override ISRC.
      var match = chooseIsrcCandidate(track, items);
      if (match) {
        myspoti.log('NullBeat matched by ISRC.');
        return { id: String(match.id), isrcMatched: true, candidate: match };
      }
      if (resolvedIsrcId) {
        myspoti.log('NullBeat resolved track by ISRC endpoint.');
        return { id: resolvedIsrcId, isrcMatched: true, candidate: null };
      }
      match = chooseArtistTitleCandidate(track, items);
      if (match) {
        myspoti.log('NullBeat matched by exact artist + title.');
        return { id: String(match.id), isrcMatched: false, candidate: match };
      }
      match = chooseCleanedCandidate(track, items);
      if (match) {
        myspoti.log('NullBeat matched by cleaned artist + title.');
        return { id: String(match.id), isrcMatched: false, candidate: match };
      }
      // Search expansion is deliberately bounded to two extra queries and
      // is only used after the primary search fails. Do not retry HTTP 429:
      // extra traffic during rate limiting would make the problem worse.
      var expandedQueries = expandedSearchQueries(track);
      var expandedItems = items.slice(0);
      for (var qi = 0; qi < expandedQueries.length; qi++) {
        if (normalize(expandedQueries[qi]) === normalize(query)) continue;
        var er = requestJson(endpoint(url, '/search', {
          q: expandedQueries[qi],
          limit: isDownload ? 20 : 10,
          type: 'track'
        }), isDownload ? 1300 : 850);
        if (er.status === 429) {
          myspoti.log('NullBeat fallback search stopped: HTTP 429 rate limit.');
          break;
        }
        if (er.status !== 200 || !er.data) {
          myspoti.log('NullBeat fallback search failed (HTTP ' + (Number(er.status) || 0) + ').');
          continue;
        }
        var extraItems = trackArrays(er.data);
        for (var ei = 0; ei < extraItems.length; ei++) {
          var duplicate = false;
          for (var di = 0; di < expandedItems.length; di++) {
            if (cleanText(expandedItems[di].id) === cleanText(extraItems[ei] && extraItems[ei].id)) {
              duplicate = true;
              break;
            }
          }
          if (!duplicate && extraItems[ei]) expandedItems.push(extraItems[ei]);
        }
        match = chooseIsrcCandidate(track, expandedItems);
        if (!match) match = chooseArtistTitleCandidate(track, expandedItems);
        if (!match) match = chooseCleanedCandidate(track, expandedItems);
        if (!match) match = chooseExpandedCandidate(track, expandedItems);
        if (match) {
          myspoti.log('NullBeat matched using expanded search query: ' + expandedQueries[qi].substring(0, 70) + '.');
          return {
            id: String(match.id),
            isrcMatched: !!(isrc && cleanText(match.isrc).toUpperCase() === isrc.toUpperCase()),
            candidate: match
          };
        }
      }
      myspoti.log('NullBeat search returned ' + expandedItems.length + ' combined results but none matched ' +
        cleanText(track.artist) + ' - ' + cleanText(track.title) + '.');
    } else {
      myspoti.log('NullBeat track search failed (HTTP ' + (Number(sr.status) || 0) + ') for ' +
        cleanText(track.artist) + ' - ' + cleanText(track.title) + '.');
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

function downloadDiagnostic(track, reason) {
  var artist = cleanText(track && (track.artist || (track.artists && track.artists[0])));
  var title = cleanText(track && track.title);
  var label = (artist ? artist + ' - ' : '') + (title || 'Unknown track');
  myspoti.log('NullBeat download diagnostic [' + label.substring(0, 100) + ']: ' +
    cleanText(reason).substring(0, 180));
}

function resolveStream(track, isDownload, isAhead) {
  var url = manifestUrl();
  var manifest = getManifest(url, false);
  if (!resource(manifest, 'stream')) {
    if (isDownload) downloadDiagnostic(track, 'Addon manifest does not advertise the stream resource.');
    return null;
  }

  var match = takePreparedQueueMatch(track) || resolveTrack(track, url, manifest, isDownload);
  if (!match) {
    if (isDownload) downloadDiagnostic(track, 'No matching NullBeat catalogue track was found.');
    return null;
  }

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
    if (feature('results')) return { outcome: 'rate-limited', retryAfterMs: 5000 };
    return null;
  }
  if (sr.status !== 200 || !sr.data || typeof sr.data.url !== 'string') {
    if (isDownload) {
      downloadDiagnostic(track, 'Stream endpoint failed: HTTP ' + (Number(sr.status) || 0) +
        ', attempts=' + maxAttempts + ', response=' + (sr.data ? 'JSON without a URL' : 'no JSON response') + '.');
    }
    return null;
  }

  var mediaUrl = cleanText(sr.data.url);
  if (!/^https:\/\//i.test(mediaUrl)) {
    if (isDownload) downloadDiagnostic(track, 'Stream endpoint returned a media URL that is not HTTPS.');
    return null;
  }

  var format = cleanText(sr.data.format).toLowerCase();
  if (!format) {
    if (/\.flac(?:[?#]|$)/i.test(mediaUrl)) format = 'flac';
    else if (/\.(?:m4a|mp4)(?:[?#]|$)/i.test(mediaUrl)) format = 'm4a';
    else if (/\.mp3(?:[?#]|$)/i.test(mediaUrl)) format = 'mp3';
  }
  if (format === 'aac' || format === 'mp4') format = 'm4a';
  if (format !== 'flac' && format !== 'm4a' && format !== 'mp3') {
    if (isDownload) {
      downloadDiagnostic(track, 'Unsupported or missing format: format=' +
        cleanText(sr.data.format || '(empty)') + ', mimeType=' +
        cleanText(sr.data.mimeType || sr.data.contentType || '(not supplied)') +
        ', codec=' + cleanText(sr.data.codec || '(not supplied)') + '.');
    }
    return null;
  }

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

  if (isDownload) {
    downloadDiagnostic(track, 'Resolved successfully: format=' + format +
      ', cache=' + (cached ? 'cached' : 'not marked cached') +
      ', expiry=' + (expiresInMs === undefined ? 'unknown' : expiresInMs + 'ms') + '.');
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
    if (result.outcome) {
      downloadDiagnostic(track, 'Resolver returned outcome=' + cleanText(result.outcome) + '.');
      return result;
    }
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
