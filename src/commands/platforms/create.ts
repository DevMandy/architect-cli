import { flags } from '@oclif/command';
import chalk from 'chalk';
import { cli } from 'cli-ux';
import inquirer from 'inquirer';
import Command from '../../base-command';
import { AccountUtils } from '../../common/utils/account';
import { EcsPlatformUtils } from '../../common/utils/ecs-platform.utils';
import { KubernetesPlatformUtils } from '../../common/utils/kubernetes-platform.utils';
import { PipelineUtils } from '../../common/utils/pipeline';
import { CreatePlatformInput } from '../../common/utils/platform';
import { Slugs } from '../../dependency-manager/src';

export default class PlatformCreate extends Command {
  static aliases = ['platform:create', 'platforms:create'];
  static description = 'Register a new platform with Architect Cloud';

  static args = [{
    name: 'platform',
    description: 'Name to give the platform',
    parse: (value: string) => value.toLowerCase(),
  }];

  static flags = {
    ...Command.flags,
    ...AccountUtils.flags,
    type: flags.string({ char: 't', options: ['KUBERNETES', 'kubernetes', 'ECS', 'ecs'] }),
    host: flags.string({ char: 'h' }),
    kubeconfig: flags.string({ char: 'k', default: '~/.kube/config', exclusive: ['service_token', 'cluster_ca_cert', 'host'] }),
    aws_key: flags.string({ exclusive: ['awsconfig', 'kubeconfig', 'service_token', 'cluster_ca_cert', 'host'] }),
    aws_secret: flags.string({ exclusive: ['awsconfig', 'kubeconfig', 'service_token', 'cluster_ca_cert', 'host'] }),
    aws_region: flags.string({ exclusive: ['awsconfig', 'kubeconfig', 'service_token', 'cluster_ca_cert', 'host'] }),
    service_token: flags.string({ description: 'Service token', env: 'ARCHITECT_SERVICE_TOKEN' }),
    cluster_ca_cert: flags.string({ description: 'File path of cluster_ca_cert', env: 'ARCHITECT_CLUSTER_CA_CERT' }),
  };

  async run() {
    const platform = await this.create_platform();
    const platform_url = `${this.app.config.app_host}/${platform.account.name}/platforms/`;
    this.log(chalk.green(`Platform created: ${platform_url}`));
  }

  private async create_platform() {
    const { args, flags } = this.parse(PlatformCreate);

    const answers: any = await inquirer.prompt([
      {
        type: 'input',
        name: 'platform',
        message: 'What would you like to name your new platform?',
        when: !args.platform,
        filter: value => value.toLowerCase(),
        validate: value => {
          if (Slugs.ArchitectSlugValidator.test(value)) return true;
          return `platform ${Slugs.ArchitectSlugDescription}`;
        },
      },
    ]);

    const platform_name = args.platform || answers.platform;
    if (!Slugs.ArchitectSlugValidator.test(platform_name)) {
      throw new Error(`platform ${Slugs.ArchitectSlugDescription}`);
    }

    const account = await AccountUtils.getAccount(this.app.api, flags.account, 'Select an account to register the platform with');

    const platform = await this.create_architect_platform(flags);
    const platform_dto = { name: platform_name, ...platform };

    cli.action.start('Registering platform with Architect');
    const created_platform = await this.post_platform_to_api(platform_dto, account.id);
    cli.action.stop();

    this.log(`Hang tight! We're completing the setup of your platform by installing applications that will broker networking. This could take as long as 15m, so feel free to grab a cup of coffee while you wait.`);
    this.log(`Logs here: ${this.app.config.app_host}/examples/platforms/new?platform_id=${created_platform.id}`);
    cli.action.start(chalk.blue('Installing platform applications'));
    const pipeline_id = await this.create_platform_applications(account.id, created_platform.id);
    await PipelineUtils.pollPipeline(this.app.api, pipeline_id);
    cli.action.stop();

    return created_platform;
  }

  async create_architect_platform(flags: any) {
    const platform_type_answers: any = await inquirer.prompt([
      {
        when: !flags.type,
        type: 'list',
        name: 'platform_type',
        message: 'What type of platform would you like to register?',
        choices: [
          'kubernetes',
          'ecs',
        ],
      },
    ]);

    const selected_type = (flags.type || platform_type_answers.platform_type).toLowerCase();

    switch (selected_type) {
      case 'kubernetes':
        return await KubernetesPlatformUtils.configure_kubernetes_platform(flags);
      case 'ecs':
        return await EcsPlatformUtils.configure_ecs_platform(flags);
      case 'architect':
        throw new Error(`You cannot create an Architect platform from the CLI. One Architect platform is registered by default per account.`);
      default:
        throw new Error(`PlatformType=${selected_type} is not currently supported`);
    }
  }

  async create_platform_applications(account_id: string, platform_id: string): Promise<any> {
    const { data: deployment } = await this.app.api.post(`/platforms/${platform_id}/apps`);
    return deployment.pipeline.id;
  }

  async post_platform_to_api(dto: CreatePlatformInput, account_id: string): Promise<any> {
    const { data: platform } = await this.app.api.post(`/accounts/${account_id}/platforms`, dto);
    return platform;
  }
}
