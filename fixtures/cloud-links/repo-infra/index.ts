import * as azure from '@pulumi/azure-native'

export const web = new azure.web.WebApp('orders-web', { name: 'orders', resourceGroupName: 'apps' })
