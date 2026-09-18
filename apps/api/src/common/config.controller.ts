import { Controller, Get } from '@nestjs/common';
import {
  type AppearanceConfig,
  BASE_CURRENCY,
  DISPLAY_CURRENCIES,
  LOCALES,
  buildAppearance,
} from '@caseforge/shared';
import { Public } from '../auth/public.decorator';
import { loadConfig } from './config';
import { FxService } from './fx.service';
import { SettingsService } from './settings.service';

/**
 * Public settings for the front end: things the layout depends on that must
 * not be baked into the bundle at build time — otherwise the same image could
 * not be shipped to both staging and production.
 *
 * The appearance travels here too, which is what makes the site configurable
 * at all: the browser is told what the site is called, what colour it is and
 * which sections exist, rather than having it compiled in. No extra cache —
 * the settings service already holds them in memory for fifteen seconds, and a
 * save clears that locally, so an operator sees their own change at once.
 */
@Controller('api/config')
export class ConfigController {
  private readonly config = loadConfig();

  constructor(
    private readonly fx: FxService,
    private readonly settings: SettingsService,
  ) {}

  @Public()
  @Get()
  async get(): Promise<{
    baseCurrency: string;
    displayCurrencies: readonly string[];
    locales: readonly string[];
    fxRates: Record<string, number>;
    depositsEnabled: boolean;
    appearance: AppearanceConfig;
  }> {
    await this.settings.ensureFresh();

    return {
      baseCurrency: BASE_CURRENCY,
      displayCurrencies: DISPLAY_CURRENCIES,
      locales: LOCALES,
      /** How many base-currency units one unit of each display currency costs. */
      fxRates: this.fx.getRates(),
      depositsEnabled: this.config.ENABLE_STUB_DEPOSITS,
      // Built by the shared function the admin panel's fields are declared
      // against, so a renamed setting cannot quietly stop taking effect.
      appearance: buildAppearance((key) => this.settings.get(key as never)),
    };
  }
}
