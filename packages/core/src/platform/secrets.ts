export interface SecretsPlatform {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

export type SecretsAdapter = SecretsPlatform;
