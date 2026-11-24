// A minimal stand-in for Confluent.Kafka, so the fixture needs no package.
using System.Threading;
using System.Threading.Tasks;

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
    }

    public interface IConsumer<TKey, TValue>
    {
        void Subscribe(string topic);
    }
}
