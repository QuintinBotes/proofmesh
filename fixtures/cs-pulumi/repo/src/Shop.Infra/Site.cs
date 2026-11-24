using Pulumi;
using Pulumi.Aws.S3;

namespace Shop.Infra;

public sealed class SiteArgs : ResourceArgs { public Input<string>? LogBucket { get; set; } }

public sealed class Site : ComponentResource
{
    public Output<string> Url { get; }

    public Site(string name, SiteArgs args, ComponentResourceOptions? options = null) : base("shop:web:Site", name, options)
    {
        var content = new Bucket($"{name}-content", new BucketArgs { Loggings = { new BucketLoggingArgs { TargetBucket = args.LogBucket } } }, new CustomResourceOptions { Parent = this });
        Url = content.WebsiteEndpoint;
    }
}
