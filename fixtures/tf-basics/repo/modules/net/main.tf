variable "cidr" {}

resource "aws_subnet" "this" {
  cidr_block = var.cidr
}

output "subnet_id" {
  value = aws_subnet.this.id
}
