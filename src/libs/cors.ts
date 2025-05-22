/**
 * CORS configuration for the application
 */

// Pre-defined CORS headers for better performance
const CORS_HEADERS = {
  "Access-Control-Allow-Methods": "GET, OPTIONS, POST",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400", // Cache preflight for 24 hours
  Vary: "Origin",
};

// Allowed origins for CORS - can be expanded as needed
const ALLOWED_ORIGINS: string[] = [];

/**
 * Adds CORS headers to a response
 * @param response The response to add CORS headers to
 * @param origin The request origin to use for Access-Control-Allow-Origin
 * @returns A new response with added CORS headers
 */
function addCorsHeaders(
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

  // If no origin or not in allowed list (if any are specified)
  if (!origin || (ALLOWED_ORIGINS.length > 0 && !ALLOWED_ORIGINS.includes(origin))) {
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
 * @param handler The original request handler function
 * @returns A new handler function with CORS support added
 */
export function handleCORS(
  handler: (req: Request) => Response | Promise<Response>,
): (req: Request) => Promise<Response> {
  return async (req: Request) => {
    // Fast path for OPTIONS - most common CORS request
    if (req.method === "OPTIONS") {
      return handleCorsPreflightRequest(req);
    }

    // Get origin early to avoid multiple header lookups
    const origin = req.headers.get("Origin");

    // Fast path for non-CORS requests
    if (!origin || (ALLOWED_ORIGINS.length > 0 && !ALLOWED_ORIGINS.includes(origin))) {
      return handler(req);
    }

    // Process the request normally then add CORS headers
    const response = await handler(req);
    return addCorsHeaders(response, origin);
  };
}
