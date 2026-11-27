using System.Collections.Generic;

namespace Shop.Wire
{
    /// <summary>An order as another service sends it: the property names are the wire keys.</summary>
    public class OrderDto
    {
        public string CustomerName { get; set; } = "";

        public decimal Total { get; set; }
    }

    public static class OrderWire
    {
        public static OrderDto Read(IDictionary<string, string> payload)
        {
            return new OrderDto { CustomerName = payload["CustomerName"], Total = decimal.Parse(payload["Total"]) };
        }

        public static IDictionary<string, string> Write(OrderDto order)
        {
            return new Dictionary<string, string> { ["CustomerName"] = order.CustomerName, ["Total"] = order.Total.ToString() };
        }

        public static string Describe(OrderDto order)
        {
            var name = order.CustomerName.Trim();
            return name.Length > 0 ? name : order.CustomerName;
        }
    }
}
