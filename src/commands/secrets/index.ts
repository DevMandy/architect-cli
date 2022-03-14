import Account from '../../architect/account/account.entity';
import AccountUtils from '../../architect/account/account.utils';
import Command from '../../base-command';
import {EnvironmentUtils} from "../../architect/environment/environment.utils";
import yaml from 'js-yaml';

export default class SecretsGet extends Command {
  async auth_required(): Promise<boolean> {
    return true;
  }

  static aliases = ['secrets:get'];
  static description = 'Get secrets for a specified account and environment';

  static flags = {
    ...AccountUtils.flags,
    ...EnvironmentUtils.flags,
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(SecretsGet);

    const account: Account = await AccountUtils.getAccount(this.app, flags.account);
    const environment = await EnvironmentUtils.getEnvironment(this.app.api, account, flags.environment);

    const { data: secrets } = await this.app.api.get(`/environments/${environment.id}/secrets/values`);
    this.log(yaml.dump(secrets));
  }
}

