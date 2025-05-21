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

  constructor(defaultTTL?: number) {
    if (defaultTTL) {
      this.defaultTTL = defaultTTL;
    }
    console.log(`Initialized query cache with ${this.defaultTTL}s TTL`);
  }

  async get<T>(
    key: string,
    queryFn: () => Promise<T>,
    ttl: number = this.defaultTTL,
  ): Promise<T> {
    const now = Math.floor(Date.now() / 1000);
    const cached = this.cache.get(key);

    // Return cached value if it exists and is not expired
    if (cached && cached.expiresAt > now) {
      console.log(
        `Cache hit for ${key} (expires in ${cached.expiresAt - now}s)`,
      );

      // Prefetch if approaching expiration (last 10% of TTL)
      if (cached.expiresAt - now < ttl * 0.1 && !this.prefetchQueue.has(key)) {
        this.prefetch(key, queryFn, ttl);
      }

      return cached.data as T;
    }

    // Execute the query
    console.log(`Cache miss for ${key}, fetching from database...`);
    const data = await queryFn();

    // Cache the result
    this.cache.set(key, {
      data,
      timestamp: now,
      expiresAt: now + ttl,
    });

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

  // Get cache stats for monitoring
  getStats(): { size: number; keys: string[] } {
    return {
      size: this.cache.size,
      keys: Array.from(this.cache.keys()),
    };
  }
}

/**
 * Factory function for creating consistent API endpoint handlers
 * @param cacheKey Key for caching the response
 * @param queryFn Function that performs the actual database query
 * @param ttl Cache TTL in seconds
 */
export function createCachedEndpoint<T>(
  cacheKey: string,
  queryFn: () => Promise<T>,
  ttl = 300,
) {
  return async (request: Request) => {
    try {
      // Get data from cache or execute query
      const data = await queryCache.get(cacheKey, queryFn, ttl);

      // Create response with proper caching headers
      const response = new Response(JSON.stringify(data), {
        headers: createCacheHeaders(cacheKey, ttl),
      });

      // Apply compression and return
      return compressResponse(request, response);
    } catch (error) {
      // Log the error with context
      console.error(`Error in endpoint ${cacheKey}:`, error);

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
