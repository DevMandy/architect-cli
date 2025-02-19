import { expect, test } from '@oclif/test';
import sinon from 'sinon';
import CredentialManager from '../../src/app-config/credentials';
import * as Docker from '../../src/common/utils/docker';

describe('logout', () => {
  // set to true while working on tests for easier debugging; otherwise oclif/test eats the stdout/stderr
  const print = false;

  describe('deletes local credentails', () => {
    const credential_spy = sinon.fake.returns(null);

    test
      .timeout(20000)
      .stub(Docker, 'verify', sinon.stub().returns(Promise.resolve()))
      .stub(CredentialManager.prototype, 'delete', credential_spy)
      .stderr({ print })
      .command(['logout'])
      .it('delete is called with expected params', () => {
        expect(credential_spy.getCalls().length).to.equal(1);
        expect(credential_spy.firstCall.args[0]).to.equal('architect.io/token');
      });
  });
});
