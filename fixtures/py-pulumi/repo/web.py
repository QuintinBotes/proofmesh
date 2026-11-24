import pulumi
import pulumi_aws as aws


class Site(pulumi.ComponentResource):
    def __init__(self, name, log_bucket, opts=None):
        super().__init__("acme:web:Site", name, None, opts)
        content = aws.s3.Bucket(
            f"{name}-content",
            loggings=[aws.s3.BucketLoggingArgs(target_bucket=log_bucket)],
            opts=pulumi.ResourceOptions(parent=self),
        )
        self.url = content.website_endpoint
