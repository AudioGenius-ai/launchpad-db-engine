import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { AuthenticationError } from '../schema/types.js';

export interface Credentials {
  token: string;
  refreshToken?: string;
  expiresAt?: string;
  projectId?: string;
}

export interface AuthConfig {
  credentialsPath?: string;
}

const DEFAULT_CREDENTIALS_PATH = join(homedir(), '.launchpad', 'credentials.json');

export class AuthHandler {
  private credentialsPath: string;
  private cachedCredentials: Credentials | null = null;

  constructor(config: AuthConfig = {}) {
    this.credentialsPath = config.credentialsPath ?? DEFAULT_CREDENTIALS_PATH;
  }

  async getToken(): Promise<string> {
    const credentials = await this.loadCredentials();

    if (!credentials?.token) {
      throw new AuthenticationError(
        'No authentication token found. Run `launchpad login` to authenticate.'
      );
    }

    if (credentials.expiresAt) {
      const expiresAt = new Date(credentials.expiresAt);
      if (expiresAt <= new Date()) {
        if (credentials.refreshToken) {
          return this.refreshToken(credentials.refreshToken);
        }
        throw new AuthenticationError(
          'Authentication token has expired. Run `launchpad login` to re-authenticate.'
        );
      }
    }

    return credentials.token;
  }

  async getProjectId(): Promise<string | undefined> {
    const credentials = await this.loadCredentials();
    return credentials?.projectId;
  }

  async saveCredentials(credentials: Credentials): Promise<void> {
    await mkdir(dirname(this.credentialsPath), { recursive: true });
    await writeFile(this.credentialsPath, JSON.stringify(credentials, null, 2), 'utf-8');
    this.cachedCredentials = credentials;
  }

  async clearCredentials(): Promise<void> {
    try {
      await writeFile(this.credentialsPath, '{}', 'utf-8');
      this.cachedCredentials = null;
    } catch {}
  }

  async isAuthenticated(): Promise<boolean> {
    try {
      await this.getToken();
      return true;
    } catch {
      return false;
    }
  }

  private async loadCredentials(): Promise<Credentials | null> {
    if (this.cachedCredentials) {
      return this.cachedCredentials;
    }

    try {
      const content = await readFile(this.credentialsPath, 'utf-8');
      this.cachedCredentials = JSON.parse(content) as Credentials;
      return this.cachedCredentials;
    } catch {
      return null;
    }
  }

  private async refreshToken(_refreshToken: string): Promise<string> {
    throw new AuthenticationError(
      'Token refresh not implemented. Run `launchpad login` to re-authenticate.'
    );
  }
}

export function createAuthHandler(config?: AuthConfig): AuthHandler {
  return new AuthHandler(config);
}
