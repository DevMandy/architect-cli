/**
 * @format
 */
import { expect } from '@oclif/test';
import axios from 'axios';
import mock_fs from 'mock-fs';
import moxios from 'moxios';
import sinon from 'sinon';
import Build from '../../src/commands/build';
import LocalDependencyManager from '../../src/common/dependency-manager/local-manager';
import PortUtil from '../../src/common/utils/port';
import { ServiceNode } from '../../src/dependency-manager/src';

describe('interfaces spec v1', () => {
  beforeEach(async () => {
    // Stub the logger
    sinon.replace(Build.prototype, 'log', sinon.stub());
    moxios.install();
    moxios.wait(function () {
      let request = moxios.requests.mostRecent()
      if (request) {
        request.respondWith({
          status: 404,
        })
      }
    })
    sinon.replace(PortUtil, 'isPortAvailable', async () => true);
    PortUtil.reset();
  });

  afterEach(function () {
    // Restore stubs
    sinon.restore();
    // Restore fs
    mock_fs.restore();
    moxios.uninstall();
  });

  let leaf_component = {} as any,
    branch_component = {} as any;

  it('should connect two services together', async () => {
    leaf_component = {
      name: 'test/leaf',
      services: {
        db: {
          image: 'postgres:11',
          interfaces: {
            postgres: {
              port: 5432,
              protocol: 'postgres',
            },
          },
        },
        api: {
          image: 'api:latest',
          interfaces: {},
          environment: {
            DB_PROTOCOL: '${ services.db.interfaces.postgres.protocol }',
            DB_HOST: '${ services.db.interfaces.postgres.host }',
            DB_PORT: '${ services.db.interfaces.postgres.port }',
            DB_URL: '${ services.db.interfaces.postgres.url }',
          },
        },
      },
      interfaces: {}
    };

    mock_fs({
      '/stack/leaf/architect.json': JSON.stringify(leaf_component),
      '/stack/environment.json': JSON.stringify({
        components: {
          'test/leaf': 'file:/stack/leaf/',
        },
      }),
    });

    const manager = await LocalDependencyManager.createFromPath(
      axios.create(),
      '/stack/environment.json',
    );
    const graph = await manager.getGraph();
    expect(graph.nodes.map((n) => n.ref)).has.members([
      'test/leaf/db:latest',
      'test/leaf/api:latest'
    ])
    expect(graph.edges.map((e) => `${e.from} -> ${e.to} [${[...e.interfaces].join(', ')}]`)).has.members([
      'test/leaf/api:latest -> test/leaf/db:latest [postgres]',
    ])
    const api_node = graph.getNodeByRef('test/leaf/api:latest') as ServiceNode;
    expect(Object.entries(api_node.node_config.getEnvironmentVariables()).map(([k, v]) => `${k}=${v}`)).has.members([
      'DB_PROTOCOL=postgres',
      'DB_HOST=test.leaf.db.latest',
      'DB_PORT=5432',
      'DB_URL=postgres://test.leaf.db.latest:5432'
    ])
  });

  it('should connect services to dependency interfaces', async () => {
    leaf_component.services.api.interfaces = {
      main: 8080,
    };

    leaf_component.interfaces = {
      api: '${ services.api.interfaces.main.url }',
    };

    branch_component = {
      name: 'test/branch',
      dependencies: {
        'test/leaf': 'latest',
      },
      services: {
        api: {
          image: 'branch:latest',
          interfaces: {},
          environment: {
            LEAF_PROTOCOL: '${ dependencies.test/leaf.interfaces.api.protocol }',
            LEAF_HOST: '${ dependencies.test/leaf.interfaces.api.host }',
            LEAF_PORT: '${ dependencies.test/leaf.interfaces.api.port }',
            LEAF_URL: '${ dependencies.test/leaf.interfaces.api.url }',
          },
        },
      },
      interfaces: {}
    };

    mock_fs({
      '/stack/leaf/architect.json': JSON.stringify(leaf_component),
      '/stack/branch/architect.json': JSON.stringify(branch_component),
      '/stack/environment.json': JSON.stringify({
        components: {
          'test/branch': 'file:/stack/branch/',
          'test/leaf': 'file:/stack/leaf/',
        },
      }),
    });

    const manager = await LocalDependencyManager.createFromPath(
      axios.create(),
      '/stack/environment.json',
    );
    const graph = await manager.getGraph();
    expect(graph.nodes.map((n) => n.ref)).has.members([
      'test/branch/api:latest',

      'test/leaf:latest-interfaces',
      'test/leaf/db:latest',
      'test/leaf/api:latest'
    ])
    expect(graph.edges.map((e) => `${e.from} -> ${e.to} [${[...e.interfaces].join(', ')}]`)).has.members([
      'test/leaf/api:latest -> test/leaf/db:latest [postgres]',
      'test/leaf:latest-interfaces -> test/leaf/api:latest [main]',

      'test/branch/api:latest -> test/leaf:latest-interfaces [api]',
    ])
    const branch_api_node = graph.getNodeByRef('test/branch/api:latest') as ServiceNode;
    expect(Object.entries(branch_api_node.node_config.getEnvironmentVariables()).map(([k, v]) => `${k}=${v}`)).has.members([
      'LEAF_PROTOCOL=http',
      'LEAF_HOST=test.leaf.api.latest',
      'LEAF_PORT=8080',
      'LEAF_URL=http://test.leaf.api.latest:8080'
    ])
  });

  it('should expose environment interfaces via a gateway', async () => {
    mock_fs({
      '/stack/leaf/architect.json': JSON.stringify(leaf_component),
      '/stack/branch/architect.json': JSON.stringify(branch_component),
      '/stack/environment.json': JSON.stringify({
        interfaces: {
          public: '${ components.test/leaf.interfaces.api.url }',
        },
        components: {
          'test/branch': 'file:/stack/branch/',
          'test/leaf': 'file:/stack/leaf/',
        },
      }),
    });

    const manager = await LocalDependencyManager.createFromPath(
      axios.create(),
      '/stack/environment.json',
    );
    const graph = await manager.getGraph();

    expect(graph.nodes.map((n) => n.ref)).has.members([
      'gateway',

      'test/branch/api:latest',

      'test/leaf:latest-interfaces',
      'test/leaf/db:latest',
      'test/leaf/api:latest'
    ])
    expect(graph.edges.map((e) => `${e.from} -> ${e.to} [${[...e.interfaces].join(', ')}]`)).has.members([
      'gateway -> test/leaf:latest-interfaces [api]',

      'test/leaf/api:latest -> test/leaf/db:latest [postgres]',
      'test/leaf:latest-interfaces -> test/leaf/api:latest [main]',

      'test/branch/api:latest -> test/leaf:latest-interfaces [api]',
    ])
    const branch_api_node = graph.getNodeByRef('test/branch/api:latest') as ServiceNode;
    expect(Object.entries(branch_api_node.node_config.getEnvironmentVariables()).map(([k, v]) => `${k}=${v}`)).has.members([
      'LEAF_PROTOCOL=http',
      'LEAF_HOST=public.localhost',
      'LEAF_PORT=80',
      'LEAF_URL=http://public.localhost:80'
    ])
  });
});
