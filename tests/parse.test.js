const test = require('node:test');
const assert = require('node:assert/strict');
const { parseEntry, parseInput, isValidStoredEntry } = require('../assets/parse.js');

const yt = value => ({ type: 'youtube', kind: 'video', value });
const live = value => ({ type: 'youtube', kind: 'live', value });
const tw = (kind, value) => ({ type: 'twitch', kind, value });

test('YouTube video URLs and IDs', () => {
  assert.deepEqual(parseEntry('dQw4w9WgXcQ'), yt('dQw4w9WgXcQ'));
  assert.deepEqual(parseEntry('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10'), yt('dQw4w9WgXcQ'));
  assert.deepEqual(parseEntry('youtu.be/dQw4w9WgXcQ'), yt('dQw4w9WgXcQ'));
  assert.deepEqual(parseEntry('https://m.youtube.com/live/dQw4w9WgXcQ?si=x'), yt('dQw4w9WgXcQ'));
  assert.deepEqual(parseEntry('https://www.youtube.com/shorts/dQw4w9WgXcQ'), yt('dQw4w9WgXcQ'));
  assert.deepEqual(parseEntry('yt:dQw4w9WgXcQ'), yt('dQw4w9WgXcQ'));
});

test('YouTube channel live URLs', () => {
  assert.deepEqual(parseEntry('https://www.youtube.com/@nijisanji_official/live'), live('@nijisanji_official'));
  assert.deepEqual(parseEntry('youtube.com/@handle'), live('@handle'));
  assert.deepEqual(parseEntry('@handle'), live('@handle'));
  const id = 'UC' + 'a'.repeat(22);
  assert.deepEqual(parseEntry(`https://www.youtube.com/channel/${id}/live`), live(id));
  assert.deepEqual(parseEntry(`https://www.youtube.com/embed/live_stream?channel=${id}`), live(id));
});

test('Twitch URLs', () => {
  assert.deepEqual(parseEntry('https://www.twitch.tv/someone'), tw('channel', 'someone'));
  assert.deepEqual(parseEntry('twitch:someone'), tw('channel', 'someone'));
  assert.deepEqual(parseEntry('https://www.twitch.tv/videos/12345'), tw('vod', '12345'));
  assert.deepEqual(parseEntry('https://clips.twitch.tv/FunnyClip-abc'), tw('clip', 'FunnyClip-abc'));
  assert.deepEqual(parseEntry('https://www.twitch.tv/someone/clip/FunnyClip-abc'), tw('clip', 'FunnyClip-abc'));
  assert.deepEqual(parseEntry('https://player.twitch.tv/?channel=someone&parent=x'), tw('channel', 'someone'));
});

test('rejects input that is not a stream instead of guessing an ID', () => {
  assert.equal(parseEntry('kawaiichannel'), null);
  assert.equal(parseEntry('https://example.com/watch?v=dQw4w9WgXcQ'), null);
  assert.equal(parseEntry('twitch.tv/directory'), null);
  assert.equal(parseEntry('https://www.youtube.com/feed/subscriptions'), null);
  assert.equal(parseEntry('twitch:bad name!'), null);
});

test('parseInput splits lines/commas and removes duplicates', () => {
  const entries = parseInput('dQw4w9WgXcQ\nhttps://youtu.be/dQw4w9WgXcQ, twitch.tv/Someone, twitch:someone, nope');
  assert.deepEqual(entries, [yt('dQw4w9WgXcQ'), tw('channel', 'Someone')]);
});

test('isValidStoredEntry only accepts resolved, well-formed entries', () => {
  assert.ok(isValidStoredEntry(yt('dQw4w9WgXcQ')));
  assert.ok(isValidStoredEntry(tw('vod', 'v12345')));
  assert.ok(!isValidStoredEntry(live('@handle')));
  assert.ok(!isValidStoredEntry({ type: 'youtube', kind: 'video', value: "x');alert(1)//" }));
  assert.ok(!isValidStoredEntry({ type: 'other', kind: 'video', value: 'dQw4w9WgXcQ' }));
});
