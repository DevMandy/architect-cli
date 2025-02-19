import { classToPlain, plainToClass, serialize } from 'class-transformer';
import { isMatch } from 'matcher';
import { buildInterfacesRef, buildNodeRef, ComponentConfig } from './config/component-config';
import { ArchitectContext, ComponentContext, ParameterValue } from './config/component-context';
import DependencyGraph from './graph';
import IngressEdge from './graph/edge/ingress';
import OutputEdge from './graph/edge/output';
import ServiceEdge from './graph/edge/service';
import { DependencyNode } from './graph/node';
import ComponentNode from './graph/node/component';
import GatewayNode from './graph/node/gateway';
import { ServiceNode } from './graph/node/service';
import { TaskNode } from './graph/node/task';
import { ComponentSpec } from './spec/component-spec';
import { transformComponentSpec, transformParameterDefinitionSpec } from './spec/transform/component-transform';
import { ComponentSlugUtils, ComponentVersionSlugUtils, ResourceType, Slugs } from './spec/utils/slugs';
import { validateOrRejectSpec } from './spec/utils/spec-validator';
import { Dictionary, transformDictionary } from './utils/dictionary';
import { ArchitectError, ValidationError, ValidationErrors } from './utils/errors';
import { interpolateObjectLoose, interpolateObjectOrReject, replaceInterpolationBrackets } from './utils/interpolation';
import { ValuesConfig } from './values/values';

export default abstract class DependencyManager {

  use_sidecar = true;
  account?: string;

  getComponentNodes(component: ComponentConfig): DependencyNode[] {
    const nodes = [];
    // Load component services
    for (const [service_name, service_config] of Object.entries(component.services)) {
      const node = new ServiceNode({
        ref: buildNodeRef(component, 'services', service_name),
        config: service_config,
        local_path: component.metadata.file?.path,
        artifact_image: component.artifact_image,
      });
      nodes.push(node);
    }

    // Load component tasks
    for (const [task_name, task_config] of Object.entries(component.tasks)) {
      const node = new TaskNode({
        ref: buildNodeRef(component, 'tasks', task_name),
        config: task_config,
        local_path: component.metadata.file?.path,
      });
      nodes.push(node);
    }
    return nodes;
  }

  getComponentRef(component_string: string): string {
    const { component_account_name, component_name, tag, instance_name } = ComponentVersionSlugUtils.parse(component_string);
    const resolved_account = this.account && this.account === component_account_name ? undefined : component_account_name;
    const component_ref = ComponentSlugUtils.build(resolved_account, component_name, instance_name);
    return component_ref;
  }

  addComponentEdges(graph: DependencyGraph, component_config: ComponentConfig, dependency_configs: ComponentConfig[], context_map: Dictionary<ComponentContext>, external_addr: string): void {
    const component = component_config;

    const dependency_map: Dictionary<ComponentConfig> = {};
    for (const dependency_component of dependency_configs) {
      const dependency_ref = dependency_component.metadata.ref;
      dependency_map[dependency_ref] = dependency_component;
    }

    // Add edges FROM services to other services
    const services = Object.entries(component_config.services).map(([resource_name, resource_config]) => ({ resource_name, resource_type: 'services' as ResourceType, resource_config }));
    const tasks = Object.entries(component_config.tasks).map(([resource_name, resource_config]) => ({ resource_name, resource_type: 'tasks' as ResourceType, resource_config }));
    for (const { resource_config, resource_name, resource_type } of [...services, ...tasks]) {
      const from = buildNodeRef(component, resource_type, resource_name);
      const copy = { ...resource_config } as any;
      delete copy.metadata;
      const service_string = replaceInterpolationBrackets(serialize(copy));
      let matches;

      // Start Ingress Edges
      const ingresses: [ComponentConfig, string][] = [];
      // Deprecated environment.ingresses
      const environment_ingresses_regex = new RegExp(`\\\${{\\s*environment\\.ingresses\\.(?<dependency_name>${ComponentSlugUtils.RegexBase})\\.(?<interface_name>${Slugs.ArchitectSlugRegexBase})\\.`, 'g');
      while ((matches = environment_ingresses_regex.exec(service_string)) != null) {
        if (!matches.groups) { continue; }
        const { dependency_name, interface_name } = matches.groups;
        const dep_ref = this.getComponentRef(dependency_name);
        if (dep_ref === component.metadata.ref) {
          ingresses.push([component, interface_name]);
        } else {
          const dep_component = dependency_map[dep_ref];
          ingresses.push([dep_component, interface_name]);
        }
      }
      const dependencies_ingresses_regex = new RegExp(`\\\${{\\s*dependencies\\.(?<dependency_name>${ComponentSlugUtils.RegexBase})\\.ingresses\\.(?<interface_name>${Slugs.ArchitectSlugRegexBase})\\.`, 'g');
      while ((matches = dependencies_ingresses_regex.exec(service_string)) != null) {
        if (!matches.groups) { continue; }
        const { dependency_name, interface_name } = matches.groups;
        const dep_ref = this.getComponentRef(dependency_name);
        const dep_component = dependency_map[dep_ref];
        ingresses.push([dep_component, interface_name]);
      }
      const ingresses_regex = new RegExp(`\\\${{\\s*ingresses\\.(?<interface_name>${Slugs.ArchitectSlugRegexBase})\\.`, 'g');
      while ((matches = ingresses_regex.exec(service_string)) != null) {
        if (!matches.groups) { continue; }
        const { interface_name } = matches.groups;
        ingresses.push([component, interface_name]);
      }
      for (const [interface_name, interface_obj] of Object.entries(component.interfaces)) {
        if (interface_obj?.ingress?.subdomain || interface_obj.ingress?.enabled) {
          ingresses.push([component, interface_name]);
        }
      }

      for (const [dep_component, interface_name] of ingresses) {
        if (!dep_component) { continue; }
        if (!dep_component.interfaces[interface_name]) { continue; }

        const dep_context = context_map[dep_component.metadata.ref];
        const subdomain = dep_context.ingresses[interface_name]?.subdomain;
        if (!subdomain) { continue; }

        let ingress_edge = graph.edges.find(edge => edge.from === 'gateway' && edge.to === buildInterfacesRef(dep_component)) as IngressEdge;
        if (!ingress_edge) {
          const gateway_host = external_addr.split(':')[0];
          const gateway_port = parseInt(external_addr.split(':')[1] || '443');
          const gateway_node = new GatewayNode(gateway_host, gateway_port);
          gateway_node.instance_id = 'gateway';
          graph.addNode(gateway_node);

          ingress_edge = new IngressEdge('gateway', buildInterfacesRef(dep_component), []);
          graph.addEdge(ingress_edge);
        }

        if (!ingress_edge.interface_mappings.find((i) => i.interface_from === subdomain && i.interface_to === interface_name)) {
          ingress_edge.interface_mappings.push({ interface_from: subdomain, interface_to: interface_name });
        }

        if (!ingress_edge.consumers_map[interface_name]) {
          ingress_edge.consumers_map[interface_name] = new Set();
        }
        ingress_edge.consumers_map[interface_name].add(from);
      }
      // End Ingress Edges

      // Add edges between services inside the component and dependencies
      const services_regex = new RegExp(`\\\${{\\s*services\\.(?<service_name>${Slugs.ArchitectSlugRegexBase})\\.interfaces\\.(?<interface_name>${Slugs.ArchitectSlugRegexBase})\\.`, 'g');
      const service_edge_map: Dictionary<Dictionary<string>> = {};
      while ((matches = services_regex.exec(service_string)) != null) {
        if (!matches.groups) { continue; }
        const { service_name, interface_name } = matches.groups;
        const to = buildNodeRef(component, 'services', service_name);
        if (to === from) continue;
        if (!service_edge_map[to]) service_edge_map[to] = {};
        service_edge_map[to][`service->${interface_name}`] = interface_name;
      }
      for (const [to, interfaces_map] of Object.entries(service_edge_map)) {
        const interface_mappings = Object.entries(interfaces_map).map(([interface_from, interface_to]) => ({ interface_from, interface_to }));
        const edge = new ServiceEdge(from, to, interface_mappings);
        if (!graph.nodes_map.has(to)) continue;
        graph.addEdge(edge);
      }

      // Add edges between services and interface dependencies inside the component
      const dep_interface_regex = new RegExp(`\\\${{\\s*dependencies\\.(?<dependency_name>${ComponentSlugUtils.RegexBase})\\.interfaces\\.(?<interface_name>${Slugs.ArchitectSlugRegexBase})\\.`, 'g');
      const dep_service_edge_map: Dictionary<Dictionary<string>> = {};
      while ((matches = dep_interface_regex.exec(service_string)) != null) {
        if (!matches.groups) { continue; }
        const { dependency_name, interface_name } = matches.groups;
        const dep_ref = this.getComponentRef(dependency_name);

        const dependency = dependency_map[dep_ref];
        if (!dependency) continue;
        const to = buildInterfacesRef(dependency);

        if (!graph.nodes_map.has(to)) continue;

        if (!dep_service_edge_map[to]) dep_service_edge_map[to] = {};
        dep_service_edge_map[to][`service->${interface_name}`] = interface_name;
      }
      for (const [to, interfaces_map] of Object.entries(dep_service_edge_map)) {
        const interface_mappings = Object.entries(interfaces_map).map(([interface_from, interface_to]) => ({ interface_from, interface_to }));
        const edge = new ServiceEdge(from, to, interface_mappings);
        graph.addEdge(edge);
      }

      // Add edges between services and output dependencies inside the component
      const dep_output_regex = new RegExp(`\\\${{\\s*dependencies\\.(?<dependency_name>${ComponentSlugUtils.RegexBase})\\.outputs\\.(?<output_name>${Slugs.ArchitectSlugRegexBase})`, 'g');
      const dep_output_edge_map: Dictionary<Dictionary<string>> = {};
      while ((matches = dep_output_regex.exec(service_string)) != null) {
        if (!matches.groups) { continue; }
        const { dependency_name, output_name } = matches.groups;
        const dep_ref = this.getComponentRef(dependency_name);
        const dependency = dependency_map[dep_ref];
        if (!dependency) continue;
        const to = buildInterfacesRef(dependency);

        if (!graph.nodes_map.has(to)) continue;

        if (!dep_output_edge_map[to]) dep_output_edge_map[to] = {};
        dep_output_edge_map[to][`output->${output_name}`] = output_name;
      }
      for (const [to, output_map] of Object.entries(dep_output_edge_map)) {
        const output_mappings = Object.entries(output_map).map(([interface_from, interface_to]) => ({ interface_from, interface_to }));
        const edge = new OutputEdge(from, to, output_mappings);
        graph.addEdge(edge);
      }
    }

    // Add edges between services and the component's interfaces node
    const service_edge_map: Dictionary<Dictionary<string>> = {};
    for (const [component_interface_name, component_interface] of Object.entries(component.interfaces)) {
      if (!component_interface) { continue; }
      const services_regex = new RegExp(`\\\${{\\s*services\\.(?<service_name>${Slugs.ArchitectSlugRegexBase})?\\.interfaces\\.(?<interface_name>${Slugs.ArchitectSlugRegexBase})?\\.`, 'g');

      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const matches = services_regex.exec(replaceInterpolationBrackets(component_interface.url!));
      if (!matches) continue;
      if (!matches.groups) { continue; }
      const { service_name, interface_name } = matches.groups;
      const to = buildNodeRef(component, 'services', service_name);
      if (!service_edge_map[to]) service_edge_map[to] = {};
      service_edge_map[to][component_interface_name] = interface_name;
    }

    for (const [component_interface_name, component_interface] of Object.entries(component.interfaces || {})) {
      if (!component_interface) { continue; }
      const dependencies_regex = new RegExp(`\\\${{\\s*dependencies\\.(?<dependency_name>${ComponentSlugUtils.RegexBase})\\.interfaces\\.(?<interface_name>${Slugs.ArchitectSlugRegexBase})\\.`, 'g');

      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const matches = dependencies_regex.exec(replaceInterpolationBrackets(component_interface.url!));
      if (!matches) continue;

      if (!matches.groups) { continue; }
      const { dependency_name, interface_name } = matches.groups;
      const dep_ref = this.getComponentRef(dependency_name);
      const dependency = dependency_map[dep_ref];
      if (!dependency) continue;
      const to = buildInterfacesRef(dependency);

      if (!graph.nodes_map.has(to)) continue;

      if (!service_edge_map[to]) service_edge_map[to] = {};
      service_edge_map[to][component_interface_name] = interface_name;
    }

    for (const [to, interfaces_map] of Object.entries(service_edge_map)) {
      if (!graph.nodes_map.has(to)) continue;
      const interface_mappings = Object.entries(interfaces_map).map(([interface_from, interface_to]) => ({ interface_from, interface_to }));
      const edge = new ServiceEdge(buildInterfacesRef(component), to, interface_mappings);
      graph.addEdge(edge);
    }
  }

  getSecretsForComponentSpec(component_spec: ComponentSpec, all_values: Dictionary<Dictionary<string | number | null>>): Dictionary<ParameterValue> {
    // pre-sort values dictionary to properly stack/override any colliding keys
    const sorted_values_keys = Object.keys(all_values).sort();
    const sorted_values_dict: Dictionary<Dictionary<string | number | null>> = {};
    for (const key of sorted_values_keys) {
      sorted_values_dict[key] = all_values[key];
    }

    const component_ref = component_spec.metadata.ref;
    const { component_account_name, component_name, instance_name } = ComponentSlugUtils.parse(component_ref);
    const component_ref_with_account = component_account_name ? component_ref : ComponentSlugUtils.build(this.account, component_name, instance_name);

    const component_parameters = new Set(Object.keys(component_spec.parameters || {}));

    const res: Dictionary<any> = {};
    // add values from values file to all existing, matching components
    // eslint-disable-next-line prefer-const
    for (let [pattern, params] of Object.entries(sorted_values_dict)) {
      // Backwards compat for tags
      if (ComponentVersionSlugUtils.Validator.test(pattern)) {
        const { component_account_name, component_name, instance_name } = ComponentVersionSlugUtils.parse(pattern);
        pattern = ComponentSlugUtils.build(component_account_name, component_name, instance_name);
      }
      if (isMatch(component_ref, [pattern]) || isMatch(component_ref_with_account, [pattern])) {
        for (const [param_key, param_value] of Object.entries(params)) {
          if (component_parameters.has(param_key)) {
            res[param_key] = param_value;
          }
        }
      }
    }
    return res;
  }

  generateUrl(interface_ref: string): string {
    const url_auth = `(${interface_ref}.password ? (${interface_ref}.username + ':' + ${interface_ref}.password + '@') : '')`;
    const url_protocol = `(${interface_ref}.protocol == 'grpc' ? '' : (${interface_ref}.protocol + '://' + ${url_auth}))`;
    const url_port = `((${interface_ref}.port == 80 || ${interface_ref}.port == 443) ? '' : ':' + ${interface_ref}.port)`;
    const url_path = `(${interface_ref}.path ? ${interface_ref}.path : '')`;
    return `\${{ ${url_protocol} + ${interface_ref}.host + ${url_port} + ${url_path} }}`;
  }

  findClosestComponent(component_configs: ComponentSpec[], date: Date): ComponentSpec | undefined {
    if (component_configs.length === 0) { return; }
    if (component_configs.length === 1) { return component_configs[0]; }

    const target_time = date.getTime();

    let res = undefined;
    let best_diff = Number.NEGATIVE_INFINITY;
    for (const component_config of component_configs) {
      if (!component_config.metadata) {
        throw new Error(`Metadata has not been set on component`);
      }
      const current_time = component_config.metadata.instance_date.getTime();
      const current_diff = current_time - target_time;
      if (current_diff <= 0 && current_diff > best_diff) {
        best_diff = current_diff;
        res = component_config;
      }
    }
    return res;
  }

  getDependencyComponents(component_spec: ComponentSpec, component_specs: ComponentSpec[]): Dictionary<ComponentSpec> {
    const component_map: Dictionary<ComponentSpec[]> = {};
    for (const component_spec of component_specs) {
      const ref = component_spec.metadata.ref;
      if (!component_map[ref]) {
        component_map[ref] = [];
      }
      // Potentially multiple components with the same ref and different instance ids
      component_map[ref].push(component_spec);
    }

    const dependency_components: Dictionary<ComponentSpec> = {};
    for (const dep_name of Object.keys(component_spec.dependencies || {})) {
      const dep_ref = this.getComponentRef(dep_name);
      if (!component_map[dep_ref]) {
        continue;
      }
      const dep_components = component_map[dep_ref];
      if (!component_spec.metadata) {
        throw new Error(`Metadata has not been set on component`);
      }
      const dep_component = this.findClosestComponent(dep_components, component_spec.metadata.instance_date || new Date());
      if (!dep_component) {
        continue;
      }
      dependency_components[dep_name] = dep_component;
    }
    return dependency_components;
  }

  validateRequiredParameters(component: ComponentConfig, parameters: Dictionary<ParameterValue>): void {
    const validation_errors = [];
    // Check required parameters for components
    for (const [pk, pv] of Object.entries(component.parameters)) {
      if (pv.required !== false && parameters[pk] === undefined) {
        const validation_error = new ValidationError({
          component: component.name,
          path: `parameters.${pk}`,
          message: `required parameter '${pk}' was not provided`,
          value: pv.default,
        });
        validation_errors.push(validation_error);
      }
    }
    if (validation_errors.length) {
      throw new ValidationErrors(validation_errors, component.metadata.file);
    }
  }

  validateGraph(graph: DependencyGraph): void {
    // Check for duplicate subdomains
    const seen_subdomains: Dictionary<string[]> = {};
    for (const ingress_edge of graph.edges.filter((edge) => edge instanceof IngressEdge)) {
      for (const { interface_from, interface_to } of ingress_edge.interface_mappings) {
        const component_node = graph.getNodeByRef(ingress_edge.to) as ComponentNode;
        const ingress = component_node.config.interfaces[interface_to].ingress;
        const key = ingress?.path ? `${interface_from} with path ${ingress.path}` : interface_from;
        if (!seen_subdomains[key]) {
          seen_subdomains[key] = [];
        }
        seen_subdomains[key].push(`${component_node.slug}.${interface_to}`);
      }
    }

    for (const [subdomain, values] of Object.entries(seen_subdomains)) {
      if (values.length > 1) {
        throw new ArchitectError(`The subdomain ${subdomain} is claimed by multiple component interfaces:\n[${values.sort().join(', ')}]\nPlease set interfaces.<name>.ingress.subdomain=<subdomain> or interfaces.<name>.ingress.path=<path> to avoid conflicts.`);
      }
    }
  }

  detectCircularDependencies(component_specs: ComponentSpec[]): void {
    const component_specs_map: Dictionary<ComponentSpec> = {};
    for (const component_spec of component_specs) {
      component_specs_map[component_spec.metadata.ref] = component_spec;
    }
    const component_specs_queue = component_specs.map(component_spec => ({ component_spec, seen_refs: [component_spec.metadata.ref] }));
    while (component_specs_queue.length) {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const { component_spec, seen_refs } = component_specs_queue.pop()!;
      for (const dep_name of Object.keys(component_spec.dependencies || {})) {
        const dep_ref = this.getComponentRef(dep_name);
        if (seen_refs.includes(dep_ref)) {
          throw new ArchitectError(`Circular component dependency detected (${seen_refs.join(' <> ')})`);
        }
        if (component_specs_map[dep_ref]) {
          component_specs_queue.push({ component_spec: component_specs_map[dep_ref], seen_refs: [...seen_refs, dep_ref] });
        }
      }
    }
  }

  abstract getArchitectContext(): ArchitectContext;

  async getGraph(component_specs: ComponentSpec[], all_secrets: Dictionary<Dictionary<string | number | null>> = {}, interpolate = true, validate = true, external_addr: string): Promise<DependencyGraph> {
    if (validate) {
      this.detectCircularDependencies(component_specs);
      ValuesConfig.validate(all_secrets);
    }

    const interpolateObject = validate ? interpolateObjectOrReject : interpolateObjectLoose;

    const graph = new DependencyGraph();

    const context_map: Dictionary<ComponentContext> = {};
    const dependency_context_map: Dictionary<ComponentContext> = {};

    const evaluated_component_specs: ComponentSpec[] = [];
    for (let component_spec of component_specs) {
      let context: ComponentContext = {
        name: component_spec.name,
        architect: this.getArchitectContext(),
        environment: {
          ingresses: {},
        },
        dependencies: {},
        ingresses: {},
        interfaces: {},
        outputs: {},
        parameters: {},
        services: {},
        tasks: {},
      };

      const parameters = transformDictionary(transformParameterDefinitionSpec, component_spec.parameters);
      for (const [key, value] of Object.entries(parameters)) {
        context.parameters[key] = value.default;
      }

      const secrets = this.getSecretsForComponentSpec(component_spec, all_secrets);
      context.parameters = {
        ...context.parameters,
        ...secrets,
      };

      if (interpolate) {
        // Interpolate parameters
        context = interpolateObject(context, context, { keys: false, values: true, file: component_spec.metadata.file });

        // Replace conditionals
        component_spec = interpolateObject(component_spec, context, { keys: true, values: false, file: component_spec.metadata.file });
      }

      const component_config = transformComponentSpec(component_spec);

      if (interpolate && validate) {
        this.validateRequiredParameters(component_config, context.parameters || {});
      }

      const nodes = this.getComponentNodes(component_config);

      const has_interfaces = Object.keys(component_config.interfaces).length > 0;
      const has_outputs = Object.keys(component_config.outputs).length > 0;
      if (has_interfaces || has_outputs) {
        const ref = component_config.metadata.ref;
        const config = {
          outputs: component_config.outputs,
          interfaces: component_config.interfaces,
        };
        const node = new ComponentNode(buildInterfacesRef(component_config), ref, config);
        nodes.push(node);
      }

      for (const node of nodes) {
        node.instance_id = component_config.metadata?.instance_id || '';
        graph.addNode(node);
      }

      // Generate remaining context except ingress.x.consumers and dependencies
      for (const [key, value] of Object.entries(component_config.outputs)) {
        context.outputs[key] = value.value;
      }
      for (const [service_name, service] of Object.entries(component_config.services)) {
        if (!context.services[service_name]) {
          context.services[service_name] = {
            interfaces: {},
            environment: {},
          };
        }
        const service_ref = buildNodeRef(component_config, 'services', service_name);
        for (const [interface_name, value] of Object.entries(service.interfaces)) {
          const interface_ref = `services.${service_name}.interfaces.${interface_name}`;

          const sidecar_service = `${service_ref}--${interface_name}`;
          if (component_spec.metadata.proxy_port_mapping) {
            component_spec.metadata.proxy_port_mapping[sidecar_service];
            if (!component_spec.metadata.proxy_port_mapping[sidecar_service]) {
              component_spec.metadata.proxy_port_mapping[sidecar_service] = Math.max(12344, ...Object.values(component_spec.metadata.proxy_port_mapping)) + 1;
            }
          }

          const architect_host = component_spec.metadata.proxy_port_mapping ? '127.0.0.1' : service_ref;
          const architect_port = component_spec.metadata.proxy_port_mapping ? component_spec.metadata.proxy_port_mapping[sidecar_service] : `${interface_ref}.external_port`;
          context.services[service_name].interfaces[interface_name] = {
            protocol: 'http',
            username: '',
            password: '',
            path: '',
            ...value,
            // eslint-disable-next-line @typescript-eslint/ban-ts-comment
            // @ts-ignore
            external_port: value.port,
            external_host: value.host,
            // Return different value for port when a service is refing its own port value
            port: `\${{ ${interface_ref}.external_host || startsWith(_path, 'services.${service_name}.') ? ${interface_ref}.external_port : ${architect_port} }}`,
            host: `\${{ ${interface_ref}.external_host ? ${interface_ref}.external_host : '${architect_host}' }}`,
            url: this.generateUrl(interface_ref),
          };
        }
      }

      // Set component interfaces
      const [external_host, external_port_string] = external_addr.split(':');
      const external_port = parseInt(external_port_string);
      const external_protocol = external_host === 'arc.localhost' ? 'http' : 'https';
      for (const [interface_name, interface_config] of Object.entries(component_config.interfaces)) {
        const url_regex = new RegExp(`\\\${{\\s*(.*?)\\.url\\s*}}`, 'g');
        const matches = url_regex.exec(interface_config.url);
        if (matches) {
          const interface_ref = matches[1];

          const [services_text, service_name, interfaces_text, service_interface_name] = interface_ref.split('.');
          if (services_text !== 'services') {
            continue;
          }
          if (interfaces_text !== 'interfaces') {
            continue;
          }
          if (!(service_name in context.services)) {
            continue;
          }
          if (!(service_interface_name in context.services[service_name].interfaces)) {
            continue;
          }
          context.interfaces[interface_name] = {
            host: interface_config.host || `\${{ ${interface_ref}.host }}`,
            port: interface_config.port || `\${{ ${interface_ref}.port }}`,
            username: interface_config.username || `\${{ ${interface_ref}.username }}`,
            password: interface_config.password || `\${{ ${interface_ref}.password }}`,
            protocol: interface_config.protocol || `\${{ ${interface_ref}.protocol }}`,
            url: interface_config.url || `\${{ ${interface_ref}.url }}`,
          };

          const ingress_ref = `ingresses.${interface_name}`;
          context.ingresses[interface_name] = {
            dns_zone: external_host,
            subdomain: interface_config.ingress?.subdomain || interface_name,
            host: `\${{ ${interface_ref}.external_host ? ${interface_ref}.external_host : ((${ingress_ref}.subdomain == '@' ? '' : ${ingress_ref}.subdomain + '.') + ${ingress_ref}.dns_zone) }}`,
            port: `\${{ ${interface_ref}.external_host ? ${interface_ref}.port : ${external_port} }}`,
            protocol: `\${{ ${interface_ref}.external_host ? ${interface_ref}.protocol : '${external_protocol}' }}`,
            username: '',
            password: '',
            path: interface_config.ingress?.path,
            url: this.generateUrl(ingress_ref),
            consumers: [],
          };

          // Deprecated: environment.ingresses
          if (!context.environment.ingresses[component_spec.name]) {
            context.environment.ingresses[component_spec.name] = {};
          }
          context.environment.ingresses[component_spec.name][interface_name] = context.ingresses[interface_name];
        }
      }

      if (interpolate) {
        // Interpolate interfaces/ingresses/services for dependencies
        dependency_context_map[component_spec.metadata.ref] = interpolateObject(context, context, { keys: false, values: true, file: component_spec.metadata.file });
      } else {
        dependency_context_map[component_spec.metadata.ref] = context;
      }

      context_map[component_spec.metadata.ref] = context;
      evaluated_component_specs.push(component_spec);
    }

    // Add edges to graph
    for (const component_spec of evaluated_component_specs) {
      const component_config = transformComponentSpec(component_spec);
      const dependency_specs = this.getDependencyComponents(component_spec, component_specs);
      const dependency_configs = Object.values(dependency_specs).map(d => transformComponentSpec(d));
      this.addComponentEdges(graph, component_config, dependency_configs, dependency_context_map, external_addr);

      for (const edge of graph.edges) {
        const from_node = graph.getNodeByRef(edge.from);
        if (from_node instanceof GatewayNode) {
          const to_node = graph.getNodeByRef(edge.to);
          edge.instance_id = to_node.instance_id;
        } else {
          edge.instance_id = from_node.instance_id;
        }
      }
    }

    // Generate context for dependencies/consumers
    for (let component_spec of evaluated_component_specs) {
      const context = context_map[component_spec.metadata.ref];

      for (const [service_name, service] of Object.entries(component_spec.services || {})) {
        if (!context.services[service_name]) {
          context.services[service_name] = {
            interfaces: {},
            environment: {},
          };
        }
        context.services[service_name].environment = service.environment;
      }

      for (const [task_name, task] of Object.entries(component_spec.tasks || {})) {
        if (!context.tasks[task_name]) { context.tasks[task_name] = {}; }
        context.tasks[task_name].environment = task.environment;
      }

      const dependency_specs = this.getDependencyComponents(component_spec, component_specs);
      context.dependencies = {};
      for (const [dep_name, dependency_spec] of Object.entries(dependency_specs)) {
        const dependency_context = dependency_context_map[dependency_spec.metadata.ref];
        context.dependencies[dep_name] = {
          ingresses: dependency_context.ingresses || {},
          interfaces: dependency_context.interfaces || {},
          outputs: dependency_context.outputs || {},
        };

        if (component_spec.metadata.proxy_port_mapping) {
          for (const [dependency_interface_name, dependency_interface] of Object.entries(context.dependencies[dep_name].interfaces)) {
            const sidecar_service = `${buildInterfacesRef(dependency_spec)}--${dependency_interface_name}`;
            component_spec.metadata.proxy_port_mapping[sidecar_service];
            if (!component_spec.metadata.proxy_port_mapping[sidecar_service]) {
              component_spec.metadata.proxy_port_mapping[sidecar_service] = Math.max(12344, ...Object.values(component_spec.metadata.proxy_port_mapping)) + 1;
            }
            if (dependency_interface.host === '127.0.0.1') {
              dependency_interface.port = component_spec.metadata.proxy_port_mapping[sidecar_service];
              dependency_interface.url = `${dependency_interface.url.split('127.0.0.1')[0]}127.0.0.1:${dependency_interface.port}`;
            }
          }
        }

        // Deprecated: environment.ingresses
        if (!context.environment.ingresses[dep_name]) {
          context.environment.ingresses[dep_name] = {};
        }
        for (const [dep_ingress_name, dep_ingress] of Object.entries(context.dependencies[dep_name].ingresses)) {
          context.environment.ingresses[dep_name][dep_ingress_name] = dep_ingress;
        }
      }

      const ingress_edge = graph.edges.find(edge => edge instanceof IngressEdge && edge.to === buildInterfacesRef(component_spec)) as IngressEdge;

      // Set consumers context
      if (ingress_edge) {
        for (const [interface_name, consumer_refs] of Object.entries(ingress_edge.consumers_map)) {
          const interfaces_refs = graph.edges.filter(edge => consumer_refs.has(edge.to) && graph.getNodeByRef(edge.from) instanceof ComponentNode).map(edge => edge.from);
          const consumer_ingress_edges = graph.edges.filter(edge => edge instanceof IngressEdge && interfaces_refs.includes(edge.to)) as IngressEdge[];
          const consumers = new Set<string>();
          for (const consumer_ingress_edge of consumer_ingress_edges) {
            const interface_node = graph.getNodeByRef(consumer_ingress_edge.to) as ComponentNode;
            const consumer_interface = dependency_context_map[interface_node.slug].ingresses || {};
            for (const { interface_to: consumer_interface_to } of consumer_ingress_edge.interface_mappings) {
              consumers.add(consumer_interface[consumer_interface_to].url);
            }
          }
          context.ingresses[interface_name].consumers = [...consumers].sort();
        }
      }

      if (interpolate) {
        component_spec = interpolateObject(component_spec, context, { keys: false, values: true, file: component_spec.metadata.file });
      }

      if (validate) {
        validateOrRejectSpec(classToPlain(plainToClass(ComponentSpec, component_spec)), component_spec.metadata);
      }

      const component_config = transformComponentSpec(component_spec);

      // Add interfaces to ComponentNode of the tree if there are any interfaces defined
      if (Object.keys(component_config.interfaces).length) {
        const component_node = graph.getNodeByRef(buildInterfacesRef(component_config)) as ComponentNode;
        component_node.config.interfaces = component_config.interfaces;
      }

      // Add outputs to ComponentNode of the tree if there are any outputs defined
      if (Object.keys(component_config.outputs).length) {
        const component_node = graph.getNodeByRef(buildInterfacesRef(component_config)) as ComponentNode;
        component_node.config.outputs = component_config.outputs;
      }

      const services = Object.entries(component_config.services).map(([resource_name, resource_config]) => ({ resource_name, resource_type: 'services' as ResourceType, resource_config }));
      const tasks = Object.entries(component_config.tasks).map(([resource_name, resource_config]) => ({ resource_name, resource_type: 'tasks' as ResourceType, resource_config }));
      for (const { resource_config, resource_type } of [...services, ...tasks]) {
        const resource_ref = buildNodeRef(component_config, resource_type, resource_config.name);
        const node = graph.getNodeByRef(resource_ref) as ServiceNode | TaskNode;
        if (this.use_sidecar) {
          node.proxy_port_mapping = component_config.metadata.proxy_port_mapping;
        }
        node.config = resource_config;
      }
    }

    if (validate) {
      this.validateGraph(graph);
      graph.validated = true;
    }

    return graph;
  }
}
