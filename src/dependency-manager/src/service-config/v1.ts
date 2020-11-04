import { plainToClass } from 'class-transformer';
import { Transform, Type } from 'class-transformer/decorators';
import { ArrayUnique, IsArray, IsEmpty, IsInstance, IsNotEmpty, IsObject, IsOptional, IsString, IsUrl, ValidateIf, ValidatorOptions } from 'class-validator';
import { parse as shell_parse } from 'shell-quote';
import { ResourceConfigV1 } from '../common/v1';
import { ValidatableConfig } from '../utils/base-spec';
import { Dictionary } from '../utils/dictionary';
import { validateDictionary, validateNested } from '../utils/validation';
import { Exclusive } from '../utils/validators/exclusive';
import { ServiceConfig, ServiceLivenessProbe } from './base';

class LivenessProbeV1 extends ValidatableConfig {
  @IsOptional({ always: true })
  @Type(() => String)
  success_threshold?: string;

  @IsOptional({ always: true })
  @Type(() => String)
  failure_threshold?: string;

  @IsOptional({ always: true })
  @IsString({ always: true })
  timeout?: string;

  @IsOptional({ always: true })
  @IsString({ always: true })
  interval?: string;

  @IsOptional({ always: true })
  @IsString({ always: true })
  initial_delay?: string;

  @ValidateIf(obj => !obj.command || ((obj.path || obj.port) && obj.command), { always: true })
  @Exclusive(['command'], { always: true, message: 'Path with port and command are exclusive' })
  @IsString({ always: true })
  path?: string;

  @ValidateIf(obj => !obj.path || ((obj.path || obj.port) && obj.command), { always: true })
  @Exclusive(['path', 'port'], { always: true, message: 'Command and path with port are exclusive' })
  @IsString({ always: true, each: true })
  command?: string[] | string;

  @ValidateIf(obj => !obj.command || ((obj.path || obj.port) && obj.command), { always: true })
  @Exclusive(['command'], { always: true, message: 'Command and path with port are exclusive' })
  @IsNotEmpty({ always: true })
  @Type(() => String)
  port?: string;
}

export class InterfaceSpecV1 extends ValidatableConfig {
  @IsOptional({ always: true })
  @IsString({ always: true })
  description?: string;

  @IsOptional({ always: true })
  /* TODO: Figure out if we should share the interface spec
  @IsEmpty({
    groups: ['developer'],
    message: 'Cannot hardcode interface hosts when publishing services',
  })
  */
  @IsString({ always: true })
  host?: string;

  @ValidateIf(obj => obj.host, { groups: ['operator'] })
  @IsNotEmpty({ always: true })
  @Type(() => String)
  port!: string;

  @IsOptional({ always: true })
  protocol?: string;

  @IsOptional({ always: true })
  url?: string;

  @IsOptional({ always: true })
  @IsArray({ always: true })
  @ArrayUnique({ always: true })
  @IsUrl({}, { always: true, each: true })
  domains?: string[];
}

export const transformInterfaces = function (input?: Dictionary<string | Dictionary<any>>): Dictionary<InterfaceSpecV1> | undefined {
  if (!input) {
    return {};
  }
  if (!(input instanceof Object)) {
    return input;
  }

  const output: Dictionary<InterfaceSpecV1> = {};
  for (const [key, value] of Object.entries(input)) {
    output[key] = value instanceof Object
      ? plainToClass(InterfaceSpecV1, value)
      : plainToClass(InterfaceSpecV1, { port: value });
  }
  return output;
};

export class ServiceConfigV1 extends ResourceConfigV1 implements ServiceConfig {
  @Type(() => ServiceConfigV1)
  @IsOptional({ always: true })
  @IsInstance(ServiceConfigV1, { always: true })
  @IsEmpty({ groups: ['debug'] })
  debug?: ServiceConfigV1;

  @IsOptional({ groups: ['operator', 'debug'] })
  @IsObject({ groups: ['developer'], message: 'interfaces must be defined even if it is empty since the majority of services need to expose ports' })
  @Transform((value) => !value ? {} : value)
  interfaces?: Dictionary<InterfaceSpecV1 | string>;

  @Type(() => LivenessProbeV1)
  @IsOptional({ always: true })
  @IsInstance(LivenessProbeV1, { always: true })
  liveness_probe?: LivenessProbeV1;

  @IsOptional({ always: true })
  @IsEmpty({
    groups: ['developer'],
    message: 'Cannot hardcode a replica count when registering services',
  })
  @Type(() => String)
  replicas?: string;

  async validate(options?: ValidatorOptions) {
    if (!options) { options = {}; }
    let errors = await super.validate(options);
    if (errors.length) return errors;
    const expanded = this.expand();
    errors = await validateNested(expanded, 'liveness_probe', errors, options);
    errors = await validateDictionary(expanded, 'interfaces', errors, undefined, options);
    return errors;
  }

  getInterfaces() {
    return transformInterfaces(this.interfaces) || {};
  }

  setInterfaces(value: Dictionary<InterfaceSpecV1 | string>) {
    this.interfaces = value;
  }

  setInterface(key: string, value: InterfaceSpecV1 | string) {
    if (!this.interfaces) {
      this.interfaces = {};
    }
    this.interfaces[key] = value;
  }

  getLivenessProbe(): ServiceLivenessProbe | undefined {
    if (!this.liveness_probe || !Object.keys(this.liveness_probe).length) { return undefined; }

    const liveness_probe = {
      success_threshold: '1',
      failure_threshold: '1',
      timeout: '5s',
      interval: '30s',
      initial_delay: '0s',
      ...this.liveness_probe,
    };

    if (this.liveness_probe.command && typeof this.liveness_probe.command === 'string') {
      liveness_probe.command = shell_parse(this.liveness_probe.command).map(e => `${e}`);
    }

    return liveness_probe as ServiceLivenessProbe;
  }

  getDebugOptions(): ServiceConfigV1 | undefined {
    return this.debug;
  }

  setDebugOptions(value: ServiceConfigV1) {
    this.debug = value;
  }

  getReplicas() {
    return this.replicas || '1';
  }

  /** @return New expanded copy of the current config */
  expand() {
    const config = super.expand();
    for (const [key, value] of Object.entries(this.getInterfaces())) {
      config.setInterface(key, value);
    }
    return config;
  }
}
