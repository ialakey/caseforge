import { Module } from '@nestjs/common';
import { PromoModule } from '../promo/promo.module';
import { PaymentsService } from './payments.service';
import { PaymentsController } from './payments.controller';
import { StubPaymentProvider } from './stub-payment.provider';

@Module({
  imports: [PromoModule],
  controllers: [PaymentsController],
  providers: [PaymentsService, StubPaymentProvider],
  exports: [PaymentsService],
})
export class PaymentsModule {}
