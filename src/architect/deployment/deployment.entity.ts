import { Dictionary } from '../../dependency-manager/src';
import Account from '../account/account.entity';
import Pipeline from '../pipeline/pipeline.entity';

export default interface Deployment {
  id: string;
  instance_id: string;
  applied_at?: string;
  failed_at?: string;
  aborted_at?: string;
  type: string;
  metadata: {
    instance_name?: string;
  }
  component_version: {
    name: string;
    tag: string;
    component: {
      name: string;
      account: Account;
    };
    config: {
      name: string;
      services?: Dictionary<any>
    };
  };
  pipeline: Pipeline;
}
