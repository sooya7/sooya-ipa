import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const pluginSource = (name: string) =>
  readFileSync(path.resolve(`../../ios/App/App/Plugins/${name}`), 'utf8');

describe('SOOYA native keychain contract', () => {
  it('uses the signing identity default access group instead of probing or pinning one', () => {
    const secrets = pluginSource('SOOYASecretsPlugin.swift');
    expect(secrets).not.toContain('SOOYAKeychainAccessGroupResolver');
    expect(secrets).not.toContain('identity.accessGroup');
    expect(secrets).not.toContain('kSecAttrAccessGroup as String: identity');
    expect(secrets).toContain('static let service = "com.sooya.app.secrets.v1"');
  });

  it('keeps every native secret consumer on the signing-safe default store', () => {
    for (const file of [
      'SOOYAHttpPlugin.swift',
      'SOOYAMcpPlugin.swift',
      'SOOYAWebSocketPlugin.swift'
    ]) {
      const swift = pluginSource(file);
      expect(swift).not.toContain('SOOYAKeychainAccessGroupResolver');
      expect(swift).not.toContain('TEAMID.com.sooya.app');
      expect(swift).not.toContain('SOOYAKeychainIdentity(accessGroup:');
      expect(swift).toContain('SOOYAKeychainStore()');
    }
  });
});
