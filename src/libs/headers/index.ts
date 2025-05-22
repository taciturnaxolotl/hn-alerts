/**
 * Security headers for the application
 *
 * This module contains header configurations for Content Security Policy
 * and other security-related headers
 */

import type { HeadersInit } from "bun";

// CSP directives to allow necessary resources while maintaining security
export const contentSecurityPolicy =
  "default-src 'self'; " +
  "script-src 'self' https://cdn.jsdelivr.net 'unsafe-inline' 'unsafe-eval'; " +
  "style-src 'self' https://cdn.jsdelivr.net 'unsafe-inline'; " +
  "img-src 'self' https://cachet.dunkirk.sh https://emoji.slack-edge.com *.slack-edge.com data:; " +
  "connect-src 'self'; " +
  "frame-src 'self';";

// Standard security headers for all responses
export const securityHeaders = {
  "Content-Security-Policy": contentSecurityPolicy,
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "X-XSS-Protection": "1; mode=block",
};

// Function to get headers for the main HTML page
export function getHtmlResponseHeaders(): HeadersInit {
  return {
    "Content-Type": "text/html",
    ...securityHeaders,
  };
}
