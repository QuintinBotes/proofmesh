import { Controller, Delete, Get, Param, Post, Put } from '@nestjs/common'
import { InventoryService } from './inventory.service'

const RETIRED = 'retired/:sku'

@Controller('inventory')
export class InventoryController {
  constructor(private readonly stock: InventoryService) {}

  @Get(':sku')
  level(@Param('sku') sku: string) {
    return this.stock.level(sku)
  }

  @Post()
  receive() {
    return this.stock.receive()
  }

  @Put([':sku/count', ':sku/recount'])
  count(@Param('sku') sku: string) {
    return this.stock.level(sku)
  }

  @Delete(RETIRED)
  retire() {
    return null
  }

  describe() {
    return 'inventory'
  }
}

@Controller()
export class StatusController {
  @Get('status')
  status() {
    return 'ok'
  }
}
