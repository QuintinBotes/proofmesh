import * as pulumi from '@pulumi/pulumi'
import * as aws from '@pulumi/aws'
import { Site } from './site'

const config = new pulumi.Config()
const logs = new aws.s3.Bucket('logs', { acl: config.require('acl') })
const policy = new aws.s3.BucketPolicy('logs-policy', {
  bucket: logs.id,
  policy: logs.arn.apply((arn) => `{"Resource":"${arn}"}`),
}, { dependsOn: [logs] })
const site = new Site('www', { logBucket: logs.bucket })

export const url = site.url
export const policyId = policy.id
