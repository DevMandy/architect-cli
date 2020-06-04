import { deserialize, plainToClass, serialize } from 'class-transformer';
import { ServiceNode } from '.';
import { ComponentConfig } from './component-config/base';
import { ComponentConfigBuilder } from './component-config/builder';
import { EnvironmentConfig } from './environment-config/base';
import { EnvironmentConfigBuilder } from './environment-config/builder';
import DependencyGraph from './graph';
import ServiceEdge from './graph/edge/service';
import { DependencyNode } from './graph/node';
import GatewayNode from './graph/node/gateway';
import { ParameterValue, ServiceConfig } from './service-config/base';
import { ServiceConfigV1 } from './service-config/v1';
import { Dictionary } from './utils/dictionary';
import { ExpressionInterpolator } from './utils/interpolation/expression-interpolator';
import { EnvironmentInterfaceContext, EnvironmentInterpolationContext, InterfaceContext } from './utils/interpolation/interpolation-context';
import { IMAGE_REGEX, REPOSITORY_REGEX } from './utils/validation';
import VaultManager from './vault-manager';

export default abstract class DependencyManager {
  abstract graph: DependencyGraph;
  gateway_port!: number;
  _environment!: EnvironmentConfig;
  protected vault_manager!: VaultManager;
  protected __component_config_cache: Dictionary<ComponentConfig | undefined>;
  protected _component_map: Dictionary<ComponentConfig>;

  protected constructor() {
    this.__component_config_cache = {};
    this._component_map = {};
  }

  async init(environment_config?: EnvironmentConfig): Promise<void> {
    this._environment = environment_config || EnvironmentConfigBuilder.buildFromJSON({});
    this.vault_manager = new VaultManager(this._environment.getVaults());
    this.gateway_port = await this.getServicePort(80);
  }

  async loadComponents(): Promise<void> {
    // TODO support old services block
    // Backwards compat: Load the old services block
    const services_component = ComponentConfigBuilder.buildFromJSON({
      name: '',
      services: this._environment.getServices(),
    });
    const components = Object.values(this._environment.getComponents());
    for (const component of components) {
      await this.loadComponent(component);
    }
  }

  async loadComponent(component_config: ComponentConfig) {
    const ref = component_config.getRef();
    if (ref in this._environment.getComponents()) {
      component_config = component_config.merge(this._environment.getComponents()[ref]);
    } else if (ref.split(':')[1] === 'latest' && component_config.getName() in this._environment.getComponents()) {
      component_config = component_config.merge(this._environment.getComponents()[component_config.getName()]);
    }

    const component = await this.loadComponentConfigWrapper(component_config);
    this._component_map[component.getRef()] = component;

    const ref_map: Dictionary<string> = {};
    // Load component services
    for (const [service_name, service_config] of Object.entries(component.getServices())) {
      const node_config = this.getNodeConfig(service_config);

      // TODO: Cleanup this is terrible
      // eslint-disable-next-line @typescript-eslint/ban-ts-ignore
      // @ts-ignore
      service_config.name = component.getServiceRef(service_config.getName());
      // eslint-disable-next-line @typescript-eslint/ban-ts-ignore
      // @ts-ignore
      node_config.name = component.getServiceRef(node_config.getName());

      const node = this.loadServiceNode(service_config, node_config);
      this.graph.addNode(node);

      ref_map[service_name] = node.ref;
    }

    // Load component dependencies
    for (const [dep_key, dep_value] of Object.entries(component.getDependencies())) {
      const dep_component = ComponentConfigBuilder.buildFromJSON({ extends: `${dep_key}:${dep_value}`, name: `${dep_key}:${dep_value}` });
      await this.loadComponent(dep_component);
    }

    // Add edges to services inside component
    for (const [service_name, service_config] of Object.entries(component.getServices())) {
      const service_string = serialize(service_config);

      const start_regex = `(?:\\[\\s*\\\\"|\\[\\s*\\'|\\.)`;
      const end_regex = `(?:\\\\"\\s*\\]|\\'\\s*\\])?\\.`;

      const services_regex = new RegExp(`\\\${\\s*services${start_regex}(${IMAGE_REGEX})?${end_regex}`, 'g');
      const from = ref_map[service_name];

      let matches;
      while ((matches = services_regex.exec(service_string)) != null) {
        const to = ref_map[matches[1]];
        const edge = new ServiceEdge(from, to);
        this.graph.addEdge(edge);
      }

      const dependencies_regex = new RegExp(`\\\${\\s*dependencies${start_regex}(${REPOSITORY_REGEX})?${end_regex}services${start_regex}(${IMAGE_REGEX})?${end_regex}`, 'g');
      while ((matches = dependencies_regex.exec(service_string)) != null) {
        const tag = component.getDependencies()[matches[1]];
        const to = `${matches[1]}/${matches[2]}:${tag}`;
        const edge = new ServiceEdge(from, to);
        this.graph.addEdge(edge);
      }
    }
  }

  async loadParameters2() {
    const env_parameters = this._environment.getParameters();
    const interface_context = this.buildEnvironmentInterfaceContext(this.graph);
    const node_component_map: Dictionary<string> = {};

    // TODO define type
    const component_context_map: any = {};
    for (const component of Object.values(this._component_map) as Array<ComponentConfig>) {
      const parameters: Dictionary<ParameterValue> = {};
      for (const [parameter_key, parameter] of Object.entries(component.getParameters())) {
        parameters[parameter_key] = parameter.default;
      }
      for (const parameter_key of Object.keys(parameters)) {
        if (parameter_key in env_parameters) {
          parameters[parameter_key] = env_parameters[parameter_key];
        }
      }

      const services: any = {};
      for (const [service_key, service] of Object.entries(component.getServices())) {
        services[service_key] = {
          interfaces: interface_context[component.getServiceRef(service_key)],
        };
        node_component_map[component.getServiceRef(service_key)] = component.getRef();
      }

      component_context_map[component.getRef()] = {
        parameters,
        services,
      };
    }

    // Loop through dependencies and set contexts
    for (const component of Object.values(this._component_map) as Array<ComponentConfig>) {
      const dependencies: any = {};
      for (const [dep_key, dep_tag] of Object.entries(component.getDependencies())) {
        dependencies[dep_key] = { ...component_context_map[`${dep_key}:${dep_tag}`] };
        delete dependencies[dep_key].dependencies;
      }
      component_context_map[component.getRef()].dependencies = dependencies;
    }

    for (const node of this.graph.nodes) {
      if (!(node instanceof ServiceNode)) continue;

      const component_ref = node_component_map[node.ref];
      const component_context = component_context_map[component_ref];

      // TODO: Support brackets ${ dependencies['concourse/ci'].services... }
      const interpolated_node_config_string = ExpressionInterpolator.interpolateString(serialize(node.node_config), component_context);
      node.node_config = deserialize(ServiceConfigV1, interpolated_node_config_string, { enableImplicitConversion: true });
    }
  }

  getNodeConfig(service_config: ServiceConfig) {
    return service_config.copy();
  }

  protected scopeEnv(node: DependencyNode, key: string) {
    const prefix = node.normalized_ref.replace(/[.-]/g, '_');
    return `${prefix}__arc__${key}`;
  }

  protected abstract toExternalProtocol(node: DependencyNode, interface_key: string): string;
  protected abstract toExternalHost(node: DependencyNode, interface_key: string): string;
  protected abstract toInternalHost(node: DependencyNode): string;
  protected toInternalPort(node: DependencyNode, interface_name: string): number {
    return node.interfaces[interface_name].port;
  }

  /*
   * Expand all valueFrom parameters into real values that can be used inside of services
  */
  async loadParameters() {
    // (1) first we construct the interface_context, a map of node_ref:interface_name:interface_block for use in mapping
    const interface_context = this.buildEnvironmentInterfaceContext(this.graph);

    // (2) we attach the interfac_context to the node_config of each node
    for (const node of this.graph.nodes) {
      const service_interfaces = interface_context[node.ref];
      for (const [interface_name, interface_block] of Object.entries(service_interfaces)) {
        node.interfaces[interface_name] = interface_block;
      }
    }

    // (3) we interpolate all mustache expressions and replace the node_config of every node inline
    this.interpolateAllNodeConfigs(this.graph, interface_context);

    /* TODO: Support vault
    for (const node of this.graph.nodes) {
      for (const [key, value] of Object.entries(node.parameters)) {
        if (value instanceof Object && value.valueFrom && 'vault' in value.valueFrom) {
          node.parameters[key] = await this.vault_manager.getSecret(value as ValueFromParameter<VaultParameter>);
        }
      }
    }
    */

    /*
    let all_env_params: { [key: string]: string } = {};
    for (const node of this.graph.nodes) {
      const env_params_to_expand: { [key: string]: string } = {};

      for (const [param_name, param_value] of Object.entries(node.parameters)) { // load the service's own params
        if (typeof param_value === 'string' || typeof param_value === 'boolean') {
          if (param_value.toString().indexOf('$') > -1 && param_value.toString().indexOf('${') === -1) {
            env_params_to_expand[this.scopeEnv(node, param_name)] = param_value.toString().replace(/\$/g, `$${this.scopeEnv(node, '')}`);
          } else {
            env_params_to_expand[this.scopeEnv(node, param_name)] = param_value.toString();
          }
        }
      }

      if (node instanceof ServiceNode) {
        const node_dependency_names = new Set([...Object.keys(node.node_config.getDependencies()), node.node_config.getName()]);

        for (const [param_name, param_value] of Object.entries(node.parameters)) { // load param references
          if (param_value instanceof Object && param_value.valueFrom && !('vault' in param_value.valueFrom)) {
            const value_from_param = param_value as ValueFromParameter<DependencyParameter>;
            let param_target_service_name = value_from_param.valueFrom.dependency || node.ref;
            // Support dep ref with or without tag
            if (param_target_service_name in node.node_config.getDependencies()) {
              const dep_tag = node.node_config.getDependencies()[param_target_service_name];
              param_target_service_name = `${param_target_service_name}:${dep_tag}`;
            }
            const param_target_datastore_name = (param_value as ValueFromParameter<DatastoreParameter>).valueFrom.datastore;

            if (param_target_service_name && !param_target_datastore_name) {
              let param_target_service;
              try {
                param_target_service = this.graph.getNodeByRef(param_target_service_name) as ServiceNode;
              } catch {
                param_target_service = this.graph.getNodeByRef(`${node.ref}.${param_target_service_name}`) as ServiceNode;
              }
              if (value_from_param.valueFrom.interface && !(value_from_param.valueFrom.interface in param_target_service.interfaces)) {
                throw new Error(`Interface ${value_from_param.valueFrom.interface} is not defined on service ${param_target_service_name}.`);
              }
              if (!param_target_service || !node_dependency_names.has(param_target_service.node_config.getName())) {
                throw new Error(`Service ${param_target_service_name} not found for config of ${node.ref}`);
              }

              if (value_from_param.valueFrom.interface && Object.keys(param_target_service.interfaces).length > 1) {
                env_params_to_expand[this.scopeEnv(node, param_name)] = param_value.valueFrom.value.replace(/\$/g, `$${this.scopeEnv(param_target_service, value_from_param.valueFrom.interface.toUpperCase())}_`);
              } else {
                if (!(this.scopeEnv(node, param_name) in env_params_to_expand)) { // prevent circular relationship
                  env_params_to_expand[this.scopeEnv(node, param_name)] = param_value.valueFrom.value.replace(/\$/g, `$${this.scopeEnv(param_target_service, '')}`);
                }
              }
            } else if (param_target_datastore_name) {
              const param_target_datastore = this.graph.getNodeByRef(`${node.ref}.${param_target_datastore_name}`);
              const datastore_names = Object.keys(node.node_config.getDatastores());
              if (!param_target_datastore || !datastore_names.includes(param_target_datastore_name)) {
                throw new Error(`Datastore ${param_target_datastore_name} not found for service ${node.ref}`);
              }
              env_params_to_expand[this.scopeEnv(node, param_name)] =
                param_value.valueFrom.value.replace(/\$/g, `$${this.scopeEnv(param_target_datastore, '')}`);
            } else {
              throw new Error(`Error creating parameter ${param_name} of ${node.ref}. A valueFrom reference must specify a dependency or datastore.`);
            }
          }
        }
      }
      all_env_params = { ...all_env_params, ...all_interface_params, ...env_params_to_expand };
    }

    // ignoreProcessEnv is important otherwise it will be stored globally
    const dotenv_config = { parsed: all_env_params, ignoreProcessEnv: true };
    const expanded_params = dotenvExpand(dotenv_config).parsed || {};
    for (const node of this.graph.nodes) {
      const prefix = this.scopeEnv(node, '');
      for (const [prefixed_key, value] of Object.entries(expanded_params)) {
        if (prefixed_key.startsWith(prefix)) {
          const key = prefixed_key.replace(prefix, '');

          // if the node_config has this parameter already on it and it isn't a valueFrom, take that one, otherwise take the one from the dotenv_expansion (used for valueFroms)
          const params_from_node_config = (node as any)?.node_config?.parameters;
          if (params_from_node_config && !ExpressionInterpolator.isNullParamValue(params_from_node_config[key]?.default) && !params_from_node_config[key].default?.valueFrom) {
            const interpolated_value = (node as any).node_config.parameters[key].default;
            node.parameters[key] = typeof interpolated_value == 'boolean' ? interpolated_value.toString() : interpolated_value;
          } else {
            node.parameters[key] = value;
          }

          // we copy the new parameter value into the node_config if it doesn't already have it
          if (node instanceof ServiceNode) {
            (node.node_config as any).parameters = (node.node_config as any).parameters || {};
            (node.node_config as any).parameters[key] = (node.node_config as any).parameters[key] || {};
            (node.node_config as any).parameters[key].default = node.parameters[key];
          }
        }
      }
    }
    */
  }

  private interpolateAllNodeConfigs(graph: DependencyGraph, interface_context: EnvironmentInterfaceContext): void {
    // map of dependency name (as it is in service config) to normalized_ref
    // used for lookups in expressions like this: ${ dependencies['friendly/name'].parameters... }
    const friendly_name_map = ExpressionInterpolator.build_friendly_name_map(this.graph);

    let change_detected = true;
    let passes = 0;
    // Limiting to depth of 1
    // We are going to use interpolation to determine edges and other metadata between services
    // We might eventually support, but for the initial implementation chaining makes it too difficult
    const MAX_DEPTH = 1;

    for (const node of this.graph.nodes) {
      if (node instanceof ServiceNode) {
        const serial_config = serialize(node.node_config);
        const namespaced_serial_config = ExpressionInterpolator.namespaceExpressions(node.namespace_ref, serial_config, friendly_name_map[node.ref]);
        node.node_config = deserialize(ServiceConfigV1, namespaced_serial_config);
      }
    }

    let environment_context = ExpressionInterpolator.mapGraphToInterpolationContext(graph, interface_context);

    // if there are any changes detected in the environment config in the course of interpolating every node, we need to do another pass at the entire graph
    while (change_detected && passes < MAX_DEPTH) {
      change_detected = false;
      for (const node of this.graph.nodes) {
        if (node instanceof ServiceNode) {
          const new_environment_context = this.interpolateNodeConfig(node, environment_context, interface_context);

          if (serialize(environment_context) !== serialize(new_environment_context)) {
            change_detected = true;
          }
          environment_context = new_environment_context;
        }
      }
      passes++;
    }

    if (passes >= MAX_DEPTH && MAX_DEPTH !== 1) {
      throw new Error('Stack Overflow Error: You might have a circular reference in your ServiceConfig expression stack.');
    }
  }

  private interpolateNodeConfig(
    node: ServiceNode,
    environment_context: EnvironmentInterpolationContext,
    interface_context: EnvironmentInterfaceContext,
  ): EnvironmentInterpolationContext {
    let change_detected = true;
    let passes = 0;
    const MAX_DEPTH = 100;

    let serial_config = serialize(node.node_config);

    while (change_detected && passes < MAX_DEPTH) {
      change_detected = false;

      const interpolated_serial_config = ExpressionInterpolator.interpolateString(serial_config, environment_context);
      // check to see if the interpolated value is different from the one listed in the environment_context. if it is, we're
      // going to want to do another pass and set update the environment_context, which requires a full deserialization/serialization
      if (interpolated_serial_config !== serial_config) {
        change_detected = true;

        const deserialized_config = deserialize(ServiceConfigV1, interpolated_serial_config);
        node.node_config = deserialized_config;
        interface_context = this.buildEnvironmentInterfaceContext(this.graph);
        environment_context[node.ref] = ExpressionInterpolator.mapNodeToInterpolationContext(node, interface_context[node.ref]);
        serial_config = serialize(node.node_config);
      } else {
        node.node_config = plainToClass(ServiceConfigV1, deserialize(ServiceConfigV1, interpolated_serial_config), { enableImplicitConversion: true });
        return environment_context;
      }
      passes++;
    }

    throw new Error('Stack Overflow Error: You might have a circular reference in your ServiceConfig expression stack.');
  }

  private buildEnvironmentInterfaceContext(graph: DependencyGraph): EnvironmentInterfaceContext {
    const environment_interface_context: EnvironmentInterfaceContext = {};
    for (const node of this.graph.nodes) {
      environment_interface_context[node.ref] = {};
      for (const interface_name of Object.keys(node.interfaces)) {
        environment_interface_context[node.ref][interface_name] = this.mapToInterfaceContext(node, interface_name);
      }
    }
    return environment_interface_context;
  }

  private mapToInterfaceContext(node: DependencyNode, interface_name: string): InterfaceContext {
    const gateway_node = this.graph.nodes.find((node) => (node instanceof GatewayNode));
    const gateway_port = gateway_node ? this.gateway_port : undefined;
    const interface_details = node.interfaces[interface_name];

    let external_host: string, internal_host: string, external_port: number | undefined, internal_port: number, external_protocol: string | undefined, internal_protocol: string;
    if (node.is_external) {
      if (!interface_details.host) {
        throw new Error('External node needs to override the host');
      }
      external_host = interface_details.host;
      internal_host = interface_details.host;
      external_port = interface_details.port;
      internal_port = interface_details.port;
      external_protocol = 'https';
      internal_protocol = 'https';
    } else {
      external_host = this.toExternalHost(node, interface_name);
      internal_host = this.toInternalHost(node);
      external_port = gateway_port;
      internal_port = this.toInternalPort(node, interface_name);
      external_protocol = this.toExternalProtocol(node, interface_name);
      internal_protocol = 'http';
    }
    const subdomain = interface_details.subdomain;

    const internal_url = internal_protocol + '://' + internal_host + ':' + internal_port;
    const external_url = external_host ? (external_protocol + '://' + external_host + ':' + external_port) : '';

    return {
      host: internal_host,
      port: internal_port,
      protocol: internal_protocol,
      url: internal_url,
      subdomain: subdomain,
      external: {
        host: external_host,
        port: external_port,
        url: external_url,
        protocol: external_protocol,
        subdomain: subdomain,
      },
      internal: {
        host: internal_host,
        port: internal_port,
        url: internal_url,
        protocol: internal_protocol,
        subdomain: subdomain,
      },
    };
  }

  /**
   * Returns a port available for a service to run on. Primary use-case is to be
   * extended by the CLI to return a dynamic available port.
   */
  async getServicePort(starting_port?: number): Promise<number> {
    return Promise.resolve(starting_port || 80);
  }

  abstract async loadComponentConfig(initial_config: ComponentConfig): Promise<ComponentConfig>;

  protected async loadComponentConfigWrapper(initial_config: ComponentConfig): Promise<ComponentConfig> {
    let service_extends = initial_config.getExtends();
    const seen_extends = new Set();
    let component_config = initial_config;
    while (service_extends) {
      if (seen_extends.has(service_extends)) {
        throw new Error(`Circular service extends detected: ${service_extends}`);
      }
      seen_extends.add(service_extends);
      let cached_config = this.__component_config_cache[service_extends];
      if (!cached_config) {
        cached_config = await this.loadComponentConfig(component_config);
        this.__component_config_cache[service_extends] = cached_config;
      }
      service_extends = cached_config.getExtends();
      component_config = component_config ? cached_config.merge(component_config) : cached_config;
    }
    return component_config;
  }

  /*
  async loadServiceFromConfig(config: ServiceConfig, recursive = true): Promise<ServiceNode> {
    const env_service = this._environment.getServiceDetails(config.getRef());
    if (env_service) {
      config = config.merge(env_service);
    }

    const service_ref = config.getRef();
    const existing_node = this.graph.nodes_map.get(service_ref);
    if (existing_node) {
      return existing_node as ServiceNode;
    }

    if (Object.keys(config.getInterfaces()).length > 0 && Object.values(config?.getInterfaces()).every((i) => (i.host))) {
      const external_node = new ServiceNode({
        service_config: config,
        node_config: config,
      });
      this.graph.addNode(external_node);
      return external_node;
    }

    const service_node = await this.loadServiceNode(config);
    this.graph.addNode(service_node);
    await this.loadDatastores(service_node);
    if (recursive) {
      await this.loadDependencies(service_node, recursive);
    }
    return service_node;
  }
  */

  loadServiceNode(service_config: ServiceConfig, node_config: ServiceConfig): ServiceNode {
    return new ServiceNode({
      service_config,
      node_config,
      tag: '', // TODO: remove tag? node_config.getRef().split(':')[node_config.getRef().split(':').length - 1],
      image: node_config.getImage(),
      digest: node_config.getDigest(),
    });
  }
}
