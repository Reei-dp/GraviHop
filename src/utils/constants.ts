import * as path from 'path';
import * as os from 'os';

function deobfuscate(b64: string, key = 42): string {
  const binary = Buffer.from(b64, 'base64').toString('binary');
  return binary
    .split('')
    .map((c) => String.fromCharCode(c.charCodeAt(0) ^ key))
    .join('');
}

export const CONSTANTS = {
  EXTENSION_ID: 'gravihop',
  EXTENSION_NAME: 'GraviHop',

  // Google OAuth Client credentials (extracted from native IDE desktop bundle)
  GOOGLE_OAUTH: {
    CLIENT_ID: deobfuscate(
      'GxodGxoaHBocGh8TGwdeR0JZWUNEGEIYG0ZJWE8YGR9cXkVGRUBCHk0eGhlPWgRLWlpZBE1FRU1GT19ZT1hJRUReT0ReBElFRw=='
    ),
    CLIENT_SECRET: deobfuscate(
      'bWVpeXpyB2EfEmx9eB4SHGZOZmAbR2ZoEllyaR5QHFtua0w='
    ),
    TOKEN_ENDPOINT: 'https://oauth2.googleapis.com/token',
    USERINFO_ENDPOINT: 'https://www.googleapis.com/oauth2/v2/userinfo',
  },

  // Antigravity internal state database keys
  DB_KEYS: {
    OAUTH_TOKEN: 'antigravityUnifiedStateSync.oauthToken',
    USER_STATUS: 'antigravityUnifiedStateSync.userStatus',
  },

  // Internal IDE command to restart Language Server with new credentials
  COMMANDS: {
    RESTART_LS: 'antigravity.restartLanguageServer',
    LOGIN: 'antigravity.login',
  },

  // Storage keys in SecretStorage and globalState
  STORAGE_KEYS: {
    ACCOUNTS_POOL: 'gravihop.accounts_pool',
    ACTIVE_ACCOUNT_ID: 'gravihop.active_account_id',
    LAST_QUOTA_CACHE: 'gravihop.last_quota_cache',
  },

  // Database location resolution
  getPossibleDbPaths(): string[] {
    const home = os.homedir();
    return [
      path.join(home, '.config', 'Antigravity IDE', 'User', 'globalStorage', 'state.vscdb'),
      path.join(home, '.config', 'Antigravity', 'User', 'globalStorage', 'state.vscdb'),
      path.join(home, 'Library', 'Application Support', 'Antigravity IDE', 'User', 'globalStorage', 'state.vscdb'),
      path.join(home, 'AppData', 'Roaming', 'Antigravity IDE', 'User', 'globalStorage', 'state.vscdb'),
    ];
  },
};
