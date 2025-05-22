// Performance test for the HN alerts API
import { $ } from "bun";
import chalk from "chalk";

// Configuration
const API_URL = "http://localhost:3000";
const ENDPOINTS = {
  stories: "/api/stories",
  totalStories: "/api/stats/total-stories",
  verifiedUsers: "/api/stats/verified-users",
};

// Test parameters
const CONCURRENCY = 50; // Number of concurrent users
const DURATION = 30; // Test duration in seconds
const RAMP_UP = 5; // Ramp-up time in seconds
const COOLDOWN = 2; // Cooldown between tests in seconds

// Performance metrics
let totalRequests = 0;
let successfulRequests = 0;
let failedRequests = 0;
let totalLatency = 0;
let maxLatency = 0;
let minLatency = Number.POSITIVE_INFINITY;
let responseTimeDistribution = {
  under50ms: 0,
  under100ms: 0,
  under250ms: 0,
  under500ms: 0,
  under1s: 0,
  under2s: 0,
  over2s: 0,
};

// Function to format milliseconds as a human-readable duration
function formatDuration(ms) {
  if (ms < 1000) return `${ms.toFixed(2)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

// Function to send HTTP requests and measure performance
async function sendRequest(endpoint) {
  const start = performance.now();
  try {
    const response = await fetch(`${API_URL}${endpoint}`);
    const end = performance.now();
    const latency = end - start;

    if (response.status === 200) {
      totalRequests++;
      successfulRequests++;
      totalLatency += latency;
      maxLatency = Math.max(maxLatency, latency);
      minLatency = Math.min(minLatency, latency);

      // Record in distribution
      if (latency < 50) responseTimeDistribution.under50ms++;
      else if (latency < 100) responseTimeDistribution.under100ms++;
      else if (latency < 250) responseTimeDistribution.under250ms++;
      else if (latency < 500) responseTimeDistribution.under500ms++;
      else if (latency < 1000) responseTimeDistribution.under1s++;
      else if (latency < 2000) responseTimeDistribution.under2s++;
      else responseTimeDistribution.over2s++;

      return { success: true, latency, status: response.status };
    }
    totalRequests++;
    failedRequests++;
    return { success: false, latency, status: response.status };
  } catch (error) {
    totalRequests++;
    failedRequests++;
    const end = performance.now();
    return { success: false, latency: end - start, error: error.message };
  }
}

// Function to show progress
function showProgress(current, total, testName) {
  const progressBar = "█"
    .repeat(Math.floor((current / total) * 30))
    .padEnd(30, "░");
  process.stdout.write(
    `\r${testName}: [${progressBar}] ${Math.floor((current / total) * 100)}% `,
  );
}

// Run load test for a specific endpoint
async function runLoadTest(endpoint, name) {
  console.log(chalk.blue(`\n📊 Starting load test for ${name} (${endpoint})`));
  console.log(
    chalk.gray(`   ${CONCURRENCY} concurrent users for ${DURATION} seconds`),
  );

  // Reset metrics
  totalRequests = 0;
  successfulRequests = 0;
  failedRequests = 0;
  totalLatency = 0;
  maxLatency = 0;
  minLatency = Number.POSITIVE_INFINITY;
  responseTimeDistribution = {
    under50ms: 0,
    under100ms: 0,
    under250ms: 0,
    under500ms: 0,
    under1s: 0,
    under2s: 0,
    over2s: 0,
  };

  const startTime = Date.now();
  const endTime = startTime + DURATION * 1000;

  // Array to track active promises
  const activePromises = new Set();

  let testInterval;
  try {
    testInterval = setInterval(() => {
      const elapsedTime = Date.now() - startTime;
      const progress = Math.min(elapsedTime / (DURATION * 1000), 1);
      showProgress(elapsedTime, DURATION * 1000, name);

      // Determine how many active users should be present based on ramp-up
      let targetConcurrency = CONCURRENCY;
      if (elapsedTime < RAMP_UP * 1000) {
        targetConcurrency = Math.ceil(
          (elapsedTime / (RAMP_UP * 1000)) * CONCURRENCY,
        );
      }

      // Add more requests if needed and we're still within the test duration
      while (activePromises.size < targetConcurrency && Date.now() < endTime) {
        const promise = sendRequest(endpoint).then((result) => {
          activePromises.delete(promise);
        });
        activePromises.add(promise);
      }
    }, 50);

    // Wait for the test duration
    await new Promise((resolve) => setTimeout(resolve, DURATION * 1000));

    // Clean up the interval
    clearInterval(testInterval);

    // Wait for all in-flight requests to complete
    await Promise.all(Array.from(activePromises));

    // Calculate final metrics
    const avgLatency =
      totalRequests > 0 ? totalLatency / successfulRequests : 0;
    const successRate =
      totalRequests > 0 ? (successfulRequests / totalRequests) * 100 : 0;
    const requestsPerSecond = totalRequests / DURATION;

    // Print results
    console.log(`\n\n${chalk.green("📈 Test Results:")}`);
    console.log(chalk.bold(`   Endpoint: ${endpoint}`));
    console.log(`   Total Requests: ${chalk.yellow(totalRequests)}`);
    console.log(
      `   Successful: ${chalk.green(successfulRequests)} (${successRate.toFixed(1)}%)`,
    );
    console.log(`   Failed: ${chalk.red(failedRequests)}`);
    console.log(
      `   Requests/second: ${chalk.cyan(requestsPerSecond.toFixed(2))}`,
    );
    console.log(
      `   Avg Response Time: ${chalk.cyan(formatDuration(avgLatency))}`,
    );
    console.log(
      `   Min Response Time: ${chalk.cyan(formatDuration(minLatency))}`,
    );
    console.log(
      `   Max Response Time: ${chalk.cyan(formatDuration(maxLatency))}`,
    );

    console.log("\n   Response Time Distribution:");
    console.log(
      `     < 50ms:   ${chalk.green(responseTimeDistribution.under50ms)} (${((responseTimeDistribution.under50ms / totalRequests) * 100).toFixed(1)}%)`,
    );
    console.log(
      `     < 100ms:  ${chalk.green(responseTimeDistribution.under100ms)} (${((responseTimeDistribution.under100ms / totalRequests) * 100).toFixed(1)}%)`,
    );
    console.log(
      `     < 250ms:  ${chalk.yellow(responseTimeDistribution.under250ms)} (${((responseTimeDistribution.under250ms / totalRequests) * 100).toFixed(1)}%)`,
    );
    console.log(
      `     < 500ms:  ${chalk.yellow(responseTimeDistribution.under500ms)} (${((responseTimeDistribution.under500ms / totalRequests) * 100).toFixed(1)}%)`,
    );
    console.log(
      `     < 1s:     ${chalk.yellow(responseTimeDistribution.under1s)} (${((responseTimeDistribution.under1s / totalRequests) * 100).toFixed(1)}%)`,
    );
    console.log(
      `     < 2s:     ${chalk.red(responseTimeDistribution.under2s)} (${((responseTimeDistribution.under2s / totalRequests) * 100).toFixed(1)}%)`,
    );
    console.log(
      `     >= 2s:    ${chalk.red(responseTimeDistribution.over2s)} (${((responseTimeDistribution.over2s / totalRequests) * 100).toFixed(1)}%)`,
    );
  } catch (error) {
    clearInterval(testInterval);
    console.error(chalk.red(`\nTest failed: ${error.message}`));
  }

  // Cooldown period
  if (COOLDOWN > 0) {
    console.log(chalk.gray(`\nCooling down for ${COOLDOWN} seconds...`));
    await new Promise((resolve) => setTimeout(resolve, COOLDOWN * 1000));
  }
}

// Main function to run all tests
async function runAllTests() {
  console.log(chalk.bold.blue("\n🔍 HN-ALERTS API PERFORMANCE TEST\n"));

  try {
    // Test health endpoint first to make sure the API is up
    console.log(chalk.gray("Checking API health..."));
    const healthCheck = await fetch(`${API_URL}/health`);
    if (!healthCheck.ok) {
      throw new Error(
        `API health check failed with status ${healthCheck.status}`,
      );
    }
    console.log(chalk.green("✅ API is healthy and responding\n"));

    // Run tests for each endpoint
    for (const [name, endpoint] of Object.entries(ENDPOINTS)) {
      await runLoadTest(endpoint, name);
    }

    console.log(chalk.bold.green("\n🎉 All tests completed successfully!\n"));
  } catch (error) {
    console.error(chalk.bold.red(`\n❌ Testing failed: ${error.message}\n`));
    process.exit(1);
  }
}

// Run the tests
runAllTests();
