import type { Book } from '@/types/book';
import type { OPDSBookMetadata } from './metadata';

// --- Constants ---

export const MAX_PAGES_PER_FEED = 5;
// Directory-style catalogs (e.g. copyparty file listings) expose subfolders
// as rel="subsection" navigation entries. When a catalog has no "by newest"
// feed those subsections are crawled breadth-first, bounded by these caps.
export const MAX_CRAWL_DEPTH = 5;
export const MAX_FEEDS_PER_CRAWL = 50;
export const MAX_KNOWN_ENTRIES = 2000;
export const MAX_RETRY_ATTEMPTS = 3;
export const RETRY_BACKOFF_MS = 60_000;
export const DOWNLOAD_CONCURRENCY = 3;
export const OPDS_SUBSCRIPTIONS_DIR = 'OPDS';
// How often to check subscribed feeds for new items, in addition to the
// app-startup check and pull-to-refresh trigger.
export const AUTO_CHECK_INTERVAL_MS = 5 * 60 * 1000;

// --- Types ---

export interface PendingItem {
  entryId: string;
  title: string;
  acquisitionHref: string;
  /** Cover advertised by the entry, preferred over the one inside the file (#5270). */
  coverHref?: string;
  /** Metadata advertised by the entry, applied over the file's own (#5270). */
  metadata?: OPDSBookMetadata;
  mimeType: string;
  updated?: string;
  baseURL: string;
  serverReadStatus?: 'read' | 'unread' | 'unknown';
}

export interface FailedEntry {
  entryId: string;
  href: string;
  title: string;
  attempts: number;
  lastAttemptAt: number;
}

export interface OPDSSubscriptionState {
  catalogId: string;
  lastCheckedAt: number;
  knownEntryIds: string[];
  failedEntries: FailedEntry[];
}

export interface SyncResult {
  newBooks: Book[];
  totalNewBooks: number;
  errors: Array<{ catalogId: string; catalogName: string; error: string }>;
}

export interface OPDSCatalogSyncStats {
  catalogId: string;
  catalogName: string;
  discovered: number;
  deferredByBackoff: number;
  filtered: number;
  planned: number;
  attempted: number;
  downloaded: number;
  failed: number;
  nextRetryAt?: number;
  error?: string;
}

export interface OPDSSyncOptions {
  limitByCatalogId?: Record<string, number>;
  onlyEntryIdsByCatalogId?: Record<string, string[]>;
  downloadConcurrency?: number;
  delayBetweenDownloadsMs?: number;
  dryRun?: boolean;
  /** Persist newly imported library rows before their OPDS entries become known. */
  onBooksImported?: (newBooks: Book[]) => Promise<void>;
  /** Provider-specific ordering applied before filtering and per-catalog limits. */
  sortItems?: (input: {
    items: PendingItem[];
    catalogId: string;
    catalogName: string;
  }) => PendingItem[] | Promise<PendingItem[]>;
  shouldSkipItem?: (input: {
    item: PendingItem;
    catalogId: string;
    catalogName: string;
    sourceUrl: string;
  }) => boolean | Promise<boolean>;
  onBookImported?: (input: {
    book: Book;
    catalogId: string;
    catalogName: string;
    sourceUrl: string;
    item: PendingItem;
  }) => void | Promise<void>;
  onCatalogComplete?: (stats: OPDSCatalogSyncStats) => void | Promise<void>;
}

// --- Helpers ---

export function isRetryEligible(entry: FailedEntry): boolean {
  if (entry.attempts >= MAX_RETRY_ATTEMPTS) return false;
  const backoff = RETRY_BACKOFF_MS * Math.pow(2, entry.attempts);
  return Date.now() - entry.lastAttemptAt >= backoff;
}

export function getNextRetryAt(entries: FailedEntry[]): number | undefined {
  const retryTimes = entries
    .filter((entry) => entry.attempts < MAX_RETRY_ATTEMPTS)
    .map((entry) => entry.lastAttemptAt + RETRY_BACKOFF_MS * Math.pow(2, entry.attempts));
  return retryTimes.length > 0 ? Math.min(...retryTimes) : undefined;
}
