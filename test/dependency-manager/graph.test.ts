import { expect } from '@oclif/test';
import axios from 'axios';
import yaml from 'js-yaml';
import nock from 'nock';
import LocalDependencyManager from '../../src/common/dependency-manager/local-manager';

describe('graph', () => {

  it('graph without interpolation', async () => {
    const component_config = `
      name: architect/component

      dependencies:
        architect/dependency: latest
        architect/missing-dependency: latest

      parameters:
        MYSQL_DATABASE:
          required: true

      interfaces:
        db: \${{ services.db.interfaces.mysql.url }}

      services:
        db:
          image: mysql:5.6.35
          command: mysqld
          interfaces:
            mysql:
              port: 3306
              protocol: mysql

        core:
          environment:
            ADDR: \${{ ingresses.db.url }}
            DEP_ADDR: \${{ dependencies.architect/dependency.interfaces.db.url }}
            DEP_INGRESS_ADDR: \${{ dependencies.architect/dependency.ingresses.db.url }}
            DEP_MISSING_ADDR: \${{ dependencies.architect/missing-dependency.interfaces.db.url }}
            DEP_MISSING_INGRESS_ADDR: \${{ dependencies.architect/missing-dependency.ingresses.db.url }}
    `;

    const dependency_config = `
      name: architect/dependency

      parameters:
        MYSQL_DATABASE:
          required: true

      interfaces:
        db: \${{ services.db.interfaces.mysql.url }}

      services:
        db:
          image: mysql:5.6.35
          command: mysqld
          interfaces:
            mysql:
              port: 3306
              protocol: mysql

        core:
          environment:
            ADDR: \${{ ingresses.db.url }}
    `;

    nock('http://localhost').get('/accounts/architect/components/component/versions/latest')
      .reply(200, { tag: 'latest', config: yaml.load(component_config), service: { url: 'architect/component:latest' } });

    nock('http://localhost').get('/accounts/architect/components/dependency/versions/latest')
      .reply(200, { tag: 'latest', config: yaml.load(dependency_config), service: { url: 'architect/dependency:latest' } });

    const manager = new LocalDependencyManager(axios.create());

    const graph = await manager.getGraph([
      await manager.loadComponentSpec('architect/component:latest'),
      await manager.loadComponentSpec('architect/dependency:latest', { interfaces: { db2: 'db' } })
    ], {}, false);

    expect(graph.nodes).to.have.length(7);
    expect(graph.edges).to.have.length(5);
  });

  it('graph without validation', async () => {
    const component_config = `
      name: architect/component

      dependencies:
        architect/dependency: latest

      parameters:
        external_host:

      services:
        db:
          interfaces:
            main:
              port: 5432
              host: \${{ parameters.external_host }}
          environment:
            OTHER_DB_ADDR: \${{ dependencies.architect/dependency.interfaces.db.url }}
    `;

    const dependency_config = `
      name: architect/dependency

      parameters:
        external_host:

      interfaces:
        db: \${{ services.db.interfaces.mysql.url }}

      services:
        db:
          interfaces:
            mysql:
              port: 3306
              protocol: mysql
              host: \${{ parameters.external_host }}
    `;

    nock('http://localhost').get('/accounts/architect/components/component/versions/latest')
      .reply(200, { tag: 'latest', config: yaml.load(component_config), service: { url: 'architect/component:latest' } });

    nock('http://localhost').get('/accounts/architect/components/dependency/versions/latest')
      .reply(200, { tag: 'latest', config: yaml.load(dependency_config), service: { url: 'architect/dependency:latest' } });

    const manager = new LocalDependencyManager(axios.create());

    const graph = await manager.getGraph([
      await manager.loadComponentSpec('architect/component:latest'),
      await manager.loadComponentSpec('architect/dependency:latest')
    ], {}, true, false);

    expect(graph.nodes).to.have.length(3);
    expect(graph.edges).to.have.length(2);
  });
});
