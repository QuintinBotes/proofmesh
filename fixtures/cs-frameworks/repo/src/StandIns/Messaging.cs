// Minimal stand-ins for MediatR, Microsoft.Extensions.Hosting, Confluent.Kafka, and Refit, so the fixture needs no package.
using System;
using System.Threading;
using System.Threading.Tasks;

namespace MediatR
{
    public interface IRequest<out TResponse> { }

    public interface INotification { }

    public interface IRequestHandler<in TRequest, TResponse> where TRequest : IRequest<TResponse>
    {
        Task<TResponse> Handle(TRequest request, CancellationToken cancellationToken);
    }

    public interface INotificationHandler<in TNotification> where TNotification : INotification
    {
        Task Handle(TNotification notification, CancellationToken cancellationToken);
    }

    public interface ISender
    {
        Task<TResponse> Send<TResponse>(IRequest<TResponse> request, CancellationToken cancellationToken = default);
    }

    public interface IPublisher
    {
        Task Publish<TNotification>(TNotification notification, CancellationToken cancellationToken = default) where TNotification : INotification;
    }

    public interface IMediator : ISender, IPublisher { }
}

namespace Microsoft.Extensions.Hosting
{
    public interface IHostedService
    {
        Task StartAsync(CancellationToken cancellationToken);
        Task StopAsync(CancellationToken cancellationToken);
    }

    public abstract class BackgroundService : IHostedService
    {
        protected abstract Task ExecuteAsync(CancellationToken stoppingToken);
        public virtual Task StartAsync(CancellationToken cancellationToken) => Task.CompletedTask;
        public virtual Task StopAsync(CancellationToken cancellationToken) => Task.CompletedTask;
    }
}

namespace Confluent.Kafka
{
    public class Message<TKey, TValue>
    {
        public TKey Key { get; set; } = default!;
        public TValue Value { get; set; } = default!;
    }

    public class DeliveryResult<TKey, TValue> { }

    public interface IProducer<TKey, TValue>
    {
        Task<DeliveryResult<TKey, TValue>> ProduceAsync(string topic, Message<TKey, TValue> message, CancellationToken cancellationToken = default);
        void Produce(string topic, Message<TKey, TValue> message, Action<DeliveryResult<TKey, TValue>>? deliveryHandler = null);
    }

    public interface IConsumer<TKey, TValue>
    {
        void Subscribe(string topic);
    }
}

namespace Refit
{
    public abstract class HttpMethodAttribute : Attribute
    {
        protected HttpMethodAttribute(string path) { }
    }

    [AttributeUsage(AttributeTargets.Method)]
    public class GetAttribute : HttpMethodAttribute
    {
        public GetAttribute(string path) : base(path) { }
    }

    [AttributeUsage(AttributeTargets.Method)]
    public class PostAttribute : HttpMethodAttribute
    {
        public PostAttribute(string path) : base(path) { }
    }
}
