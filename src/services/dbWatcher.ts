import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { CONSTANTS } from '../utils/constants';

const execFileAsync = promisify(execFile);

export class DbWatcher {
  private static resolvedDbPath: string | null = null;

  public static getDbPath(): string {
    if (this.resolvedDbPath && fs.existsSync(this.resolvedDbPath)) {
      return this.resolvedDbPath;
    }

    for (const p of CONSTANTS.getPossibleDbPaths()) {
      if (fs.existsSync(p)) {
        this.resolvedDbPath = p;
        return p;
      }
    }

    throw new Error('Antigravity state database (state.vscdb) not found on system.');
  }

  /**
   * Safely creates a timestamped backup of state.vscdb
   */
  public static async createBackup(): Promise<string> {
    const dbPath = this.getDbPath();
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = `${dbPath}.backup.${timestamp}`;

    await fs.promises.copyFile(dbPath, backupPath);

    // Prune older backups if more than 5 exist
    try {
      const dir = path.dirname(dbPath);
      const base = path.basename(dbPath);
      const files = await fs.promises.readdir(dir);
      const backups = files
        .filter((f) => f.startsWith(`${base}.backup.`))
        .map((f) => path.join(dir, f))
        .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);

      if (backups.length > 5) {
        for (const oldBackup of backups.slice(5)) {
          await fs.promises.unlink(oldBackup).catch(() => {});
        }
      }
    } catch (e) {
      console.warn('[GraviHop] Warning pruning old backups:', e);
    }

    return backupPath;
  }

  /**
   * Reads a raw value for a given key from state.vscdb
   */
  public static async readKey(key: string): Promise<string | null> {
    const dbPath = this.getDbPath();

    // Primary: Python3 sqlite3 parameter binding
    try {
      const script = `import sqlite3, sys
try:
    db = sqlite3.connect(sys.argv[1], timeout=3.0)
    cur = db.cursor()
    cur.execute('SELECT value FROM ItemTable WHERE key = ?', (sys.argv[2],))
    row = cur.fetchone()
    if row and row[0] is not None:
        sys.stdout.write(row[0])
except Exception as e:
    sys.stderr.write(str(e))
    sys.exit(1)
`;
      const { stdout } = await execFileAsync('python3', ['-c', script, dbPath, key], {
        maxBuffer: 10 * 1024 * 1024,
      });
      return stdout || null;
    } catch {
      // Fallback: sqlite3 CLI
      try {
        const query = `SELECT value FROM ItemTable WHERE key = '${key.replace(/'/g, "''")}';`;
        const { stdout } = await execFileAsync('sqlite3', ['-batch', '-noheader', dbPath, query], {
          maxBuffer: 10 * 1024 * 1024,
        });
        return stdout.trim() || null;
      } catch (err) {
        console.error(`[GraviHop] Error reading key "${key}":`, err);
        return null;
      }
    }
  }

  /**
   * Writes key-value pair into ItemTable in state.vscdb
   */
  public static async writeKey(key: string, value: string): Promise<boolean> {
    const dbPath = this.getDbPath();

    try {
      const script = `import sqlite3, sys
try:
    db = sqlite3.connect(sys.argv[1], timeout=5.0)
    cur = db.cursor()
    cur.execute('INSERT OR REPLACE INTO ItemTable(key, value) VALUES (?, ?)', (sys.argv[2], sys.argv[3]))
    db.commit()
    db.close()
except Exception as e:
    sys.stderr.write(str(e))
    sys.exit(1)
`;
      await execFileAsync('python3', ['-c', script, dbPath, key, value], {
        maxBuffer: 10 * 1024 * 1024,
      });
      return true;
    } catch (err) {
      console.error(`[GraviHop] Failed to write key "${key}":`, err);
      return false;
    }
  }

  /**
   * Reads active raw OAuth token base64 string
   */
  public static async getActiveOAuthTokenRaw(): Promise<string | null> {
    return this.readKey(CONSTANTS.DB_KEYS.OAUTH_TOKEN);
  }

  /**
   * Reads active raw User status base64 string
   */
  public static async getActiveUserStatusRaw(): Promise<string | null> {
    return this.readKey(CONSTANTS.DB_KEYS.USER_STATUS);
  }

  /**
   * Writes the full session (OAuth Token + User Status) with safety backup
   */
  public static async applySession(oauthTokenB64: string, userStatusB64?: string): Promise<boolean> {
    await this.createBackup();

    const okToken = await this.writeKey(CONSTANTS.DB_KEYS.OAUTH_TOKEN, oauthTokenB64);
    if (!okToken) {
      throw new Error('Failed to write OAuth token to state.vscdb');
    }

    // Only write userStatus if non-empty to prevent wiping IDE model catalog & user tier
    if (userStatusB64 && userStatusB64.trim().length > 0) {
      await this.writeKey(CONSTANTS.DB_KEYS.USER_STATUS, userStatusB64);
    }

    return true;
  }
}
