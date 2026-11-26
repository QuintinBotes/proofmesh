export async function fetchOrder(id: string) { return fetch(`/api/orders/${id}`) }
export const listOrders = () => axios.get('/api/orders')
import axios from 'axios'
