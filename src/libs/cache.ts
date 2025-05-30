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
  data?: unknown,
): Record<string, string> {
  // Generate stable ETag based on version, cache key, and data hash if available
  let etag: string;
  
  if (data) {
    // Generate based on actual data content for stronger validation
    const dataStr = JSON.stringify(data);
    const dataHash = Bun.hash(dataStr).toString(36).slice(0, 12);
    etag = `"${version}-${key}-${dataHash}"`;
  } else {
    // Fallback to time-based for headers without data
    etag = `"${version}-${key}-${Math.floor(Date.now() / (maxAge * 1000))}"`;
  }

  return {
    "Content-Type": "application/json",
    "Cache-Control": `public, max-age=${maxAge - 10}, stale-while-revalidate=60`,
    ETag: etag,
    "X-Cache-Key": key, // Helps with debugging cache issues
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
  // @ts-expect-error
): Promise<Response | Bun.Response> {
  // Skip compression for non-JSON responses or small responses
  const contentType = response.headers.get("Content-Type");
  if (!contentType?.includes("application/json")) {
    return response;
  }

  // Early exit if compression is not supported by client
  const acceptEncoding = request.headers.get("Accept-Encoding") || "";
  const supportsGzip = acceptEncoding.includes("gzip");
  const supportsDeflate = acceptEncoding.includes("deflate");

  if (!supportsGzip && !supportsDeflate) {
    return response;
  }

  // Get response body
  const body = await response.text();

  // Only compress responses over a certain size (1KB)
  if (body.length < 1024) {
    return new Response(body, {
      status: response.status,
      headers: response.headers,
    });
  }

  // Get headers once
  const headers = Object.fromEntries(response.headers.entries());

  // Try gzip first as it's more widely supported
  if (supportsGzip) {
    try {
      // Use a lower compression level (4) for speed vs. size tradeoff
      const compressedBody = Bun.gzipSync(Buffer.from(body), {
        level: 4, // Medium compression level for better performance
      });

      // Only compress if it actually reduces size
      if (compressedBody.length < body.length) {
        return new Response(compressedBody, {
          status: response.status,
          headers: {
            ...headers,
            "Content-Encoding": "gzip",
            "Content-Length": compressedBody.length.toString(),
            Vary: "Accept-Encoding",
          },
        });
      }
    } catch (error) {
      // Fall back to uncompressed if compression fails
      if (!isProduction) {
        console.error("Compression error:", error);
      }
    }
  } else if (supportsDeflate) {
    try {
      const compressedBody = Bun.deflateSync(Buffer.from(body), {
        level: 4, // Medium compression level
      });

      if (compressedBody.length < body.length) {
        return new Response(compressedBody, {
          status: response.status,
          headers: {
            ...headers,
            "Content-Encoding": "deflate",
            "Content-Length": compressedBody.length.toString(),
            Vary: "Accept-Encoding",
          },
        });
      }
    } catch (error) {
      if (!isProduction) {
        console.error("Deflate compression error:", error);
      }
    }
  }

  // Return original response if compression not possible or not beneficial
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
  private priorityKeys: Set<string> = new Set(); // High-priority keys that shouldn't be evicted
  private lowLatencyMode = true; // Whether to optimize for consistent latency

  // Cache hits and misses tracking
  private hits = 0;
  private misses = 0;
  private lastGC: number = Date.now(); // Last garbage collection time

  // Registry to store query functions for reuse during cache warming
  private queryRegistry: Map<
    string,
    { fn: QueryFunction<unknown>; ttl: number; priority: boolean }
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

    // Set up periodic garbage collection for cache health
    setInterval(
      () => this.runGarbageCollection(),
      isProduction ? 300000 : 60000, // 5 min in prod, 1 min in dev
    );
  }

  /**
   * Register a query function for later use in cache warming
   * @param key Cache key
   * @param queryFn Function that performs the actual query
   * @param ttl Cache TTL in seconds
   * @param priority Whether this is a high-priority key that should resist eviction
   */
  register<T>(
    key: string,
    queryFn: QueryFunction<T>,
    ttl: number = this.defaultTTL,
    priority = false,
  ): void {
    this.queryRegistry.set(key, {
      fn: queryFn as QueryFunction<unknown>,
      ttl,
      priority,
    });

    if (priority) {
      this.priorityKeys.add(key);
    } else {
      // Make sure it's not in priority keys if priority=false
      this.priorityKeys.delete(key);
    }

    if (!isProduction) {
      console.log(
        `Registered query function for key: ${key} with TTL: ${ttl}s${priority ? " (priority)" : ""}`,
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
   * Get all non-priority registered cache keys
   * @returns Array of non-priority cache keys
   */
  getNonPriorityKeys(): string[] {
    return Array.from(this.queryRegistry.entries())
      .filter(([_, details]) => !details.priority)
      .map(([key]) => key);
  }

  /**
   * Get registration details for a specific key
   * @param key Cache key to look up
   * @returns Registration details or undefined if not found
   */
  getQueryRegistration(
    key: string,
  ):
    | { fn: QueryFunction<unknown>; ttl: number; priority: boolean }
    | undefined {
    return this.queryRegistry.get(key);
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
      // Track hit rate
      this.hits++;

      if (!isProduction) {
        console.log(
          `Cache hit for ${key} (expires in ${cached.expiresAt - now}s)`,
        );
      }

      // Aggressive prefetching for frequently accessed keys
      // Only prefetch if not already in queue and approaching expiry
      const timeToExpiry = cached.expiresAt - now;
      const isPriority = this.priorityKeys.has(key);
      // More aggressive prefetching for priority keys (15% vs 5%) and for dev (25% vs 15%)
      const prefetchThreshold = isPriority
        ? isProduction
          ? ttl * 0.15
          : ttl * 0.25 // Priority keys
        : isProduction
          ? ttl * 0.05
          : ttl * 0.15; // Regular keys

      if (timeToExpiry < prefetchThreshold && !this.prefetchQueue.has(key)) {
        // Schedule prefetch in background
        this.prefetch(key, queryFn, ttl);
      }

      return cached.data as T;
    }

    // Track miss rate
    this.misses++;

    // Execute the query (cache miss)
    if (!isProduction) {
      console.log(`Cache miss for ${key}, fetching from database...`);
    }

    // Execute query and store result
    try {
      const data = await queryFn();

      // Cache the result
      this.cache.set(key, {
        data,
        timestamp: now,
        expiresAt: now + ttl,
      });

      // Register this key if it's not already registered
      if (!this.queryRegistry.has(key)) {
        this.register(key, queryFn, ttl, this.priorityKeys.has(key));
      }

      // Check cache size asynchronously to avoid blocking the response
      if (this.cache.size > this.maxItems * 0.9) {
        // At 90% capacity
        queueMicrotask(() => this.pruneCache());
      }

      return data;
    } catch (error) {
      // If query fails but we have stale data, return it with a warning (stale-while-error)
      if (cached) {
        console.warn(
          `Query failed for ${key}, returning stale data from ${new Date(cached.timestamp * 1000).toISOString()}`,
        );
        Sentry.captureException(
          new Error(`Query failed for ${key}, returning stale data`, {
            cause: error,
          }),
        );
        return cached.data as T;
      }
      // No stale data to fall back to
      throw error;
    }
  }

  // Background prefetch to refresh cache before expiration
  private prefetch<T>(
    key: string,
    queryFn: QueryFunction<T>,
    ttl: number,
  ): void {
    this.prefetchQueue.add(key);

    // Use adaptive delay based on system load and key priority
    const isPriority = this.priorityKeys.has(key);
    const queueSize = this.prefetchQueue.size;
    let delay: number;

    if (isPriority) {
      // Priority keys get lower delay
      delay = isProduction ? 10 : 0;
    } else if (queueSize > 10) {
      // Under heavy prefetch load, increase delay for non-priority keys
      delay = isProduction ? 200 + queueSize * 10 : 100;
    } else {
      // Normal delay
      delay = isProduction ? 50 : 0;
    }

    setTimeout(async () => {
      try {
        const startTime = Date.now();
        if (!isProduction) {
          console.log(`Prefetching ${key} before expiration`);
        }

        const data = await queryFn();
        const queryTime = Date.now() - startTime;
        const now = Math.floor(Date.now() / 1000);

        // Adjust TTL based on query performance if in low latency mode
        let adjustedTtl = ttl;
        if (this.lowLatencyMode && queryTime > 200) {
          // For slow queries, extend the cache TTL to reduce frequency of expensive operations
          const slowQueryMultiplier = Math.min(3, 1 + queryTime / 1000);
          adjustedTtl = Math.floor(ttl * slowQueryMultiplier);
          if (!isProduction) {
            console.log(
              `Slow query (${queryTime}ms) for ${key}, extending TTL by ${slowQueryMultiplier}x`,
            );
          }
        }

        this.cache.set(key, {
          data,
          timestamp: now,
          expiresAt: now + adjustedTtl,
        });

        if (!isProduction) {
          console.log(`Successfully prefetched ${key} in ${queryTime}ms`);
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

    // Preserve data for priority keys by keeping their entries
    if (this.priorityKeys.size > 0) {
      const priorityEntries: [string, CacheItem<unknown>][] = [];

      // First collect all priority entries
      for (const [key, value] of this.cache.entries()) {
        if (this.priorityKeys.has(key)) {
          priorityEntries.push([key, value]);
        }
      }

      // Clear everything
      this.cache.clear();

      // Restore priority entries
      for (const [key, value] of priorityEntries) {
        this.cache.set(key, value);
      }

      if (!isProduction) {
        console.log(
          `Preserved ${priorityEntries.length} priority cache entries during invalidation`,
        );
      }
    } else {
      this.cache.clear();
    }
  }

  // Prune cache when it exceeds max size using smart eviction policy
  private pruneCache(): void {
    if (this.cache.size <= this.maxItems) return;

    // Get entries as array for sorting
    const entries = Array.from(this.cache.entries());
    const now = Math.floor(Date.now() / 1000);

    // First, check for any expired entries we can remove
    const expiredEntries = entries.filter(
      ([key, item]) => item.expiresAt <= now && !this.priorityKeys.has(key),
    );

    // If we have expired entries, remove those first
    if (expiredEntries.length > 0) {
      for (const entry of expiredEntries) {
        this.cache.delete(entry[0]);
      }

      if (!isProduction) {
        console.log(`Pruned ${expiredEntries.length} expired items from cache`);
      }

      // If removing expired entries was enough, we're done
      if (this.cache.size <= this.maxItems * 0.9) {
        return;
      }
    }

    // If we still need to remove more, use a smarter eviction policy
    // Filter out priority keys that should never be evicted
    const evictableEntries = entries.filter(
      ([key]) => !this.priorityKeys.has(key),
    );

    if (evictableEntries.length === 0) {
      console.warn(
        "Cache full but all items are priority - consider increasing cache size",
      );
      return;
    }

    // Sort by timestamp (oldest first)
    evictableEntries.sort((a, b) => a[1].timestamp - b[1].timestamp);

    // Calculate how many to remove - more aggressive cleanup (down to 70%)
    const removeCount = Math.ceil(this.cache.size - this.maxItems * 0.7);
    // Remove oldest non-priority entries
    const entriesToRemove = evictableEntries.slice(0, removeCount);
    for (const [key] of entriesToRemove) {
      this.cache.delete(key);
    }

    if (!isProduction) {
      console.log(`Pruned ${removeCount} oldest non-priority items from cache`);
    }
  }

  /**
   * Runs a full garbage collection cycle to clean expired entries
   * and optimize memory usage
   */
  private runGarbageCollection(): void {
    const now = Math.floor(Date.now() / 1000);
    let expiredCount = 0;

    // Clean expired entries
    for (const [key, item] of this.cache.entries()) {
      if (item.expiresAt <= now && !this.priorityKeys.has(key)) {
        this.cache.delete(key);
        expiredCount++;
      }
    }

    if (!isProduction && expiredCount > 0) {
      console.log(`GC: Removed ${expiredCount} expired entries`);
    }

    this.lastGC = Date.now();
  }

  // Get cache stats for monitoring
  getStats(): {
    size: number;
    keys: string[];
    registeredKeys: string[];
    requestRate: number;
    hitRate: number;
  } {
    const elapsedSeconds = (Date.now() - this.lastCounterReset) / 1000;
    const requestRate =
      elapsedSeconds > 0 ? this.requestCounter / elapsedSeconds : 0;

    const totalRequests = this.hits + this.misses;
    const hitRate = totalRequests > 0 ? this.hits / totalRequests : 0;

    return {
      size: this.cache.size,
      keys: Array.from(this.cache.keys()),
      registeredKeys: Array.from(this.queryRegistry.keys()),
      requestRate: Math.round(requestRate * 100) / 100,
      hitRate: Math.round(hitRate * 100) / 100,
    };
  }
}

// Pre-prepared error response to avoid recreation
const ERROR_RESPONSE = JSON.stringify({
  error: "An error occurred processing your request",
  code: "INTERNAL_SERVER_ERROR",
});

// Create a global cache instance with optimized settings
export const queryCache = new QueryCache(
  // Default TTL of 10 minutes in production, 5 minutes in dev
  isProduction ? 600 : 300,
  // Larger cache size to reduce evictions
  isProduction ? 1500 : 800,
);

/**
 * Factory function for creating consistent API endpoint handlers
 * @param cacheKey Key for caching the response
 * @param queryFn Function that performs the actual database query
 * @param ttl Cache TTL in seconds
 * @param isPriority Whether this endpoint should have priority in cache
 */
export function createCachedEndpoint<T>(
  cacheKey: string,
  queryFn: () => Promise<T>,
  ttl = 300,
  isPriority = false,
) {
  // Register the query function for cache warming with priority flag
  // Set frequently accessed endpoints as priority by default
  const defaultToPriority = cacheKey === "leaderboard_stories" || isPriority;
  queryCache.register(cacheKey, queryFn, ttl, defaultToPriority);

  // Prepare common response headers
  const errorHeaders = {
    "Content-Type": "application/json",
    "Cache-Control": "no-cache, no-store",
    "X-Error": "true",
  };

  // Pre-build common responses for reuse
  const errorResponse = new Response(ERROR_RESPONSE, {
    status: 500,
    headers: errorHeaders,
  });

  return async (request: Request) => {
    // Start request timing for potential performance monitoring
    const requestStart = isProduction ? 0 : performance.now();

    try {
      // Get data from cache or execute query first
      const data = await queryCache.get(cacheKey, queryFn, ttl);
      
      // Generate data-based ETag for better validation
      const headers = createCacheHeaders(cacheKey, ttl, data);
      
      // Check client ETag after we have our data
      const clientETag = request.headers.get("if-none-match");
      
      // Return 304 if client's ETag matches our data-based ETag
      if (clientETag && clientETag === headers.ETag) {
        return new Response(null, {
          status: 304,
          headers: {
            ETag: headers.ETag,
            "Cache-Control": headers["Cache-Control"] as string,
          },
        });
      }

      // Add server timing header in development
      if (!isProduction && requestStart > 0) {
        const requestTime = Math.round(performance.now() - requestStart);
        headers["Server-Timing"] = `cache;dur=${requestTime}`;
      }

      const response = new Response(JSON.stringify(data), { headers });

      // Apply compression and return
      return compressResponse(request, response);
    } catch (error) {
      // Minimal logging in production
      if (!isProduction) {
        console.error(`Error in endpoint ${cacheKey}:`, error);
      }

      // Report to Sentry without blocking
      Sentry.captureException(error);

      // Return pre-built error response
      return errorResponse.clone();
    }
  };
}
