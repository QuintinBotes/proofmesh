using Pulumi;
using Pulumi.Aws.S3;
using Shop.Infra;

var config = new Config();
var logs = new Bucket("logs", new BucketArgs { Acl = config.Require("acl") });
var policy = new BucketPolicy("logs-policy", new BucketPolicyArgs
{
    Bucket = logs.Id,
    Policy = logs.Arn.Apply(arn => $"{{\"Resource\":\"{arn}\"}}"),
}, new CustomResourceOptions { DependsOn = { logs } });
var site = new Site("www", new SiteArgs { LogBucket = logs.BucketName });
