/**
 * CORS configuration for the application
 * This adds support for Cloudflare Insights specifically
 */

// Pre-defined CORS headers for better performance
const CORS_HEADERS = {
  "Access-Control-Allow-Methods": "GET, OPTIONS, POST",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400", // Cache preflight for 24 hours
  Vary: "Origin",
};

// Allowed origins for CORS
const ALLOWED_ORIGINS = [
  "https://static.cloudflareinsights.com",
  "https://cloudflareinsights.com",
];

/**
 * Adds CORS headers to allow Cloudflare Insights
 * @param response The response to add CORS headers to
 * @param origin The request origin to use for Access-Control-Allow-Origin
 * @returns A new response with added CORS headers
 */
function addCloudflareInsightsCors(
  response: Response,
  origin: string,
): Response {
  // Get headers as plain object for better performance
  const headers = Object.fromEntries(response.headers.entries());

  // Add CORS headers (spread is faster than multiple set operations)
  const newHeaders = {
    ...headers,
    ...CORS_HEADERS,
    "Access-Control-Allow-Origin": origin,
  };

  // Create a new response with the original body and updated headers
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: newHeaders,
  });
}

/**
 * Handles OPTIONS preflight requests for CORS
 * @param req The original request
 * @returns A response for preflight requests
 */
function handleCorsPreflightRequest(req: Request): Response {
  const origin = req.headers.get("Origin");

  // Fast path: if origin is not in allowed list, return minimal response
  if (!origin || !ALLOWED_ORIGINS.includes(origin)) {
    return new Response(null, { status: 204 });
  }

  // Create headers object directly instead of using Headers class
  const headers = {
    ...CORS_HEADERS,
    "Access-Control-Allow-Origin": origin,
  };

  // Return cached 204 No Content for preflight requests
  return new Response(null, {
    status: 204,
    headers,
  });
}

/**
 * Higher-order function that adds CORS support to a request handler
 * Specifically configured for Cloudflare Insights requests
 * @param handler The original request handler function
 * @returns A new handler function with CORS support added
 */
export function handleCORS(
  handler: (req: Request) => Response | Promise<Response>,
): (req: Request) => Promise<Response> {
  // Cache response for OPTIONS requests
  const cachedOptionsResponse = new Response(null, {
    status: 204,
    headers: CORS_HEADERS,
  });

  return async (req: Request) => {
    // Fast path for OPTIONS - most common CORS request
    if (req.method === "OPTIONS") {
      return handleCorsPreflightRequest(req);
    }

    // Get origin early to avoid multiple header lookups
    const origin = req.headers.get("Origin");

    // Fast path for non-CORS requests
    if (!origin || !ALLOWED_ORIGINS.includes(origin)) {
      return handler(req);
    }

    // Process the request normally then add CORS headers
    const response = await handler(req);
    return addCloudflareInsightsCors(response, origin);
  };
}
