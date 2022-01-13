import { expect, test } from '@oclif/test';
import yaml from 'js-yaml';
import path from 'path';
import sinon, { SinonSpy } from 'sinon';
import AppService from '../../src/app-config/service';
import PipelineUtils from '../../src/architect/pipeline/pipeline.utils';
import Deploy from '../../src/commands/deploy';
import DockerComposeTemplate from '../../src/common/docker-compose/template';
import * as Docker from '../../src/common/utils/docker';
import { resourceRefToNodeRef } from '../../src/dependency-manager/src';
import * as ComponentBuilder from '../../src/dependency-manager/src/spec/utils/component-builder';
import { buildSpecFromYml } from '../../src/dependency-manager/src/spec/utils/component-builder';
import { app_host } from '../config.json';
import { mockArchitectAuth, MOCK_API_HOST } from '../utils/mocks';

// set to true while working on tests for easier debugging; otherwise oclif/test eats the stdout/stderr
const print = false;

const account = {
  id: 'test-account-id',
  name: 'test-account'
}

const environment = {
  id: 'test-env-id',
  name: 'test-env',
  account,
}

const mock_pipeline = {
  id: 'test-pipeline-id'
}

describe('local deploy environment', function () {

  function getHelloComponentConfig(): any {
    return `
    name: examples/hello-world

    parameters:
      hello_ingress: hello

    services:
      api:
        image: heroku/nodejs-hello-world
        interfaces:
          main:
            port: 3000
        environment: {}

    interfaces:
      hello:
        ingress:
          subdomain: \${{ parameters.hello_ingress }}
        url: \${{ services.api.interfaces.main.url }}
    `
  }

  const local_component_config_with_parameters = `
    name: examples/hello-world

    parameters:
      a_required_key:
        required: true
      another_required_key:
        required: true
      one_more_required_param:
        required: true
      compose_escaped_variable:
        required: false
      api_port:

    services:
      api:
        image: heroku/nodejs-hello-world
        interfaces:
          main: \${{ parameters.api_port }}
        environment:
          a_required_key: \${{ parameters.a_required_key }}
          another_required_key: \${{ parameters.another_required_key }}
          one_more_required_param: \${{ parameters.one_more_required_param }}
          compose_escaped_variable: \${{ parameters.compose_escaped_variable }}

    interfaces:
      hello:
        url: \${{ services.api.interfaces.main.url }}
    `;

  const basic_parameter_secrets = {
    'examples/hello-world:latest': {
      'a_required_key': 'some_value',
      'another_required_key': 'required_value',
      'one_more_required_param': 'one_more_value',
      'compose_escaped_variable': 'variable_split_$_with_dollar$signs',
      'api_port': 3000
    },
  }
  const wildcard_parameter_secrets = {
    'examples/hello-world:*': {
      'a_required_key': 'some_value',
      'api_port': 3000
    },
    'examples/hello-world:la*': {
      'one_more_required_param': 'one_more_value'
    },
    '*': {
      'another_required_key': 'required_value'
    }
  }
  const stacked_parameter_secrets = {
    'examples/hello-world:*': {
      'a_required_key': 'some_value',
      'another_required_key': 'required_value',
      'one_more_required_param': 'one_more_value',
      'api_port': 3000
    },
    '*': {
      'a_required_key': 'a_value_which_will_be_overwritten',
      'another_required_key': 'another_value_which_will_be_overwritten'
    }
  }

  const local_component_config_with_dependency = {
    "name": "examples/hello-world",

    "services": {
      "api": {
        "image": "heroku/nodejs-hello-world",
        "interfaces": {
          "main": 3000
        },
        "environment": {
          "a_required_key": "${{ parameters.a_required_key }}",
          "another_required_key": "${{ parameters.another_required_key }}",
          "one_more_required_param": "${{ parameters.one_more_required_param }}"
        }
      }
    },

    "interfaces": {
      "hello": {
        "url": "${{ services.api.interfaces.main.url }}"
      }
    },

    "parameters": {
      'a_required_key': {
        'required': true
      },
      'another_required_key': {
        'required': true
      },
      'one_more_required_param': {
        'required': true
      }
    },

    "dependencies": {
      "examples/react-app": "latest"
    }
  }
  const local_component_config_dependency = {
    'config': {
      'name': 'examples/react-app',
      'interfaces': {
        'app': '\${{ services.app.interfaces.main.url }}'
      },
      'parameters': {
        'world_text': {
          'default': 'world'
        }
      },
      'services': {
        'app': {
          'build': {
            'context': './frontend'
          },
          'interfaces': {
            'main': 8080
          },
          'environment': {
            'PORT': '\${{ services.app.interfaces.main.port }}',
            'WORLD_TEXT': '\${{ parameters.world_text }}'
          }
        }
      }
    },
    'component': {
      'name': 'examples/react-app',
    },
    'tag': 'latest'
  }
  const component_and_dependency_parameter_secrets = {
    'examples/hello-world:*': {
      'a_required_key': 'some_value',
      'another_required_key': 'required_value',
      'one_more_required_param': 'one_more_value'
    },
    '*': {
      'a_required_key': 'a_value_which_will_be_overwritten',
      'another_required_key': 'another_value_which_will_be_overwritten',
      'world_text': 'some other name',
      'unused_parameter': 'value_not_used_by_any_component'
    }
  }

  const local_database_seeding_component_config = {
    "name": "examples/database-seeding",

    "parameters": {
      "AUTO_DDL": {
        "default": "none"
      },
      "DB_USER": {
        "default": "postgres"
      },
      "DB_PASS": {
        "default": "architect"
      },
      "DB_NAME": {
        "default": "seeding_demo"
      }
    },

    "services": {
      "app": {
        "build": {
          "context": "./",
          "dockerfile": "Dockerfile",
          "target": "production",
        },
        "interfaces": {
          "main": 3000,
        },
        "depends_on": ["my-demo-db"],
        "environment": {
          "DATABASE_HOST": "${{ services.my-demo-db.interfaces.postgres.host }}",
          "DATABASE_PORT": "${{ services.my-demo-db.interfaces.postgres.port }}",
          "DATABASE_USER": "${{ services.my-demo-db.environment.POSTGRES_USER }}",
          "DATABASE_PASSWORD": "${{ services.my-demo-db.environment.POSTGRES_PASSWORD }}",
          "DATABASE_SCHEMA": "${{ services.my-demo-db.environment.POSTGRES_DB }}",
          "AUTO_DDL": "${{ parameters.AUTO_DDL }}"
        }
      },

      "my-demo-db": {
        "image": "postgres:11",
        "interfaces": {
          "postgres": 5432,
        },
        "environment": {
          "POSTGRES_DB": "${{ parameters.DB_NAME }}",
          "POSTGRES_USER": "${{ parameters.DB_USER }}",
          "POSTGRES_PASSWORD": "${{ parameters.DB_PASS }}"
        }
      }
    },

    "interfaces": {
      "main": {
        "url": "${{ services.app.interfaces.main.url }}"
      }
    }
  };

  const seed_app_ref = resourceRefToNodeRef('examples/database-seeding/app:latest');
  const seed_db_ref = resourceRefToNodeRef('examples/database-seeding/my-demo-db:latest');

  const seeding_component_expected_compose: DockerComposeTemplate = {
    "version": "3",
    "services": {
      [seed_app_ref]: {
        "ports": [
          "50000:3000"
        ],
        "depends_on": [
          seed_db_ref
        ],
        "environment": {
          "DATABASE_HOST": seed_db_ref,
          "DATABASE_PORT": "5432",
          "DATABASE_USER": "postgres",
          "DATABASE_PASSWORD": "architect",
          "DATABASE_SCHEMA": "test-db",
          "AUTO_DDL": "seed"
        },
        "labels": [
          "traefik.enable=true",
          "traefik.port=80",
          `traefik.http.routers.${seed_app_ref}-main.rule=Host(\`app.arc.localhost\`)`,
          `traefik.http.routers.${seed_app_ref}-main.service=${seed_app_ref}-main-service`,
          `traefik.http.services.${seed_app_ref}-main-service.loadbalancer.server.port=3000`,
        ],
        "build": {
          "context": path.resolve('./examples/database-seeding'),
          "dockerfile": "Dockerfile",
          "target": "production",
        },
        "external_links": [
          "gateway:app.arc.localhost"
        ]
      },
      [seed_db_ref]: {
        "ports": [
          "50001:5432"
        ],
        "environment": {
          "POSTGRES_DB": "test-db",
          "POSTGRES_USER": "postgres",
          "POSTGRES_PASSWORD": "architect"
        },
        "image": "postgres:11",
        "external_links": [
          "gateway:app.arc.localhost"
        ]
      },
      "gateway": {
        "image": "traefik:v2.4.14",
        "command": [
          "--api.insecure=true",
          "--pilot.dashboard=false",
          "--accesslog=true",
          "--accesslog.filters.statusCodes=400-599",
          "--entryPoints.web.address=:80",
          "--providers.docker=true",
          "--providers.docker.exposedByDefault=false",
          "--providers.docker.constraints=Label(`traefik.port`,`80`)"
        ],
        "ports": [
          "80:80",
          "8080:8080"
        ],
        "volumes": [
          "/var/run/docker.sock:/var/run/docker.sock:ro"
        ]
      }
    },
    "volumes": {}
  }

  const hello_api_ref = resourceRefToNodeRef('examples/hello-world/api:latest');
  const component_expected_compose: DockerComposeTemplate = {
    "version": "3",
    "services": {
      [hello_api_ref]: {
        "ports": [
          "50000:3000",
        ],
        "environment": {},
        "labels": [
          "traefik.enable=true",
          "traefik.port=80",
          `traefik.http.routers.${hello_api_ref}-hello.rule=Host(\`hello.arc.localhost\`)`,
          `traefik.http.routers.${hello_api_ref}-hello.service=${hello_api_ref}-hello-service`,
          `traefik.http.services.${hello_api_ref}-hello-service.loadbalancer.server.port=3000`,
        ],
        "external_links": [
          "gateway:hello.arc.localhost"
        ],
        "image": "heroku/nodejs-hello-world",
      },
      "gateway": {
        "image": "traefik:v2.4.14",
        "command": [
          "--api.insecure=true",
          "--pilot.dashboard=false",
          "--accesslog=true",
          "--accesslog.filters.statusCodes=400-599",
          "--entryPoints.web.address=:80",
          "--providers.docker=true",
          "--providers.docker.exposedByDefault=false",
          "--providers.docker.constraints=Label(`traefik.port`,`80`)"
        ],
        "ports": [
          "80:80",
          "8080:8080"
        ],
        "volumes": [
          "/var/run/docker.sock:/var/run/docker.sock:ro"
        ]
      }
    },
    "volumes": {}
  }

  test
    .timeout(20000)
    .stub(ComponentBuilder, 'buildSpecFromPath', () => {
      return buildSpecFromYml(getHelloComponentConfig());
    })
    .stub(Docker, 'verify', sinon.stub().returns(Promise.resolve()))
    .stub(Deploy.prototype, 'runCompose', sinon.stub().returns(undefined))
    .stdout({ print })
    .stderr({ print })
    .command(['deploy', '-l', './examples/hello-world/architect.yml', '-i', 'hello'])
    .it('Create a local deploy with a component and an interface', ctx => {
      const runCompose = Deploy.prototype.runCompose as sinon.SinonStub;
      expect(runCompose.calledOnce).to.be.true
      expect(runCompose.firstCall.args[0]).to.deep.equal(component_expected_compose)
    })

  test
    .timeout(20000)
    .stub(ComponentBuilder, 'buildSpecFromPath', () => {
      const hello_json = yaml.load(getHelloComponentConfig()) as any;
      hello_json.services.api.interfaces.main.sticky = true;
      return buildSpecFromYml(yaml.dump(hello_json));
    })
    .stub(Docker, 'verify', sinon.stub().returns(Promise.resolve()))
    .stub(Deploy.prototype, 'runCompose', sinon.stub().returns(undefined))
    .stdout({ print })
    .stderr({ print })
    .command(['deploy', '-l', './examples/hello-world/architect.yml', '-i', 'hello'])
    .it('Sticky label added for sticky interfaces', ctx => {
      const runCompose = Deploy.prototype.runCompose as sinon.SinonStub;
      expect(runCompose.calledOnce).to.be.true;
      const hello_api_ref = resourceRefToNodeRef('examples/hello-world/api:latest');
      expect(runCompose.firstCall.args[0].services[hello_api_ref].labels).to.contain(`traefik.http.services.${hello_api_ref}-hello-service.loadBalancer.sticky.cookie=true`);
    })

  test
    .timeout(20000)
    .stub(ComponentBuilder, 'buildSpecFromPath', () => {
      const spec = buildSpecFromYml(yaml.dump(local_database_seeding_component_config));
      spec.metadata.file = { path: './examples/database-seeding/architect.yml', contents: '' }
      return spec;
    })
    .stub(Docker, 'verify', sinon.stub().returns(Promise.resolve()))
    .stub(Deploy.prototype, 'runCompose', sinon.stub().returns(undefined))
    .stdout({ print })
    .stderr({ print })
    .command(['deploy', '-l', './examples/database-seeding/architect.yml', '-p', 'AUTO_DDL=seed', '-p', 'DB_NAME=test-db', '-i', 'app:main'])
    .it('Create a local deploy with a component, parameters, and an interface', ctx => {
      const runCompose = Deploy.prototype.runCompose as sinon.SinonStub;
      expect(runCompose.calledOnce).to.be.true;
      expect(runCompose.firstCall.args[0]).to.deep.equal(seeding_component_expected_compose);
    })

  test
    .timeout(20000)
    .stub(ComponentBuilder, 'buildSpecFromPath', () => {
      return buildSpecFromYml(local_component_config_with_parameters)
    })
    .stub(Deploy.prototype, 'readSecretsFile', () => {
      return basic_parameter_secrets;
    })
    .stub(Docker, 'verify', sinon.stub().returns(Promise.resolve()))
    .stub(Deploy.prototype, 'runCompose', sinon.stub().returns(undefined))
    .stdout({ print })
    .stderr({ print })
    .command(['deploy', '-l', './examples/hello-world/architect.yml', '-i', 'test:hello', '-s', './examples/hello-world/values.yml'])
    .it('Create a local deploy with a basic component and a basic secrets file', ctx => {
      const runCompose = Deploy.prototype.runCompose as sinon.SinonStub;
      expect(runCompose.calledOnce).to.be.true;
      const hello_world_service = runCompose.firstCall.args[0].services[hello_api_ref] as any;
      expect(hello_world_service.external_links).to.contain('gateway:test.arc.localhost');
      expect(hello_world_service.environment.a_required_key).to.equal('some_value');
      expect(hello_world_service.environment.another_required_key).to.equal('required_value');
      expect(hello_world_service.environment.one_more_required_param).to.equal('one_more_value');
    })

  // This test will be removed when the deprecated 'values' flag is removed
  test
    .timeout(20000)
    .stub(ComponentBuilder, 'buildSpecFromPath', () => {
      return buildSpecFromYml(local_component_config_with_parameters)
    })
    .stub(Deploy.prototype, 'readSecretsFile', () => {
      return basic_parameter_secrets;
    })
    .stub(Docker, 'verify', sinon.stub().returns(Promise.resolve()))
    .stub(Deploy.prototype, 'runCompose', sinon.stub().returns(undefined))
    .stdout({ print })
    .stderr({ print })
    .command(['deploy', '-l', './examples/hello-world/architect.yml', '-i', 'test:hello', '-v', './examples/hello-world/values.yml'])
    .it('Create a local deploy with a basic component and a basic secrets file using deprecated values flag', ctx => {
      const runCompose = Deploy.prototype.runCompose as sinon.SinonStub;
      expect(runCompose.calledOnce).to.be.true;
      const hello_world_service = runCompose.firstCall.args[0].services[hello_api_ref] as any;
      expect(hello_world_service.external_links).to.contain('gateway:test.arc.localhost');
      expect(hello_world_service.environment.a_required_key).to.equal('some_value');
      expect(hello_world_service.environment.another_required_key).to.equal('required_value');
      expect(hello_world_service.environment.one_more_required_param).to.equal('one_more_value');
    })

  test
    .timeout(20000)
    .stub(ComponentBuilder, 'buildSpecFromPath', () => {
      return buildSpecFromYml(local_component_config_with_parameters)
    })
    .stub(Deploy.prototype, 'readSecretsFile', () => {
      return wildcard_parameter_secrets;
    })
    .stub(Docker, 'verify', sinon.stub().returns(Promise.resolve()))
    .stub(Deploy.prototype, 'runCompose', sinon.stub().returns(undefined))
    .stdout({ print })
    .stderr({ print })
    .command(['deploy', '-l', './examples/hello-world/architect.yml', '-i', 'test:hello', '-s', './examples/hello-world/values.yml'])
    .it('Create a local deploy with a basic component and a wildcard secrets file', ctx => {
      const runCompose = Deploy.prototype.runCompose as sinon.SinonStub;
      const hello_world_environment = (runCompose.firstCall.args[0].services[hello_api_ref] as any).environment;
      expect(hello_world_environment.a_required_key).to.equal('some_value');
      expect(hello_world_environment.another_required_key).to.equal('required_value');
      expect(hello_world_environment.one_more_required_param).to.equal('one_more_value');
    })

  test
    .timeout(20000)
    .stub(ComponentBuilder, 'buildSpecFromPath', () => {
      return buildSpecFromYml(local_component_config_with_parameters)
    })
    .stub(Docker, 'verify', sinon.stub().returns(Promise.resolve()))
    .stub(Deploy.prototype, 'readSecretsFile', () => {
      return stacked_parameter_secrets;
    })
    .stub(Deploy.prototype, 'runCompose', sinon.stub().returns(undefined))
    .stdout({ print })
    .stderr({ print })
    .command(['deploy', '-l', './examples/hello-world/architect.yml', '-i', 'test:hello', '-s', './examples/hello-world/values.yml'])
    .it('Create a local deploy with a basic component and a stacked secrets file', ctx => {
      const runCompose = Deploy.prototype.runCompose as sinon.SinonStub;
      const hello_world_environment = (runCompose.firstCall.args[0].services[hello_api_ref] as any).environment;
      expect(hello_world_environment.a_required_key).to.equal('some_value');
      expect(hello_world_environment.another_required_key).to.equal('required_value');
      expect(hello_world_environment.one_more_required_param).to.equal('one_more_value');
    })

  test
    .timeout(20000)
    .stub(ComponentBuilder, 'buildSpecFromPath', () => {
      return buildSpecFromYml(yaml.dump(local_component_config_with_dependency))
    })
    .stub(Docker, 'verify', sinon.stub().returns(Promise.resolve()))
    .stub(Deploy.prototype, 'readSecretsFile', () => {
      return component_and_dependency_parameter_secrets;
    })
    .nock(MOCK_API_HOST, api => api
      .get(`/accounts/examples/components/react-app/versions/latest`)
      .reply(200, local_component_config_dependency))
    .stub(Deploy.prototype, 'runCompose', sinon.stub().returns(undefined))
    .stdout({ print })
    .stderr({ print })
    .command(['deploy', '-l', './examples/hello-world/architect.yml', '-i', 'test:hello', '-s', './examples/hello-world/values.yml'])
    .it('Create a local deploy with a basic component, a dependency, and a values file', ctx => {
      const runCompose = Deploy.prototype.runCompose as sinon.SinonStub;
      const hello_world_environment = (runCompose.firstCall.args[0].services[hello_api_ref] as any).environment;
      expect(hello_world_environment.a_required_key).to.equal('some_value');
      expect(hello_world_environment.another_required_key).to.equal('required_value');
      expect(hello_world_environment.one_more_required_param).to.equal('one_more_value');
    })

  test
    .timeout(20000)
    .stub(ComponentBuilder, 'buildSpecFromPath', () => {
      return buildSpecFromYml(yaml.dump(local_component_config_with_dependency))
    })
    .stub(Docker, 'verify', sinon.stub().returns(Promise.resolve()))
    .stub(Deploy.prototype, 'readSecretsFile', () => {
      return component_and_dependency_parameter_secrets;
    })
    .nock(MOCK_API_HOST, api => api
      .get(`/accounts/examples/components/react-app/versions/latest`)
      .reply(200, local_component_config_dependency))
    .stub(Deploy.prototype, 'runCompose', sinon.stub().returns(undefined))
    .stdout({ print })
    .stderr({ print })
    .command(['deploy', '-l', './examples/hello-world/architect.yml', '-i', 'test:hello', '-s', './examples/hello-world/values.yml', '-r'])
    .it('Create a local recursive deploy with a basic component, a dependency, and a values file', ctx => {
      const runCompose = Deploy.prototype.runCompose as sinon.SinonStub;
      const hello_world_environment = (runCompose.firstCall.args[0].services[hello_api_ref] as any).environment;
      const react_app_ref = resourceRefToNodeRef('examples/react-app/app:latest');
      const react_app_environment = (runCompose.firstCall.args[0].services[react_app_ref] as any).environment;
      expect(hello_world_environment.a_required_key).to.equal('some_value');
      expect(hello_world_environment.another_required_key).to.equal('required_value');
      expect(hello_world_environment.one_more_required_param).to.equal('one_more_value');
      expect(react_app_environment.WORLD_TEXT).to.equal('some other name');
    })

  test
    .timeout(20000)
    .stub(ComponentBuilder, 'buildSpecFromPath', () => {
      return buildSpecFromYml(local_component_config_with_parameters)
    })
    .stub(Deploy.prototype, 'readSecretsFile', () => {
      return basic_parameter_secrets;
    })
    .stub(Docker, 'verify', sinon.stub().returns(Promise.resolve()))
    .stub(Deploy.prototype, 'runCompose', sinon.stub().returns(undefined))
    .stdout({ print })
    .stderr({ print })
    .command(['deploy', '-l', './examples/hello-world/architect.yml', '-s', './examples/hello-world/values.yml'])
    .it('Dollar signs are escaped for environment variables in local compose deployments', ctx => {
      const runCompose = Deploy.prototype.runCompose as sinon.SinonStub;
      expect(runCompose.calledOnce).to.be.true;
      const hello_world_service = runCompose.firstCall.args[0].services[hello_api_ref] as any;
      expect(hello_world_service.environment.compose_escaped_variable).to.equal('variable_split_$$_with_dollar$$signs');
    })

  describe('linked deploy', function () {
    test
      .timeout(20000)
      .stub(ComponentBuilder, 'buildSpecFromPath', () => {
        return buildSpecFromYml(getHelloComponentConfig())
      })
      .stub(Docker, 'verify', sinon.stub().returns(Promise.resolve()))
      .stub(Deploy.prototype, 'runCompose', sinon.stub().returns(undefined))
      .stub(AppService.prototype, 'loadLinkedComponents', sinon.stub().returns({ 'examples/hello-world': './examples/hello-world/architect.yml' }))
      .stdout({ print })
      .stderr({ print })
      .command(['deploy', '-l', 'examples/hello-world:latest', '-i', 'hello'])
      .it('Create a local deploy with a component and an interface', ctx => {
        const runCompose = Deploy.prototype.runCompose as sinon.SinonStub;
        expect(runCompose.calledOnce).to.be.true
        expect(runCompose.firstCall.args[0]).to.deep.equal(component_expected_compose)
      })
  });

  describe('instance deploys', function () {
    const hello_api_instance_ref = resourceRefToNodeRef('examples/hello-world/api:latest@tenant-1');
    const expected_instance_compose = JSON.parse(JSON.stringify(component_expected_compose).replace(new RegExp(hello_api_ref, 'g'), hello_api_instance_ref));

    const local_deploy = test
      .timeout(20000)
      .stub(ComponentBuilder, 'buildSpecFromPath', () => {
        return buildSpecFromYml(getHelloComponentConfig())
      })
      .stub(Docker, 'verify', sinon.stub().returns(Promise.resolve()))
      .stub(AppService.prototype, 'loadLinkedComponents', sinon.stub().returns({ 'examples/hello-world': './examples/hello-world/architect.yml' }))
      .stdout({ print })
      .stderr({ print })

    local_deploy
      .stub(Deploy.prototype, 'runCompose', sinon.stub().returns(undefined))
      .command(['deploy', '-l', 'examples/hello-world@tenant-1', '-i', 'hello'])
      .it('Create a local deploy with instance id and no tag', ctx => {
        const runCompose = Deploy.prototype.runCompose as sinon.SinonStub;
        expect(runCompose.calledOnce).to.be.true
        expect(runCompose.firstCall.args[0]).to.deep.equal(expected_instance_compose)
      })

    local_deploy
      .stub(Deploy.prototype, 'runCompose', sinon.stub().returns(undefined))
      .command(['deploy', '-l', 'examples/hello-world:latest@tenant-1', '-i', 'hello'])
      .it('Create a local deploy with instance name and tag', ctx => {
        const runCompose = Deploy.prototype.runCompose as sinon.SinonStub;
        expect(runCompose.calledOnce).to.be.true
        expect(runCompose.firstCall.args[0]).to.deep.equal(expected_instance_compose)
      })

    local_deploy
      .stub(Deploy.prototype, 'runCompose', sinon.stub().returns(undefined))
      .stub(ComponentBuilder, 'buildSpecFromPath', () => {
        const hello_json = yaml.load(getHelloComponentConfig()) as any;
        hello_json.services.api.environment.SELF_URL = `\${{ ingresses['hello'].url }}`
        return buildSpecFromYml(yaml.dump(hello_json));
      })
      .stub(Deploy.prototype, 'readSecretsFile', () => {
        return {
          'examples/hello-world:latest@tenant-1': {
            'hello_ingress': 'hello-1'
          },
          'examples/hello-world:latest@tenant-2': {
            'hello_ingress': 'hello-2'
          }
        };
      })
      .command(['deploy', '-l', '-s', './examples/hello-world/values.yml', 'examples/hello-world@tenant-1', 'examples/hello-world@tenant-2'])
      .it('Create a local deploy with multiple instances of the same component', ctx => {
        const runCompose = Deploy.prototype.runCompose as sinon.SinonStub;
        expect(runCompose.calledOnce).to.be.true;

        const tenant_1_ref = resourceRefToNodeRef('examples/hello-world/api:latest@tenant-1');
        const tenant_2_ref = resourceRefToNodeRef('examples/hello-world/api:latest@tenant-2');

        const compose = runCompose.firstCall.args[0];
        expect(Object.keys(compose.services)).includes(tenant_1_ref, tenant_2_ref)
        expect(compose.services[tenant_1_ref].labels || []).includes(`traefik.http.routers.${tenant_1_ref}-hello.rule=Host(\`hello-1.arc.localhost\`)`)
        expect(compose.services[tenant_2_ref].labels || []).includes(`traefik.http.routers.${tenant_2_ref}-hello.rule=Host(\`hello-2.arc.localhost\`)`)
      })
  });

  describe('ingresses deploys', function () {
    test
      .timeout(20000)
      // @ts-ignore
      .stub(ComponentBuilder, 'buildSpecFromPath', (path: string) => {
        let config: string;
        if (path === './examples/react-app/architect.yml') {
          config = `
          name: examples/auth
          services:
            auth:
              interfaces:
                main: 8080
              environment:
                SELF_URL: \${{ ingresses.auth.url }} # is not auto-exposed
                OLD_SELF_URL: \${{ environment.ingresses['examples/auth'].auth.url }} # is not auto-exposed
          interfaces:
            auth: \${{ services.auth.interfaces.main.url }}
          `
        } else {
          config = `
          name: examples/app
          dependencies:
            examples/auth: latest
          services:
            app:
              interfaces:
                main: 8080
              environment:
                SELF_URL: \${{ ingresses.app.url }} # successfully auto-exposed as an ingress
                OLD_SELF_URL: \${{ environment.ingresses['examples/app'].app.url }} # successfully auto-exposed as an ingress
                DEPENDENCY_URL: \${{ dependencies['examples/auth'].ingresses.auth.url }} # is not auto-exposed
          interfaces:
            app: \${{ services.app.interfaces.main.url }}
          `
        }
        return buildSpecFromYml(config)
      })
      .stub(Docker, 'verify', sinon.stub().returns(Promise.resolve()))
      .stub(AppService.prototype, 'loadLinkedComponents', sinon.stub().returns({
        'examples/app': './examples/hello-world/architect.yml',
        'examples/auth': './examples/react-app/architect.yml'
      }))
      .stdout({ print })
      .stderr({ print })
      .stub(Deploy.prototype, 'runCompose', sinon.stub().returns(undefined))
      .command(['deploy', '-l', 'examples/app'])
      .it('Deploy component with dependency with ingresses', ctx => {
        const runCompose = Deploy.prototype.runCompose as sinon.SinonStub;
        expect(runCompose.calledOnce).to.be.true
        const compose = runCompose.firstCall.args[0];
        const app_ref = resourceRefToNodeRef('examples/app/app:latest');
        expect(compose.services[app_ref].labels).includes('traefik.enable=true');
        const auth_ref = resourceRefToNodeRef('examples/auth/auth:latest');
        expect(compose.services[auth_ref].labels).includes('traefik.enable=true');
      })
  });
});

describe('remote deploy environment', function () {
  const remoteDeploy = mockArchitectAuth
    .stub(Docker, 'verify', sinon.stub().returns(Promise.resolve()))
    .stub(PipelineUtils, 'pollPipeline', async () => mock_pipeline)
    .nock(MOCK_API_HOST, api => api
      .get(`/accounts/${account.name}`)
      .reply(200, account))
    .nock(MOCK_API_HOST, api => api
      .get(`/accounts/${account.id}/environments/${environment.name}`)
      .reply(200, environment))
    .nock(MOCK_API_HOST, api => api
      .post(`/environments/${environment.id}/deploy`)
      .reply(200, mock_pipeline))
    .nock(MOCK_API_HOST, api => api
      .post(`/pipelines/${mock_pipeline.id}/approve`)
      .reply(200, {}))
    .stdout({ print })
    .stderr({ print })

  remoteDeploy
    .command(['deploy', '-e', environment.name, '-a', account.name, '--auto-approve', 'examples/echo:latest'])
    .it('Creates a remote deployment when env exists with env and account flags', ctx => {
      expect(ctx.stdout).to.contain('Deployed');
    })

  describe('instance deploys', function () {
    remoteDeploy
      .command(['deploy', '-e', environment.name, '-a', account.name, '--auto-approve', 'examples/echo:latest@tenant-1'])
      .it('Creates a remote deployment when env exists with env and account flags', ctx => {
        expect(ctx.stdout).to.contain('Deployed')
      })
  });
});

describe('auto-approve flag with underscore style still works', function () {
  const remoteDeploy = mockArchitectAuth
    .stub(Docker, 'verify', sinon.stub().returns(Promise.resolve()))
    .stub(PipelineUtils, 'pollPipeline', async () => mock_pipeline)
    .nock(MOCK_API_HOST, api => api
      .get(`/accounts/${account.name}`)
      .reply(200, account))
    .nock(MOCK_API_HOST, api => api
      .get(`/accounts/${account.id}/environments/${environment.name}`)
      .reply(200, environment))
    .nock(MOCK_API_HOST, api => api
      .post(`/environments/${environment.id}/deploy`)
      .reply(200, mock_pipeline))
    .nock(MOCK_API_HOST, api => api
      .post(`/pipelines/${mock_pipeline.id}/approve`)
      .reply(200, {}))
    .stdout({ print })
    .stderr({ print })

  remoteDeploy
    .command(['deploy', '-e', environment.name, '-a', account.name, '--auto_approve', 'examples/echo:latest'])
    .it('works but also emits a deprication warning', ctx => {
      expect(ctx.stderr).to.contain('Flag --auto_approve is deprecated.');
      expect(ctx.stdout).to.contain('Deployed');
    });
});

describe('pollPipeline handles failed deployments', () => {
  let randomId = () => (Math.random() + 1).toString(36).substring(2);

  const mock_platform = {
    id: randomId(),
    name: 'my-mocked-platform',
    account,
  }
  const failed_pipeline = {
    id: mock_pipeline.id,
    failed_at: new Date(),
    environment,
    platform: mock_platform,
  };
  const aborted_deployment = {
    id: randomId(),
    aborted_at: new Date(),
    pipeline: failed_pipeline,
  };
  const failed_environment_deployment = {
    id: randomId(),
    failed_at: new Date(),
    pipeline: {
      ...failed_pipeline,
      platform: undefined,
    },
  };
  const failed_environment_deployment_2 = {
    ...failed_environment_deployment,
    id: randomId(),
  }
  const failed_platform_deployment = {
    id: randomId(),
    failed_at: new Date(),
    pipeline: {
      ...failed_pipeline,
      environment: undefined,
    },
  };

  const baseRemoteDeploy = mockArchitectAuth
    .stub(Docker, 'verify', sinon.stub().returns(Promise.resolve()))
    .stub(PipelineUtils, 'awaitPipeline', sinon.stub().resolves({ pipeline: failed_pipeline }))
    .nock(MOCK_API_HOST, api => api
      .get(`/accounts/${account.name}`)
      .reply(200, account))
    .nock(MOCK_API_HOST, api => api
      .get(`/accounts/${account.id}/environments/${environment.name}`)
      .reply(200, environment))
    .nock(MOCK_API_HOST, api => api
      .post(`/environments/${environment.id}/deploy`)
      .reply(200, mock_pipeline))
    .nock(MOCK_API_HOST, api => api
      .post(`/pipelines/${mock_pipeline.id}/approve`)
      .reply(200, {}));

  baseRemoteDeploy
    .stub(Deploy.prototype, 'warn', sinon.fake.returns(null))
    .nock(MOCK_API_HOST, api => api
      .get(`/pipelines/${mock_pipeline.id}/deployments`)
      .reply(200, [aborted_deployment]))
    .stdout({ print })
    .stderr({ print })
    .command(['deploy', '-e', environment.name, '-a', account.name, '--auto-approve', 'examples/echo:latest'])
    .it('when deployment is aborted it prints useful error with expected url', (ctx) => {
      const message = `Deployment ${aborted_deployment.id} was aborted. See the deployment log for more details:`;
      const link = `${app_host}/${account.name}/environments/${aborted_deployment.pipeline.environment.name}/deployments/${aborted_deployment.id}`;
      const expected_error = `${message}\n${link}`
      expect((Deploy.prototype.warn as SinonSpy).getCalls().length).to.equal(1);
      expect((Deploy.prototype.warn as SinonSpy).firstCall.args[0]).to.equal(expected_error);
    });

  baseRemoteDeploy
    .stub(Deploy.prototype, 'warn', sinon.fake.returns(null))
    .nock(MOCK_API_HOST, api => api
      .get(`/pipelines/${mock_pipeline.id}/deployments`)
      .reply(200, [failed_environment_deployment]))
    .stdout({ print })
    .stderr({ print })
    .command(['deploy', '-e', environment.name, '-a', account.name, '--auto-approve', 'examples/echo:latest'])
    .it('when environment deployment fails it prints useful error with expected url', ctx => {
      const message = `Pipeline ${mock_pipeline.id} failed because 1 deployment failed:`;
      const link = `- ${app_host}/${account.name}/environments/${failed_environment_deployment.pipeline.environment!.name}/deployments/${failed_environment_deployment.id}`;
      const expected_error = `${message}\n${link}`
      expect((Deploy.prototype.warn as SinonSpy).getCalls().length).to.equal(1);
      expect((Deploy.prototype.warn as SinonSpy).firstCall.args[0]).to.equal(expected_error);
    });

  baseRemoteDeploy
    .stub(Deploy.prototype, 'warn', sinon.fake.returns(null))
    .nock(MOCK_API_HOST, api => api
      .get(`/pipelines/${mock_pipeline.id}/deployments`)
      .reply(200, [failed_platform_deployment]))
    .stdout({ print })
    .stderr({ print })
    .command(['deploy', '-e', environment.name, '-a', account.name, '--auto-approve', 'examples/echo:latest'])
    .it('when pipeline deployment fails it prints useful error with expected url', ctx => {
      const message = `Pipeline ${mock_pipeline.id} failed because 1 deployment failed:`;
      const link = `- ${app_host}/${account.name}/platforms/${failed_platform_deployment.pipeline.platform!.name}`;
      const expected_error = `${message}\n${link}`
      expect((Deploy.prototype.warn as SinonSpy).getCalls().length).to.equal(1);
      expect((Deploy.prototype.warn as SinonSpy).firstCall.args[0]).to.equal(expected_error);
    });

  baseRemoteDeploy
    .stub(Deploy.prototype, 'warn', sinon.fake.returns(null))
    .nock(MOCK_API_HOST, api => api
      .get(`/pipelines/${mock_pipeline.id}/deployments`)
      .reply(200, [failed_environment_deployment, failed_environment_deployment_2]))
    .stdout({ print })
    .stderr({ print })
    .command(['deploy', '-e', environment.name, '-a', account.name, '--auto-approve', 'examples/echo:latest'])
    .it('when multiple pipeline deployments fail it prints useful error with expected urls', ctx => {
      const message = `Pipeline ${mock_pipeline.id} failed because 2 deployments failed:`;
      const link1 = `- ${app_host}/${account.name}/environments/${failed_environment_deployment.pipeline.environment.name}/deployments/${failed_environment_deployment.id}`;
      const link2 = `- ${app_host}/${account.name}/environments/${failed_environment_deployment_2.pipeline.environment.name}/deployments/${failed_environment_deployment_2.id}`;
      const expected_error = `${message}\n${link1}\n${link2}`
      expect((Deploy.prototype.warn as SinonSpy).getCalls().length).to.equal(1);
      expect((Deploy.prototype.warn as SinonSpy).firstCall.args[0]).to.equal(expected_error);
    });

  baseRemoteDeploy
    .stub(PipelineUtils, 'awaitPipeline', sinon.stub().resolves({ poll_timeout: true }))
    .stub(Deploy.prototype, 'warn', sinon.fake.returns(null))
    .stdout({ print })
    .stderr({ print })
    .command(['deploy', '-e', environment.name, '-a', account.name, '--auto-approve', 'examples/echo:latest'])
    .it('when polling times out it prints expected message', ctx => {
      const expected_error = 'Timeout while polling the pipeline'
      expect((Deploy.prototype.warn as SinonSpy).getCalls().length).to.equal(1);
      expect((Deploy.prototype.warn as SinonSpy).firstCall.args[0]).to.equal(expected_error);
    });
});
