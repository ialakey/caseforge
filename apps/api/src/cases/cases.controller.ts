import { Body, Controller, Get, NotFoundException, Param, Post } from '@nestjs/common';
import {
  type FreeCaseStatus,
  type OpenCaseBatchResult,
  openCaseSchema,
} from '@caseforge/shared';
import { CasesService } from './cases.service';
import { Public } from '../auth/public.decorator';
import { CurrentUser, type AuthenticatedUser } from '../common/current-user.decorator';
import { ZodValidationPipe } from '../common/zod-validation.pipe';

@Controller('api/cases')
export class CasesController {
  constructor(private readonly cases: CasesService) {}

  @Public()
  @Get()
  list() {
    return this.cases.listCases();
  }

  @Public()
  @Get(':slug')
  getOne(@Param('slug') slug: string) {
    return this.cases.getCaseBySlug(slug);
  }

  /**
   * How this player stands against a free case's terms.
   *
   * Its own authenticated route rather than a field on the case: the case view
   * is public and cached for everybody at once, and this answer is different
   * for every player. Folding it in would either poison that cache or force it
   * to be abandoned for the sake of one panel.
   */
  @Get(':slug/free-status')
  async freeStatus(
    @CurrentUser() user: AuthenticatedUser,
    @Param('slug') slug: string,
  ): Promise<FreeCaseStatus> {
    const gameCase = await this.cases.findFreeCase(slug);
    if (!gameCase) throw new NotFoundException('No such free case');
    return this.cases.freeCaseStatus(user.id, gameCase);
  }

  @Post('open')
  open(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(openCaseSchema)) body: { caseId: string; count: number },
  ): Promise<OpenCaseBatchResult> {
    return this.cases.openCase(user.id, body.caseId, body.count);
  }
}
