import { Flags } from '@oclif/core';
import chalk from 'chalk';
import inquirer from 'inquirer';
import AppService from '../../app-config/service';
import Account from './account.entity';

export default class AccountUtils {
  static flags = {
    account: Flags.string({
      description: 'Architect account',
      env: 'ARCHITECT_ACCOUNT',
      char: 'a',
      parse: async value => value.toLowerCase(),
    }),
  };

  static getLocalAccount(): Account {
    // Account ids are UUID so there is no chance of collision
    return {
      id: 'dev',
      name: 'dev (Local Machine)',
    };
  }

  static isLocalAccount(account: Account): boolean {
    return account.id === "dev";
  }

  static async getAccount(app: AppService, account_name?: string, options?: { account_message?: string, ask_local_account?: boolean }): Promise<Account> {
    const config_account = app.config.defaultAccount();
    // Set the account name from the config only if an account name wasn't set as cli flag
    if (config_account && !account_name && !options?.ask_local_account) {
      account_name = config_account;
    }

    if (process.env.ARCHITECT_ACCOUNT === account_name && process.env.ARCHITECT_ACCOUNT) {
      console.log(chalk.blue(`Using account from environment variables: `) + account_name);
    }

    if (!account_name && !options?.ask_local_account) {
      const { data: user_data } = await app.api.get('/users/me');
      if (user_data.memberships?.length === 1) { // if user only has one account, use it by default
        return user_data.memberships[0].account;
      }
    }

    let account: Account;
    if (account_name) {
      account = (await app.api.get(`/accounts/${account_name}`)).data;
      if (!account) {
        throw new Error(`Could not find account=${account_name}`);
      }
    } else {
      inquirer.registerPrompt('autocomplete', require('inquirer-autocomplete-prompt'));
      const answers: { account: Account } = await inquirer.prompt([
        {
          type: 'autocomplete',
          name: 'account',
          message: options?.account_message || 'Select an account',
          filter: (x) => x, // api filters
          source: async (answers_so_far: any, input: string) => {
            const { data } = await app.api.get('/accounts', { params: { q: input, limit: 10 } });
            const accounts = data.rows as Account[];
            if (options?.ask_local_account) {
              accounts.unshift(this.getLocalAccount());
            }
            return accounts.map((a) => ({ name: a.name, value: a }));
          },
        },
      ]);
      account = answers.account;
      if (!account) {
        throw new Error(`Could not find account=${answers.account}`);
      }
    }
    return account;
  }
}
