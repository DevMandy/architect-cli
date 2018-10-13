export interface ServiceEnvironment {
  host: string;
  port: number;
}

export default interface DeploymentConfig {
  [service_name: string]: ServiceEnvironment;
}
