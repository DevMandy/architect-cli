import { expect } from 'chai';
import PipelineUtils from '../../src/architect/pipeline/pipeline.utils';
import { mockArchitectAuth, MOCK_API_HOST } from '../utils/mocks';

describe('destroy', function () {

  // set to true while working on tests for easier debugging; otherwise oclif/test eats the stdout/stderr
  const print = false;

  const mock_account = {
    id: 'test-account-id',
    name: 'test-account'
  }

  const mock_env = {
    id: 'test-env-id',
    name: 'test-env'
  }

  const mock_pipeline = {
    id: 'test-pipeline-id'
  }

  mockArchitectAuth
    .stub(PipelineUtils, 'pollPipeline', async () => null)
    .nock(MOCK_API_HOST, api => api
      .get(`/accounts/${mock_account.name}`)
      .reply(200, mock_account))
    .nock(MOCK_API_HOST, api => api
      .get(`/accounts/${mock_account.id}/environments/${mock_env.name}`)
      .reply(200, mock_env))
    .nock(MOCK_API_HOST, api => api
      .delete(`/environments/${mock_env.id}/instances`)
      .reply(200, mock_pipeline))
    .nock(MOCK_API_HOST, api => api
      .post(`/pipelines/${mock_pipeline.id}/approve`)
      .reply(200, {}))
    .stdout({ print })
    .stderr({ print })
    .timeout(20000)
    .command(['destroy', '-a', mock_account.name, '-e', mock_env.name, '--auto-approve'])
    .it('destroy completes', ctx => {
      expect(ctx.stdout).to.contain('Deployed\n')
    });
});
