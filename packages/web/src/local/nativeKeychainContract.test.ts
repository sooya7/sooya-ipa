import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

describe('SOOYA native keychain contract', () => {
  it('uses the signing identity default access group instead of probing or pinning one', () => {
    const swift = readFileSync(path.resolve('../../ios/App/App/Plugins/SOOYASecretsPlugin.swift'), 'utf8');
    expect(swift).not.toContain('SOOYAKeychainAccessGroupResolver');
    expect(swift).not.toContain('identity.accessGroup');
    expect(swift).not.toContain('kSecAttrAccessGroup as String: identity');
    expect(swift).toContain('static let service = "com.sooya.app.secrets.v1"');
  });
});
