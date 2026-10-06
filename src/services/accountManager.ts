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
    let pool: AccountEntry[] = [];
    try {
      const raw = await this.secretStorage.get(CONSTANTS.STORAGE_KEYS.ACCOUNTS_POOL);
      if (raw) {
        pool = JSON.parse(raw);
      }
    } catch (e) {
      console.warn('[GraviHop] SecretStorage error, using fallback globalState:', e);
    }

    const fallbackRaw = this.globalState.get<string>(CONSTANTS.STORAGE_KEYS.ACCOUNTS_POOL);
    if (fallbackRaw) {
      try {
        const fallbackList: AccountEntry[] = JSON.parse(fallbackRaw);
        if (pool.length === 0) {
          pool = fallbackList;
        } else {
          // Merge to ensure accounts are never dropped
          for (const fb of fallbackList) {
            if (!pool.some((a) => a.id === fb.id)) {
              pool.push(fb);
            }
          }
        }
      } catch {}
    }

    this.accountsCache = pool;
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
        rawUserStatusB64: (userStatusRaw && userStatusRaw.length > 0)
          ? userStatusRaw
          : (existingIdx >= 0 ? this.accountsCache[existingIdx].rawUserStatusB64 : undefined),
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
          progress.report({ increment: 15, message: 'Checking token validity...' });

          // 1. Refresh token if expired or about to expire in next 5 minutes
          const nowSec = Math.floor(Date.now() / 1000);
          if (!target.accessToken || nowSec + 300 >= target.expiryDateSeconds) {
            progress.report({ increment: 15, message: 'Refreshing Google Access Token...' });
            const refreshRes = await GoogleAuthService.refreshAccessToken(target.refreshToken);
            target.accessToken = refreshRes.accessToken;
            target.expiryDateSeconds = refreshRes.expiryDateSeconds;
            await this.persistAccounts();
          }

          progress.report({ increment: 20, message: 'Updating session credentials...' });

          // Ensure valid userStatus (never wipe IDE model catalog and tiers)
          if (!target.rawUserStatusB64 || target.rawUserStatusB64.length === 0) {
            const donor = this.accountsCache.find((a) => a.rawUserStatusB64 && a.rawUserStatusB64.length > 0);
            if (donor) {
              target.rawUserStatusB64 = donor.rawUserStatusB64;
            } else {
              const currentInDb = await DbWatcher.getActiveUserStatusRaw();
              if (currentInDb && currentInDb.length > 0) {
                target.rawUserStatusB64 = currentInDb;
              }
            }
          }

          // 2. NATIVE UNIFIED STATE SYNC: Update in-memory state in Antigravity IDE
          await this.pushNativeAuthState('signedIn', target);

          // 3. PERSISTENCE: Write into state.vscdb on disk (survives IDE restarts)
          const newOAuthB64 = ProtobufHelper.encodeOAuthToken({
            accessToken: target.accessToken,
            refreshToken: target.refreshToken,
            expiryDateSeconds: target.expiryDateSeconds,
          });
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

          // 5. Wait for Language Server to fully restart and authenticate
          progress.report({ increment: 15, message: 'Waiting for Language Server...' });
          await new Promise((resolve) => setTimeout(resolve, 2000));

          // 6. Sync fresh quota from the now-authenticated LS
          progress.report({ increment: 10, message: 'Syncing live quotas...' });
          const freshQuota = await QuotaClient.fetchActiveQuotaWithRetry(5, 1200);
          if (freshQuota) {
            target.quota = freshQuota;
          }

          await this.persistAccounts();
          this._onDidChangeAccounts.fire(this.accountsCache);

          progress.report({ increment: 5, message: 'Switched successfully!' });
          vscode.window.showInformationMessage(
            `GraviHop: Switched to ${target.email}! Active and ready.`
          );
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

    this.accountsCache = this.accountsCache.filter((a) => a.id !== id);
    if (this.activeAccountId === id) {
      this.activeAccountId = this.accountsCache[0]?.id || null;
      await this.globalState.update(CONSTANTS.STORAGE_KEYS.ACTIVE_ACCOUNT_ID, this.activeAccountId);
      if (this.activeAccountId) {
        await this.switchToAccount(this.activeAccountId);
      }
    }
    await this.persistAccounts();
    this._onDidChangeAccounts.fire(this.accountsCache);
    vscode.window.showInformationMessage(`GraviHop: Removed ${account.email}`);
  }

  /**
   * Pushes in-memory auth state and tokens directly into Antigravity Unified State Sync (USS)
   * This immediately transitions the IDE Chat and agents to signedIn without reload.
   */
  public async pushNativeAuthState(
    state: 'signedIn' | 'signedOut',
    account?: AccountEntry
  ): Promise<void> {
    const agySync = (vscode as any).antigravityUnifiedStateSync;
    if (!agySync) {
      console.log('[GraviHop] Native unifiedStateSync API not found on vscode module.');
      return;
    }

    try {
      // 1. In-memory OAuth preferences (tokens)
      if (account && agySync.OAuthPreferences?.setOAuthTokenInfo) {
        await agySync.OAuthPreferences.setOAuthTokenInfo({
          accessToken: account.accessToken,
          refreshToken: account.refreshToken,
          expiryDateSeconds: account.expiryDateSeconds || Math.floor(Date.now() / 1000) + 3600,
          tokenType: 'Bearer',
          isGcpTos: false,
        });
        console.log('[GraviHop] Native in-memory OAuthPreferences updated.');
      }

      // 2. In-memory authStateWithContextSentinelKey in uss-oauth topic
      if (agySync.pushUpdate) {
        await agySync.pushUpdate({
          topicName: 'uss-oauth',
          appliedUpdate: {
            key: 'authStateWithContextSentinelKey',
            newRow: {
              value: JSON.stringify({
                state: state,
                context: {
                  project: '',
                  showProjectError: false,
                  errorMessage: '',
                  ineligibleMessage: '',
                  verificationUrl: '',
                  isGcpTos: false,
                  browserOpenFailed: false,
                  appealUrl: '',
                  appealLinkText: '',
                },
              }),
              eTag: 0,
            },
          },
        });
        console.log(`[GraviHop] Native USS authState pushed: ${state}`);
      }

      // 3. Trigger native IDE auth refresh event
      try {
        await vscode.commands.executeCommand('antigravity.handleAuthRefresh');
        console.log('[GraviHop] Executed antigravity.handleAuthRefresh');
      } catch (e) {
        console.warn('[GraviHop] handleAuthRefresh warning:', e);
      }
    } catch (err) {
      console.warn('[GraviHop] pushNativeAuthState warning:', err);
    }
  }

  /**
   * Checks current IDE auth state. If it is in 'loginError' or broken,
   * automatically heals it by syncing the active account credentials.
   */
  public async autoHealAuthState(): Promise<void> {
    try {
      const agySync = (vscode as any).antigravityUnifiedStateSync;
      if (!agySync) return;

      const currentAuthState = agySync.OAuthPreferences?.getAuthState
        ? await agySync.OAuthPreferences.getAuthState()
        : null;

      console.log('[GraviHop] Current Antigravity auth state:', currentAuthState);

      const active = this.getActiveAccount();
      if (
        active &&
        (currentAuthState === 'loginError' ||
          currentAuthState === 'uninitialized' ||
          currentAuthState === 'signedOut')
      ) {
        console.log(`[GraviHop] Detected auth state '${currentAuthState}'. Auto-healing with active account ${active.email}...`);
        await this.pushNativeAuthState('signedIn', active);
        try {
          await vscode.commands.executeCommand(CONSTANTS.COMMANDS.RESTART_LS);
        } catch {}
      }
    } catch (err) {
      console.warn('[GraviHop] autoHealAuthState warning:', err);
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

              let newlyAdded: AccountEntry | null = null;
              await vscode.window.withProgress(
                {
                  location: vscode.ProgressLocation.Notification,
                  title: 'GraviHop: Authorizing new account...',
                  cancellable: false,
                },
                async (progress) => {
                  try {
                    progress.report({ increment: 30, message: 'Exchanging authorization code...' });
                    const tokens = await GoogleAuthService.exchangeCodeForTokens(code, redirectUri);
                    progress.report({ increment: 40, message: 'Fetching user profile...' });
                    const profile = await GoogleAuthService.fetchUserProfile(tokens.accessToken);
                    const email = profile?.email || 'unknown@gmail.com';

                    const donor = this.accountsCache.find((a) => a.rawUserStatusB64 && a.rawUserStatusB64.length > 0);
                    const newEntry: AccountEntry = {
                      id: email,
                      email: email,
                      name: profile?.name || email.split('@')[0],
                      picture: profile?.picture,
                      refreshToken: tokens.refreshToken,
                      accessToken: tokens.accessToken,
                      expiryDateSeconds: tokens.expiryDateSeconds,
                      rawUserStatusB64: donor?.rawUserStatusB64,
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
                    newlyAdded = newEntry;
                    progress.report({ increment: 30, message: 'Account saved!' });
                  } catch (e: any) {
                    vscode.window.showErrorMessage(`GraviHop OAuth failed: ${e.message}`);
                  }
                }
              );

              if (newlyAdded) {
                vscode.window.showInformationMessage(
                  `GraviHop: Account ${(newlyAdded as AccountEntry).email} successfully added!`
                );
                // Switch outside the authorizer progress dialog so notifications don't freeze
                await this.switchToAccount((newlyAdded as AccountEntry).id);
                resolve(newlyAdded);
              } else {
                resolve(null);
              }
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
          const scopes = encodeURIComponent(CONSTANTS.GOOGLE_OAUTH.SCOPES.join(' '));

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
