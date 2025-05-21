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
const CONFIG = {
  baseUrl: "http://localhost:3000",
  startConcurrency: 100, // Start with higher concurrency
  maxConcurrency: 200000, // Increased max to test limits more aggressively
  concurrencyFactor: 3, // More aggressive scaling (3x per step)
  requestsPerUser: 20, // More requests per user
  delayBetweenRequests: 0, // No delay between requests for maximum load
  delayBetweenLevels: 1000, // Shorter delay between levels
  runWithCaching: false, // Disabled caching for more aggressive testing
  successThreshold: 95, // % success rate to continue
  responseTimeThreshold: 500, // ms
  stopOnFailure: true, // Stop when hitting breaking point
  disableDetailedLogging: true, // Disable per-request logging to reduce overhead
};

// Stats tracking
type EndpointStats = {
  totalRequests: number;
  successfulRequests: number;
  notModifiedResponses: number;
  failedRequests: number;
  responseTimeTotal: number;
  responseTimeMin: number;
  responseTimeMax: number;
};

// Add memory usage tracking
type ConcurrencyStats = {
  concurrency: number;
  totalRequests: number;
  successfulRequests: number;
  notModifiedResponses: number;
  failedRequests: number;
  responseTimeTotal: number;
  responseTimeMin: number;
  responseTimeMax: number;
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
  responseTimeMin: Number.MAX_VALUE,
  responseTimeMax: 0,
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
    responseTimeMin: Number.MAX_VALUE,
    responseTimeMax: 0,
  };
}
// ETag cache
const etagCache: Record<string, string> = {};

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
    const startTime = performance.now();
    const response = await fetch(url, { headers });
    const endTime = performance.now();
    const responseTime = endTime - startTime;

    // Track overall stats
    stats.totalRequests++;

    // Ensure the endpoint exists in stats.endpoints
    if (!stats.endpoints[endpoint]) {
      stats.endpoints[endpoint] = {
        totalRequests: 0,
        successfulRequests: 0,
        notModifiedResponses: 0,
        failedRequests: 0,
        responseTimeTotal: 0,
        responseTimeMin: Number.MAX_VALUE,
        responseTimeMax: 0,
      };
    }

    stats.endpoints[endpoint].totalRequests++;
    stats.responseTimeTotal += responseTime;
    stats.responseTimeMin = Math.min(stats.responseTimeMin, responseTime);
    stats.responseTimeMax = Math.max(stats.responseTimeMax, responseTime);

    // Track endpoint-specific stats
    stats.endpoints[endpoint].responseTimeTotal += responseTime;
    stats.endpoints[endpoint].responseTimeMin = Math.min(
      stats.endpoints[endpoint].responseTimeMin,
      responseTime,
    );
    stats.endpoints[endpoint].responseTimeMax = Math.max(
      stats.endpoints[endpoint].responseTimeMax,
      responseTime,
    );

    if (response.status === 304) {
      stats.notModifiedResponses++;
      stats.endpoints[endpoint].notModifiedResponses++;
      if (!CONFIG.disableDetailedLogging) {
        logWithTime(
          `User ${userId.slice(0, 4)} - Request ${requestId} - ${endpoint} - 304 Not Modified (${responseTime.toFixed(2)}ms)`,
          "info",
        );
      }
    } else if (response.ok) {
      stats.successfulRequests++;
      stats.endpoints[endpoint].successfulRequests++;
      if (!CONFIG.disableDetailedLogging) {
        logWithTime(
          `User ${userId.slice(0, 4)} - Request ${requestId} - ${endpoint} - ${response.status} OK (${responseTime.toFixed(2)}ms)`,
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

      // Parse JSON response (but don't do anything with it)
      await response.json();
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
        responseTimeMin: Number.MAX_VALUE,
        responseTimeMax: 0,
      };
    }

    stats.endpoints[endpoint].failedRequests++;
    // Always log errors, even if detailed logging is disabled
    logWithTime(
      `User ${userId.slice(0, 4)} - Request ${requestId} - ${endpoint} - Exception: ${(error as Error).message}`,
      "error",
    );
  }
}

// Simulate a user session
async function simulateUser(userId: string): Promise<void> {
  try {
    // Create all requests at once for maximum concurrency
    const requests: Promise<void>[] = [];

    for (let i = 0; i < CONFIG.requestsPerUser; i++) {
      // Choose a random endpoint
      const endpoint = endpoints[Math.floor(Math.random() * endpoints.length)];

      // Make sure endpoint is not undefined before adding it
      if (endpoint) {
        // Instead of waiting for each request, push them to an array
        requests.push(makeRequest(endpoint, userId, i + 1));

        // Add a minimal delay if configured (usually 0)
        if (CONFIG.delayBetweenRequests > 0) {
          await new Promise((resolve) =>
            setTimeout(resolve, CONFIG.delayBetweenRequests),
          );
        }
      }
    }

    // Wait for all requests to complete
    await Promise.allSettled(requests);
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
  console.log(
    `${chalk.cyan("Average Response Time:")} ${chalk.yellow(avgResponseTime.toFixed(2))} ms`,
  );
  console.log(
    `${chalk.cyan("Min Response Time:")} ${chalk.green(stats.responseTimeMin.toFixed(2))} ms`,
  );
  console.log(
    `${chalk.cyan("Max Response Time:")} ${chalk.red(stats.responseTimeMax.toFixed(2))} ms`,
  );

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
    console.log(
      `${chalk.cyan("Average Response Time:")} ${chalk.yellow(avgResponseTime.toFixed(2))} ms`,
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
    responseTimeMin: Number.MAX_VALUE,
    responseTimeMax: 0,
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
      responseTimeMin: Number.MAX_VALUE,
      responseTimeMax: 0,
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
      ? (stats.successfulRequests / stats.totalRequests) * 100
      : 0;

  // Capture memory usage
  if (process.memoryUsage) {
    const memoryUsage = process.memoryUsage();
    (stats as any).memoryUsage = {
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

function printLevelResults(levelStats: ConcurrencyStats) {
  console.log("\n");
  console.log(
    chalk.bold.cyan(`📊 Concurrency Level: ${levelStats.concurrency} users`),
  );
  console.log(
    chalk.gray("────────────────────────────────────────────────────"),
  );

  console.log(
    `${chalk.cyan("Success Rate:")} ${
      levelStats.successRate >= CONFIG.successThreshold
        ? chalk.green(`${levelStats.successRate.toFixed(2)}%`)
        : chalk.red(`${levelStats.successRate.toFixed(2)}%`)
    }`,
  );

  console.log(
    `${chalk.cyan("Requests per Second:")} ${levelStats.requestsPerSecond.toFixed(2)}`,
  );

  const avgResponseTime =
    levelStats.responseTimeTotal / levelStats.totalRequests;
  console.log(
    `${chalk.cyan("Average Response Time:")} ${
      avgResponseTime <= CONFIG.responseTimeThreshold
        ? chalk.green(`${avgResponseTime.toFixed(2)} ms`)
        : chalk.red(`${avgResponseTime.toFixed(2)} ms`)
    }`,
  );

  console.log(`${chalk.cyan("Total Requests:")} ${levelStats.totalRequests}`);
  console.log(
    `${chalk.cyan("Successful Requests:")} ${levelStats.successfulRequests}`,
  );
  console.log(`${chalk.cyan("Failed Requests:")} ${levelStats.failedRequests}`);
  console.log(
    `${chalk.cyan("Test Duration:")} ${((levelStats.endTime - levelStats.startTime) / 1000).toFixed(2)}s`,
  );

  // Add memory usage info if available
  if (levelStats.memoryUsage) {
    console.log(
      `${chalk.cyan("Memory RSS:")} ${(levelStats.memoryUsage.rss / 1024 / 1024).toFixed(2)} MB`,
    );
    console.log(
      `${chalk.cyan("Heap Used:")} ${(levelStats.memoryUsage.heapUsed / 1024 / 1024).toFixed(2)} MB`,
    );
  }
}

function printBreakingPointSummary() {
  console.log("\n");
  console.log(chalk.bold.magenta("🔥 BREAKING POINT SUMMARY 🔥"));
  console.log(
    chalk.gray("════════════════════════════════════════════════════════"),
  );

  if (breakingPoint) {
    console.log(
      chalk.bold.yellow(
        `Server breaking point: ${breakingPoint.concurrency} concurrent users`,
      ),
    );
    console.log(
      chalk.gray("────────────────────────────────────────────────────"),
    );
    console.log(
      `${chalk.cyan("Success Rate:")} ${chalk.red(`${breakingPoint.successRate.toFixed(2)}%`)}`,
    );
    console.log(
      `${chalk.cyan("Requests per Second:")} ${breakingPoint.requestsPerSecond.toFixed(2)}`,
    );

    const avgResponseTime =
      breakingPoint.responseTimeTotal / breakingPoint.totalRequests;
    console.log(
      `${chalk.cyan("Average Response Time:")} ${chalk.red(`${avgResponseTime.toFixed(2)} ms`)}`,
    );

    // Get the last successful level
    const lastGoodLevelIndex =
      concurrencyResults.findIndex(
        (stats) => stats.concurrency === breakingPoint.concurrency,
      ) - 1;

    if (lastGoodLevelIndex >= 0) {
      const safeLevel = concurrencyResults[lastGoodLevelIndex];
      if (safeLevel) {
        console.log("");
        console.log(
          chalk.bold.green(
            `✅ Recommended Safe Concurrency: ${safeLevel.concurrency} users`,
          ),
        );
        console.log(
          `${chalk.cyan("Success Rate:")} ${chalk.green(`${safeLevel.successRate.toFixed(2)}%`)}`,
        );
        console.log(
          `${chalk.cyan("Requests per Second:")} ${safeLevel.requestsPerSecond.toFixed(2)}`,
        );

        const safeAvgTime =
          safeLevel.responseTimeTotal / safeLevel.totalRequests;
        console.log(
          `${chalk.cyan("Average Response Time:")} ${chalk.green(`${safeAvgTime.toFixed(2)} ms`)}`,
        );
      }
    }
  } else {
    console.log(chalk.bold.green("✅ No breaking point found!"));

    if (concurrencyResults.length > 0) {
      const maxLevel = concurrencyResults[concurrencyResults.length - 1];
      if (maxLevel) {
        console.log(
          chalk.gray("────────────────────────────────────────────────────"),
        );
        console.log(
          chalk.bold.green(
            `Maximum tested concurrency: ${maxLevel.concurrency} users`,
          ),
        );
        console.log(
          `${chalk.cyan("Success Rate:")} ${chalk.green(`${maxLevel.successRate.toFixed(2)}%`)}`,
        );
        console.log(
          `${chalk.cyan("Requests per Second:")} ${maxLevel.requestsPerSecond.toFixed(2)}`,
        );

        const maxAvgTime = maxLevel.responseTimeTotal / maxLevel.totalRequests;
        console.log(
          `${chalk.cyan("Average Response Time:")} ${chalk.green(`${maxAvgTime.toFixed(2)} ms`)}`,
        );
      }
    }
  }

  console.log("");
  console.log(chalk.bold.white("📈 Concurrency Progression:"));

  for (const levelStats of concurrencyResults) {
    const avgResponseTime =
      levelStats.responseTimeTotal / levelStats.totalRequests;

    // Determine if this level was successful
    const isSuccessful =
      levelStats.successRate >= CONFIG.successThreshold &&
      avgResponseTime <= CONFIG.responseTimeThreshold;

    // Get icon and color based on success
    const icon = isSuccessful ? "✅" : "❌";
    const color = isSuccessful ? chalk.green : chalk.red;

    console.log(
      color(
        `${icon} ${levelStats.concurrency} users: ${levelStats.successRate.toFixed(2)}% success, ${levelStats.requestsPerSecond.toFixed(2)} req/s, ${avgResponseTime.toFixed(2)}ms avg`,
      ),
    );
  }

  console.log("");
  console.log(chalk.gray("HN Front Page Readiness Assessment:"));

  // Hacker News Front Page typically might see ~100-500 concurrent users
  if (!breakingPoint || breakingPoint.concurrency > 500) {
    console.log(
      chalk.bold.green(
        "✅ READY FOR HN FRONT PAGE! Your server can handle high traffic loads.",
      ),
    );
  } else if (breakingPoint.concurrency > 100) {
    console.log(
      chalk.bold.yellow(
        "⚠️ POTENTIALLY READY: Your server may handle the front page but could struggle with peak traffic.",
      ),
    );
  } else {
    console.log(
      chalk.bold.red(
        "❌ NOT READY: Your server is likely to fail under HN front page traffic.",
      ),
    );
  }
}

async function main() {
  console.clear();
  console.log(chalk.bold.cyan("⚡ Hacker News Breaking Point Stress Test ⚡"));
  console.log(
    chalk.gray("════════════════════════════════════════════════════════"),
  );
  console.log(`${chalk.cyan("Base URL:")} ${chalk.yellow(CONFIG.baseUrl)}`);
  console.log(
    `${chalk.cyan("Starting Users:")} ${chalk.yellow(CONFIG.startConcurrency)}`,
  );
  console.log(
    `${chalk.cyan("Maximum Users:")} ${chalk.yellow(CONFIG.maxConcurrency)}`,
  );
  console.log(
    `${chalk.cyan("Concurrency Factor:")} ${chalk.yellow(CONFIG.concurrencyFactor)}x (exponential growth)`,
  );
  console.log(
    `${chalk.cyan("Success Threshold:")} ${chalk.yellow(CONFIG.successThreshold)}%`,
  );
  console.log(
    `${chalk.cyan("Response Time Threshold:")} ${chalk.yellow(CONFIG.responseTimeThreshold)}ms`,
  );
  console.log(
    `${chalk.cyan("Caching:")} ${CONFIG.runWithCaching ? chalk.green("Enabled") : chalk.red("Disabled")}`,
  );
  console.log(
    `${chalk.cyan("Detailed Logging:")} ${!CONFIG.disableDetailedLogging ? chalk.green("Enabled") : chalk.yellow("Disabled")}`,
  );
  console.log(
    chalk.gray("════════════════════════════════════════════════════════"),
  );

  // Verify server is up
  const spinner = new Spinner("Checking server availability...");
  spinner.start();

  try {
    const response = await fetch(`${CONFIG.baseUrl}/health`);
    if (!response.ok) {
      spinner.stop();
      logWithTime(
        `Server health check failed: ${response.status} ${response.statusText}`,
        "error",
      );
      process.exit(1);
    }

    spinner.stop();
    logWithTime("Server is up and running", "success");
  } catch (error) {
    spinner.stop();
    logWithTime(`Server not available: ${(error as Error).message}`, "error");
    logWithTime(
      "Make sure the server is running before starting the stress test",
      "info",
    );
    process.exit(1);
  }

  console.log("\n");
  logWithTime("Starting breaking point test...", "info");

  let currentConcurrency = CONFIG.startConcurrency;
  let failureDetected = false;

  while (currentConcurrency <= CONFIG.maxConcurrency && !failureDetected) {
    // Run test with current concurrency level
    const levelResults = await runConcurrencyLevel(currentConcurrency);

    // Store results
    concurrencyResults.push(levelResults);

    // Print results for this level
    printLevelResults(levelResults);

    // Check if this is the breaking point
    const avgResponseTime =
      levelResults.responseTimeTotal / levelResults.totalRequests;
    if (
      levelResults.successRate < CONFIG.successThreshold ||
      avgResponseTime > CONFIG.responseTimeThreshold
    ) {
      breakingPoint = levelResults;

      if (CONFIG.stopOnFailure) {
        logWithTime(
          `Breaking point found at ${currentConcurrency} users!`,
          "warn",
        );
        failureDetected = true;
      } else {
        logWithTime(
          `Performance degradation at ${currentConcurrency} users, but continuing test...`,
          "warn",
        );
      }
    }

    // Increment concurrency exponentially for next level
    currentConcurrency = Math.floor(
      currentConcurrency * CONFIG.concurrencyFactor,
    );

    // Wait between levels
    if (!failureDetected && currentConcurrency <= CONFIG.maxConcurrency) {
      await new Promise((resolve) =>
        setTimeout(resolve, CONFIG.delayBetweenLevels),
      );
    }
  }

  // Print final summary
  printBreakingPointSummary();

  if (!breakingPoint && currentConcurrency > CONFIG.maxConcurrency) {
    logWithTime(
      "Maximum concurrency level reached without hitting breaking point.",
      "success",
    );
    logWithTime(
      `Your server can handle at least ${CONFIG.maxConcurrency} concurrent users!`,
      "success",
    );
  }
}

// Run the stress test and handle errors
main().catch((error) => {
  console.error(`${chalk.red("Fatal error:")} ${error.message}`);
  process.exit(1);
});
