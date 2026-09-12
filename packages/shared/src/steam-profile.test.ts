import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { parseSteamProfileXml } from './steam-profile.ts';

const PROFILE = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><profile>
  <steamID64>76561197960435530</steamID64>
  <steamID><![CDATA[Robin]]></steamID>
  <privacyState>public</privacyState>
  <avatarIcon><![CDATA[https://avatars.fastly.steamstatic.com/abc.jpg]]></avatarIcon>
  <avatarFull><![CDATA[https://avatars.fastly.steamstatic.com/abc_full.jpg]]></avatarFull>
  <memberSince>September 12, 2003</memberSince>
</profile>`;

test('nickname and avatar are extracted from the XML', () => {
  const p = parseSteamProfileXml(PROFILE);
  assert.equal(p.username, 'Robin');
  assert.equal(p.avatarUrl, 'https://avatars.fastly.steamstatic.com/abc_full.jpg');
  assert.equal(p.isPrivate, false);
  assert.equal(p.accountCreatedAt?.getUTCFullYear(), 2003);
});

test('avatars from the friends list do not replace our own', () => {
  // The profile XML continues with nested lists carrying their own <steamID>
  // and <avatarFull>. Grabbing whichever comes first means showing the player
  // somebody else's nickname and avatar.
  const withFriends = PROFILE.replace(
    '</profile>',
    `<friends>
       <friend><steamID><![CDATA[SomeoneElse]]></steamID>
       <avatarFull><![CDATA[https://avatars.fastly.steamstatic.com/other_full.jpg]]></avatarFull></friend>
     </friends></profile>`,
  );
  const p = parseSteamProfileXml(withFriends);
  assert.equal(p.username, 'Robin');
  assert.match(p.avatarUrl ?? '', /abc_full/);
});

test('a private profile is recognised', () => {
  const priv = PROFILE.replace('<privacyState>public</privacyState>', '<privacyState>private</privacyState>');
  assert.equal(parseSteamProfileXml(priv).isPrivate, true);
});

test('empty or malformed XML does not break parsing', () => {
  for (const xml of ['', '<profile></profile>', 'not xml at all']) {
    const p = parseSteamProfileXml(xml);
    assert.equal(p.username, null);
    assert.equal(p.avatarUrl, null);
    assert.equal(p.accountCreatedAt, null);
  }
});

test('an invalid registration date does not break the profile', () => {
  const broken = PROFILE.replace('September 12, 2003', 'a long time ago');
  const p = parseSteamProfileXml(broken);
  assert.equal(p.accountCreatedAt, null);
  assert.equal(p.username, 'Robin');
});
