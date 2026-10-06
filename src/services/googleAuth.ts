import * as https from 'https';
import { CONSTANTS } from '../utils/constants';

export interface TokenRefreshResult {
  accessToken: string;
  expiresIn: number;
  expiryDateSeconds: number;
}

export interface TokenExchangeResult {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  expiryDateSeconds: number;
}

export interface GoogleUserProfile {
  id: string;
  email: string;
  name: string;
  picture?: string;
}

export class GoogleAuthService {
  /**
   * Refreshes a Google OAuth access token using the stored refresh token
   */
  public static async refreshAccessToken(refreshToken: string): Promise<TokenRefreshResult> {
    const postData = new URLSearchParams({
      client_id: CONSTANTS.GOOGLE_OAUTH.CLIENT_ID,
      client_secret: CONSTANTS.GOOGLE_OAUTH.CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }).toString();

    return new Promise((resolve, reject) => {
      const req = https.request(
        CONSTANTS.GOOGLE_OAUTH.TOKEN_ENDPOINT,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': Buffer.byteLength(postData),
          },
        },
        (res) => {
          let body = '';
          res.on('data', (chunk) => (body += chunk));
          res.on('end', () => {
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              try {
                const parsed = JSON.parse(body);
                const accessToken = parsed.access_token;
                const expiresIn = parsed.expires_in || 3600;
                const expiryDateSeconds = Math.floor(Date.now() / 1000) + expiresIn;
                resolve({
                  accessToken,
                  expiresIn,
                  expiryDateSeconds,
                });
              } catch (e) {
                reject(new Error(`Failed to parse token response: ${e}`));
              }
            } else {
              reject(new Error(`Token refresh failed (HTTP ${res.statusCode}): ${body}`));
            }
          });
        }
      );

      req.on('error', (err) => reject(err));
      req.write(postData);
      req.end();
    });
  }

  /**
   * Exchanges an authorization code for access and refresh tokens
   */
  public static async exchangeCodeForTokens(
    code: string,
    redirectUri: string
  ): Promise<TokenExchangeResult> {
    const postData = new URLSearchParams({
      client_id: CONSTANTS.GOOGLE_OAUTH.CLIENT_ID,
      client_secret: CONSTANTS.GOOGLE_OAUTH.CLIENT_SECRET,
      grant_type: 'authorization_code',
      code: code,
      redirect_uri: redirectUri,
    }).toString();

    return new Promise((resolve, reject) => {
      const req = https.request(
        CONSTANTS.GOOGLE_OAUTH.TOKEN_ENDPOINT,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': Buffer.byteLength(postData),
          },
        },
        (res) => {
          let body = '';
          res.on('data', (chunk) => (body += chunk));
          res.on('end', () => {
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              try {
                const parsed = JSON.parse(body);
                const accessToken = parsed.access_token;
                const refreshToken = parsed.refresh_token;
                const expiresIn = parsed.expires_in || 3600;
                const expiryDateSeconds = Math.floor(Date.now() / 1000) + expiresIn;
                if (!refreshToken) {
                  reject(new Error('Google did not return a refresh token. Try logging in again with consent prompt.'));
                  return;
                }
                resolve({
                  accessToken,
                  refreshToken,
                  expiresIn,
                  expiryDateSeconds,
                });
              } catch (e) {
                reject(new Error(`Failed to parse token response: ${e}`));
              }
            } else {
              reject(new Error(`Token exchange failed (HTTP ${res.statusCode}): ${body}`));
            }
          });
        }
      );

      req.on('error', (err) => reject(err));
      req.write(postData);
      req.end();
    });
  }

  /**
   * Fetches the user profile (email, name, picture) via Google UserInfo API
   */
  public static async fetchUserProfile(accessToken: string): Promise<GoogleUserProfile | null> {
    return new Promise((resolve) => {
      const req = https.request(
        CONSTANTS.GOOGLE_OAUTH.USERINFO_ENDPOINT,
        {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'User-Agent': 'GraviHop-Extension',
          },
        },
        (res) => {
          let body = '';
          res.on('data', (chunk) => (body += chunk));
          res.on('end', () => {
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              try {
                const parsed = JSON.parse(body);
                resolve({
                  id: parsed.id,
                  email: parsed.email,
                  name: parsed.name || parsed.email.split('@')[0],
                  picture: parsed.picture,
                });
              } catch {
                resolve(null);
              }
            } else {
              resolve(null);
            }
          });
        }
      );

      req.on('error', () => resolve(null));
      req.end();
    });
  }
}
