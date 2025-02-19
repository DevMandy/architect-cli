import Account from '../../architect/account/account.entity';
import AccountUtils from '../../architect/account/account.utils';
import Command from '../../base-command';
import Table from '../../base-table';
import localizedTimestamp from '../../common/utils/localized-timestamp';

interface Component {
  created_at: string;
  updated_at: string;
  name: string;
  metadata: {
    tag_count: number;
  };
  account: Account;
}

export default class Components extends Command {
  static aliases = ['components', 'components:search', 'component:search', 'component:search'];
  static description = 'Search components you have access to';

  static flags = {
    ...Command.flags,
    ...AccountUtils.flags,
  };

  static args = [{
    name: 'query',
    description: 'Search term used to filter the results',
  }];

  async run(): Promise<void> {
    const { args, flags } = await this.parse(Components);

    let account: Account | undefined = undefined;
    if (flags.account) {
      account = await AccountUtils.getAccount(this.app, flags.account);
    }

    const params = {
      q: args.query || '',
      account_id: account?.id,
    };

    let { data: { rows: components } } = await this.app.api.get(`/components`, { params });
    components = components.filter((c: Component) => c.account);

    if (!components.length) {
      if (args.query) {
        this.log(`No components found matching ${args.query}.`);
      } else {
        this.log('You have not registered any components yet. Use `architect register` to set up your first one.');
      }
      return;
    }

    const table = new Table({ head: ['Name', 'Account', 'Versions', 'Created', 'Updated'] });
    for (const component of components.sort((c1: Component, c2: Component) => c1.name.localeCompare(c2.name))) {
      table.push([
        component.name,
        component.account.name,
        component.metadata.tag_count,
        localizedTimestamp(component.created_at),
        localizedTimestamp(component.updated_at),
      ]);
    }

    this.log(table.toString());
  }
}
