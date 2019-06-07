import * as dotenv from 'dotenv';
import * as Joi from 'joi';

const CONFIG_SCHEMA: Joi.ObjectSchema = Joi.object({
  OAUTH_DOMAIN: Joi
    .string()
    .hostname()
    .default('architect.auth0.com'),
  OAUTH_CLIENT_ID: Joi
    .string()
    .default('lIpW9fq9IFQBBjTgllhN6EI01TXMhRVm'),
  DEFAULT_REGISTRY_HOST: Joi
    .string()
    .uri()
    .default('registry.architect.io'),
  API_HOST: Joi
    .string()
    .uri()
    .default('https://api.architect.io')
});

const validate_config = (
  input_config: { [key: string]: any },
): { [key: string]: string } => {
  const { error, value: validatedEnvConfig } = Joi.validate(
    input_config,
    CONFIG_SCHEMA,
    { stripUnknown: true },
  );
  if (error) {
    throw new Error(`Config validation error: ${error.message}`);
  }
  return validatedEnvConfig;
};

export class AppConfig {
  readonly oauth_domain: string;
  readonly oauth_client_id: string;
  readonly default_registry_host: string;
  readonly api_host: string;

  constructor() {
    // Load environment params from a .env file if found
    dotenv.config();

    const app_env = validate_config(process.env);
    this.oauth_domain = app_env.OAUTH_DOMAIN;
    this.oauth_client_id = app_env.OAUTH_CLIENT_ID;
    this.default_registry_host = app_env.DEFAULT_REGISTRY_HOST;
    this.api_host = app_env.API_HOST;
  }
}
