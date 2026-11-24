using System;
using System.Threading;
using System.Threading.Tasks;
using MediatR;

namespace Shop.Application;

public record PlaceOrder(Guid CustomerId) : IRequest<Guid>;
public record CancelOrder(Guid OrderId) : IRequest<bool>;
public record OrderPlaced(Guid OrderId) : INotification;

public class PlaceOrderHandler(IOrderRepository repository) : IRequestHandler<PlaceOrder, Guid>
{
    public Task<Guid> Handle(PlaceOrder request, CancellationToken cancellationToken) => Task.FromResult(request.CustomerId);
}

public class EmailOnOrderPlaced : INotificationHandler<OrderPlaced>
{
    public Task Handle(OrderPlaced notification, CancellationToken cancellationToken) => Task.CompletedTask;
}

public class AuditOnOrderPlaced : INotificationHandler<OrderPlaced>
{
    public Task Handle(OrderPlaced notification, CancellationToken cancellationToken) => Task.CompletedTask;
}
