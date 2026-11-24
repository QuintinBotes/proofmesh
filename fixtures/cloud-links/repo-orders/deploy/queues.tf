# The orders service declares its own audit queue: no link is needed for it.
resource "aws_sqs_queue" "audit" {
  name = "orders.audit"
}
