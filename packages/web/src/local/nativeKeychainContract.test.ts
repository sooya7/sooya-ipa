import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

describe('SOOYA native keychain contract', () => {
  it('requests attributes, but never secret data, when discovering the signed access group', () => {
    const swift = readFileSync(path.resolve('../../ios/App/App/Plugins/SOOYASecretsPlugin.swift'), 'utf8');
    const start = swift.indexOf('final class SOOYAKeychainAccessGroupResolver');
    const end = swift.indexOf('final class SOOYAKeychainStore');
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);

    const resolver = swift.slice(start, end);
    expect(resolver).toContain('kSecReturnAttributes as String: true');
    expect(resolver).not.toContain('kSecReturnData as String: true');
  });
});
