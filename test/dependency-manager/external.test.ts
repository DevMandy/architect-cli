import { expect } from '@oclif/test';
import axios from 'axios';
import mock_fs from 'mock-fs';
import moxios from 'moxios';
import path from 'path';
import sinon from 'sinon';
import Register from '../../src/commands/register';
import LocalDependencyManager from '../../src/common/dependency-manager/local-manager';
import { DockerComposeUtils } from '../../src/common/docker-compose';
import DockerComposeTemplate from '../../src/common/docker-compose/template';
import PortUtil from '../../src/common/utils/port';
import { ComponentConfig, ServiceNode } from '../../src/dependency-manager/src';

describe('external spec v1', () => {
  beforeEach(() => {
    moxios.install();
    moxios.wait(function () {
      let request = moxios.requests.mostRecent()
      if (request) {
        request.respondWith({
          status: 404,
        })
      }
    })

    sinon.replace(Register.prototype, 'log', sinon.stub());
    sinon.replace(PortUtil, 'isPortAvailable', async () => true);
    PortUtil.reset();
  });

  afterEach(() => {
    sinon.restore();
    mock_fs.restore();
    moxios.uninstall();
  });

  it('simple external', async () => {
    const component_config = {
      name: 'architect/cloud',
      services: {
        app: {
          interfaces: {
            main: {
              host: 'cloud.architect.io',
              port: 8080
            }
          },
          environment: {
            HOST: '${{ services.app.interfaces.main.host }}',
            ADDR: '${{ services.app.interfaces.main.url }}'
          }
        }
      },
      interfaces: {}
    };

    mock_fs({
      '/stack/architect.json': JSON.stringify(component_config),
    });

    const manager = new LocalDependencyManager(axios.create(), {
      'architect/cloud': '/stack/architect.json'
    });
    const graph = await manager.getGraph([
      await manager.loadComponentConfig('architect/cloud:latest')
    ]);

    const app_ref = ComponentConfig.getNodeRef('architect/cloud/app:latest')
    expect(graph.nodes.map((n) => n.ref)).has.members([
      app_ref,
    ])
    expect(graph.edges.map((e) => e.toString())).has.members([])
    const app_node = graph.getNodeByRef(app_ref) as ServiceNode;
    expect(app_node.is_external).to.be.true;
    expect(app_node.config.getEnvironmentVariables()).to.deep.equal({
      HOST: 'cloud.architect.io',
      ADDR: 'http://cloud.architect.io:8080'
    })

    const template = await DockerComposeUtils.generate(graph);
    expect(template).to.be.deep.equal({
      'services': {},
      'version': '3',
      'volumes': {},
    })
  });

  it('simple no override', async () => {
    const component_config = {
      name: 'architect/cloud',
      parameters: {
        optional_host: { required: false }
      },
      services: {
        app: {
          interfaces: {
            main: {
              host: '${{ parameters.optional_host }}',
              port: 8080
            }
          },
          environment: {
            HOST: '${{ services.app.interfaces.main.host }}',
            ADDR: '${{ services.app.interfaces.main.url }}'
          }
        }
      },
      interfaces: {}
    };

    mock_fs({
      '/stack/architect.json': JSON.stringify(component_config),
    });

    const manager = new LocalDependencyManager(axios.create(), {
      'architect/cloud': '/stack/architect.json'
    });
    const graph = await manager.getGraph([
      await manager.loadComponentConfig('architect/cloud:latest')
    ]);

    const app_ref = ComponentConfig.getNodeRef('architect/cloud/app:latest')
    expect(graph.nodes.map((n) => n.ref)).has.members([
      app_ref,
    ])
    expect(graph.edges.map((e) => e.toString())).has.members([])
    const app_node = graph.getNodeByRef(app_ref) as ServiceNode;
    expect(app_node.is_external).to.be.false;
    expect(app_node.config.getEnvironmentVariables()).to.deep.equal({
      HOST: app_ref,
      ADDR: `http://${app_ref}:8080`
    })
  });

  it('simple external override', async () => {
    const component_config = {
      name: 'architect/cloud',
      parameters: {
        optional_host: {}
      },
      services: {
        app: {
          interfaces: {
            main: {
              host: '${{ parameters.optional_host }}',
              port: 8080
            }
          },
          environment: {
            HOST: '${{ services.app.interfaces.main.host }}',
            ADDR: '${{ services.app.interfaces.main.url }}'
          }
        }
      },
      interfaces: {}
    };

    mock_fs({
      '/stack/architect.json': JSON.stringify(component_config),
    });

    const manager = new LocalDependencyManager(axios.create(), {
      'architect/cloud': '/stack/architect.json'
    });
    const graph = await manager.getGraph([
      await manager.loadComponentConfig('architect/cloud:latest')
    ], { '*': { optional_host: 'cloud.architect.io' } });

    const app_ref = ComponentConfig.getNodeRef('architect/cloud/app:latest')
    expect(graph.nodes.map((n) => n.ref)).has.members([
      app_ref,
    ])
    expect(graph.edges.map((e) => e.toString())).has.members([])
    const app_node = graph.getNodeByRef(app_ref) as ServiceNode;
    expect(app_node.is_external).to.be.true;
    expect(app_node.config.getEnvironmentVariables()).to.deep.equal({
      HOST: 'cloud.architect.io',
      ADDR: 'http://cloud.architect.io:8080'
    })

    const template = await DockerComposeUtils.generate(graph);
    expect(template).to.be.deep.equal({
      'services': {},
      'version': '3',
      'volumes': {},
    })
  });

  it('service connecting to external', async () => {
    const component_config = {
      name: 'architect/cloud',
      services: {
        app: {
          interfaces: {
            main: 8080
          },
          environment: {
            API_ADDR: '${{ services.api.interfaces.main.url }}',
            EXTERNAL_API_ADDR: '${{ services.api.interfaces.main.url }}'
          }
        },
        api: {
          interfaces: {
            main: {
              protocol: 'https',
              host: 'external.locahost',
              port: 443,
            }
          }
        }
      },
      interfaces: {}
    };

    mock_fs({
      '/stack/architect.json': JSON.stringify(component_config),
    });

    const manager = new LocalDependencyManager(axios.create(), {
      'architect/cloud': '/stack/architect.json'
    });
    const graph = await manager.getGraph([
      await manager.loadComponentConfig('architect/cloud:latest')
    ]);
    const app_ref = ComponentConfig.getNodeRef('architect/cloud/app:latest')
    const api_ref = ComponentConfig.getNodeRef('architect/cloud/api:latest')

    expect(graph.nodes.map((n) => n.ref)).has.members([
      app_ref,
      api_ref
    ])
    expect(graph.edges.map((e) => e.toString())).has.members([
      `${app_ref} [service->main] -> ${api_ref} [main]`
    ])
    const app_node = graph.getNodeByRef(app_ref) as ServiceNode;
    expect(app_node.is_external).to.be.false;
    const api_node = graph.getNodeByRef(api_ref) as ServiceNode;
    expect(api_node.is_external).to.be.true;

    const template = await DockerComposeUtils.generate(graph);
    const expected_compose: DockerComposeTemplate = {
      services: {
        [app_ref]: {
          environment: {
            API_ADDR: 'https://external.locahost',
            EXTERNAL_API_ADDR: 'https://external.locahost'
          },
          ports: [
            '50000:8080'
          ],
          build: {
            context: path.resolve('/stack')
          }
        }
      },
      'version': '3',
      'volumes': {},
    };
    expect(template).to.be.deep.equal(expected_compose);
  });

  it('dependency refs external host', async () => {
    const component_config = `
      name: architect/component
      dependencies:
        architect/dependency: latest
      services:
        app:
          image: hashicorp/http-echo
          environment:
            DEP_ADDR: \${{ dependencies.architect/dependency.interfaces.api.url }}
            CI_ADDR: \${{ dependencies.architect/dependency.interfaces.ci.url }}
    `;

    const dependency_config = `
      name: architect/dependency
      parameters:
        optional_host: ci.architect.io
      services:
        app:
          image: hashicorp/http-echo
          interfaces:
            api:
              port: 443
              protocol: https
              host: external.localhost
            ci:
              port: 8501
              protocol: https
              host: \${{ parameters.optional_host }}
      interfaces:
        api: \${{ services.app.interfaces.api.url }}
        ci: \${{ services.app.interfaces.ci.url }}
    `;

    mock_fs({
      '/stack/component/architect.yml': component_config,
      '/stack/dependency/architect.yml': dependency_config,
    });

    const manager = new LocalDependencyManager(axios.create(), {
      'architect/component': '/stack/component/architect.yml',
      'architect/dependency': '/stack/dependency/architect.yml'
    });
    const graph = await manager.getGraph([
      await manager.loadComponentConfig('architect/component:latest'),
      await manager.loadComponentConfig('architect/dependency:latest')
    ]);

    const app_ref = ComponentConfig.getNodeRef('architect/component/app:latest')

    const test_node = graph.getNodeByRef(app_ref) as ServiceNode;
    expect(test_node.config.getEnvironmentVariables()).to.deep.eq({
      DEP_ADDR: `https://external.localhost`,
      CI_ADDR: `https://ci.architect.io:8501`
    });
  });

  it('should strip default ports from environment ingress references', async () => {
    const component_config = `
      name: architect/component
      services:
        app:
          image: hashicorp/http-echo
          interfaces:
            api: 8080
          environment:
            SELF_ADDR: \${{ environment.ingresses['architect/component'].app.url }}
      interfaces:
        app: \${{ services.app.interfaces.api.url }}
    `;

    mock_fs({
      '/stack/component/architect.yml': component_config,
    });

    const manager = new LocalDependencyManager(axios.create(), {
      'architect/component': '/stack/component/architect.yml'
    });
    const graph = await manager.getGraph([
      await manager.loadComponentConfig('architect/component:latest')
    ]);

    const app_ref = ComponentConfig.getNodeRef('architect/component/app:latest')

    const test_node = graph.getNodeByRef(app_ref) as ServiceNode;
    expect(test_node.config.getEnvironmentVariables()).to.deep.eq({
      SELF_ADDR: `http://${app_ref}.arc.localhost`,
    });
  });
});
