import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { type OpenCaseBatchResult, openCaseSchema } from '@caseforge/shared';
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

  @Post('open')
  open(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(openCaseSchema)) body: { caseId: string; count: number },
  ): Promise<OpenCaseBatchResult> {
    return this.cases.openCase(user.id, body.caseId, body.count);
  }
}
