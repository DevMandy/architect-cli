import { CliUx, Flags, Interfaces } from '@oclif/core';
import chalk from 'chalk';
import inquirer from 'inquirer';
import AccountUtils from '../../architect/account/account.utils';
import { EnvironmentUtils } from '../../architect/environment/environment.utils';
import Command from '../../base-command';

export default class EnvironmentDestroy extends Command {
  static aliases = ['environment:destroy', 'envs:destroy', 'env:destroy', 'env:deregister', 'environment:deregister'];
  static description = 'Deregister an environment';

  static flags = {
    ...Command.flags,
    ...AccountUtils.flags,
    auto_approve: Flags.boolean({
      description: `${Command.DEPRECATED} Please use --auto-approve.`,
      hidden: true,
    }),
    ['auto-approve']: Flags.boolean({
      description: 'Automatically apply the changes',
      default: false,
    }),
    force: Flags.boolean({
      description: 'Force the deletion even if the environment is not empty',
      char: 'f',
      default: false,
    }),
  };

  static args = [{
    name: 'environment',
    description: 'Name of the environment to deregister',
    parse: async (value: string): Promise<string> => value.toLowerCase(),
  }];

  protected async parse<F, A extends {
    [name: string]: any;
  }>(options?: Interfaces.Input<F>, argv = this.argv): Promise<Interfaces.ParserOutput<F, A>> {
    const parsed = await super.parse(options, argv) as Interfaces.ParserOutput<F, A>;
    const flags: any = parsed.flags;

    // Merge any values set via deprecated flags into their supported counterparts
    flags['auto-approve'] = flags.auto_approve ? flags.auto_approve : flags['auto-approve'];
    parsed.flags = flags;

    return parsed;
  }

  async run(): Promise<void> {
    const { args, flags } = await this.parse(EnvironmentDestroy);

    const account = await AccountUtils.getAccount(this.app, flags.account);
    const environment = await EnvironmentUtils.getEnvironment(this.app.api, account, args.environment);

    let answers = await inquirer.prompt([{
      type: 'input',
      name: 'destroy',
      message: 'Are you absolutely sure? This will deregister the environment.\nPlease type in the name of the environment to confirm.\n',
      validate: (value: any, answers: any) => {
        if (value === environment.name) {
          return true;
        }
        return `Name must match: ${chalk.blue(environment.name)}`;
      },
      when: !flags['auto-approve'],
    }]);

    CliUx.ux.action.start(chalk.blue('Deregistering environment'));
    answers = { ...args, ...flags, ...answers };
    const { data: account_environment } = await this.app.api.get(`/accounts/${account.id}/environments/${environment.name}`);

    await this.app.api.delete(`/environments/${account_environment.id}`, {
      params: {
        force: answers.force ? 1 : 0,
      },
    });
    CliUx.ux.action.stop();
    this.log(chalk.green('Environment deregistered'));
  }
}
