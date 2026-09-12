import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { parseSteamProfileXml } from '@caseforge/shared';
import { loadConfig } from '../common/config';

const OPENID_ENDPOINT = 'https://steamcommunity.com/openid/login';
const CLAIMED_ID_REGEX = /^https:\/\/steamcommunity\.com\/openid\/id\/(\d{17})$/;

// steamcommunity.com serves the XML only to browser-looking clients.
const XML_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';

export interface SteamProfile {
  steamId64: string;
  username: string;
  avatarUrl: string | null;
  profileUrl: string;
  accountCreatedAt: Date | null;
}

/**
 * Steam does not support OAuth — only OpenID 2.0.
 * The profile is read afterwards, through the Web API or the public XML.
 */
@Injectable()
export class SteamOpenIdService {
  private readonly logger = new Logger(SteamOpenIdService.name);
  private readonly config = loadConfig();

  /** URL the player is redirected to in order to sign in. */
  buildAuthUrl(): string {
    const params = new URLSearchParams({
      'openid.ns': 'http://specs.openid.net/auth/2.0',
      'openid.mode': 'checkid_setup',
      'openid.return_to': this.config.STEAM_RETURN_URL,
      'openid.realm': this.config.STEAM_REALM,
      'openid.identity': 'http://specs.openid.net/auth/2.0/identifier_select',
      'openid.claimed_id': 'http://specs.openid.net/auth/2.0/identifier_select',
    });
    return `${OPENID_ENDPOINT}?${params.toString()}`;
  }

  /**
   * Verifies Steam's response. Without a check_authentication round trip the
   * return parameters are trivially forgeable — this is the only step that
   * proves the answer really came from Steam.
   */
  async verifyCallback(query: Record<string, string | undefined>): Promise<string> {
    if (query['openid.mode'] !== 'id_res') {
      throw new UnauthorizedException('Malformed Steam OpenID response');
    }

    const body = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (key.startsWith('openid.') && value !== undefined) body.append(key, value);
    }
    body.set('openid.mode', 'check_authentication');

    const response = await fetch(OPENID_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const text = await response.text();

    if (!/is_valid\s*:\s*true/.test(text)) {
      this.logger.warn(`Steam rejected the OpenID check: ${text.slice(0, 200)}`);
      throw new UnauthorizedException('Steam did not confirm the sign-in');
    }

    const claimedId = query['openid.claimed_id'] ?? '';
    const match = CLAIMED_ID_REGEX.exec(claimedId);
    if (!match) {
      throw new UnauthorizedException(`Could not parse a SteamID out of ${claimedId}`);
    }
    return match[1];
  }

  /**
   * Reads the nickname and avatar. Steam never returns an e-mail address —
   * the system will not have one unless the player types it in.
   *
   * Two sources: the Web API (needs a key, returns more) and the public
   * profile XML (no key). The XML is not a development shim but a working
   * fallback: if the Web API is down or the key has expired the player still
   * sees their own nickname and avatar instead of "user_123456".
   */
  async fetchProfile(steamId64: string): Promise<SteamProfile> {
    if (this.config.STEAM_API_KEY) {
      try {
        return await this.fetchProfileViaWebApi(steamId64);
      } catch (err) {
        this.logger.warn(
          `Web API unavailable (${String(err)}), falling back to the public profile XML`,
        );
      }
    }
    return this.fetchProfileViaXml(steamId64);
  }

  /** Public profile XML: nickname and avatar without an API key. */
  private async fetchProfileViaXml(steamId64: string): Promise<SteamProfile> {
    const fallback: SteamProfile = {
      steamId64,
      username: `user_${steamId64.slice(-6)}`,
      avatarUrl: null,
      profileUrl: `https://steamcommunity.com/profiles/${steamId64}`,
      accountCreatedAt: null,
    };

    try {
      const response = await fetch(
        `https://steamcommunity.com/profiles/${steamId64}?xml=1`,
        { headers: { 'User-Agent': XML_USER_AGENT }, signal: AbortSignal.timeout(10_000) },
      );
      if (!response.ok) return fallback;

      const parsed = parseSteamProfileXml(await response.text());
      return {
        steamId64,
        username: parsed.username ?? fallback.username,
        avatarUrl: parsed.avatarUrl,
        profileUrl: fallback.profileUrl,
        accountCreatedAt: parsed.accountCreatedAt,
      };
    } catch (err) {
      // A missing profile is no reason to block sign-in: OpenID has already
      // confirmed the identity, and the nickname and avatar will arrive on the
      // next login.
      this.logger.warn(`Could not read the profile XML for ${steamId64}: ${String(err)}`);
      return fallback;
    }
  }

  private async fetchProfileViaWebApi(steamId64: string): Promise<SteamProfile> {
    const url = new URL('https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/');
    url.searchParams.set('key', this.config.STEAM_API_KEY);
    url.searchParams.set('steamids', steamId64);

    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Steam Web API returned ${response.status}`);
    }
    const data = (await response.json()) as {
      response?: { players?: Array<Record<string, unknown>> };
    };
    const player = data.response?.players?.[0];
    if (!player) {
      throw new Error('Steam profile missing from the Web API response');
    }

    return {
      steamId64,
      username: String(player.personaname ?? `user_${steamId64.slice(-6)}`),
      avatarUrl: (player.avatarfull as string | undefined) ?? null,
      profileUrl: String(player.profileurl ?? `https://steamcommunity.com/profiles/${steamId64}`),
      accountCreatedAt: player.timecreated
        ? new Date(Number(player.timecreated) * 1000)
        : null,
    };
  }
}
