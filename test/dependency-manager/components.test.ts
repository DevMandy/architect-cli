import { expect } from '@oclif/test';
import axios from 'axios';
import mock_fs from 'mock-fs';
import moxios from 'moxios';
import sinon from 'sinon';
import Build from '../../src/commands/build';
import LocalDependencyManager from '../../src/common/dependency-manager/local-manager';

describe('dependencies', function () {
  beforeEach(async () => {
    // Stub the logger
    sinon.replace(Build.prototype, 'log', sinon.stub());
    moxios.install();
  });

  afterEach(function () {
    // Restore stubs
    sinon.restore();
    // Restore fs
    mock_fs.restore();
    moxios.uninstall();
  });

  describe('standard components', function () {
    it('simple local component', async () => {
      const component_config = {
        name: 'architect/cloud',
        services: {
          app: {
            interfaces: {
              main: 8080
            }
          },
          api: {
            interfaces: {
              main: 8080
            }
          }
        }
      };

      const env_config = {
        components: {
          'architect/cloud': {
            'extends': 'file:.'
          }
        }
      };

      mock_fs({
        '/stack/architect.json': JSON.stringify(component_config),
        '/stack/arc.env.json': JSON.stringify(env_config),
      });

      const manager = await LocalDependencyManager.createFromPath(axios.create(), '/stack/arc.env.json');
      const graph = manager.graph;
      expect(graph.nodes).length(2);
      expect(graph.nodes[0].ref).eq('architect/cloud/app:latest')
      expect(graph.nodes[1].ref).eq('architect/cloud/api:latest')
      expect(graph.edges).length(0);
    });

    it('simple remote component', async () => {
      const component_config = {
        name: 'architect/cloud',
        services: {
          app: {
            interfaces: {
              main: 8080
            }
          },
          api: {
            interfaces: {
              main: 8080
            }
          }
        }
      };

      moxios.stubRequest(`/accounts/architect/services/cloud/versions/v1`, {
        status: 200,
        response: { tag: 'v1', config: component_config, service: { url: 'architect/cloud:v1' } }
      });

      const env_config = {
        components: {
          'architect/cloud': 'v1'
        }
      };

      mock_fs({
        '/stack/arc.env.json': JSON.stringify(env_config),
      });

      const manager = await LocalDependencyManager.createFromPath(axios.create(), '/stack/arc.env.json');
      const graph = manager.graph;
      expect(graph.nodes).length(2);
      expect(graph.nodes[0].ref).eq('architect/cloud/app:latest')
      expect(graph.nodes[1].ref).eq('architect/cloud/api:latest')
      expect(graph.edges).length(0);
    });

    it('local component with edges', async () => {
      const component_config = {
        name: 'architect/cloud',
        services: {
          app: {
            interfaces: {
              main: 8080
            },
            environment: {
              API_ADDR: '${ services.api.interfaces.main.url }'
            }
          },
          api: {
            interfaces: {
              main: 8080
            },
            environment: {
              DB_ADDR: '${ services.db.interfaces.main.url }'
            }
          },
          db: {
            interfaces: {
              main: 5432
            }
          }
        }
      };

      const env_config = {
        components: {
          'architect/cloud': {
            'extends': 'file:.'
          }
        }
      };

      mock_fs({
        '/stack/architect.json': JSON.stringify(component_config),
        '/stack/arc.env.json': JSON.stringify(env_config),
      });

      const manager = await LocalDependencyManager.createFromPath(axios.create(), '/stack/arc.env.json');
      const graph = manager.graph;
      expect(graph.nodes).length(3);
      expect(graph.nodes[0].ref).eq('architect/cloud/app:latest')
      expect(graph.nodes[1].ref).eq('architect/cloud/api:latest')
      expect(graph.nodes[2].ref).eq('architect/cloud/db:latest')
      expect(graph.edges).length(2);
      expect(graph.edges[0].from).eq('architect/cloud/app:latest')
      expect(graph.edges[0].to).eq('architect/cloud/api:latest')
      expect(graph.edges[1].from).eq('architect/cloud/api:latest')
      expect(graph.edges[1].to).eq('architect/cloud/db:latest')
      // Test parameter values
      expect(graph.nodes[0].parameters.API_ADDR).eq('architect/cloud/app:latest')
      expect(graph.nodes[1].parameters.DB_ADDR).eq('architect/cloud/app:latest')
    });
  });
});
