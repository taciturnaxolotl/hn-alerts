import { version } from "../../package.json";
import * as Sentry from "@sentry/bun";

// Check if we're in production mode to reduce logging
const isProduction = process.env.NODE_ENV === "production";

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
  // Skip compression for small payloads or non-JSON responses
  const contentType = response.headers.get("Content-Type");
  if (!contentType?.includes("application/json")) {
    return response;
  }

  // Fast path - check headers in optimization-friendly way
  const acceptEncoding = request.headers.get("Accept-Encoding") || "";

  // Clone response body once to avoid multiple awaits
  const body = await response.text();

  // Only compress responses over a certain size
  if (body.length < 1024) {
    return new Response(body, {
      status: response.status,
      headers: response.headers,
    });
  }

  // Pre-extract headers to avoid repeated calls
  const headers = Object.fromEntries(response.headers.entries());

  if (acceptEncoding.includes("gzip")) {
    // Create compressed body with Bun's built-in gzip compression
    const compressedBody = Bun.gzipSync(Buffer.from(body));

    // Only use compression if it actually reduces size
    if (compressedBody.length < body.length) {
      return new Response(compressedBody, {
        status: response.status,
        headers: {
          ...headers,
          "Content-Encoding": "gzip",
          "Content-Length": compressedBody.length.toString(),
        },
      });
    }
  } else if (acceptEncoding.includes("deflate")) {
    const compressedBody = Bun.deflateSync(Buffer.from(body));

    // Only use compression if it actually reduces size
    if (compressedBody.length < body.length) {
      return new Response(compressedBody, {
        status: response.status,
        headers: {
          ...headers,
          "Content-Encoding": "deflate",
          "Content-Length": compressedBody.length.toString(),
        },
      });
    }
  }

  // Return original response if compression not supported/needed
  return new Response(body, {
    status: response.status,
    headers: headers,
  });
}

// Cache system for database queries
export type CacheItem<T> = {
  data: T;
  timestamp: number;
  expiresAt: number;
};

// Type for registered query functions
export type QueryFunction<T> = () => Promise<T>;

export class QueryCache {
  private cache: Map<string, CacheItem<unknown>> = new Map();
  private defaultTTL: number = 60 * 5; // 5 minutes in seconds
  private prefetchQueue: Set<string> = new Set();
  private maxItems = 500; // Maximum cache entries
  private requestCounter = 0; // Counter for recent requests
  private lastCounterReset: number = Date.now(); // Last time counter was reset

  // Registry to store query functions for reuse during cache warming
  private queryRegistry: Map<
    string,
    { fn: QueryFunction<unknown>; ttl: number }
  > = new Map();

  constructor(defaultTTL?: number, maxItems?: number) {
    if (defaultTTL) {
      this.defaultTTL = defaultTTL;
    }
    if (maxItems) {
      this.maxItems = maxItems;
    }
    if (!isProduction) {
      console.log(
        `Initialized query cache with ${this.defaultTTL}s TTL and max ${this.maxItems} items`,
      );
    }

    // Set up periodic counter reset for monitoring - less frequent in production
    setInterval(
      () => {
        this.requestCounter = 0;
        this.lastCounterReset = Date.now();
      },
      isProduction ? 30000 : 10000,
    ); // Reset every 30s in prod, 10s in dev
  }

  /**
   * Register a query function for later use in cache warming
   * @param key Cache key
   * @param queryFn Function that performs the actual query
   * @param ttl Cache TTL in seconds
   */
  register<T>(
    key: string,
    queryFn: QueryFunction<T>,
    ttl: number = this.defaultTTL,
  ): void {
    this.queryRegistry.set(key, { fn: queryFn as QueryFunction<unknown>, ttl });
    if (!isProduction) {
      console.log(
        `Registered query function for key: ${key} with TTL: ${ttl}s`,
      );
    }
  }

  /**
   * Get all registered cache keys
   * @returns Array of registered cache keys
   */
  getRegisteredKeys(): string[] {
    return Array.from(this.queryRegistry.keys());
  }

  /**
   * Get data from cache or execute the query function
   * @param key Cache key
   * @param queryFn Function that performs the actual query
   * @param ttl Cache TTL in seconds
   * @returns Query result
   */
  async get<T>(
    key: string,
    queryFn: QueryFunction<T>,
    ttl: number = this.defaultTTL,
  ): Promise<T> {
    // Track request load
    this.requestCounter++;

    const now = Math.floor(Date.now() / 1000);
    const cached = this.cache.get(key);

    // Fast path: Return cached value if it exists and is not expired
    if (cached && cached.expiresAt > now) {
      if (!isProduction) {
        console.log(
          `Cache hit for ${key} (expires in ${cached.expiresAt - now}s)`,
        );
      }

      // Prefetch if approaching expiration (last 15% of TTL) in non-prod environments
      // In production, only prefetch at 5% to reduce overhead
      const prefetchThreshold = isProduction ? 0.05 : 0.15;
      if (
        cached.expiresAt - now < ttl * prefetchThreshold &&
        !this.prefetchQueue.has(key)
      ) {
        this.prefetch(key, queryFn, ttl);
      }

      return cached.data as T;
    }

    // Execute the query (cache miss)
    if (!isProduction) {
      console.log(`Cache miss for ${key}, fetching from database...`);
    }

    const data = await queryFn();

    // Cache the result with timestamp optimization
    this.cache.set(key, {
      data,
      timestamp: now,
      expiresAt: now + ttl,
    });

    // Only prune the cache in non-critical paths
    if (this.cache.size > this.maxItems) {
      // Defer pruning to not block response
      setTimeout(() => this.pruneCache(), 0);
    }

    return data;
  }

  // Background prefetch to refresh cache before expiration
  private prefetch<T>(
    key: string,
    queryFn: QueryFunction<T>,
    ttl: number,
  ): void {
    this.prefetchQueue.add(key);

    // Use setTimeout with a small delay to avoid immediately hammering the database
    // Higher delay in production for better stability
    const delay = isProduction ? 50 : 0;

    setTimeout(async () => {
      try {
        if (!isProduction) {
          console.log(`Prefetching ${key} before expiration`);
        }

        const data = await queryFn();
        const now = Math.floor(Date.now() / 1000);

        this.cache.set(key, {
          data,
          timestamp: now,
          expiresAt: now + ttl,
        });

        if (!isProduction) {
          console.log(`Successfully prefetched ${key}`);
        }
      } catch (error) {
        console.error(`Error prefetching ${key}:`, error);
        Sentry.captureException(error);
      } finally {
        this.prefetchQueue.delete(key);
      }
    }, delay);
  }

  /**
   * Warm a specific cache entry using its registered query function
   * @param key Cache key to warm
   * @returns Promise resolving to the cached data or null if key not registered
   */
  async warmCache<T>(key: string): Promise<T | null> {
    const registration = this.queryRegistry.get(key);
    if (!registration) {
      if (!isProduction) {
        console.warn(
          `Cannot warm cache for ${key}: No registered query function`,
        );
      }
      return null;
    }

    try {
      if (!isProduction) {
        console.log(`Warming cache for ${key} using registered function`);
      }

      const data = await this.get(
        key,
        registration.fn as QueryFunction<T>,
        registration.ttl,
      );
      return data;
    } catch (error) {
      console.error(`Error warming cache for ${key}:`, error);
      Sentry.captureException(error);
      return null;
    }
  }

  invalidate(key: string): void {
    // Fast path - only log if actually invalidating
    if (this.cache.has(key)) {
      if (!isProduction) {
        console.log(`Invalidating cache for ${key}`);
      }
      this.cache.delete(key);
    }
  }

  invalidateAll(): void {
    if (!isProduction) {
      console.log("Invalidating entire cache");
    }
    this.cache.clear();
  }

  // Prune cache when it exceeds max size using LRU policy
  private pruneCache(): void {
    if (this.cache.size <= this.maxItems) return;

    // Get all entries sorted by timestamp (oldest first)
    // Only convert to array and sort what we need for better performance
    // This is much faster than sorting the entire cache
    const entries = Array.from(this.cache.entries()).sort(
      (a, b) => a[1].timestamp - b[1].timestamp,
    );

    // Calculate how many to remove - remove in larger batches when far over limit
    const overageAmount = this.cache.size - this.maxItems;
    const removeCount = Math.min(
      Math.ceil(overageAmount * 1.2), // Remove 20% more than needed to avoid frequent pruning
      Math.floor(this.maxItems * 0.2), // But never more than 20% of max items
    );

    // Remove oldest entries
    if (entries.length > 0) {
      // Take a slice of entries to remove for better performance
      const toRemove = entries.slice(0, removeCount);

      // Use batch delete for better efficiency
      for (const [key] of toRemove) {
        this.cache.delete(key);
      }
    }

    if (!isProduction) {
      console.log(`Pruned ${removeCount} oldest items from cache`);
    }
  }

  // Get cache stats for monitoring
  getStats(): {
    size: number;
    keys: string[];
    registeredKeys: string[];
    requestRate: number;
  } {
    const elapsedSeconds = (Date.now() - this.lastCounterReset) / 1000;
    const requestRate =
      elapsedSeconds > 0 ? this.requestCounter / elapsedSeconds : 0;

    return {
      size: this.cache.size,
      keys: Array.from(this.cache.keys()),
      registeredKeys: Array.from(this.queryRegistry.keys()),
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
// Memoized JSON.stringify for common objects in high-traffic scenarios
const stringifyCache = new Map<string, string>();

export function createCachedEndpoint<T>(
  cacheKey: string,
  queryFn: () => Promise<T>,
  ttl = 300,
) {
  // Register the query function for later use in cache warming
  queryCache.register(cacheKey, queryFn, ttl);

  // Pre-create cache headers to avoid recreating them on each request
  const cacheHeaders = createCacheHeaders(cacheKey, ttl);

  return async (request: Request) => {
    try {
      // Get data from cache or execute query
      const data = await queryCache.get(cacheKey, queryFn, ttl);

      let jsonString: string;

      // Try to use the stringify cache for very frequent identical responses
      // This helps tremendously with high-traffic endpoints returning the same data
      const cacheStringKey = cacheKey + JSON.stringify(data);
      if (stringifyCache.has(cacheStringKey)) {
        jsonString = stringifyCache.get(cacheStringKey)!;
      } else {
        jsonString = JSON.stringify(data);
        // Only cache strings under a certain size to avoid memory issues
        if (jsonString.length < 10000 && stringifyCache.size < 50) {
          stringifyCache.set(cacheStringKey, jsonString);
        }
      }

      // Create response with proper caching headers
      const response = new Response(jsonString, {
        headers: cacheHeaders,
      });

      // Apply compression and return
      return compressResponse(request, response);
    } catch (error) {
      // Log the error with context
      console.error(`Error in endpoint ${cacheKey}:`, error);

      // Capture with Sentry
      Sentry.captureException(error);

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
