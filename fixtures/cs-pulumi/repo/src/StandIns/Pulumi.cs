// Minimal stand-ins for the Pulumi .NET SDK and its AWS provider, so the fixture needs no package.
using System;
using System.Collections.Generic;

namespace Pulumi
{
    public class Output<T> { public Output<U> Apply<U>(Func<T, U> f) => new(); }
    public class Input<T>
    {
        public static implicit operator Input<T>(T value) => new();
        public static implicit operator Input<T>(Output<T> value) => new();
    }
    public abstract class ResourceArgs { }
    public class ResourceOptions
    {
        public List<Resource> DependsOn { get; set; } = new();
        public Resource? Parent { get; set; }
    }
    public sealed class CustomResourceOptions : ResourceOptions { }
    public sealed class ComponentResourceOptions : ResourceOptions { }
    public abstract class Resource { public Output<string> Urn { get; } = new(); }
    public class CustomResource : Resource
    {
        public Output<string> Id { get; } = new();
        public CustomResource(string type, string name, ResourceArgs? args, CustomResourceOptions? options = null) { }
    }
    public class ComponentResource : Resource
    {
        public ComponentResource(string type, string name, ComponentResourceOptions? options = null) { }
    }
    public sealed class Config { public string Require(string key) => key; }
}

namespace Pulumi.Aws.S3
{
    public sealed class BucketLoggingArgs : ResourceArgs { public Input<string>? TargetBucket { get; set; } }
    public sealed class BucketArgs : ResourceArgs
    {
        public Input<string>? Acl { get; set; }
        public List<BucketLoggingArgs> Loggings { get; set; } = new();
    }
    public sealed class Bucket : CustomResource
    {
        public Output<string> Arn { get; } = new();
        public Output<string> BucketName { get; } = new();
        public Output<string> WebsiteEndpoint { get; } = new();
        public Bucket(string name, BucketArgs? args = null, CustomResourceOptions? options = null) : base("aws:s3/bucket:Bucket", name, args, options) { }
    }
    public sealed class BucketPolicyArgs : ResourceArgs
    {
        public Input<string>? Bucket { get; set; }
        public Input<string>? Policy { get; set; }
    }
    public sealed class BucketPolicy : CustomResource
    {
        public BucketPolicy(string name, BucketPolicyArgs args, CustomResourceOptions? options = null) : base("aws:s3/bucketPolicy:BucketPolicy", name, args, options) { }
    }
}
