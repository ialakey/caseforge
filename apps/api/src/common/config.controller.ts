import { Controller, Get } from '@nestjs/common';
import { BASE_CURRENCY, DISPLAY_CURRENCIES, LOCALES } from '@caseforge/shared';
import { Public } from '../auth/public.decorator';
import { loadConfig } from './config';
import { FxService } from './fx.service';

/**
 * Public settings for the front end: things the layout depends on that must
 * not be baked into the bundle at build time — otherwise the same image could
 * not be shipped to both staging and production.
 */
@Controller('api/config')
export class ConfigController {
  private readonly config = loadConfig();

  constructor(private readonly fx: FxService) {}

  @Public()
  @Get()
  get() {
    return {
      baseCurrency: BASE_CURRENCY,
      displayCurrencies: DISPLAY_CURRENCIES,
      locales: LOCALES,
      /** How many base-currency units one unit of each display currency costs. */
      fxRates: this.fx.getRates(),
      depositsEnabled: this.config.ENABLE_STUB_DEPOSITS,
    };
  }
}
