/**
 * Parsing of the public Steam profile XML.
 *
 * Steam OpenID reports only a SteamID64 — the response carries neither the
 * nickname nor the avatar. They are usually read through the Web API
 * (`GetPlayerSummaries`), which needs a key. The public XML
 * (`/profiles/<id>?xml=1`) returns the same data without one, which makes it a
 * usable fallback: the site shows a proper profile straight after install,
 * before a STEAM_API_KEY exists.
 */

export interface SteamProfileXml {
  username: string | null;
  avatarUrl: string | null;
  accountCreatedAt: Date | null;
  isPrivate: boolean;
}

const CDATA_OPEN = '<![CDATA[';
const CDATA_CLOSE = ']]>';

/**
 * First occurrence of a tag, with the CDATA wrapper removed.
 *
 * Deliberately regex-free: CDATA markup consists entirely of characters that
 * need escaping inside a pattern, and one lost backslash turns the expression
 * into one that silently never matches.
 */
function firstTag(xml: string, tag: string): string | null {
  const open = `<${tag}>`;
  const close = `</${tag}>`;

  const start = xml.indexOf(open);
  if (start < 0) return null;
  const end = xml.indexOf(close, start + open.length);
  if (end < 0) return null;

  let value = xml.slice(start + open.length, end).trim();
  if (value.startsWith(CDATA_OPEN) && value.endsWith(CDATA_CLOSE)) {
    value = value.slice(CDATA_OPEN.length, -CDATA_CLOSE.length);
  }
  return value.trim() || null;
}

export function parseSteamProfileXml(xml: string): SteamProfileXml {
  // The profile embeds nested friend and group lists with their own
  // <avatarFull> and <steamID>. Cut everything after the first such list,
  // otherwise someone else's avatar lands in our profile.
  const cutAt = Math.min(
    ...['<groups>', '<friends>', '<friendslist>', '<mostPlayedGames>']
      .map((marker) => xml.indexOf(marker))
      .filter((i) => i >= 0)
      .concat([xml.length]),
  );
  const head = xml.slice(0, cutAt);

  const since = firstTag(head, 'memberSince');
  const parsedSince = since ? new Date(since) : null;

  return {
    username: firstTag(head, 'steamID'),
    avatarUrl: firstTag(head, 'avatarFull'),
    accountCreatedAt: parsedSince && !Number.isNaN(parsedSince.getTime()) ? parsedSince : null,
    // A hidden profile is an anti-fraud signal: throwaway accounts usually are.
    isPrivate: firstTag(head, 'privacyState') === 'private',
  };
}
