import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { PrivateEcsService, PrivateEcsServiceProps } from '../src';

export const PKG_ROOT = path.resolve(__dirname, '..');
// Valores que parecen de verdad pero son ficticios; ninguno es un ID de 12 digitos ni un host real.
export const DIGEST = `sha256:${'ab'.repeat(32)}`;
export const NAMESPACE = 'demo-namespace';

/** Stack sin env (agnostico de cuenta y region): el template trae tokens, nunca un ID de cuenta. */
export function newStack(): cdk.Stack {
  return new cdk.Stack(new cdk.App(), 'DemoStack');
}

export interface Fixture {
  stack: cdk.Stack;
  svc: PrivateEcsService;
  template: Template;
  props: PrivateEcsServiceProps;
}

/** Props minimas validas, sobre recursos importados (como hace un consumidor real). */
export function minimalProps(stack: cdk.Stack): PrivateEcsServiceProps {
  const vpc = ec2.Vpc.fromVpcAttributes(stack, 'Vpc', {
    vpcId: 'vpc-0a1b2c3d4e5f6a7b8',
    availabilityZones: ['zone-a', 'zone-b'],
    privateSubnetIds: ['subnet-0a1b2c3d4e5f6a7b8', 'subnet-0b1c2d3e4f5a6b7c8'],
    privateSubnetRouteTableIds: ['rtb-0a1b2c3d4e5f6a7b8', 'rtb-0b1c2d3e4f5a6b7c8'],
  });
  return {
    cluster: ecs.Cluster.fromClusterAttributes(stack, 'Cluster', { clusterName: 'demo-cluster', vpc, securityGroups: [] }),
    vpc,
    serviceName: 'demo-engine',
    image: { repository: ecr.Repository.fromRepositoryName(stack, 'Repo', 'demo-engine'), version: '1.2.3', digest: DIGEST },
    // El ARN llega por SSM (token), como en un consumidor real: no hay ningun ID de cuenta en el template ni en el snapshot.
    databaseUrlSecret: secretsmanager.Secret.fromSecretCompleteArn(stack, 'DbSecret', ssm.StringParameter.valueForStringParameter(stack, '/demo/db/secret-arn')),
    serviceConnect: { namespace: NAMESPACE },
    ingressFrom: [ec2.SecurityGroup.fromSecurityGroupId(stack, 'ClientSg', 'sg-0a1b2c3d4e5f6a7b8', { mutable: false })],
    appKey: { applicationId: 'DEMO' },
    environment: 'development',
  };
}

/** El construct sin sintetizar: permite agregar recursos al stack (un cliente, un topico) antes de `Template.fromStack`. */
export function make(over: Partial<PrivateEcsServiceProps> | ((stack: cdk.Stack) => Partial<PrivateEcsServiceProps>) = {}): Omit<Fixture, 'template'> {
  const stack = newStack();
  const extra = typeof over === 'function' ? over(stack) : over;
  const props = { ...minimalProps(stack), ...extra };
  const svc = new PrivateEcsService(stack, 'Engine', props);
  return { stack, svc, props };
}

export function build(over: Partial<PrivateEcsServiceProps> | ((stack: cdk.Stack) => Partial<PrivateEcsServiceProps>) = {}): Fixture {
  const f = make(over);
  return { ...f, template: Template.fromStack(f.stack) };
}

type Json = Record<string, unknown>;

/** La task definition del servicio, sin pasar por el logical id. */
export function taskDef(t: Template): Json {
  const defs = Object.values(t.findResources('AWS::ECS::TaskDefinition'));
  if (defs.length !== 1) throw new Error(`se esperaba 1 task definition y hay ${defs.length}`);
  return defs[0]!.Properties as Json;
}

export function container(t: Template): Json {
  return (taskDef(t).ContainerDefinitions as Json[])[0]!;
}

/** Statements de TODAS las policies del template (policies sueltas y roles con policies inline). */
export function allStatements(t: Template): { where: string; statement: Json }[] {
  const out: { where: string; statement: Json }[] = [];
  for (const [id, r] of Object.entries(t.findResources('AWS::IAM::Policy'))) {
    for (const s of ((r.Properties as Json).PolicyDocument as Json).Statement as Json[]) out.push({ where: id, statement: s });
  }
  for (const [id, r] of Object.entries(t.findResources('AWS::IAM::Role'))) {
    for (const p of ((r.Properties as Json).Policies as Json[] | undefined) ?? []) {
      for (const s of (p.PolicyDocument as Json).Statement as Json[]) out.push({ where: id, statement: s });
    }
  }
  return out;
}

export const asList = (v: unknown): unknown[] => (Array.isArray(v) ? v : v === undefined ? [] : [v]);
