import * as vscode from 'vscode';
import * as http from 'http';
import { CONSTANTS } from '../utils/constants';
import { ProtobufHelper } from '../utils/protobufHelper';
import { DbWatcher } from './dbWatcher';
import { GoogleAuthService } from './googleAuth';
import { QuotaClient, QuotaSummary } from './quotaClient';

export interface AccountEntry {
  id: string;
  email: string;
  name: string;
  picture?: string;
  tier?: string;
  refreshToken: string;
  accessToken: string;
  expiryDateSeconds: number;
  rawUserStatusB64?: string;
  quota?: QuotaSummary;
  lastCapturedAt: number;
}

export class AccountManager {
  private static instance: AccountManager;
  private secretStorage: vscode.SecretStorage;
  private globalState: vscode.Memento;
  private _onDidChangeAccounts = new vscode.EventEmitter<AccountEntry[]>();
  public readonly onDidChangeAccounts = this._onDidChangeAccounts.event;

  private accountsCache: AccountEntry[] = [];
  private activeAccountId: string | null = null;

  private constructor(context: vscode.ExtensionContext) {
    this.secretStorage = context.secrets;
    this.globalState = context.globalState;
  }

  public static initialize(context: vscode.ExtensionContext): AccountManager {
    if (!this.instance) {
      this.instance = new AccountManager(context);
    }
    return this.instance;
  }

  public static getInstance(): AccountManager {
    if (!this.instance) {
      throw new Error('AccountManager not initialized');
    }
    return this.instance;
  }

  public async load(): Promise<AccountEntry[]> {
    try {
      const raw = await this.secretStorage.get(CONSTANTS.STORAGE_KEYS.ACCOUNTS_POOL);
      if (raw) {
        this.accountsCache = JSON.parse(raw);
      } else {
        const fallbackRaw = this.globalState.get<string>(CONSTANTS.STORAGE_KEYS.ACCOUNTS_POOL);
        this.accountsCache = fallbackRaw ? JSON.parse(fallbackRaw) : [];
      }
    } catch (e) {
      console.warn('[GraviHop] SecretStorage error, using fallback globalState:', e);
      const fallbackRaw = this.globalState.get<string>(CONSTANTS.STORAGE_KEYS.ACCOUNTS_POOL);
      this.accountsCache = fallbackRaw ? JSON.parse(fallbackRaw) : [];
    }

    this.activeAccountId = this.globalState.get<string>(CONSTANTS.STORAGE_KEYS.ACTIVE_ACCOUNT_ID) || null;

    // Automatically capture active account if pool is empty
    if (this.accountsCache.length === 0) {
      await this.captureCurrentAccount(false);
    }

    return this.accountsCache;
  }

  public getAccounts(): AccountEntry[] {
    return this.accountsCache;
  }

  public getActiveAccount(): AccountEntry | null {
    if (!this.activeAccountId && this.accountsCache.length > 0) {
      return this.accountsCache[0];
    }
    return this.accountsCache.find((a) => a.id === this.activeAccountId) || null;
  }

  private async persistAccounts(): Promise<void> {
    try {
      await this.secretStorage.store(
        CONSTANTS.STORAGE_KEYS.ACCOUNTS_POOL,
        JSON.stringify(this.accountsCache)
      );
    } catch (e) {
      console.warn('[GraviHop] SecretStorage store failed, using globalState fallback:', e);
    }

    // Always keep safe mirror in globalState
    await this.globalState.update(
      CONSTANTS.STORAGE_KEYS.ACCOUNTS_POOL,
      JSON.stringify(this.accountsCache)
    );

    this._onDidChangeAccounts.fire(this.accountsCache);
  }

  public async setActiveAccountId(id: string): Promise<void> {
    this.activeAccountId = id;
    await this.globalState.update(CONSTANTS.STORAGE_KEYS.ACTIVE_ACCOUNT_ID, id);
    this._onDidChangeAccounts.fire(this.accountsCache);
  }

  /**
   * Captures the account currently active in state.vscdb
   */
  public async captureCurrentAccount(showNotification = true): Promise<AccountEntry | null> {
    try {
      const oauthRaw = await DbWatcher.getActiveOAuthTokenRaw();
      const userStatusRaw = await DbWatcher.getActiveUserStatusRaw();

      if (!oauthRaw) {
        if (showNotification) {
          vscode.window.showWarningMessage('No active Google session found in Antigravity IDE.');
        }
        return null;
      }

      const decodedToken = ProtobufHelper.decodeOAuthToken(oauthRaw);
      if (!decodedToken || !decodedToken.refreshToken) {
        if (showNotification) {
          vscode.window.showErrorMessage('Could not extract refresh token from active session.');
        }
        return null;
      }

      let email = '';
      let name = '';
      let tier = 'standard-tier';
      let picture = '';

      if (userStatusRaw) {
        const decodedStatus = ProtobufHelper.decodeUserStatus(userStatusRaw);
        email = decodedStatus.email;
        name = decodedStatus.name;
        tier = decodedStatus.userTier || tier;
        picture = decodedStatus.profilePictureUrl || '';
      }

      // Try Google UserInfo API if details are missing
      if (!email || !picture) {
        const profile = await GoogleAuthService.fetchUserProfile(decodedToken.accessToken);
        if (profile) {
          email = email || profile.email;
          name = name || profile.name;
          picture = picture || profile.picture || '';
        }
      }

      if (!email) {
        email = `account_${this.accountsCache.length + 1}@antigravity`;
        name = `Account #${this.accountsCache.length + 1}`;
      }

      const id = email.toLowerCase();
      const existingIdx = this.accountsCache.findIndex((a) => a.id === id);

      // Fetch active quota
      const quota = await QuotaClient.fetchActiveQuota();

      const entry: AccountEntry = {
        id,
        email,
        name: name || email.split('@')[0],
        picture,
        tier,
        refreshToken: decodedToken.refreshToken,
        accessToken: decodedToken.accessToken,
        expiryDateSeconds: decodedToken.expiryDateSeconds,
        rawUserStatusB64: userStatusRaw || undefined,
        quota: quota || undefined,
        lastCapturedAt: Date.now(),
      };

      if (existingIdx >= 0) {
        this.accountsCache[existingIdx] = {
          ...this.accountsCache[existingIdx],
          ...entry,
        };
      } else {
        this.accountsCache.push(entry);
      }

      await this.setActiveAccountId(id);
      await this.persistAccounts();

      if (showNotification) {
        vscode.window.showInformationMessage(
          `GraviHop: Saved account ${email} (Slot ${existingIdx >= 0 ? existingIdx + 1 : this.accountsCache.length}/${this.accountsCache.length})`
        );
      }

      return entry;
    } catch (err) {
      console.error('[GraviHop] Failed to capture active account:', err);
      if (showNotification) {
        vscode.window.showErrorMessage(`Failed to capture account: ${err}`);
      }
      return null;
    }
  }

  /**
   * Switches IDE to target account in 1-click
   */
  public async switchToAccount(id: string): Promise<boolean> {
    const target = this.accountsCache.find((a) => a.id === id);
    if (!target) {
      vscode.window.showErrorMessage(`Account ${id} not found in pool.`);
      return false;
    }

    return vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `GraviHop: Switching to ${target.email}...`,
        cancellable: false,
      },
      async (progress) => {
        try {
          progress.report({ increment: 20, message: 'Checking token validity...' });

          // 1. Refresh token if expired or about to expire in next 5 minutes
          const nowSec = Math.floor(Date.now() / 1000);
          if (!target.accessToken || nowSec + 300 >= target.expiryDateSeconds) {
            progress.report({ increment: 20, message: 'Refreshing Google Access Token...' });
            const refreshRes = await GoogleAuthService.refreshAccessToken(target.refreshToken);
            target.accessToken = refreshRes.accessToken;
            target.expiryDateSeconds = refreshRes.expiryDateSeconds;
            await this.persistAccounts();
          }

          progress.report({ increment: 30, message: 'Updating state.vscdb...' });

          // 2. Re-encode OAuth token protobuf
          const newOAuthB64 = ProtobufHelper.encodeOAuthToken({
            accessToken: target.accessToken,
            refreshToken: target.refreshToken,
            expiryDateSeconds: target.expiryDateSeconds,
          });

          // 3. Write into state.vscdb
          await DbWatcher.applySession(newOAuthB64, target.rawUserStatusB64);
          await this.setActiveAccountId(target.id);

          progress.report({ increment: 20, message: 'Restarting Language Server...' });

          // 4. Invalidate quota cache & trigger Language Server restart
          QuotaClient.invalidateCache();
          try {
            await vscode.commands.executeCommand(CONSTANTS.COMMANDS.RESTART_LS);
          } catch (e) {
            console.warn('[GraviHop] restartLanguageServer command warning:', e);
          }

          // 5. Poll with retry for Language Server startup, then fetch fresh quota
          progress.report({ increment: 15, message: 'Syncing live quotas...' });
          await new Promise((resolve) => setTimeout(resolve, 800));
          const freshQuota = await QuotaClient.fetchActiveQuotaWithRetry(6, 1200);
          if (freshQuota) {
            target.quota = freshQuota;
          }

          // 6. Capture updated user status if generated by LS
          const freshStatus = await DbWatcher.getActiveUserStatusRaw();
          if (freshStatus) {
            target.rawUserStatusB64 = freshStatus;
          }

          await this.persistAccounts();
          this._onDidChangeAccounts.fire(this.accountsCache);

          progress.report({ increment: 10, message: 'Switched successfully!' });
          vscode.window.showInformationMessage(`GraviHop: Switched to ${target.email}`);
          return true;
        } catch (err) {
          vscode.window.showErrorMessage(`Failed to switch account: ${err}`);
          return false;
        }
      }
    );
  }

  public async removeAccount(id: string): Promise<void> {
    const account = this.accountsCache.find((a) => a.id === id);
    if (!account) {
      return;
    }

    const confirm = await vscode.window.showWarningMessage(
      `Remove account ${account.email} from GraviHop pool?`,
      { modal: true },
      'Remove'
    );

    if (confirm === 'Remove') {
      this.accountsCache = this.accountsCache.filter((a) => a.id !== id);
      if (this.activeAccountId === id) {
        this.activeAccountId = this.accountsCache[0]?.id || null;
        await this.globalState.update(CONSTANTS.STORAGE_KEYS.ACTIVE_ACCOUNT_ID, this.activeAccountId);
      }
      await this.persistAccounts();
      vscode.window.showInformationMessage(`Removed ${account.email}`);
    }
  }

  /**
   * Starts a local loopback server, launches browser for Google OAuth,
   * captures incoming code, fetches tokens, and adds account to pool.
   */
  public async loginWithGoogleBrowser(): Promise<AccountEntry | null> {
    return new Promise((resolve) => {
      let server: http.Server | null = null;
      let timeoutId: NodeJS.Timeout | null = null;

      const cleanup = () => {
        if (timeoutId) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }
        if (server) {
          try {
            server.close();
          } catch {}
          server = null;
        }
      };

      try {
        server = http.createServer(async (req, res) => {
          try {
            const host = req.headers.host || '127.0.0.1';
            const reqUrl = new URL(req.url || '', `http://${host}`);
            if (reqUrl.pathname === '/oauth-callback') {
              const code = reqUrl.searchParams.get('code');
              const error = reqUrl.searchParams.get('error');

              if (error) {
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(`<html><body style="font-family:sans-serif;background:#18181b;color:#ef4444;text-align:center;padding:50px;"><h2>Authorization cancelled</h2><p>${error}</p></body></html>`);
                cleanup();
                resolve(null);
                return;
              }

              if (!code) {
                res.writeHead(400, { 'Content-Type': 'text/plain' });
                res.end('Missing authorization code');
                return;
              }

              // Serve sleek confirmation page
              res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
              res.end(`<!DOCTYPE html>
<html>
<head><title>GraviHop Authorized</title></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;background:#18181b;color:#f4f4f5;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;">
  <div style="background:#27272a;border:1px solid #3f3f46;border-radius:12px;padding:32px 40px;text-align:center;box-shadow:0 10px 30px rgba(0,0,0,0.5);">
    <div style="font-size:36px;margin-bottom:12px;">✅</div>
    <h2 style="margin:0 0 8px 0;font-size:18px;">Account added to GraviHop!</h2>
    <p style="margin:0;color:#a1a1aa;font-size:13px;">You can now close this tab and return to Antigravity IDE.</p>
  </div>
  <script>setTimeout(() => window.close(), 1500);</script>
</body>
</html>`);

              const address = server?.address();
              const port = typeof address === 'object' && address ? address.port : 0;
              const redirectUri = `http://127.0.0.1:${port}/oauth-callback`;

              cleanup();

              await vscode.window.withProgress(
                {
                  location: vscode.ProgressLocation.Notification,
                  title: 'GraviHop: Authorizing new account...',
                  cancellable: false,
                },
                async () => {
                  try {
                    const tokens = await GoogleAuthService.exchangeCodeForTokens(code, redirectUri);
                    const profile = await GoogleAuthService.fetchUserProfile(tokens.accessToken);
                    const email = profile?.email || 'unknown@gmail.com';

                    const newEntry: AccountEntry = {
                      id: email,
                      email: email,
                      name: profile?.name || email.split('@')[0],
                      picture: profile?.picture,
                      refreshToken: tokens.refreshToken,
                      accessToken: tokens.accessToken,
                      expiryDateSeconds: tokens.expiryDateSeconds,
                      lastCapturedAt: Date.now(),
                    };

                    const existingIdx = this.accountsCache.findIndex((a) => a.id === newEntry.id);
                    if (existingIdx >= 0) {
                      this.accountsCache[existingIdx] = newEntry;
                    } else {
                      this.accountsCache.push(newEntry);
                    }

                    await this.persistAccounts();
                    this._onDidChangeAccounts.fire(this.accountsCache);

                    // Automatically activate and switch to the newly authorized account
                    await this.switchToAccount(newEntry.id);

                    vscode.window.showInformationMessage(
                      `GraviHop: Account ${email} successfully added and activated!`
                    );
                    resolve(newEntry);
                  } catch (e: any) {
                    vscode.window.showErrorMessage(`GraviHop OAuth failed: ${e.message}`);
                    resolve(null);
                  }
                }
              );
            }
          } catch (e) {
            cleanup();
            resolve(null);
          }
        });

        // Listen on random free port on loopback 127.0.0.1
        server.listen(0, '127.0.0.1', async () => {
          const address = server?.address();
          if (!address || typeof address !== 'object') {
            cleanup();
            resolve(null);
            return;
          }

          const port = address.port;
          const redirectUri = `http://127.0.0.1:${port}/oauth-callback`;
          const scopes = encodeURIComponent(
            'https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile'
          );

          const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${CONSTANTS.GOOGLE_OAUTH.CLIENT_ID}&redirect_uri=${encodeURIComponent(
            redirectUri
          )}&response_type=code&scope=${scopes}&access_type=offline&prompt=select_account%20consent`;

          await vscode.env.openExternal(vscode.Uri.parse(authUrl));

          // 3-minute timeout
          timeoutId = setTimeout(() => {
            cleanup();
            resolve(null);
          }, 180000);
        });

        server.on('error', (err) => {
          cleanup();
          vscode.window.showErrorMessage(`GraviHop OAuth server error: ${err.message}`);
          resolve(null);
        });
      } catch (err: any) {
        cleanup();
        vscode.window.showErrorMessage(`Failed to start login: ${err.message}`);
        resolve(null);
      }
    });
  }

  /**
   * Refreshes quota for active account (and updates cached accounts)
   */
  public async refreshActiveQuota(): Promise<QuotaSummary | null> {
    QuotaClient.invalidateCache();
    const quota = await QuotaClient.fetchActiveQuotaWithRetry(3, 1000);
    if (quota) {
      const active = this.getActiveAccount();
      if (active) {
        active.quota = quota;
        await this.persistAccounts();
        this._onDidChangeAccounts.fire(this.accountsCache);
      }
    }
    return quota;
  }
}
