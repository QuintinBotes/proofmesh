package server

import (
	"context"

	pb "example.com/shop/gen/shopv1"
)

type server struct {
	pb.UnimplementedOrdersServer
}

func (s *server) GetOrder(ctx context.Context, r *pb.GetOrderRequest) (*pb.Order, error) {
	return &pb.Order{Id: r.Id}, nil
}
