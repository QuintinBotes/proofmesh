import * as pulumi from '@pulumi/pulumi'
import * as aws from '@pulumi/aws'

export class Site extends pulumi.ComponentResource {
  readonly url: pulumi.Output<string>

  constructor(name: string, args: { logBucket: pulumi.Input<string> }, opts?: pulumi.ComponentResourceOptions) {
    super('acme:web:Site', name, {}, opts)
    const content = new aws.s3.Bucket(`${name}-content`, { loggings: [{ targetBucket: args.logBucket }] }, { parent: this })
    this.url = content.websiteEndpoint
  }
}
