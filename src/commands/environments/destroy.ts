import { flags } from '@oclif/command';
import chalk from 'chalk';
import { cli } from 'cli-ux';
import inquirer from 'inquirer';
import Command from '../../base-command';
import { AccountUtils } from '../../common/utils/account';
import { EnvironmentUtils } from '../../common/utils/environment';

export default class EnvironmentDestroy extends Command {
  static aliases = ['environment:destroy', 'envs:destroy', 'env:destroy'];
  static description = 'Destroy an environment';

  static flags = {
    ...Command.flags,
    ...AccountUtils.flags,
    auto_approve: flags.boolean({
      description: 'Automatically apply the changes',
      default: false,
    }),
    force: flags.boolean({
      description: 'Force the deletion even if the environment is not empty',
      char: 'f',
      default: false,
    }),
  };

  static args = [{
    name: 'environment',
    description: 'Name of the environment to destroy',
    parse: (value: string) => value.toLowerCase(),
  }];

  async run() {
    const { args, flags } = this.parse(EnvironmentDestroy);

    if (!flags.account && await this.destroyLocal(args.environment, flags.auto_approve)) {
      this.log(chalk.green('Local environment destroyed'));
      return;
    }

    const account = await AccountUtils.getAccount(this.app.api, flags.account);
    const environment = await EnvironmentUtils.getEnvironment(this.app.api, account, args.environment);

    let answers = await inquirer.prompt([{
      type: 'input',
      name: 'destroy',
      message: 'Are you absolutely sure? This will destroy the environment.\nPlease type in the name of the environment to confirm.\n',
      validate: (value: any, answers: any) => {
        if (value === environment.name) {
          return true;
        }
        return `Name must match: ${chalk.blue(environment.name)}`;
      },
      when: !flags.auto_approve,
    }]);

    cli.action.start(chalk.blue('Destroying environment'));
    answers = { ...args, ...flags, ...answers };
    const { data: account_environment } = await this.app.api.get(`/accounts/${account.id}/environments/${environment.name}`);

    await this.app.api.delete(`/environments/${account_environment.id}`, {
      params: {
        force: answers.force ? 1 : 0,
      },
    });
    cli.action.stop();
    this.log(chalk.green('Environment destroyed'));
  }

  private async destroyLocal(environment_name: string, auto_approve: boolean): Promise<boolean> {
    const local_environments = this.app.getAllLocalEnvironments();
    if (!Object.keys(local_environments).includes(environment_name)) {
      return false;
    }

    await inquirer.prompt([{
      type: 'input',
      name: 'destroy',
      message: 'Are you absolutely sure? This will destroy the environment.\nPlease type in the name of the environment to confirm.\n',
      validate: (value: any, answers: any) => {
        if (value === environment_name) {
          return true;
        }
        return `Name must match: ${chalk.blue(environment_name)}`;
      },
      when: !auto_approve,
    }]);

    this.app.setLocalEnvironment(environment_name, undefined);
    return true;
  }
}
