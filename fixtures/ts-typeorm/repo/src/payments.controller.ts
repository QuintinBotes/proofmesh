import { Controller, Post } from '@nestjs/common'
import { chargeCard } from './service'

@Controller('payments')
export class PaymentsController {
  @Post()
  charge() {
    return chargeCard()
  }
}
