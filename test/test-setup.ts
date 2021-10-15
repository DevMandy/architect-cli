process.env.CI = 'true'
import CredentialManager from '../src/app-config/credentials';
import PromptUtils from '../src/common/utils/prompt-utils';

PromptUtils.disable_prompts();

for (const env_key of Object.keys(process.env)) {
  if (env_key.startsWith('ARC_')) {
    delete process.env[env_key];
  }
}
process.env.ARCHITECT_CONFIG_DIR = './test'
process.env.NODE_ENV = 'test'

CredentialManager.prototype.get = async (service: string) => {
  return {
    account: 'test',
    password: '{}'
  }
}
