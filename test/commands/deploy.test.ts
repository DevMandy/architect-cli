import { expect } from '@oclif/test';
import sinon, { SinonSpy } from 'sinon';
import PipelineUtils from '../../src/architect/pipeline/pipeline.utils';
import Deploy from '../../src/commands/deploy';
import * as Docker from '../../src/common/utils/docker';
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
