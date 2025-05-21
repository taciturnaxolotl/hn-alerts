import { Chalk } from "chalk";
import { randomUUIDv7 } from "bun";

// Create a console logger with fancy colors
const chalk = new Chalk({ level: 3 });
const endpoints = [
  "/api/stories",
  "/api/stats/total-stories",
  "/api/stats/verified-users",
];

// Script configuration
/**
 * Stress Test Configuration Parameters
 *
 * @remarks
 * These settings control the behavior and intensity of the load test.
 * Modify with extreme caution as improper values may cause service disruption.
 */
const CONFIG = {
  /** Target server endpoint - modify for production targets */
  baseUrl: "http://localhost:3000",

  /** @critical Initial concurrency value - starts with significant load */
  startConcurrency: 500, // Higher initial load for stress testing

  /** @warning Maximum concurrent users - can overload production systems */
  maxConcurrency: 10000, // Increased maximum for thorough performance evaluation

  /** Multiplicative step between concurrency levels (geometric progression) */
  concurrencyFactor: 2.0, // More aggressive scaling to identify breaking points faster

  /** @critical Number of sequential requests each simulated user will make */
  requestsPerUser: 25, // Increased per-user workload for extended session simulation

  /** Maximum milliseconds before timing out a request */
  requestTimeout: 8000, // Reduced timeout to identify latency issues earlier

  /** Milliseconds to wait between sequential requests from same user */
  delayBetweenRequests: 20, // Reduced delay for more intensive testing

  /** Milliseconds to pause between concurrency level increases */
  delayBetweenLevels: 2000, // Shorter recovery time between test phases

  /** Whether to utilize HTTP caching mechanisms (ETag) */
  runWithCaching: false, // Disabled caching to maximize server load

  /** @critical Minimum success rate percentage to continue testing */
  successThreshold: 95, // Lowered success threshold to detect degradation earlier

  /** @critical Maximum acceptable p95 response time in milliseconds */
  responseTimeThreshold: 350, // Stricter response time requirements

  /** Whether to abort testing when thresholds are exceeded */
  stopOnFailure: true, // Halt on threshold breach to prevent cascading failures

  /** Suppress detailed per-request logging to reduce client-side overhead */
  disableDetailedLogging: true, // Limit logging to improve test client performance

  /** Track Time To First Byte as separate metric */
  measureTTFB: true, // Important for network latency analysis

  /** Calculate and store statistical distribution of response times */
  trackPercentiles: true, // Essential for performance analysis

  /** Track time requests spend in queue vs processing (advanced) */
  trackQueueTime: false, // Disabled to reduce complexity

  /** @critical Number of requests to execute before measurement begins */
  warmupRequests: 100, // Increased warmup to ensure system stabilization
};

// Time buckets for percentile tracking (in ms)
const TIME_BUCKETS = [
  0, 10, 25, 50, 75, 100, 150, 200, 250, 300, 400, 500, 750, 1000, 1500, 2000,
  3000, 5000, 7500, 10000, 15000, 30000,
];

// Stats tracking
type EndpointStats = {
  totalRequests: number;
  successfulRequests: number;
  notModifiedResponses: number;
  failedRequests: number;
  responseTimeTotal: number;
  ttfbTimeTotal: number; // Time to first byte total
  processingTimeTotal: number; // Server processing time (TTFB to full response)
  responseTimeMin: number;
  responseTimeMax: number;
  ttfbTimeMin: number;
  ttfbTimeMax: number;
  timeBuckets: number[]; // For percentile calculations
  ttfbTimeBuckets: number[]; // TTFB percentiles
};

// Add memory usage tracking
type ConcurrencyStats = {
  concurrency: number;
  totalRequests: number;
  successfulRequests: number;
  notModifiedResponses: number;
  failedRequests: number;
  responseTimeTotal: number;
  ttfbTimeTotal: number;
  processingTimeTotal: number;
  responseTimeMin: number;
  responseTimeMax: number;
  ttfbTimeMin: number;
  ttfbTimeMax: number;
  p50ResponseTime: number; // 50th percentile (median)
  p90ResponseTime: number; // 90th percentile
  p95ResponseTime: number; // 95th percentile
  p99ResponseTime: number; // 99th percentile
  p50TTFB: number; // TTFB percentiles
  p90TTFB: number;
  p95TTFB: number;
  p99TTFB: number;
  startTime: number;
  endTime: number;
  userCompletedCount: number;
  requestsPerSecond: number;
  successRate: number;
  endpoints: Record<string, EndpointStats>;
  memoryUsage?: {
    rss: number;
    heapTotal: number;
    heapUsed: number;
    external: number;
  };
};

const concurrencyResults: ConcurrencyStats[] = [];
let breakingPoint: ConcurrencyStats | null = null;

// Current level stats
const stats = {
  concurrency: 0,
  totalRequests: 0,
  successfulRequests: 0,
  notModifiedResponses: 0,
  failedRequests: 0,
  responseTimeTotal: 0,
  ttfbTimeTotal: 0,
  processingTimeTotal: 0,
  responseTimeMin: Number.MAX_VALUE,
  responseTimeMax: 0,
  ttfbTimeMin: Number.MAX_VALUE,
  ttfbTimeMax: 0,
  p50ResponseTime: 0,
  p90ResponseTime: 0,
  p95ResponseTime: 0,
  p99ResponseTime: 0,
  p50TTFB: 0,
  p90TTFB: 0,
  p95TTFB: 0,
  p99TTFB: 0,
  startTime: 0,
  endTime: 0,
  userCompletedCount: 0,
  requestsPerSecond: 0,
  successRate: 0,
  endpoints: {} as Record<string, EndpointStats>,
};

// Initialize stats for each endpoint
for (const endpoint of endpoints) {
  stats.endpoints[endpoint] = {
    totalRequests: 0,
    successfulRequests: 0,
    notModifiedResponses: 0,
    failedRequests: 0,
    responseTimeTotal: 0,
    ttfbTimeTotal: 0,
    processingTimeTotal: 0,
    responseTimeMin: Number.MAX_VALUE,
    responseTimeMax: 0,
    ttfbTimeMin: Number.MAX_VALUE,
    ttfbTimeMax: 0,
    timeBuckets: new Array(TIME_BUCKETS.length).fill(0),
    ttfbTimeBuckets: new Array(TIME_BUCKETS.length).fill(0),
  };
}

// ETag cache for each endpoint by user
const etagCache: Record<string, string> = {};
// Helper function to calculate percentiles from time buckets
function calculatePercentile(buckets: number[], percentile: number): number {
  const totalSamples = buckets.reduce((sum, count) => sum + count, 0);
  if (totalSamples === 0) return 0;

  const targetCount = totalSamples * (percentile / 100);
  let currentCount = 0;

  for (let i = 0; i < buckets.length; i++) {
    currentCount += buckets[i] ?? 0; // Handle potential undefined values safely
    if (currentCount >= targetCount) {
      // Return the bucket boundary
      return TIME_BUCKETS[i] ?? 0; // Handle potential undefined values safely
    }
  }

  return TIME_BUCKETS[TIME_BUCKETS.length - 1] ?? 0; // Handle potential undefined value
}
// Helper function to add a time to the appropriate bucket
function addTimeToBucket(buckets: number[], time: number): void {
  for (let i = 0; i < TIME_BUCKETS.length; i++) {
    if (
      time <= (TIME_BUCKETS[i] || Number.MAX_VALUE) ||
      i === TIME_BUCKETS.length - 1
    ) {
      buckets[i] = (buckets[i] || 0) + 1;
      break;
    }
  }
}

// Spinner for loading animation
class Spinner {
  private frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  private interval: NodeJS.Timeout | null = null;
  private currentFrame = 0;
  private text: string;

  constructor(text: string) {
    this.text = text;
  }

  start() {
    this.interval = setInterval(() => {
      process.stdout.write(
        `\r${chalk.cyan(this.frames[this.currentFrame])} ${this.text}`,
      );
      this.currentFrame = (this.currentFrame + 1) % this.frames.length;
    }, 80);
  }

  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
      process.stdout.write(
        "\r                                                                      \r",
      );
    }
  }

  setText(text: string) {
    this.text = text;
  }
}

// Helper to log with timestamp
function logWithTime(
  message: string,
  type: "info" | "success" | "error" | "warn" = "info",
) {
  const timestamp = new Date().toISOString().split("T")[1]?.slice(0, -1) || "";
  const prefix = {
    info: chalk.blue(`[${timestamp}] ℹ️ `),
    success: chalk.green(`[${timestamp}] ✅ `),
    error: chalk.red(`[${timestamp}] ❌ `),
    warn: chalk.yellow(`[${timestamp}] ⚠️ `),
  }[type];

  console.log(`${prefix}${message}`);
}

// Make a HTTP request with timing
async function makeRequest(
  endpoint: string,
  userId: string,
  requestId: number,
): Promise<void> {
  const url = `${CONFIG.baseUrl}${endpoint}`;
  const headers: Record<string, string> = {
    "User-Agent": `stress-test-user-${userId}/request-${requestId}`,
  };

  // Add ETag if available and caching is enabled
  const cacheKey = `${userId}-${endpoint}`;
  if (CONFIG.runWithCaching && etagCache[cacheKey]) {
    headers["If-None-Match"] = etagCache[cacheKey];
  }

  try {
    // Start timing
    const startTime = performance.now();

    // Create AbortController for timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort();
    }, CONFIG.requestTimeout);

    // Make the request
    const response = await fetch(url, {
      headers,
      signal: controller.signal,
    });

    // Measure TTFB as soon as headers are available
    const ttfbTime = performance.now() - startTime;

    // Get the response body
    const text = await response.text();

    // Clear timeout
    clearTimeout(timeoutId);

    // End timing after body is received
    const endTime = performance.now();
    const responseTime = endTime - startTime;
    const processingTime = responseTime - ttfbTime;

    // Track overall stats
    stats.totalRequests++;
    stats.responseTimeTotal += responseTime;
    stats.ttfbTimeTotal += ttfbTime;
    stats.processingTimeTotal += processingTime;
    stats.responseTimeMin = Math.min(stats.responseTimeMin, responseTime);
    stats.responseTimeMax = Math.max(stats.responseTimeMax, responseTime);
    stats.ttfbTimeMin = Math.min(stats.ttfbTimeMin, ttfbTime);
    stats.ttfbTimeMax = Math.max(stats.ttfbTimeMax, ttfbTime);

    // Ensure the endpoint exists in stats.endpoints
    if (!stats.endpoints[endpoint]) {
      stats.endpoints[endpoint] = {
        totalRequests: 0,
        successfulRequests: 0,
        notModifiedResponses: 0,
        failedRequests: 0,
        responseTimeTotal: 0,
        ttfbTimeTotal: 0,
        processingTimeTotal: 0,
        responseTimeMin: Number.MAX_VALUE,
        responseTimeMax: 0,
        ttfbTimeMin: Number.MAX_VALUE,
        ttfbTimeMax: 0,
        timeBuckets: new Array(TIME_BUCKETS.length).fill(0),
        ttfbTimeBuckets: new Array(TIME_BUCKETS.length).fill(0),
      };
    }

    // Track endpoint-specific stats
    stats.endpoints[endpoint].totalRequests++;
    stats.endpoints[endpoint].responseTimeTotal += responseTime;
    stats.endpoints[endpoint].ttfbTimeTotal += ttfbTime;
    stats.endpoints[endpoint].processingTimeTotal += processingTime;
    stats.endpoints[endpoint].responseTimeMin = Math.min(
      stats.endpoints[endpoint].responseTimeMin,
      responseTime,
    );
    stats.endpoints[endpoint].responseTimeMax = Math.max(
      stats.endpoints[endpoint].responseTimeMax,
      responseTime,
    );
    stats.endpoints[endpoint].ttfbTimeMin = Math.min(
      stats.endpoints[endpoint].ttfbTimeMin,
      ttfbTime,
    );
    stats.endpoints[endpoint].ttfbTimeMax = Math.max(
      stats.endpoints[endpoint].ttfbTimeMax,
      ttfbTime,
    );

    // Track time buckets for percentiles
    if (CONFIG.trackPercentiles) {
      addTimeToBucket(stats.endpoints[endpoint].timeBuckets, responseTime);
      addTimeToBucket(stats.endpoints[endpoint].ttfbTimeBuckets, ttfbTime);
    }

    if (response.status === 304) {
      stats.notModifiedResponses++;
      stats.endpoints[endpoint].notModifiedResponses++;
      stats.successfulRequests++; // Count 304 as success
      stats.endpoints[endpoint].successfulRequests++;

      if (!CONFIG.disableDetailedLogging) {
        logWithTime(
          `User ${userId.slice(0, 4)} - Request ${requestId} - ${endpoint} - 304 Not Modified (${responseTime.toFixed(2)}ms, TTFB: ${ttfbTime.toFixed(2)}ms)`,
          "info",
        );
      }
    } else if (response.ok) {
      stats.successfulRequests++;
      stats.endpoints[endpoint].successfulRequests++;

      if (!CONFIG.disableDetailedLogging) {
        logWithTime(
          `User ${userId.slice(0, 4)} - Request ${requestId} - ${endpoint} - ${response.status} OK (${responseTime.toFixed(2)}ms, TTFB: ${ttfbTime.toFixed(2)}ms)`,
          "success",
        );
      }

      // Store ETag for future requests if caching is enabled
      if (CONFIG.runWithCaching) {
        const etag = response.headers.get("ETag");
        if (etag) {
          etagCache[cacheKey] = etag;
        }
      }

      // Parse JSON response for validation
      try {
        JSON.parse(text);
      } catch (e) {
        stats.failedRequests++;
        stats.endpoints[endpoint].failedRequests++;
        stats.successfulRequests--;
        stats.endpoints[endpoint].successfulRequests--;

        logWithTime(
          `User ${userId.slice(0, 4)} - Request ${requestId} - ${endpoint} - Invalid JSON response`,
          "error",
        );
      }
    } else {
      stats.failedRequests++;
      stats.endpoints[endpoint].failedRequests++;

      // Always log errors, even if detailed logging is disabled
      logWithTime(
        `User ${userId.slice(0, 4)} - Request ${requestId} - ${endpoint} - ${response.status} Error (${responseTime.toFixed(2)}ms)`,
        "error",
      );
    }
  } catch (error) {
    stats.failedRequests++;

    // Ensure the endpoint exists in stats.endpoints
    if (!stats.endpoints[endpoint]) {
      stats.endpoints[endpoint] = {
        totalRequests: 0,
        successfulRequests: 0,
        notModifiedResponses: 0,
        failedRequests: 0,
        responseTimeTotal: 0,
        ttfbTimeTotal: 0,
        processingTimeTotal: 0,
        responseTimeMin: Number.MAX_VALUE,
        responseTimeMax: 0,
        ttfbTimeMin: Number.MAX_VALUE,
        ttfbTimeMax: 0,
        timeBuckets: new Array(TIME_BUCKETS.length).fill(0),
        ttfbTimeBuckets: new Array(TIME_BUCKETS.length).fill(0),
      };
    }

    stats.endpoints[endpoint].failedRequests++;

    // Check if this was a timeout
    const errorMessage = error instanceof Error ? error.message : String(error);
    const isTimeout =
      errorMessage.includes("abort") || errorMessage.includes("timeout");

    // Always log errors, even if detailed logging is disabled
    logWithTime(
      `User ${userId.slice(0, 4)} - Request ${requestId} - ${endpoint} - ${isTimeout ? "Timeout" : "Exception"}: ${errorMessage}`,
      "error",
    );
  }
}

// Simulate a user session
async function simulateUser(userId: string): Promise<void> {
  try {
    for (let i = 0; i < CONFIG.requestsPerUser; i++) {
      // Choose a random endpoint
      const endpoint = endpoints[Math.floor(Math.random() * endpoints.length)];

      // Make sure endpoint is not undefined before adding it
      if (endpoint) {
        // Make the request
        await makeRequest(endpoint, userId, i + 1);

        // Add a small delay between requests to simulate real user behavior
        if (CONFIG.delayBetweenRequests > 0) {
          await new Promise((resolve) =>
            setTimeout(resolve, CONFIG.delayBetweenRequests),
          );
        }
      }
    }
  } catch (error) {
    logWithTime(
      `User ${userId.slice(0, 4)} - Error: ${(error as Error).message}`,
      "error",
    );
  } finally {
    // Mark user as completed regardless of success/failure
    stats.userCompletedCount++;
  }
}

// Do warmup requests to prime the server cache
async function warmupServer(): Promise<void> {
  logWithTime(
    `Warming up server with ${CONFIG.warmupRequests} requests...`,
    "info",
  );

  const spinner = new Spinner("Warming up server...");
  spinner.start();

  const promises: Promise<void>[] = [];

  for (let i = 0; i < CONFIG.warmupRequests; i++) {
    const endpoint = endpoints[i % endpoints.length];
    promises.push(
      fetch(`${CONFIG.baseUrl}${endpoint}`)
        .then(async (response) => {
          // Store the ETag for future use
          const etag = response.headers.get("ETag");
          if (etag && CONFIG.runWithCaching) {
            etagCache[`warmup-${endpoint}`] = etag;
          }

          // Read the response to completion
          await response.text();
        })
        .catch((e) => {
          logWithTime(`Warmup request error: ${e.message}`, "error");
        }),
    );
  }

  await Promise.allSettled(promises);
  spinner.stop();

  logWithTime("Server warmup complete", "success");
}

// Calculate percentiles after test completion
function calculatePercentiles(): void {
  if (!CONFIG.trackPercentiles) return;

  // Initialize combined stats objects to track cumulative data
  const combinedResponseBuckets = new Array(TIME_BUCKETS.length).fill(0);
  const combinedTTFBBuckets = new Array(TIME_BUCKETS.length).fill(0);

  // Combine all endpoint buckets
  for (const endpoint in stats.endpoints) {
    const endpointStats = stats.endpoints[endpoint];

    if (!endpointStats) continue;

    // Add this endpoint's data to the combined buckets
    for (let i = 0; i < TIME_BUCKETS.length; i++) {
      combinedResponseBuckets[i] += endpointStats.timeBuckets[i] || 0;
      combinedTTFBBuckets[i] += endpointStats.ttfbTimeBuckets[i] || 0;
    }
  }

  // Calculate overall percentiles from combined data
  stats.p50ResponseTime = calculatePercentile(combinedResponseBuckets, 50);
  stats.p90ResponseTime = calculatePercentile(combinedResponseBuckets, 90);
  stats.p95ResponseTime = calculatePercentile(combinedResponseBuckets, 95);
  stats.p99ResponseTime = calculatePercentile(combinedResponseBuckets, 99);

  stats.p50TTFB = calculatePercentile(combinedTTFBBuckets, 50);
  stats.p90TTFB = calculatePercentile(combinedTTFBBuckets, 90);
  stats.p95TTFB = calculatePercentile(combinedTTFBBuckets, 95);
  stats.p99TTFB = calculatePercentile(combinedTTFBBuckets, 99);
}

// Print results in a fancy way
function printResults() {
  console.log("\n");
  console.log(chalk.bold.cyan("🚀 Stress Test Results 🚀"));
  console.log(
    chalk.gray("════════════════════════════════════════════════════════"),
  );
  console.log(chalk.bold.white("📊 General Stats:"));
  console.log(
    `${chalk.cyan("Total Users:")} ${chalk.yellow(stats.concurrency)}`,
  );
  console.log(
    `${chalk.cyan("Completed Users:")} ${chalk.yellow(stats.userCompletedCount)}`,
  );
  console.log(
    `${chalk.cyan("Total Requests:")} ${chalk.yellow(stats.totalRequests)}`,
  );
  console.log(
    `${chalk.cyan("Successful Requests:")} ${chalk.green(stats.successfulRequests)} (${(
      (stats.successfulRequests / stats.totalRequests) *
      100
    ).toFixed(2)}%)`,
  );
  console.log(
    `${chalk.cyan("Not Modified (304):")} ${chalk.blue(stats.notModifiedResponses)} (${((stats.notModifiedResponses / stats.totalRequests) * 100).toFixed(2)}%)`,
  );
  console.log(
    `${chalk.cyan("Failed Requests:")} ${chalk.red(stats.failedRequests)} (${((stats.failedRequests / stats.totalRequests) * 100).toFixed(2)}%)`,
  );

  const durationInSeconds = (stats.endTime - stats.startTime) / 1000;
  console.log(
    `${chalk.cyan("Test Duration:")} ${chalk.yellow(durationInSeconds.toFixed(2))} seconds`,
  );
  console.log(
    `${chalk.cyan("Requests per Second:")} ${chalk.yellow((stats.totalRequests / durationInSeconds).toFixed(2))}`,
  );

  const avgResponseTime = stats.responseTimeTotal / stats.totalRequests;
  const avgTTFB = stats.ttfbTimeTotal / stats.totalRequests;
  const avgProcessingTime = stats.processingTimeTotal / stats.totalRequests;

  console.log(
    `${chalk.cyan("Average Response Time:")} ${chalk.yellow(avgResponseTime.toFixed(2))} ms`,
  );
  console.log(
    `${chalk.cyan("Average TTFB:")} ${chalk.yellow(avgTTFB.toFixed(2))} ms`,
  );
  console.log(
    `${chalk.cyan("Average Processing Time:")} ${chalk.yellow(avgProcessingTime.toFixed(2))} ms`,
  );

  console.log(
    `${chalk.cyan("Min Response Time:")} ${chalk.green(stats.responseTimeMin.toFixed(2))} ms`,
  );
  console.log(
    `${chalk.cyan("Max Response Time:")} ${chalk.red(stats.responseTimeMax.toFixed(2))} ms`,
  );

  if (CONFIG.trackPercentiles) {
    console.log(
      `${chalk.cyan("Response Time (p50/p95/p99):")} ${chalk.yellow(stats.p50ResponseTime.toFixed(2))}/${chalk.yellow(stats.p95ResponseTime.toFixed(2))}/${chalk.red(stats.p99ResponseTime.toFixed(2))} ms`,
    );
    console.log(
      `${chalk.cyan("TTFB Time (p50/p95/p99):")} ${chalk.yellow(stats.p50TTFB.toFixed(2))}/${chalk.yellow(stats.p95TTFB.toFixed(2))}/${chalk.red(stats.p99TTFB.toFixed(2))} ms`,
    );
  }

  console.log("\n");
  console.log(chalk.bold.white("📈 Endpoint Stats:"));

  for (const [endpoint, endpointStats] of Object.entries(stats.endpoints)) {
    if (endpointStats.totalRequests === 0) continue;

    console.log(
      chalk.gray("────────────────────────────────────────────────────"),
    );
    console.log(chalk.bold.cyan(`Endpoint: ${endpoint}`));
    console.log(
      `${chalk.cyan("Total Requests:")} ${chalk.yellow(endpointStats.totalRequests)}`,
    );
    console.log(
      `${chalk.cyan("Successful Requests:")} ${chalk.green(endpointStats.successfulRequests)} (${((endpointStats.successfulRequests / endpointStats.totalRequests) * 100).toFixed(2)}%)`,
    );
    console.log(
      `${chalk.cyan("Not Modified (304):")} ${chalk.blue(endpointStats.notModifiedResponses)} (${((endpointStats.notModifiedResponses / endpointStats.totalRequests) * 100).toFixed(2)}%)`,
    );
    console.log(
      `${chalk.cyan("Failed Requests:")} ${chalk.red(endpointStats.failedRequests)} (${((endpointStats.failedRequests / endpointStats.totalRequests) * 100).toFixed(2)}%)`,
    );

    const avgResponseTime =
      endpointStats.responseTimeTotal / endpointStats.totalRequests;
    const avgEndpointTTFB =
      endpointStats.ttfbTimeTotal / endpointStats.totalRequests;

    console.log(
      `${chalk.cyan("Average Response Time:")} ${chalk.yellow(avgResponseTime.toFixed(2))} ms`,
    );
    console.log(
      `${chalk.cyan("Average TTFB:")} ${chalk.yellow(avgEndpointTTFB.toFixed(2))} ms`,
    );
    console.log(
      `${chalk.cyan("Min Response Time:")} ${chalk.green(endpointStats.responseTimeMin.toFixed(2))} ms`,
    );
    console.log(
      `${chalk.cyan("Max Response Time:")} ${chalk.red(endpointStats.responseTimeMax.toFixed(2))} ms`,
    );
  }

  console.log(
    chalk.gray("════════════════════════════════════════════════════════"),
  );
  console.log(chalk.bold.green("✅ Stress Test Completed"));
  if (CONFIG.runWithCaching) {
    console.log(chalk.bold.blue("ℹ️ Test ran with caching enabled (ETags)"));
  } else {
    console.log(chalk.bold.yellow("⚠️ Test ran without caching (no ETags)"));
  }
}

// Main function
async function runConcurrencyLevel(
  concurrencyLevel: number,
): Promise<ConcurrencyStats> {
  // Reset stats for this level
  Object.assign(stats, {
    concurrency: concurrencyLevel,
    totalRequests: 0,
    successfulRequests: 0,
    notModifiedResponses: 0,
    failedRequests: 0,
    responseTimeTotal: 0,
    ttfbTimeTotal: 0,
    processingTimeTotal: 0,
    responseTimeMin: Number.MAX_VALUE,
    responseTimeMax: 0,
    ttfbTimeMin: Number.MAX_VALUE,
    ttfbTimeMax: 0,
    p50ResponseTime: 0,
    p90ResponseTime: 0,
    p95ResponseTime: 0,
    p99ResponseTime: 0,
    p50TTFB: 0,
    p90TTFB: 0,
    p95TTFB: 0,
    p99TTFB: 0,
    startTime: 0,
    endTime: 0,
    userCompletedCount: 0,
    requestsPerSecond: 0,
    successRate: 0,
    endpoints: {},
  });

  // Reset endpoint stats
  for (const endpoint of endpoints) {
    stats.endpoints[endpoint] = {
      totalRequests: 0,
      successfulRequests: 0,
      notModifiedResponses: 0,
      failedRequests: 0,
      responseTimeTotal: 0,
      ttfbTimeTotal: 0,
      processingTimeTotal: 0,
      responseTimeMin: Number.MAX_VALUE,
      responseTimeMax: 0,
      ttfbTimeMin: Number.MAX_VALUE,
      ttfbTimeMax: 0,
      timeBuckets: new Array(TIME_BUCKETS.length).fill(0),
      ttfbTimeBuckets: new Array(TIME_BUCKETS.length).fill(0),
    };
  }

  logWithTime(`Running concurrency level: ${concurrencyLevel} users`, "info");
  stats.startTime = performance.now();

  // Create user promises
  const userPromises: Promise<void>[] = [];

  for (let i = 0; i < concurrencyLevel; i++) {
    const userId = randomUUIDv7();
    userPromises.push(simulateUser(userId));
  }

  // Wait for all users to complete
  const spinner = new Spinner(
    `Running ${concurrencyLevel} concurrent users...`,
  );
  spinner.start();

  // Only update spinner occasionally to reduce logging overhead
  const updateIntervalMs = concurrencyLevel > 10000 ? 500 : 100;

  let lastCount = 0;
  const updateInterval = setInterval(() => {
    if (stats.userCompletedCount > lastCount) {
      lastCount = stats.userCompletedCount;
      // Only update text if significant progress has been made
      if (
        stats.userCompletedCount === concurrencyLevel ||
        stats.userCompletedCount %
          Math.max(1, Math.floor(concurrencyLevel / 20)) ===
          0
      ) {
        spinner.setText(
          `Progress: ${stats.userCompletedCount}/${concurrencyLevel} users (${Math.floor((stats.userCompletedCount / concurrencyLevel) * 100)}%)`,
        );
      }
    }
  }, updateIntervalMs);

  await Promise.allSettled(userPromises);

  clearInterval(updateInterval);
  spinner.stop();

  stats.endTime = performance.now();

  // Calculate final stats
  const durationInSeconds = (stats.endTime - stats.startTime) / 1000;
  stats.requestsPerSecond = stats.totalRequests / durationInSeconds;
  stats.successRate =
    stats.totalRequests > 0
      ? ((stats.successfulRequests + stats.notModifiedResponses) /
          stats.totalRequests) *
        100
      : 0;

  // Calculate percentiles from time buckets
  calculatePercentiles();

  // Capture memory usage
  if (process.memoryUsage) {
    const memoryUsage = process.memoryUsage();
    (stats as Record<string, unknown>).memoryUsage = {
      rss: memoryUsage.rss,
      heapTotal: memoryUsage.heapTotal,
      heapUsed: memoryUsage.heapUsed,
      external: memoryUsage.external,
    };
  }

  // Create a deep copy of the stats to return
  const result: ConcurrencyStats = JSON.parse(JSON.stringify(stats));

  return result;
}

// Print a summary of all concurrency levels tested
function printConcurrencySummary(): void {
  console.log("\n");
  console.log(chalk.bold.cyan("📊 Concurrency Level Summary"));
  console.log(
    chalk.gray("════════════════════════════════════════════════════════"),
  );

  // Table headers
  console.log(
    chalk.bold(
      `${chalk.cyan("Concurrency").padEnd(10)} | ` +
        `${chalk.cyan("RPS").padEnd(8)} | ` +
        `${chalk.cyan("Success %").padEnd(10)} | ` +
        `${chalk.cyan("Avg(ms)").padEnd(8)} | ` +
        `${chalk.cyan("p95(ms)").padEnd(8)} | ` +
        `${chalk.cyan("p99(ms)").padEnd(8)} | ` +
        `${chalk.cyan("TTFB p95").padEnd(8)} | ` +
        `${chalk.cyan("Status")}`,
    ),
  );

  // Separator
  console.log(
    chalk.gray(
      "───────────┼──────────┼────────────┼──────────┼──────────┼──────────┼──────────┼──────────",
    ),
  );

  // For each concurrency level tested
  for (const result of concurrencyResults) {
    const isBreakingPoint =
      breakingPoint && result.concurrency === breakingPoint.concurrency;

    // Format status based on thresholds
    const statusColor =
      result.successRate < CONFIG.successThreshold
        ? chalk.red
        : result.p95ResponseTime > CONFIG.responseTimeThreshold
          ? chalk.yellow
          : chalk.green;

    const status =
      result.successRate < CONFIG.successThreshold
        ? "FAIL"
        : result.p95ResponseTime > CONFIG.responseTimeThreshold
          ? "SLOW"
          : "PASS";

    // Text color for the entire row
    const rowColor = isBreakingPoint ? chalk.bold.red : chalk.white;

    console.log(
      rowColor(
        `${result.concurrency.toString().padEnd(10)} | ${result.requestsPerSecond.toFixed(1).padEnd(8)} | ${result.successRate.toFixed(1).padEnd(10)} | ${(result.responseTimeTotal / result.totalRequests).toFixed(1).padEnd(8)} | ${result.p95ResponseTime.toFixed(1).padEnd(8)} | ${result.p99ResponseTime.toFixed(1).padEnd(8)} | ${result.p95TTFB.toFixed(1).padEnd(8)} | ${statusColor(status)}${isBreakingPoint ? " ← BREAKING POINT" : ""}`,
      ),
    );
  }

  console.log(
    chalk.gray("════════════════════════════════════════════════════════"),
  );

  if (breakingPoint) {
    console.log(
      chalk.yellow(
        `⚠️ Breaking point detected at ${chalk.bold(breakingPoint.concurrency)} concurrent users`,
      ),
    );
    console.log(
      `   - Success Rate: ${chalk.bold(breakingPoint.successRate.toFixed(2))}% (Threshold: ${CONFIG.successThreshold}%)`,
    );
    console.log(
      `   - p95 Response Time: ${chalk.bold(breakingPoint.p95ResponseTime.toFixed(2))}ms (Threshold: ${CONFIG.responseTimeThreshold}ms)`,
    );
  } else {
    const lastConcurrency =
      concurrencyResults.length > 0
        ? concurrencyResults[concurrencyResults.length - 1]?.concurrency || 0
        : 0;

    console.log(
      chalk.green(
        `✅ No breaking point detected up to ${chalk.bold(lastConcurrency)} concurrent users`,
      ),
    );
  }

  // Find the highest RPS level
  if (concurrencyResults.length > 0) {
    const maxRpsResult = concurrencyResults.reduce((prev, current) =>
      current.requestsPerSecond > prev.requestsPerSecond ? current : prev,
    );

    console.log(
      chalk.green(
        `⚡ Peak performance: ${chalk.bold(maxRpsResult.requestsPerSecond.toFixed(2))} requests/second at ${chalk.bold(maxRpsResult.concurrency)} concurrent users`,
      ),
    );
  }
}

// Export results to CSV file
function exportToCsv(): string {
  const csvRows: string[] = [];

  // Add header row
  csvRows.push(
    "Concurrency,Requests,Success Rate,Requests/Sec,Avg Time (ms),p50 (ms),p95 (ms),p99 (ms),TTFB p50 (ms),TTFB p95 (ms),TTFB p99 (ms)",
  );

  // Add data rows
  for (const result of concurrencyResults) {
    csvRows.push(
      [
        result.concurrency,
        result.totalRequests,
        result.successRate.toFixed(2),
        result.requestsPerSecond.toFixed(2),
        (result.responseTimeTotal / result.totalRequests).toFixed(2),
        result.p50ResponseTime.toFixed(2),
        result.p95ResponseTime.toFixed(2),
        result.p99ResponseTime.toFixed(2),
        result.p50TTFB.toFixed(2),
        result.p95TTFB.toFixed(2),
        result.p99TTFB.toFixed(2),
      ].join(","),
    );
  }

  // Join all rows with newlines
  return csvRows.join("\n");
}

// Export detailed results to JSON file
function exportToJson(): string {
  return JSON.stringify(
    {
      config: CONFIG,
      results: concurrencyResults,
      breakingPoint: breakingPoint,
      timestamp: new Date().toISOString(),
    },
    null,
    2,
  );
}

// Checks if a test run fails the success criteria
function checkFailureCriteria(result: ConcurrencyStats): boolean {
  // Check success rate threshold
  if (result.successRate < CONFIG.successThreshold) {
    logWithTime(
      `Success rate ${result.successRate.toFixed(2)}% is below threshold ${CONFIG.successThreshold}%`,
      "warn",
    );
    return true;
  }

  // Check response time threshold (p95)
  if (result.p95ResponseTime > CONFIG.responseTimeThreshold) {
    logWithTime(
      `p95 response time ${result.p95ResponseTime.toFixed(2)}ms exceeds threshold ${CONFIG.responseTimeThreshold}ms`,
      "warn",
    );
    return true;
  }

  return false;
}

// Save result files
async function saveResultFiles(): Promise<void> {
  try {
    const timestamp = new Date()
      .toISOString()
      .replace(/:/g, "-")
      .replace(/\./g, "-");

    // Save CSV results
    const csvContent = exportToCsv();
    const csvFilename = `stress-test-results-${timestamp}.csv`;
    await Bun.write(csvFilename, csvContent);
    logWithTime(`Saved CSV results to ${csvFilename}`, "success");

    // Save JSON results
    const jsonContent = exportToJson();
    const jsonFilename = `stress-test-results-${timestamp}.json`;
    await Bun.write(jsonFilename, jsonContent);
    logWithTime(`Saved detailed JSON results to ${jsonFilename}`, "success");
  } catch (error) {
    logWithTime(
      `Error saving result files: ${(error as Error).message}`,
      "error",
    );
  }
}

// Main test function that runs through increasing concurrency levels
async function runTest(): Promise<void> {
  console.log(chalk.bold.cyan("🚀 API Stress Test 🚀"));
  console.log(
    chalk.gray("════════════════════════════════════════════════════════"),
  );
  console.log(chalk.cyan(`Base URL: ${CONFIG.baseUrl}`));
  console.log(chalk.cyan(`Endpoints: ${endpoints.join(", ")}`));
  console.log(
    chalk.cyan(
      `Concurrency: ${CONFIG.startConcurrency} to ${CONFIG.maxConcurrency} (×${CONFIG.concurrencyFactor} steps)`,
    ),
  );
  console.log(chalk.cyan(`Requests per user: ${CONFIG.requestsPerUser}`));
  console.log(chalk.cyan(`Success threshold: ${CONFIG.successThreshold}%`));
  console.log(
    chalk.cyan(`Response time threshold: ${CONFIG.responseTimeThreshold}ms`),
  );

  if (CONFIG.runWithCaching) {
    console.log(chalk.blue("ℹ️ Caching enabled (using ETags)"));
  } else {
    console.log(chalk.yellow("⚠️ Caching disabled (no ETags)"));
  }

  console.log(
    chalk.gray("════════════════════════════════════════════════════════"),
  );

  // Warm up the server first
  await warmupServer();

  // Start with the initial concurrency level
  let concurrencyLevel = CONFIG.startConcurrency;

  // Keep testing until we hit the max concurrency or a breaking point
  while (concurrencyLevel <= CONFIG.maxConcurrency) {
    // Run the test at this concurrency level
    const result = await runConcurrencyLevel(concurrencyLevel);

    // Store the result
    concurrencyResults.push(result);

    // Print brief stats for this level
    logWithTime(
      `Completed level: ${concurrencyLevel} users, ` +
        `RPS: ${result.requestsPerSecond.toFixed(2)}, ` +
        `Success: ${result.successRate.toFixed(2)}%, ` +
        `Avg: ${(result.responseTimeTotal / result.totalRequests).toFixed(2)}ms, ` +
        `p95: ${result.p95ResponseTime.toFixed(2)}ms`,
      "success",
    );

    // Check if we should stop
    if (CONFIG.stopOnFailure && checkFailureCriteria(result)) {
      breakingPoint = result;
      logWithTime(
        `Breaking point reached at ${concurrencyLevel} concurrent users`,
        "warn",
      );
      break;
    }

    // Increase concurrency level
    concurrencyLevel = Math.round(concurrencyLevel * CONFIG.concurrencyFactor);

    // Add a delay between levels
    if (concurrencyLevel <= CONFIG.maxConcurrency) {
      logWithTime(
        `Waiting ${CONFIG.delayBetweenLevels / 1000} seconds before next level...`,
        "info",
      );
      await new Promise((resolve) =>
        setTimeout(resolve, CONFIG.delayBetweenLevels),
      );
    }
  }

  // Print final results
  printConcurrencySummary();
  printResults();

  // Save result files
  await saveResultFiles();
}

// Check args for custom config overrides
function parseCliArgs(): void {
  const args = process.argv.slice(2);

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (!arg) continue;

    // Check for configuration overrides
    if (arg.startsWith("--")) {
      const configKey = arg
        .slice(2)
        .replace(/-([a-z])/g, (g) => g[1]?.toUpperCase() || "");
      const configValue = args[i + 1];

      if (configValue && !configValue.startsWith("--")) {
        try {
          // Convert numeric strings or booleans
          if (/^\d+$/.test(configValue)) {
            (CONFIG as Record<string, unknown>)[configKey] = Number.parseInt(
              configValue,
              10,
            );
          } else if (/^\d+\.\d+$/.test(configValue)) {
            (CONFIG as Record<string, unknown>)[configKey] =
              Number.parseFloat(configValue);
          } else if (configValue === "true" || configValue === "false") {
            (CONFIG as Record<string, unknown>)[configKey] =
              configValue === "true";
          } else {
            (CONFIG as Record<string, unknown>)[configKey] = configValue;
          }

          logWithTime(`Config override: ${configKey} = ${configValue}`, "info");
          i++; // Skip the value
        } catch (e) {
          logWithTime(
            `Error parsing config value for ${configKey}: ${e}`,
            "error",
          );
        }
      }
    }
  }
}

// Entry point
async function main(): Promise<void> {
  try {
    // Parse CLI arguments
    parseCliArgs();

    // Run the test
    await runTest();
  } catch (error) {
    logWithTime(`Stress test failed: ${(error as Error).message}`, "error");
    console.error(error);
    process.exit(1);
  }
}

// Start the test
main();
