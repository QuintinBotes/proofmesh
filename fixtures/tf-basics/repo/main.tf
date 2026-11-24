variable "env" {
  type = string
}

locals {
  name = "logs-${var.env}"
}

resource "aws_s3_bucket" "logs" {
  bucket = local.name
}

data "aws_iam_policy_document" "logs" {}

resource "aws_s3_bucket_policy" "logs" {
  bucket     = aws_s3_bucket.logs.id
  policy     = data.aws_iam_policy_document.logs.json
  depends_on = [aws_s3_bucket.logs]
}

module "net" {
  source = "./modules/net"
  cidr   = "10.0.0.0/16"
}

module "dns" {
  source = "terraform-aws-modules/route53/aws"
}

output "bucket_arn" {
  value = aws_s3_bucket.logs.arn
}

output "subnet" {
  value = module.net.subnet_id
}

output "ghost" {
  value = aws_instance.ghost.id
}
