/**
 * CORS configuration for the application
 * This adds support for Cloudflare Insights specifically
 */

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
  // Get existing headers
  const headers = new Headers(response.headers);

  // Add CORS headers specifically for Cloudflare Insights
  // Use the request's origin if it matches allowed origins
  headers.set("Access-Control-Allow-Origin", origin);
  headers.set("Access-Control-Allow-Methods", "GET, OPTIONS, POST");
  headers.set("Access-Control-Allow-Headers", "Content-Type");
  headers.set("Access-Control-Max-Age", "86400"); // Cache preflight for 24 hours

  // For browser caching
  headers.append("Vary", "Origin");

  // Create a new response with the original body and updated headers
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * Handles OPTIONS preflight requests for CORS
 * @param req The original request
 * @returns A response for preflight requests
 */
function handleCorsPreflightRequest(req: Request): Response {
  const headers = new Headers();
  const origin = req.headers.get("Origin");

  // List of allowed origins
  const allowedOrigins: string[] = [];

  // Only set the Access-Control-Allow-Origin if the origin is in our allowed list
  if (origin && allowedOrigins.includes(origin)) {
    headers.set("Access-Control-Allow-Origin", origin);
  }

  headers.set("Access-Control-Allow-Methods", "GET, OPTIONS, POST");
  headers.set("Access-Control-Allow-Headers", "Content-Type");
  headers.set("Access-Control-Max-Age", "86400"); // Cache preflight for 24 hours
  headers.set("Vary", "Origin");

  // Return 204 No Content for preflight requests
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
  return async (req: Request) => {
    const origin = req.headers.get("Origin");
    const allowedOrigins = [
      "https://static.cloudflareinsights.com",
      "https://cloudflareinsights.com",
    ];

    // Handle OPTIONS preflight requests
    if (req.method === "OPTIONS") {
      return handleCorsPreflightRequest(req);
    }

    // Process the request normally then add CORS headers
    const response = await handler(req);

    // Only add CORS headers if the origin is in our allowed list
    if (origin && allowedOrigins.includes(origin)) {
      return addCloudflareInsightsCors(response, origin);
    }

    return response;
  };
}
