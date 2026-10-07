// ===== URL / ID parsing (shared by the app and the Node tests) =====
// parseEntry returns { type:'youtube'|'twitch', kind, value } | null
//   youtube: kind 'video' (value = 11-char ID) | 'live' (value = '@handle' or 'UC…' channel ID)
//   twitch : kind 'channel' | 'vod' | 'clip'
(function (root) {
  const YT_ID = /^[A-Za-z0-9_-]{11}$/;
  const YT_HANDLE = /^@[^\s/?#]{1,100}$/;
  const YT_CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;
  const TWITCH_NAME = /^[A-Za-z0-9_]{1,25}$/;
  const TWITCH_VOD = /^v?\d+$/;
  const TWITCH_CLIP = /^[A-Za-z0-9_-]+$/;
  // twitch.tv/<path> that are site pages, not channels
  const TWITCH_RESERVED = new Set([
    'directory', 'videos', 'search', 'settings', 'downloads', 'jobs', 'turbo', 'p', 'u',
    'subscriptions', 'inventory', 'wallet', 'drops', 'following', 'friends', 'messages',
    'payments', 'prime', 'store', 'moderator', 'popout', 'embed', 'login', 'signup',
  ]);

  function safeDecode(part) {
    try { return decodeURIComponent(part); } catch (e) { return part; }
  }
  function youtubeChannel(value) {
    if (YT_HANDLE.test(value) || YT_CHANNEL_ID.test(value)) return { type: 'youtube', kind: 'live', value };
    return null;
  }
  function twitchChannel(value) {
    if (!TWITCH_NAME.test(value) || TWITCH_RESERVED.has(value.toLowerCase())) return null;
    return { type: 'twitch', kind: 'channel', value };
  }

  function parseYouTubeUrl(url) {
    const v = url.searchParams.get('v');
    if (v && YT_ID.test(v)) return { type: 'youtube', kind: 'video', value: v };
    const parts = url.pathname.split('/').filter(Boolean).map(safeDecode);
    // "live_stream" is itself 11 characters, so check it before the video-ID pattern
    if (parts[0] === 'embed' && parts[1] === 'live_stream') {
      return youtubeChannel(url.searchParams.get('channel') || '');
    }
    if (['live', 'embed', 'shorts', 'v'].includes(parts[0]) && parts[1] && YT_ID.test(parts[1])) {
      return { type: 'youtube', kind: 'video', value: parts[1] };
    }
    if (parts[0] && parts[0].startsWith('@')) return youtubeChannel(parts[0]);
    if (parts[0] === 'channel' && parts[1]) return youtubeChannel(parts[1]);
    return null;
  }

  function parseTwitchUrl(url, host) {
    if (host === 'player.twitch.tv') {
      const ch = url.searchParams.get('channel');
      const vid = url.searchParams.get('video');
      const clip = url.searchParams.get('clip');
      if (ch) return twitchChannel(ch);
      if (vid && TWITCH_VOD.test(vid)) return { type: 'twitch', kind: 'vod', value: vid };
      if (clip && TWITCH_CLIP.test(clip)) return { type: 'twitch', kind: 'clip', value: clip };
      return null;
    }
    const parts = url.pathname.split('/').filter(Boolean);
    if (host === 'clips.twitch.tv') {
      return parts[0] && TWITCH_CLIP.test(parts[0]) ? { type: 'twitch', kind: 'clip', value: parts[0] } : null;
    }
    if (parts[0] === 'videos') {
      return parts[1] && TWITCH_VOD.test(parts[1]) ? { type: 'twitch', kind: 'vod', value: parts[1] } : null;
    }
    if (parts[1] === 'clip' && parts[2] && TWITCH_CLIP.test(parts[2])) {
      return { type: 'twitch', kind: 'clip', value: parts[2] };
    }
    return parts[0] ? twitchChannel(parts[0]) : null;
  }

  function parseEntry(raw) {
    const s = (raw || '').trim();
    if (!s) return null;
    let m;
    if ((m = s.match(/^(?:twitch|tw):(.+)$/i))) return twitchChannel(m[1].trim());
    if ((m = s.match(/^(?:youtube|yt):(.+)$/i))) {
      const v = m[1].trim();
      return YT_ID.test(v) ? { type: 'youtube', kind: 'video', value: v } : youtubeChannel(v);
    }
    if (YT_ID.test(s)) return { type: 'youtube', kind: 'video', value: s };
    if (s.startsWith('@')) return youtubeChannel(s);
    let url;
    try { url = new URL(/^https?:\/\//i.test(s) ? s : 'https://' + s); } catch (e) { return null; }
    const host = url.hostname.toLowerCase().replace(/^(www|m)\./, '');
    if (host === 'youtu.be') {
      const id = url.pathname.split('/').filter(Boolean)[0];
      return id && YT_ID.test(id) ? { type: 'youtube', kind: 'video', value: id } : null;
    }
    if (host === 'youtube.com' || host.endsWith('.youtube.com') ||
        host === 'youtube-nocookie.com' || host.endsWith('.youtube-nocookie.com')) {
      return parseYouTubeUrl(url);
    }
    if (host === 'twitch.tv' || host.endsWith('.twitch.tv')) return parseTwitchUrl(url, host);
    return null;
  }

  function entryKey(e) {
    // YouTube video IDs are case-sensitive; Twitch names and handles are not.
    const value = (e.type === 'youtube' && e.kind === 'video') ? e.value : e.value.toLowerCase();
    return `${e.type}:${e.kind}:${value}`;
  }

  function parseInput(raw) {
    const parts = (raw || '').split(/[\n,]+/).map(s => s.trim()).filter(Boolean);
    const seen = new Set();
    const entries = [];
    for (const p of parts) {
      const e = parseEntry(p);
      if (!e) continue;
      const key = entryKey(e);
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push(e);
    }
    return entries;
  }

  // Validates an entry restored from storage or a shared URL (only playable, resolved kinds).
  function isValidStoredEntry(o) {
    if (!o || typeof o.value !== 'string') return false;
    if (o.type === 'youtube') return o.kind === 'video' && YT_ID.test(o.value);
    if (o.type === 'twitch') {
      if (o.kind === 'channel') return TWITCH_NAME.test(o.value);
      if (o.kind === 'vod') return TWITCH_VOD.test(o.value);
      if (o.kind === 'clip') return TWITCH_CLIP.test(o.value);
    }
    return false;
  }

  const api = { parseEntry, parseInput, entryKey, isValidStoredEntry };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else Object.assign(root, api);
})(this);
