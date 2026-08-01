import { listPendingFoodOrders, type PendingFoodOrderSummary } from './food-order';
import { listPendingZeptoOrders, type PendingZeptoOrderSummary } from './zepto-order';
import { listPendingProductOrders, type PendingProductOrderSummary } from './product-order';

export type LiveOrder = PendingFoodOrderSummary | PendingZeptoOrderSummary | PendingProductOrderSummary;

export interface ConsolidatedOrdersSnapshot {
  orders: LiveOrder[];
  counts: {
    food: number;
    zepto: number;
    product: number;
    total: number;
  };
  fetchedAt: number;
}

export function getConsolidatedLiveOrders(): ConsolidatedOrdersSnapshot {
  const food = listPendingFoodOrders();
  const zepto = listPendingZeptoOrders();
  const product = listPendingProductOrders();

  const all: LiveOrder[] = [...food, ...zepto, ...product].sort((a, b) => b.createdAt - a.createdAt);

  return {
    orders: all,
    counts: {
      food: food.length,
      zepto: zepto.length,
      product: product.length,
      total: all.length,
    },
    fetchedAt: Date.now(),
  };
}
