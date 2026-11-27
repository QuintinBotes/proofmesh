import grpc

import orders_pb2
import orders_pb2_grpc


def fetch(order_id):
    channel = grpc.insecure_channel("localhost:50051")
    stub = orders_pb2_grpc.OrdersStub(channel)
    req = orders_pb2.GetOrderRequest(id=order_id)
    return stub.GetOrder(req)
