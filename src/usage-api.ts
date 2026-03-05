import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as https from 'https';
import { execFileSync } from 'child_process';
import type { UsageData } from './types.js';
import { createDebug } from './debug.js';

export type { UsageData } from './types.js';

const debug = createDebug('usage');

interface CredentialsFile {
  claudeAiOauth?: {
    accessToken?: string;
    refreshToken?: string;
    subscriptionType?: string;
    rateLimitTier?: string;
    expiresAt?: number;  // Unix millisecond timestamp
    scopes?: string[];
  };
}

interface UsageApiResponse {
  five_hour?: {
    utilization?: number;
    resets_at?: string;
  };
  seven_day?: {
    utilization?: number;
    resets_at?: string;
  };
}

// File-based cache (HUD runs as new process each render, so in-memory cache won't persist)
// With multiple Claude Code instances sharing one cache file, shorter TTLs cause
// thundering herd: all instances hit the API simultaneously when cache expires → 429 loop.
const CACHE_TTL_MS = 180_000; // 3 minutes (longer to reduce API calls with multiple instances)
const CACHE_FAILURE_TTL_MS = 120_000; // 2 minutes for failed requests
const CACHE_RATE_LIMIT_TTL_MS = 600_000; // 10 minutes for 429 rate limit responses
const FETCH_LOCK_TIMEOUT_MS = 15_000; // Lock expires after 15s (stale lock protection)
const KEYCHAIN_TIMEOUT_MS = 5000;
const KEYCHAIN_BACKOFF_MS = 60_000; // Backoff on keychain failures to avoid re-prompting

interface CacheFile {
  data: UsageData;
  timestamp: number;
  rateLimited?: boolean; // true if cached due to 429 rate limit
}

function getCachePath(homeDir: string): string {
  return path.join(homeDir, '.claude', 'plugins', 'claude-hud', '.usage-cache.json');
}

function readCache(homeDir: string, now: number): UsageData | null {
  try {
    const cachePath = getCachePath(homeDir);
    if (!fs.existsSync(cachePath)) return null;

    const content = fs.readFileSync(cachePath, 'utf8');
    const cache: CacheFile = JSON.parse(content);

    // Check TTL - use appropriate TTL based on result type
    const ttl = cache.rateLimited
      ? CACHE_RATE_LIMIT_TTL_MS
      : cache.data.apiUnavailable
        ? CACHE_FAILURE_TTL_MS
        : CACHE_TTL_MS;
    if (now - cache.timestamp >= ttl) return null;

    // JSON.stringify converts Date to ISO string, so we need to reconvert on read.
    // new Date() handles both Date objects and ISO strings safely.
    const data = cache.data;
    if (data.fiveHourResetAt) {
      data.fiveHourResetAt = new Date(data.fiveHourResetAt);
    }
    if (data.sevenDayResetAt) {
      data.sevenDayResetAt = new Date(data.sevenDayResetAt);
    }

    return data;
  } catch {
    return null;
  }
}

function writeCache(homeDir: string, data: UsageData, timestamp: number, rateLimited = false): void {
  try {
    const cachePath = getCachePath(homeDir);
    const cacheDir = path.dirname(cachePath);

    if (!fs.existsSync(cacheDir)) {
      fs.mkdirSync(cacheDir, { recursive: true });
    }

    const cache: CacheFile = { data, timestamp, ...(rateLimited && { rateLimited }) };
    fs.writeFileSync(cachePath, JSON.stringify(cache), 'utf8');
  } catch {
    // Ignore cache write failures
  }
}

/**
 * Read cache data regardless of TTL (for serving stale data while another process fetches).
 */
function readStaleCache(homeDir: string): UsageData | null {
  try {
    const cachePath = getCachePath(homeDir);
    if (!fs.existsSync(cachePath)) return null;

    const content = fs.readFileSync(cachePath, 'utf8');
    const cache: CacheFile = JSON.parse(content);
    const data = cache.data;
    if (data.fiveHourResetAt) {
      data.fiveHourResetAt = new Date(data.fiveHourResetAt);
    }
    if (data.sevenDayResetAt) {
      data.sevenDayResetAt = new Date(data.sevenDayResetAt);
    }
    return data;
  } catch {
    return null;
  }
}

function getFetchLockPath(homeDir: string): string {
  return path.join(homeDir, '.claude', 'plugins', 'claude-hud', '.usage-fetch.lock');
}

/**
 * Try to acquire exclusive fetch lock.
 * Only one process should call the API at a time to prevent thundering herd → 429 loop.
 * Uses 'wx' flag for atomic creation. Stale locks (>15s) are cleaned up.
 */
function tryAcquireFetchLock(homeDir: string, now: number): boolean {
  const lockPath = getFetchLockPath(homeDir);
  try {
    // Check for existing lock
    if (fs.existsSync(lockPath)) {
      const lockTime = parseInt(fs.readFileSync(lockPath, 'utf8'), 10);
      if (now - lockTime < FETCH_LOCK_TIMEOUT_MS) {
        debug('Fetch lock held by another process, skipping API call');
        return false;
      }
      // Stale lock - remove it
      debug('Removing stale fetch lock');
      fs.unlinkSync(lockPath);
    }
    // Atomic create - 'wx' fails if file already exists (race protection)
    const dir = path.dirname(lockPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(lockPath, String(now), { flag: 'wx' });
    return true;
  } catch {
    // Another process won the race
    return false;
  }
}

function releaseFetchLock(homeDir: string): void {
  try {
    const lockPath = getFetchLockPath(homeDir);
    if (fs.existsSync(lockPath)) {
      fs.unlinkSync(lockPath);
    }
  } catch {
    // Ignore
  }
}

/** Result from fetchUsageApi with error classification */
type FetchResult =
  | { ok: true; data: UsageApiResponse }
  | { ok: false; rateLimited: boolean };

// Dependency injection for testing
export type UsageApiDeps = {
  homeDir: () => string;
  fetchApi: (accessToken: string) => Promise<FetchResult>;
  now: () => number;
  readKeychain: (now: number, homeDir: string) => { accessToken: string; subscriptionType: string } | null;
};

const defaultDeps: UsageApiDeps = {
  homeDir: () => os.homedir(),
  fetchApi: fetchUsageApi,
  now: () => Date.now(),
  readKeychain: readKeychainCredentials,
};

/**
 * Get OAuth usage data from Anthropic API.
 * Returns null if user is an API user (no OAuth credentials) or credentials are expired.
 * Returns { apiUnavailable: true, ... } if API call fails (to show warning in HUD).
 *
 * Uses file-based cache since HUD runs as a new process each render (~300ms).
 * Cache TTL: 60s for success, 15s for failures.
 */
export async function getUsage(overrides: Partial<UsageApiDeps> = {}): Promise<UsageData | null> {
  const deps = { ...defaultDeps, ...overrides };
  const now = deps.now();
  const homeDir = deps.homeDir();

  // Check file-based cache first
  const cached = readCache(homeDir, now);
  if (cached) {
    return cached;
  }

  // Cache expired - try to acquire fetch lock to prevent thundering herd.
  // Only one process fetches; others serve stale cache.
  if (!tryAcquireFetchLock(homeDir, now)) {
    const stale = readStaleCache(homeDir);
    if (stale) {
      debug('Serving stale cache while another process fetches');
      return stale;
    }
    // No stale cache available - first run, fall through to fetch
  }

  try {
    const credentials = readCredentials(homeDir, now, deps.readKeychain);
    if (!credentials) {
      releaseFetchLock(homeDir);
      return null;
    }

    const { accessToken, subscriptionType } = credentials;

    // Determine plan name from subscriptionType
    const planName = getPlanName(subscriptionType);
    if (!planName) {
      // API user, no usage limits to show
      releaseFetchLock(homeDir);
      return null;
    }

    // Fetch usage from API
    const fetchResult = await deps.fetchApi(accessToken);
    if (!fetchResult.ok) {
      // API call failed, cache the failure to prevent retry storms
      const failureResult: UsageData = {
        planName,
        fiveHour: null,
        sevenDay: null,
        fiveHourResetAt: null,
        sevenDayResetAt: null,
        apiUnavailable: true,
      };
      if (fetchResult.rateLimited) {
        debug('Rate limited (429), backing off for', CACHE_RATE_LIMIT_TTL_MS / 1000, 'seconds');
      }
      writeCache(homeDir, failureResult, now, fetchResult.rateLimited);
      releaseFetchLock(homeDir);
      return failureResult;
    }

    const apiResponse = fetchResult.data;

    // Parse response - API returns 0-100 percentage directly
    // Clamp to 0-100 and handle NaN/Infinity
    const fiveHour = parseUtilization(apiResponse.five_hour?.utilization);
    const sevenDay = parseUtilization(apiResponse.seven_day?.utilization);

    const fiveHourResetAt = parseDate(apiResponse.five_hour?.resets_at);
    const sevenDayResetAt = parseDate(apiResponse.seven_day?.resets_at);

    const result: UsageData = {
      planName,
      fiveHour,
      sevenDay,
      fiveHourResetAt,
      sevenDayResetAt,
    };

    // Write to file cache
    writeCache(homeDir, result, now);
    releaseFetchLock(homeDir);

    return result;
  } catch (error) {
    debug('getUsage failed:', error);
    releaseFetchLock(homeDir);
    return null;
  }
}

/**
 * Get path for keychain failure backoff cache.
 * Separate from usage cache to track keychain-specific failures.
 */
function getKeychainBackoffPath(homeDir: string): string {
  return path.join(homeDir, '.claude', 'plugins', 'claude-hud', '.keychain-backoff');
}

/**
 * Check if we're in keychain backoff period (recent failure/timeout).
 * Prevents re-prompting user on every render cycle.
 */
function isKeychainBackoff(homeDir: string, now: number): boolean {
  try {
    const backoffPath = getKeychainBackoffPath(homeDir);
    if (!fs.existsSync(backoffPath)) return false;
    const timestamp = parseInt(fs.readFileSync(backoffPath, 'utf8'), 10);
    return now - timestamp < KEYCHAIN_BACKOFF_MS;
  } catch {
    return false;
  }
}

/**
 * Record keychain failure for backoff.
 */
function recordKeychainFailure(homeDir: string, now: number): void {
  try {
    const backoffPath = getKeychainBackoffPath(homeDir);
    const dir = path.dirname(backoffPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(backoffPath, String(now), 'utf8');
  } catch {
    // Ignore write failures
  }
}

/**
 * Read credentials from macOS Keychain.
 * Claude Code 2.x stores OAuth credentials in the macOS Keychain under "Claude Code-credentials".
 * Returns null if not on macOS or credentials not found.
 *
 * Security: Uses execFileSync with absolute path to avoid shell injection and PATH hijacking.
 */
function readKeychainCredentials(now: number, homeDir: string): { accessToken: string; subscriptionType: string } | null {
  // Only available on macOS
  if (process.platform !== 'darwin') {
    return null;
  }

  // Check backoff to avoid re-prompting on every render after a failure
  if (isKeychainBackoff(homeDir, now)) {
    debug('Keychain in backoff period, skipping');
    return null;
  }

  try {
    // Read from macOS Keychain using security command
    // Security: Use execFileSync with absolute path and args array (no shell)
    const keychainData = execFileSync(
      '/usr/bin/security',
      ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: KEYCHAIN_TIMEOUT_MS }
    ).trim();

    if (!keychainData) {
      return null;
    }

    const data: CredentialsFile = JSON.parse(keychainData);
    return parseCredentialsData(data, now);
  } catch (error) {
    // Security: Only log error message, not full error object (may contain stdout/stderr with tokens)
    const message = error instanceof Error ? error.message : 'unknown error';
    debug('Failed to read from macOS Keychain:', message);
    // Record failure for backoff to avoid re-prompting
    recordKeychainFailure(homeDir, now);
    return null;
  }
}

/**
 * Read credentials from file (legacy method).
 * Older versions of Claude Code stored credentials in ~/.claude/.credentials.json
 */
function readFileCredentials(homeDir: string, now: number): { accessToken: string; subscriptionType: string } | null {
  const credentialsPath = path.join(homeDir, '.claude', '.credentials.json');

  if (!fs.existsSync(credentialsPath)) {
    return null;
  }

  try {
    const content = fs.readFileSync(credentialsPath, 'utf8');
    const data: CredentialsFile = JSON.parse(content);
    return parseCredentialsData(data, now);
  } catch (error) {
    debug('Failed to read credentials file:', error);
    return null;
  }
}

/**
 * Parse and validate credentials data from either Keychain or file.
 */
function parseCredentialsData(data: CredentialsFile, now: number): { accessToken: string; subscriptionType: string } | null {
  const accessToken = data.claudeAiOauth?.accessToken;
  const subscriptionType = data.claudeAiOauth?.subscriptionType ?? '';

  if (!accessToken) {
    return null;
  }

  // Check if token is expired (expiresAt is Unix ms timestamp)
  // Use != null to handle expiresAt=0 correctly (would be expired)
  const expiresAt = data.claudeAiOauth?.expiresAt;
  if (expiresAt != null && expiresAt <= now) {
    debug('OAuth token expired');
    return null;
  }

  return { accessToken, subscriptionType };
}

/**
 * Read OAuth credentials, trying macOS Keychain first (Claude Code 2.x),
 * then falling back to file-based credentials (older versions).
 *
 * Token priority: Keychain token is authoritative (Claude Code 2.x stores current token there).
 * SubscriptionType: Can be supplemented from file if keychain lacks it (display-only field).
 */
function readCredentials(
  homeDir: string,
  now: number,
  readKeychain: (now: number, homeDir: string) => { accessToken: string; subscriptionType: string } | null
): { accessToken: string; subscriptionType: string } | null {
  // Try macOS Keychain first (Claude Code 2.x)
  const keychainCreds = readKeychain(now, homeDir);
  if (keychainCreds) {
    if (keychainCreds.subscriptionType) {
      debug('Using credentials from macOS Keychain');
      return keychainCreds;
    }
    // Keychain has token but no subscriptionType - try to supplement from file
    const fileCreds = readFileCredentials(homeDir, now);
    if (fileCreds?.subscriptionType) {
      debug('Using keychain token with file subscriptionType');
      return {
        accessToken: keychainCreds.accessToken,
        subscriptionType: fileCreds.subscriptionType,
      };
    }
    // No subscriptionType available - use keychain token anyway
    debug('Using keychain token without subscriptionType');
    return keychainCreds;
  }

  // Fall back to file-based credentials (older versions or non-macOS)
  const fileCreds = readFileCredentials(homeDir, now);
  if (fileCreds) {
    debug('Using credentials from file');
    return fileCreds;
  }

  return null;
}

function getPlanName(subscriptionType: string): string | null {
  const lower = subscriptionType.toLowerCase();
  if (lower.includes('max')) return 'Max';
  if (lower.includes('pro')) return 'Pro';
  if (lower.includes('team')) return 'Team';
  // API users don't have subscriptionType or have 'api'
  if (!subscriptionType || lower.includes('api')) return null;
  // Unknown subscription type - show it capitalized
  return subscriptionType.charAt(0).toUpperCase() + subscriptionType.slice(1);
}

/** Parse utilization value, clamping to 0-100 and handling NaN/Infinity */
function parseUtilization(value: number | undefined): number | null {
  if (value == null) return null;
  if (!Number.isFinite(value)) return null;  // Handles NaN and Infinity
  return Math.round(Math.max(0, Math.min(100, value)));
}

/** Parse ISO date string safely, returning null for invalid dates */
function parseDate(dateStr: string | undefined): Date | null {
  if (!dateStr) return null;
  const date = new Date(dateStr);
  // Check for Invalid Date
  if (isNaN(date.getTime())) {
    debug('Invalid date string:', dateStr);
    return null;
  }
  return date;
}

function fetchUsageApi(accessToken: string): Promise<FetchResult> {
  return new Promise((resolve) => {
    const options = {
      hostname: 'api.anthropic.com',
      path: '/api/oauth/usage',
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'User-Agent': 'claude-hud/1.0',
      },
      timeout: 5000,
    };

    const req = https.request(options, (res) => {
      let data = '';

      res.on('data', (chunk: Buffer) => {
        data += chunk.toString();
      });

      res.on('end', () => {
        if (res.statusCode !== 200) {
          debug('API returned non-200 status:', res.statusCode);
          resolve({ ok: false, rateLimited: res.statusCode === 429 });
          return;
        }

        try {
          const parsed: UsageApiResponse = JSON.parse(data);
          resolve({ ok: true, data: parsed });
        } catch (error) {
          debug('Failed to parse API response:', error);
          resolve({ ok: false, rateLimited: false });
        }
      });
    });

    req.on('error', (error) => {
      debug('API request error:', error);
      resolve({ ok: false, rateLimited: false });
    });
    req.on('timeout', () => {
      debug('API request timeout');
      req.destroy();
      resolve({ ok: false, rateLimited: false });
    });

    req.end();
  });
}

// Export for testing
export function clearCache(homeDir?: string): void {
  if (homeDir) {
    try {
      const cachePath = getCachePath(homeDir);
      if (fs.existsSync(cachePath)) {
        fs.unlinkSync(cachePath);
      }
      // Also clean up fetch lock
      const lockPath = getFetchLockPath(homeDir);
      if (fs.existsSync(lockPath)) {
        fs.unlinkSync(lockPath);
      }
    } catch {
      // Ignore
    }
  }
}
