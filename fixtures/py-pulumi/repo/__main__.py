import pulumi
import pulumi_aws as aws
from web import Site

config = pulumi.Config()
logs = aws.s3.Bucket("logs", acl=config.require("acl"))
policy = aws.s3.BucketPolicy(
    "logs-policy",
    bucket=logs.id,
    policy=logs.arn.apply(lambda arn: f'{{"Resource":"{arn}"}}'),
    opts=pulumi.ResourceOptions(depends_on=[logs]),
)
site = Site("www", log_bucket=logs.bucket)

pulumi.export("url", site.url)
pulumi.export("policy_id", policy.id)
