import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  UserRole,
  adjustBalanceSchema,
  importItemsSchema,
  paginationSchema,
  steamSearchSchema,
  upsertCaseChecked,
  upsertCaseCategorySchema,
  upsertPromoCodeSchema,
  settingDefinitions,
  type UpsertCaseInput,
  type UpsertCaseCategoryInput,
  type UpsertPromoCodeInput,
} from '@caseforge/shared';
import { AdminService } from './admin.service';
import { ReportsService } from './reports.service';
import { CasesService } from '../cases/cases.service';
import { SteamMarketService } from '../steam/steam-market.service';
import { ItemSyncService } from '../steam/item-sync.service';
import { SettingsService } from '../common/settings.service';
import { PromoService } from '../promo/promo.service';
import { Roles } from '../common/roles.decorator';
import { RolesGuard } from '../common/roles.guard';
import { CurrentUser, type AuthenticatedUser } from '../common/current-user.decorator';
import { ZodValidationPipe } from '../common/zod-validation.pipe';

const periodSchema = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

const botStatusSchema = z.object({
  status: z.enum(['DISABLED', 'OFFLINE']),
});

/** The same two transitions a bot has, for the same reason. */
const marketAccountStatusSchema = z.object({
  status: z.enum(['DISABLED', 'OFFLINE']),
});

/**
 * Settings arrive as a partial map. Validating the individual values is the
 * registry's job, so this only pins the envelope.
 */
const saveSettingsSchema = z.object({
  values: z.record(z.string(), z.unknown()),
});

const banSchema = z.object({
  isBanned: z.boolean(),
  reason: z.string().trim().max(500).nullable().default(null),
});

/** Reports default to the last 30 days. */
function resolvePeriod(query: { from?: Date; to?: Date }): { from: Date; to: Date } {
  const to = query.to ?? new Date();
  const from = query.from ?? new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);
  return { from, to };
}

@Controller('api/admin')
@UseGuards(RolesGuard)
@Roles(UserRole.ANALYST)
export class AdminController {
  constructor(
    private readonly admin: AdminService,
    private readonly cases: CasesService,
    private readonly market: SteamMarketService,
    private readonly itemSync: ItemSyncService,
    private readonly settings: SettingsService,
    private readonly promo: PromoService,
    private readonly reports: ReportsService,
  ) {}

  @Get('dashboard')
  dashboard(@Query(new ZodValidationPipe(periodSchema)) query: { from?: Date; to?: Date }) {
    const { from, to } = resolvePeriod(query);
    return this.admin.dashboard(from, to);
  }

  @Get('reports/cases')
  caseReport(@Query(new ZodValidationPipe(periodSchema)) query: { from?: Date; to?: Date }) {
    const { from, to } = resolvePeriod(query);
    return this.admin.caseReport(from, to);
  }

  @Get('cases')
  listCases() {
    return this.admin.listCases();
  }

  /** The shelves the catalogue is grouped into. */
  @Get('categories')
  listCategories() {
    return this.admin.listCategories();
  }

  @Post('categories')
  @Roles(UserRole.ADMIN)
  upsertCategory(
    @CurrentUser() actor: AuthenticatedUser,
    @Body(new ZodValidationPipe(upsertCaseCategorySchema)) body: UpsertCaseCategoryInput,
    @Req() request: FastifyRequest,
  ) {
    return this.admin.upsertCategory(actor.id, body, request.ip ?? null);
  }

  @Get('cases/:slug')
  getCase(@Param('slug') slug: string) {
    return this.admin.getCase(slug);
  }

  /**
   * Steam market search — the source of images, rarity and prices.
   * Steam throttles hard, so responses are cached for an hour.
   */
  @Get('steam/search')
  steamSearch(
    @Query(new ZodValidationPipe(steamSearchSchema)) query: { query: string; count: number },
  ) {
    return this.market.search(query.query, query.count);
  }

  @Get('items')
  items(@Query() query: Record<string, string>) {
    const { page, perPage } = paginationSchema.parse(query);
    return this.admin.listItems(query.search, page, perPage);
  }

  @Get('users')
  users(@Query() query: Record<string, string>) {
    const { page, perPage } = paginationSchema.parse(query);
    return this.admin.listUsers(query.search, page, perPage);
  }

  @Get('withdrawals')
  withdrawals(@Query() query: Record<string, string>) {
    const { page, perPage } = paginationSchema.parse(query);
    return this.admin.listWithdrawals(query.status, page, perPage);
  }

  /**
   * A money summary for a period, by channel.
   *
   * The dashboard answers "how are we doing"; this and the exports below
   * answer "show me the rows" — which is what reconciling against a statement
   * or answering a chargeback actually needs.
   */
  @Get('reports/summary')
  @Roles(UserRole.ANALYST)
  reportSummary(@Query() query: Record<string, string>) {
    return this.reports.summary(periodSchema.parse(query));
  }

  /**
   * The exports.
   *
   * One route with the report named in the path rather than four: they differ
   * only in which query runs, and four near-identical handlers is four places
   * to forget the content type.
   */
  @Get('reports/:report.csv')
  @Roles(UserRole.ANALYST)
  async reportCsv(
    @Param('report') report: string,
    @Query() query: Record<string, string>,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const period = periodSchema.parse(query);

    const builders: Record<string, () => Promise<string>> = {
      transactions: () => this.reports.transactionsCsv(period),
      payments: () => this.reports.paymentsCsv(period),
      withdrawals: () => this.reports.withdrawalsCsv(period),
      'item-deposits': () => this.reports.itemDepositsCsv(period),
    };

    const build = builders[report];
    if (!build) throw new NotFoundException(`No report called "${report}"`);

    const csv = await build();
    await reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="${report}.csv"`)
      // A financial export is per-operator and per-moment; a cached copy in a
      // proxy is somebody else's numbers.
      .header('Cache-Control', 'no-store, private')
      .send(csv);
  }

  @Get('payments')
  payments(@Query() query: Record<string, string>) {
    const { page, perPage } = paginationSchema.parse(query);
    return this.admin.listPayments(query.status, page, perPage);
  }

  /** Deposits of skins: what the site was given, and whether it paid for it. */
  @Get('item-deposits')
  itemDeposits(@Query() query: Record<string, string>) {
    const { page, perPage } = paginationSchema.parse(query);
    return this.admin.listItemDeposits(query.status, page, perPage);
  }

  @Get('bots')
  bots() {
    return this.admin.listBots();
  }

  /**
   * The buying account and what it is in the middle of buying.
   *
   * Named for the channel rather than the route because `market` on this class
   * is already the Steam Community market — the one prices come from, which has
   * nothing to do with the one withdrawals are bought on.
   */
  @Get('market')
  marketChannel() {
    return this.admin.marketOverview();
  }

  @Post('market/accounts/:id/status')
  @Roles(UserRole.ADMIN)
  setMarketAccountStatus(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(marketAccountStatusSchema))
    body: { status: 'DISABLED' | 'OFFLINE' },
    @Req() request: FastifyRequest,
  ) {
    return this.admin.setMarketAccountStatus(actor.id, id, body.status, request.ip ?? null);
  }

  @Get('market/purchases')
  marketPurchases(@Query() query: Record<string, string>) {
    const { page, perPage } = paginationSchema.parse(query);
    return this.admin.listMarketPurchases(query.status, page, perPage);
  }

  /**
   * The settings registry and its current values.
   *
   * The definitions travel with the values so the panel can render the form
   * without knowing what settings exist — adding one is a line in the shared
   * registry and nothing here.
   */
  @Get('settings')
  settingsList() {
    return this.settings.all().then((values) => ({
      definitions: settingDefinitions(),
      values,
    }));
  }

  @Post('settings')
  @Roles(UserRole.ADMIN)
  saveSettings(
    @CurrentUser() actor: AuthenticatedUser,
    @Body(new ZodValidationPipe(saveSettingsSchema)) body: { values: Record<string, unknown> },
    @Req() request: FastifyRequest,
  ) {
    return this.admin.saveSettings(actor.id, body.values, request.ip ?? null);
  }

  @Get('promo-codes')
  promoCodes() {
    return this.promo.list();
  }

  @Post('promo-codes')
  @Roles(UserRole.ADMIN)
  upsertPromoCode(@Body(new ZodValidationPipe(upsertPromoCodeSchema)) body: UpsertPromoCodeInput) {
    return this.promo.upsert(body);
  }

  @Post('promo-codes/:id/deactivate')
  @Roles(UserRole.ADMIN)
  deactivatePromoCode(@Param('id') id: string) {
    return this.promo.deactivate(id);
  }

  @Post('bots/:id/status')
  @Roles(UserRole.ADMIN)
  setBotStatus(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(botStatusSchema)) body: { status: 'DISABLED' | 'OFFLINE' },
    @Req() request: FastifyRequest,
  ) {
    return this.admin.setBotStatus(actor.id, id, body.status, request.ip ?? null);
  }

  @Get('audit')
  audit(@Query() query: Record<string, string>) {
    const { page, perPage } = paginationSchema.parse(query);
    return this.admin.listAuditLog(page, perPage);
  }

  // --- Mutating operations: ADMIN only ---

  @Post('cases')
  @Roles(UserRole.ADMIN)
  upsertCase(
    @CurrentUser() actor: AuthenticatedUser,
    @Body(new ZodValidationPipe(upsertCaseChecked)) body: UpsertCaseInput,
    @Req() request: FastifyRequest,
  ) {
    return this.admin.upsertCase(actor.id, body, request.ip ?? null);
  }

  /** Imports the selected Steam items into the catalogue, with prices. */
  @Post('items/import')
  @Roles(UserRole.ADMIN)
  importItems(@Body(new ZodValidationPipe(importItemsSchema)) body: { marketHashNames: string[] }) {
    return this.itemSync.importItems(body.marketHashNames);
  }

  @Post('items/:id/refresh-price')
  @Roles(UserRole.ADMIN)
  refreshPrice(@Param('id') id: string) {
    return this.itemSync.refreshPrice(id);
  }

  /** Manually triggers the scheduled price synchronisation. */
  @Post('items/sync-prices')
  @Roles(UserRole.ADMIN)
  syncPrices() {
    return this.itemSync.syncPrices();
  }

  @Post('cases/:id/recalculate-rtp')
  @Roles(UserRole.ADMIN)
  recalculateRtp(@Param('id') id: string) {
    return this.cases.recalculateRtp(id).then((rtp) => ({ rtp }));
  }

  @Post('users/balance')
  @Roles(UserRole.ADMIN)
  adjustBalance(
    @CurrentUser() actor: AuthenticatedUser,
    @Body(new ZodValidationPipe(adjustBalanceSchema))
    body: { userId: string; amount: number; reason: string },
    @Req() request: FastifyRequest,
  ) {
    return this.admin.adjustBalance(
      actor.id,
      body.userId,
      body.amount,
      body.reason,
      request.ip ?? null,
    );
  }

  @Post('users/:id/ban')
  @Roles(UserRole.SUPPORT)
  setBanned(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(banSchema)) body: { isBanned: boolean; reason: string | null },
    @Req() request: FastifyRequest,
  ) {
    return this.admin.setBanned(actor.id, id, body.isBanned, body.reason, request.ip ?? null);
  }
}
