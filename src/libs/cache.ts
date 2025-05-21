import { version } from "../../package.json";

/**
 * Creates consistent cache headers with stable ETags
 * @param key Cache key for the resource
 * @param maxAge Max age in seconds for the Cache-Control header
 * @returns Headers object with proper caching directives
 */
export function createCacheHeaders(
  key: string,
  maxAge = 300,
): Record<string, string> {
  // Generate stable ETag based on version and cache key
  // Only changes when version changes or when cache TTL expires (divided by TTL)
  const etag = `"${version}-${key}-${Math.floor(Date.now() / (maxAge * 1000))}"`;

  return {
    "Content-Type": "application/json",
    "Cache-Control": `public, max-age=${maxAge - 10}, stale-while-revalidate=30`,
    ETag: etag,
  };
}

/**
 * Applies compression to a Response if the client supports it
 * @param request Original request to check Accept-Encoding
 * @param response Response to potentially compress
 * @returns Compressed response if possible, original otherwise
 */
export async function compressResponse(
  request: Request,
  response: Response,
): Promise<Response> {
  // Only compress JSON responses
  const contentType = response.headers.get("Content-Type");
  if (!contentType?.includes("application/json")) {
    return response;
  }

  // Check if client accepts compression
  const acceptEncoding = request.headers.get("Accept-Encoding") || "";
  if (acceptEncoding.includes("gzip")) {
    // Clone the response
    const body = await response.text();

    // Create compressed body with Bun's built-in gzip compression
    const compressedBody = Bun.gzipSync(Buffer.from(body));

    // Create new response with compressed body and updated headers
    return new Response(compressedBody, {
      status: response.status,
      headers: {
        ...Object.fromEntries(response.headers.entries()),
        "Content-Encoding": "gzip",
        "Content-Length": compressedBody.length.toString(),
      },
    });
  }
  // Bun.deflateSync uses zlib format. If we wanted to support 'deflate':
  if (acceptEncoding.includes("deflate")) {
    const body = await response.text();
    const compressedBody = Bun.deflateSync(Buffer.from(body));
    return new Response(compressedBody, {
      status: response.status,
      headers: {
        ...Object.fromEntries(response.headers.entries()),
        "Content-Encoding": "deflate",
        "Content-Length": compressedBody.length.toString(),
      },
    });
  }

  // Return original response if compression not supported/needed
  return response;
}

// Cache system for database queries
export type CacheItem<T> = {
  data: T;
  timestamp: number;
  expiresAt: number;
};

export class QueryCache {
  private cache: Map<string, CacheItem<unknown>> = new Map();
  private defaultTTL: number = 60 * 5; // 5 minutes in seconds
  private prefetchQueue: Set<string> = new Set();
  private maxItems = 500; // Maximum cache entries
  private highLoadMode = false; // Track high load mode
  private highLoadThreshold = 200; // Request threshold for high load
  private requestCounter = 0; // Counter for recent requests
  private lastCounterReset: number = Date.now(); // Last time counter was reset

  constructor(defaultTTL?: number, maxItems?: number) {
    if (defaultTTL) {
      this.defaultTTL = defaultTTL;
    }
    if (maxItems) {
      this.maxItems = maxItems;
    }
    console.log(
      `Initialized query cache with ${this.defaultTTL}s TTL and max ${this.maxItems} items`,
    );

    // Set up periodic counter reset for load detection
    setInterval(() => {
      this.highLoadMode = this.requestCounter > this.highLoadThreshold;
      this.requestCounter = 0;
      this.lastCounterReset = Date.now();
    }, 10000); // Reset every 10 seconds
  }

  async get<T>(
    key: string,
    queryFn: () => Promise<T>,
    ttl: number = this.defaultTTL,
  ): Promise<T> {
    // Track request load
    this.requestCounter++;

    const now = Math.floor(Date.now() / 1000);
    const cached = this.cache.get(key);

    // Return cached value if it exists and is not expired
    if (cached && cached.expiresAt > now) {
      // Reduce logging in high load scenarios
      if (!this.highLoadMode) {
        console.log(
          `Cache hit for ${key} (expires in ${cached.expiresAt - now}s)`,
        );
      }

      // Prefetch if approaching expiration (last 10% of TTL)
      // Don't prefetch during high load to reduce DB pressure
      if (
        !this.highLoadMode &&
        cached.expiresAt - now < ttl * 0.1 &&
        !this.prefetchQueue.has(key)
      ) {
        this.prefetch(key, queryFn, ttl);
      }

      return cached.data as T;
    }

    // Execute the query
    if (!this.highLoadMode) {
      console.log(`Cache miss for ${key}, fetching from database...`);
    }
    const data = await queryFn();

    // Cache the result
    this.cache.set(key, {
      data,
      timestamp: now,
      expiresAt: now + ttl,
    });

    // Prune cache if it exceeds max size
    this.pruneCache();

    return data;
  }

  // Background prefetch to refresh cache before expiration
  private prefetch<T>(
    key: string,
    queryFn: () => Promise<T>,
    ttl: number,
  ): void {
    this.prefetchQueue.add(key);

    // Use setTimeout to run this outside the current request
    setTimeout(async () => {
      try {
        console.log(`Prefetching ${key} before expiration`);
        const data = await queryFn();
        const now = Math.floor(Date.now() / 1000);

        this.cache.set(key, {
          data,
          timestamp: now,
          expiresAt: now + ttl,
        });

        console.log(`Successfully prefetched ${key}`);
      } catch (error) {
        console.error(`Error prefetching ${key}:`, error);
      } finally {
        this.prefetchQueue.delete(key);
      }
    }, 0);
  }

  invalidate(key: string): void {
    if (this.cache.has(key)) {
      console.log(`Invalidating cache for ${key}`);
      this.cache.delete(key);
    }
  }

  invalidateAll(): void {
    console.log("Invalidating entire cache");
    this.cache.clear();
  }

  // Prune cache when it exceeds max size using LRU policy
  private pruneCache(): void {
    if (this.cache.size <= this.maxItems) return;

    // Get all entries sorted by timestamp (oldest first)
    const entries = Array.from(this.cache.entries()).sort(
      (a, b) => a[1].timestamp - b[1].timestamp,
    );

    // Calculate how many to remove
    const removeCount = Math.ceil(this.cache.size - this.maxItems);

    // Remove oldest entries
    for (let i = 0; i < removeCount && i < entries.length; i++) {
      const entry = entries[i];
      if (entry) {
        this.cache.delete(entry[0]);
      }
    }

    if (!this.highLoadMode) {
      console.log(`Pruned ${removeCount} oldest items from cache`);
    }
  }

  // Get cache stats for monitoring
  getStats(): {
    size: number;
    keys: string[];
    highLoad: boolean;
    requestRate: number;
  } {
    const elapsedSeconds = (Date.now() - this.lastCounterReset) / 1000;
    const requestRate =
      elapsedSeconds > 0 ? this.requestCounter / elapsedSeconds : 0;

    return {
      size: this.cache.size,
      keys: Array.from(this.cache.keys()),
      highLoad: this.highLoadMode,
      requestRate: Math.round(requestRate * 100) / 100,
    };
  }
}

/**
 * Factory function for creating consistent API endpoint handlers
 * Creates consistent API endpoint handlers
 * @param cacheKey Key for caching the response
 * @param queryFn Function that performs the actual database query
 * @param ttl Cache TTL in seconds
 */
export function createCachedEndpoint<T>(
  cacheKey: string,
  queryFn: (() => Promise<T>) & { highLoad?: () => Promise<T> },
  ttl = 300,
) {
  return async (request: Request) => {
    try {
      // Check for high load indicators in headers
      const isHighLoad =
        queryCache.getStats().highLoad ||
        request.headers.get("x-high-load") === "true";

      // Use a different cache key under high load if needed
      const effectiveCacheKey = isHighLoad ? `${cacheKey}_lite` : cacheKey;

      // Execute optimized query function during high load, or regular one otherwise
      const effectiveQueryFn =
        isHighLoad && queryFn.highLoad !== undefined
          ? queryFn.highLoad
          : queryFn;

      // Get data from cache or execute query
      const data = await queryCache.get(
        effectiveCacheKey,
        effectiveQueryFn,
        ttl,
      );

      // Create response with proper caching headers
      const response = new Response(JSON.stringify(data), {
        headers: {
          ...createCacheHeaders(effectiveCacheKey, ttl),
          "X-High-Load": isHighLoad ? "true" : "false",
        },
      });

      // Apply compression and return
      return compressResponse(request, response);
    } catch (error) {
      // Log the error with context
      console.error(`Error in endpoint ${cacheKey}:`, error);

      // Capture with Sentry if available
      if (typeof Sentry !== "undefined" && Sentry.captureException) {
        Sentry.captureException(error);
      }

      // Return consistent error response
      return new Response(
        JSON.stringify({
          error: "An error occurred processing your request",
          code: "INTERNAL_SERVER_ERROR",
        }),
        {
          status: 500,
          headers: { "Content-Type": "application/json" },
        },
      );
    }
  };
}

// Create a global cache instance
export const queryCache = new QueryCache();

// Import Sentry for error reporting
import * as Sentry from "@sentry/bun";
