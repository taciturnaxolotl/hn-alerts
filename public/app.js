document.addEventListener("DOMContentLoaded", () => {
  // Elements
  const storyList = document.getElementById("story-list");
  const refreshButton = document.getElementById("refresh-data");
  const noGraph = document.getElementById("no-graph");
  const rankChart = document.getElementById("rank-chart");
  const verifiedOnlyToggle = document.getElementById("verified-only-toggle");

  // Auto-refresh timer
  let autoRefreshTimer = null;
  const AUTO_REFRESH_INTERVAL = 2 * 60 * 1000; // 2 minutes in milliseconds

  // Live counter timer
  const LIVE_COUNTER_INTERVAL = 1000; // Update every second
  let liveCounterTimer = null;

  // Track verified user stats
  let verifiedUserStats = {
    frontPageCount: 0,
    avgPeakPoints: 0,
    totalCount: 0,
    timestamp: 0,
  };

  // Performance metrics elements
  const currentFrontpageCountEl = document.getElementById(
    "current-frontpage-count",
  );
  const topTenCountEl = document.getElementById("top-ten-count");
  const mostActiveTimeEl = document.getElementById("most-active-time");
  const avgFrontpageTimeEl = document.getElementById("avg-frontpage-time");
  let totalStoriesCount = 0; // Track total stories count
  let headerStatsLoaded = false; // Track if header stats have been loaded

  // Initialize stats
  updatePerformanceMetrics([]);

  // For calculating durations (updated live)
  let now = Date.now();

  // Utility function to format time duration
  function formatDuration(ms) {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) {
      return `${days}d ${hours % 24}h`;
    }

    if (hours > 0) {
      return `${hours}h ${minutes % 60}m`;
    }

    if (minutes > 0) {
      return `${minutes}m ${seconds % 60}s`;
    }

    return `${seconds}s`;
  }

  // Get duration class based on time
  function getDurationClass(ms) {
    const hours = ms / (1000 * 60 * 60);

    if (hours >= 18) {
      return "duration-long"; // Long-lasting story (18+ hours)
    }
    if (hours >= 10) {
      return "duration-medium"; // Medium-lasting story (10-18 hours)
    }
    if (hours >= 3) {
      return "duration-normal"; // Normal duration (3-12 hours)
    }
    return "duration-short"; // New story (<3 hours)
  }

  // Get emoji for duration visualization
  function getDurationEmoji(ms) {
    const hours = ms / (1000 * 60 * 60);

    if (hours >= 24) {
      return "⏳"; // Long duration
    }
    if (hours >= 12) {
      return "⌛"; // Medium duration
    }
    if (hours >= 3) {
      return "🕙"; // Normal duration
    }
    return "🆕"; // New story
  }

  // Chart instance
  let chart = null;
  let activeStoryId = null;
  let topRankRecord = Number.POSITIVE_INFINITY; // Track the all-time best rank
  let allStories = []; // Store all stories for filtering
  let showVerifiedOnly = false; // Default to showing all stories

  // Cache for ETags and data to support conditional requests with sessionStorage persistence
  const etagCache = JSON.parse(sessionStorage.getItem('etagCache') || JSON.stringify({
    stories: null,
    totalStories: null,
    verifiedUsers: null,
  }));

  // Cache for actual response data
  const responseCache = JSON.parse(sessionStorage.getItem('responseCache') || JSON.stringify({
    stories: null,
    totalStories: null,
    verifiedUsers: null,
  }));

  // Helper function to persist cache state
  function persistCaches() {
    sessionStorage.setItem('etagCache', JSON.stringify(etagCache));
    sessionStorage.setItem('responseCache', JSON.stringify(responseCache));
  }

  // Fetch stories data
  function fetchStories() {
    // Update last refresh time
    window.lastRefreshTime = Date.now();

    // Keep a copy of the current stories for metrics calculation during loading
    const previousStories =
      allStories && allStories.length > 0 ? [...allStories] : null;

    storyList.innerHTML = '<div class="loading">Loading stories...</div>';

    // Ensure live counters are running
    if (!liveCounterTimer) {
      startLiveCounters();
    }

    // Fetch total stories count first
    const totalStoriesOptions = {
      headers: {},
    };

    // Add If-None-Match header if we have an ETag
    if (etagCache.totalStories) {
      totalStoriesOptions.headers["If-None-Match"] = etagCache.totalStories;
    }

    fetch("/api/stats/total-stories", totalStoriesOptions)
      .then((response) => {
        // Store the new ETag if available
        const etag = response.headers.get("ETag");
        if (etag) {
          etagCache.totalStories = etag;
          persistCaches();
        }

        // If 304 Not Modified, use cached data
        if (response.status === 304) {
          console.log("Total stories not modified, using cached data");
          return Promise.resolve(responseCache.totalStories); // Use cached data
        }

        return response.json();
      })
      .then((data) => {
        if (data) {
          // Store in cache for future 304 responses
          responseCache.totalStories = data;
          persistCaches();

          if (typeof data.count !== "undefined") {
            totalStoriesCount = data.count;
            currentFrontpageCountEl.textContent = totalStoriesCount;
          }
        }
      })
      .catch((error) => {
        console.error("Error fetching total stories count:", error);
      });

    // Fetch verified user stats for the top row
    const verifiedUsersOptions = {
      headers: {},
    };

    // Add If-None-Match header if we have an ETag
    if (etagCache.verifiedUsers) {
      verifiedUsersOptions.headers["If-None-Match"] = etagCache.verifiedUsers;
    }

    // Add Accept-Encoding header if browser supports it
    if ('Accept-Encoding' in navigator) {
      verifiedUsersOptions.headers["Accept-Encoding"] = "gzip, deflate, br";
    }

    fetch("/api/stats/verified-users", verifiedUsersOptions)
      .then((response) => {
        // Store the new ETag if available
        const etag = response.headers.get("ETag");
        if (etag) {
          etagCache.verifiedUsers = etag;
          persistCaches();
        }

        // If 304 Not Modified, use cached data
        if (response.status === 304) {
          console.log("Verified users not modified, using cached data");
          return Promise.resolve(responseCache.verifiedUsers); // Use cached data
        }

        return response.json();
      })
      .then((data) => {
        if (data) {
          // Store in cache for future 304 responses
          responseCache.verifiedUsers = data;
          persistCaches();

          verifiedUserStats = data;
          updateTopStats(data); // Update UI with the new stats
        }
      })
      .catch((error) => {
        console.error("Error fetching verified user stats:", error);
      });
      
    // Fetch header stats for performance metrics
    const statsHeaderOptions = {
      headers: {},
    };
    
    // Add If-None-Match header if we have an ETag
    if (etagCache.statsHeader) {
      statsHeaderOptions.headers["If-None-Match"] = etagCache.statsHeader;
    }
    
    // Add Accept-Encoding header if browser supports it
    if ('Accept-Encoding' in navigator) {
      statsHeaderOptions.headers["Accept-Encoding"] = "gzip, deflate, br";
    }
    
    fetch("/api/stats/header", statsHeaderOptions)
      .then((response) => {
        // Store the new ETag if available
        const etag = response.headers.get("ETag");
        if (etag) {
          etagCache.statsHeader = etag;
          persistCaches();
        }
        
        // If 304 Not Modified, use cached data
        if (response.status === 304) {
          console.log("Stats header not modified, using cached data");
          return Promise.resolve(responseCache.statsHeader); // Use cached data
        }
        
        return response.json();
      })
      .then((data) => {
        if (data) {
          // Store in cache for future 304 responses
          responseCache.statsHeader = data;
          persistCaches();
          
          // Update UI with the stats header data
          updateHeaderStats(data);
        }
      })
      .catch((error) => {
        console.error("Error fetching stats header:", error);
      });

    // Fetch stories
    const storiesOptions = {
      headers: {},
    };

    // Add If-None-Match header if we have an ETag
    if (etagCache.stories) {
      storiesOptions.headers["If-None-Match"] = etagCache.stories;
    }

    // Add Accept-Encoding header if browser supports it
    if ('Accept-Encoding' in navigator) {
      storiesOptions.headers["Accept-Encoding"] = "gzip, deflate, br";
    }

    fetch("/api/stories", storiesOptions)
      .then((response) => {
        // Store the new ETag if available
        const etag = response.headers.get("ETag");
        if (etag) {
          etagCache.stories = etag;
          persistCaches();
        }

        if (!response.ok) {
          // Allow 304 Not Modified
          if (response.status === 304) {
            console.log("Stories not modified, using cached data");
            return Promise.resolve(responseCache.stories); // Use cached data
          }
          throw new Error("Network response was not ok");
        }
        return response.json();
      })
      .then((data) => {
        if (data) {
          // Store in cache for future 304 responses
          responseCache.stories = data;
          persistCaches();

          // Store all stories for filtering
          allStories = data;
          // Apply filters and update UI
          applyFiltersAndUpdateUI(previousStories);
        }
      })
      .catch((error) => {
        // If there was an error but we have previous stories, keep showing them
        if (previousStories && previousStories.length > 0) {
          allStories = previousStories;
          applyFiltersAndUpdateUI();
        } else {
          storyList.innerHTML = `<div class="loading">Error loading data: ${error.message}</div>`;
        }
        console.error("Error fetching stories:", error);
      });
  }

  // Apply filters and update UI
  function applyFiltersAndUpdateUI(fallbackStories = null) {
    // Use fallbackStories for metrics if current stories are empty
    const storiesForMetrics =
      !allStories || allStories.length === 0 ? fallbackStories : allStories;

    if (!allStories || allStories.length === 0) {
      if (!fallbackStories) return;
      // If we have no current stories but have fallback, only update metrics
      updatePerformanceMetrics(fallbackStories);
      return;
    }

    // Apply filters
    let filteredStories = allStories;

    // Filter for verified users if enabled
    if (showVerifiedOnly) {
      filteredStories = filteredStories.filter(
        (story) => story.isFromMonitoredUser,
      );
    }

    // Update UI with filtered stories
    displayStories(filteredStories);
    updatePerformanceMetrics(storiesForMetrics); // Use appropriate stories for metrics
  }

  // Display stories in the UI
  function displayStories(stories) {
    if (!stories || stories.length === 0) {
      storyList.innerHTML = '<div class="loading">No stories found.</div>';
      return;
    }

    // Update the all-time top rank record
    const bestRank = Math.min(...stories.map((s) => s.rank));
    const isNewTopRecord = bestRank < topRankRecord;
    if (isNewTopRecord) {
      topRankRecord = bestRank;
    }

    // Store stories globally for duration updates
    window.displayedStories = stories;
    now = Date.now(); // Update current time for accurate initial durations

    let html = "";
    for (let i = 0; i < stories.length; i++) {
      const story = stories[i];
      const date = new Date(story.timestamp).toLocaleString();
      const isCurrentRankOne = story.rank === 1; // Check if current rank is 1
      const isBestRankOne = story.peakRank === 1; // Check if best rank is 1
      const isCurrentTop = story.rank === 1;

      // Calculate duration on front page
      const timestampMs = new Date(story.timestamp).getTime();
      const durationMs = now - timestampMs;

      // Format the duration text and get appropriate class
      const durationText = formatDuration(durationMs);
      const durationClass = getDurationClass(durationMs);
      const durationEmoji = getDurationEmoji(durationMs);

      // Build the rank display with icons
      let rankDisplay = `<p>Current Rank: #${story.rank}`;

      // Add trophy for current rank if it's 1
      if (isCurrentRankOne) {
        rankDisplay +=
          ' <span class="trophy" title="Top Ranked Story">🏆</span>';
      }

      rankDisplay += ` | Best Rank: #${story.peakRank}`;

      // Add star for best rank if it's 1
      if (isBestRankOne) {
        rankDisplay +=
          ' <span class="former-top" title="Previously Top Ranked">⭐</span>';
      }

      rankDisplay += "</p>";

      // Add verified badge if story is from a monitored user
      html += `
        <div class="story-item${isCurrentTop ? " top-story" : ""}${isCurrentRankOne ? " top-ranked" : ""}${isBestRankOne && !isCurrentRankOne ? " previously-top-ranked" : ""}" data-id="${story.id}" data-url="${story.url}" data-timestamp="${timestampMs}">
            <h3>${story.title}</h3>
            ${rankDisplay}
            <div class="story-meta">
                <span>Points: ${story.points}</span>
                <span>Peak Points: ${story.peakPoints || story.points}</span>
                <span>Comments: ${story.comments}</span>
                <span>By: ${story.by}${story.isFromMonitoredUser ? " 💖" : ""}</span>
            </div>
            <div class="story-meta">
                <span>Detected: ${date}</span>
                <span class="duration ${durationClass}" title="Time since first detection" data-timestamp="${timestampMs}" data-story-id="${story.id}">${durationEmoji} ${durationText}</span>
                <span><a href="${story.url}" target="_blank" class="external-link">View Story ↗</a></span>
                <span><a href="/item?id=${story.id}" class="item-link">View Stats</a></span>
            </div>
        </div>
      `;
    }

    storyList.innerHTML = html;

    // Add event listeners to story items
    const storyItems = document.querySelectorAll(".story-item");

    for (const item of storyItems) {
      // Ensure timestamps are available for live updates
      if (!item.hasAttribute("data-timestamp")) {
        const storyId = item.getAttribute("data-id");
        const story = stories.find((s) => s.id.toString() === storyId);
        if (story?.timestamp) {
          const timestamp = new Date(story.timestamp).getTime();
          item.setAttribute("data-timestamp", timestamp);
        }
      }

      item.addEventListener("click", (e) => {
        // Prevent triggering when clicking links
        if (
          e.target.classList.contains("external-link") ||
          e.target.closest(".external-link") ||
          e.target.classList.contains("item-link") ||
          e.target.closest(".item-link")
        ) {
          return;
        }

        const storyId = item.dataset.id;
        loadStoryGraph(storyId);

        // Mark as active
        const allItems = document.querySelectorAll(".story-item");
        for (const i of allItems) {
          i.classList.remove("active");
        }
        item.classList.add("active");
      });
    }
  }

  // Load story snapshots and display graph
  // Cache for story snapshot ETags and data
  const snapshotEtagCache = {};
  const snapshotDataCache = {};

  function loadStoryGraph(storyId) {
    if (activeStoryId === storyId) return;
    activeStoryId = storyId;

    noGraph.style.display = "flex";
    rankChart.style.display = "none";
    noGraph.innerHTML = '<div class="loading">Loading graph data...</div>';

    const options = {
      headers: {},
    };

    // Add If-None-Match header if we have an ETag for this story
    if (snapshotEtagCache[storyId]) {
      options.headers["If-None-Match"] = snapshotEtagCache[storyId];
    }

    // Use template literal correctly since we need string interpolation
    fetch(`/api/story/${storyId}/snapshots`, options)
      .then((response) => {
        // Store the new ETag if available
        const etag = response.headers.get("ETag");
        if (etag) snapshotEtagCache[storyId] = etag;

        if (!response.ok) {
          // Allow 304 Not Modified
          if (response.status === 304) {
            console.log(
              `Story ${storyId} snapshots not modified, using cached data`,
            );
            // Use the cached data for this story ID
            if (snapshotDataCache[storyId]) {
              return snapshotDataCache[storyId];
            }
            // If we don't have cached data, re-fetch
            throw new Error("Cache miss on 304, re-fetching");
          }
          throw new Error("Failed to fetch snapshot data");
        }
        return response.json();
      })
      .then((snapshots) => {
        if (!snapshots || snapshots.length === 0) {
          noGraph.innerHTML =
            "<p>No historical data available for this story.</p>";
          return;
        }

        // Cache the snapshots data for future use
        snapshotDataCache[storyId] = snapshots;

        displayGraph(snapshots);
      })
      .catch((error) => {
        console.error("Error fetching snapshots:", error);
        noGraph.innerHTML = `<p>Error loading graph: ${error.message}</p>`;
      });
  }

  // Display the rank history graph
  function displayGraph(snapshots) {
    noGraph.style.display = "none";
    rankChart.style.display = "block";

    // Prepare data for Chart.js
    const timestamps = snapshots.map((snap) => snap.date);
    const positionData = snapshots.map((snap) => snap.position);
    const scoreData = snapshots.map((snap) => snap.score);

    // Create data points that Chart.js can use without time adapter
    const positionDataPoints = timestamps.map((t, i) => ({
      x: new Date(t).getTime(),
      y: positionData[i],
    }));

    const scoreDataPoints = timestamps.map((t, i) => ({
      x: new Date(t).getTime(),
      y: scoreData[i],
    }));

    // Update the chart data instead of destroying and recreating
    // Destroy existing chart if it exists
    if (chart) {
      chart.destroy();
    }

    // Create new chart
    chart = new Chart(rankChart, {
      type: "line",
      data: {
        datasets: [
          {
            label: "Rank (Position)",
            data: positionDataPoints,
            borderColor: "#ff6600",
            backgroundColor: "rgba(255, 102, 0, 0.1)",
            tension: 0.1,
            yAxisID: "y",
          },
          {
            label: "Score (Points)",
            data: scoreDataPoints,
            borderColor: "#3b82f6",
            backgroundColor: "rgba(59, 130, 246, 0.1)",
            tension: 0.1,
            yAxisID: "y1",
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          x: {
            type: "linear",
            position: "bottom",
            title: {
              display: true,
              text: "Time",
            },
            ticks: {
              callback: (value) => new Date(value).toLocaleString(),
            },
          },
          y: {
            position: "left",
            reverse: true, // Lower rank numbers (better) should be at the top
            title: {
              display: true,
              text: "Rank",
            },
            grid: {
              display: true,
            },
          },
          y1: {
            position: "right",
            title: {
              display: true,
              text: "Points",
            },
            grid: {
              display: false,
            },
          },
        },
        plugins: {
          tooltip: {
            callbacks: {
              title: (context) =>
                new Date(context[0].parsed.x).toLocaleString(),
            },
          },
        },
      },
    });
  }

  // Update performance metrics
  function updatePerformanceMetrics(stories) {
    if (!stories || stories.length === 0) {
      // Don't reset values to zero if they already have values
      // This prevents flickering during refresh operations
      if (
        topTenCountEl.textContent === "0" ||
        topTenCountEl.textContent === ""
      ) {
        topTenCountEl.textContent = "0";
      }
      if (
        mostActiveTimeEl.textContent === "N/A" ||
        mostActiveTimeEl.textContent === ""
      ) {
        mostActiveTimeEl.textContent = "N/A";
      }
      if (
        avgFrontpageTimeEl.textContent === "N/A" ||
        avgFrontpageTimeEl.textContent === ""
      ) {
        avgFrontpageTimeEl.textContent = "N/A";
      }
      return;
    }

    // Update current time for accurate calculations
    now = Date.now();

    // Get total stories from the API
    const options = {
      headers: {},
    };

    // Add If-None-Match header if we have an ETag
    if (etagCache.totalStories) {
      options.headers["If-None-Match"] = etagCache.totalStories;
    }

    fetch("/api/stats/total-stories", options)
      .then((response) => {
        // Store the new ETag if available
        const etag = response.headers.get("ETag");
        if (etag) etagCache.totalStories = etag;

        // If 304 Not Modified, use cached data
        if (response.status === 304) {
          console.log(
            "Total stories not modified, using cached data for metrics",
          );
          return responseCache.totalStories;
        }

        return response.json();
      })
      .then((data) => {
        if (data) {
          // Update cache
          responseCache.totalStories = data;

          if (data.count !== undefined) {
            currentFrontpageCountEl.textContent = data.count;
          } else {
            currentFrontpageCountEl.textContent = allStories.length; // Fallback to local data
          }
        } else {
          currentFrontpageCountEl.textContent = allStories.length; // Fallback to local data
        }
      })
      .catch((error) => {
        console.error("Error fetching total stories count:", error);
        currentFrontpageCountEl.textContent = allStories.length; // Fallback to local data
      });

    // Find highest points ever achieved
    const highestPointsStory = stories.reduce((highest, story) => {
      return (story.peakPoints || story.points) >
        (highest.peakPoints || highest.points)
        ? story
        : highest;
    }, stories[0]);
    topTenCountEl.textContent = `${highestPointsStory.peakPoints || highestPointsStory.points}`;

    // Calculate average points per story
    const totalPoints = stories.reduce((sum, story) => sum + story.points, 0);
    const avgPoints = Math.round(totalPoints / stories.length);
    mostActiveTimeEl.textContent = avgPoints;

    // Calculate average time on front page
    let totalMs = 0;
    let storiesWithDuration = 0;

    for (const story of stories) {
      if (story.timestamp) {
        const enteredTimestamp = new Date(story.timestamp).getTime();

        // If story is still on front page, calculate duration until now
        if (story.rank <= 30) {
          const durationMs = now - enteredTimestamp;
          totalMs += durationMs;
          storiesWithDuration++;
        }
        // Otherwise, we would need exit timestamp which we don't have in this data
      }
    }

    if (storiesWithDuration > 0) {
      const avgDurationMs = Math.round(totalMs / storiesWithDuration);
      avgFrontpageTimeEl.textContent = formatDuration(avgDurationMs);
    } else {
      avgFrontpageTimeEl.textContent = "N/A";
    }
  }

  // Event listeners
  // Add event listeners
  refreshButton.addEventListener("click", () => {
    fetchStories();
    // Reset auto-refresh timer when manually refreshing
    resetAutoRefreshTimer();
  });

  // Toggle verified users only
  verifiedOnlyToggle.addEventListener("change", (e) => {
    showVerifiedOnly = e.target.checked;
    applyFiltersAndUpdateUI();
  });

  // Apply updateLiveCounters() periodically for time-based UI elements
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      console.log("Tab is visible again, updating time elements");
      // Update the current time immediately
      now = Date.now();
      // Force update of all time-based elements
      updateLiveCounters();
      // Restart live counters if they're not running
      if (!liveCounterTimer) {
        startLiveCounters();
      }
      // Refresh data if it's been more than 30 seconds since last refresh
      const lastRefreshTime = window.lastRefreshTime || 0;
      if (now - lastRefreshTime > 30000) {
        console.log("Data may be stale, triggering refresh");
        fetchStories();
      }
    } else {
      // Tab is hidden, pause live counters to save resources
      if (liveCounterTimer) {
        clearInterval(liveCounterTimer);
        liveCounterTimer = null;
        console.log("Live counters paused while tab is inactive");
      }
    }
  });

  // Add CSS for duration indicators
  const style = document.createElement("style");
  style.textContent = `
    .duration {
      font-weight: bold;
      padding: 4px 8px;
      border-radius: 8px;
      display: inline-flex;
      align-items: center;
      gap: 5px;
      transition: all 0.2s ease;
      margin-right: 1.1rem;
    }
    .duration:hover {
      transform: translateY(-2px);
    }
    .duration-short {
      background-color: rgba(76, 175, 80, 0.2);
      color: #4CAF50; /* Green for new stories (<3h) */
      box-shadow: 0 2px 6px rgba(76, 175, 80, 0.2);
    }
    .duration-normal {
      background-color: rgba(3, 169, 244, 0.2);
      color: #03A9F4; /* Blue for normal-age stories (3-12h) */
      box-shadow: 0 2px 6px rgba(3, 169, 244, 0.2);
    }
    .duration-medium {
      background-color: rgba(255, 152, 0, 0.2);
      color: #FF9800; /* Orange for medium-age stories (12-24h) */
      box-shadow: 0 2px 6px rgba(255, 152, 0, 0.2);
    }
    .duration-long {
      background-color: rgba(156, 39, 176, 0.2);
      color: #9C27B0; /* Purple for long-lasting stories (24h+) */
      box-shadow: 0 2px 6px rgba(156, 39, 176, 0.2);
    }

    /* Tooltip styles for duration */
    .story-meta .duration {
      cursor: help;
    }
  `;
  document.head.appendChild(style);

  // Auto-refresh function to periodically update data
  function startAutoRefreshTimer() {
    // Clear any existing timer first
    if (autoRefreshTimer) {
      clearTimeout(autoRefreshTimer);
    }

    // Set new timer
    autoRefreshTimer = setTimeout(() => {
      console.log("Auto-refreshing data...");
      fetchStories();
      // Set up the next refresh
      startAutoRefreshTimer();
    }, AUTO_REFRESH_INTERVAL);
  }

  // Reset the auto-refresh timer
  function resetAutoRefreshTimer() {
    if (autoRefreshTimer) {
      clearTimeout(autoRefreshTimer);
    }
    startAutoRefreshTimer();

    // Also reset the live counter to ensure synchronized updates
    if (liveCounterTimer) {
      clearInterval(liveCounterTimer);
    }
    startLiveCounters();
  }

  // Live counter function to update time-based elements
  // Update header stats based on API data
  function updateHeaderStats(data) {
    // Update the stats from the header API endpoint
    const currentFrontpageCountEl = document.getElementById("current-frontpage-count");
    const topTenCountEl = document.getElementById("top-ten-count");
    const avgFrontpageTimeEl = document.getElementById("avg-frontpage-time");
    const mostActiveTimeEl = document.getElementById("most-active-time");
    
    if (currentFrontpageCountEl) {
      currentFrontpageCountEl.textContent = data.totalStories || "0";
    }
    
    if (topTenCountEl) {
      topTenCountEl.textContent = data.topPoints || "0";
    }
    
    if (avgFrontpageTimeEl && data.avgTimeOnFrontPageMinutes) {
      const minutes = data.avgTimeOnFrontPageMinutes;
      const hours = Math.floor(minutes / 60);
      const remainingMinutes = minutes % 60;
      avgFrontpageTimeEl.textContent = `${hours}:${remainingMinutes.toString().padStart(2, '0')}`;
    }
    
    // Mark stats as loaded
    headerStatsLoaded = true;
  }

  function updateTopStats(data) {
    // This function is now primarily used for verified user data updates
    // Main stats are updated directly from the /api/stats/header endpoint
    
    // Update verified user analytics metrics if they exist
    const verifiedUserCountEl = document.getElementById("verified-user-count");
    const verifiedAvgPointsEl = document.getElementById("verified-avg-points");
    const mostActiveTimeEl = document.getElementById("most-active-time");

    if (verifiedUserCountEl) {
      verifiedUserCountEl.textContent = data.totalCount || "0";
    }
    if (verifiedAvgPointsEl) {
      verifiedAvgPointsEl.textContent = data.avgPeakPoints || "0";
    }
    
    // Update the most active time element if it exists
    if (mostActiveTimeEl && !mostActiveTimeEl.textContent.trim() && !headerStatsLoaded) {
      mostActiveTimeEl.textContent = data.avgPeakPoints || "0";
    }
  }

  function updateLiveCounters() {
    // Update current time
    now = Date.now();

    // Update story durations if we have stories displayed
    if (window.displayedStories && window.displayedStories.length > 0) {
      // Update all duration spans
      // Get all story items with timestamps
      const storyItems = document.querySelectorAll(
        ".story-item[data-timestamp]",
      );
      for (const item of storyItems) {
        const timestamp = Number.parseInt(
          item.getAttribute("data-timestamp"),
          10,
        );
        if (Number.isNaN(timestamp)) continue;

        const durationMs = now - timestamp;
        const durationEl = item.querySelector(".duration");

        if (durationEl) {
          // Get new duration values
          const durationText = formatDuration(durationMs);
          const durationClass = getDurationClass(durationMs);
          const durationEmoji = getDurationEmoji(durationMs);

          // Update the duration element
          durationEl.innerHTML = `${durationEmoji} ${durationText}`;

          // Update the class if needed
          const durationClasses = [
            "duration-short",
            "duration-normal",
            "duration-medium",
            "duration-long",
          ];
          for (const cls of durationClasses) {
            durationEl.classList.remove(cls);
          }
          durationEl.classList.add(durationClass);
        }
      }

      // Only update if we don't have data from the API
      if (document.getElementById("avg-frontpage-time") && !headerStatsLoaded) {
        let totalMs = 0;
        let storiesWithDuration = 0;

        for (const story of window.displayedStories) {
          if (story.timestamp) {
            const enteredTimestamp = new Date(story.timestamp).getTime();

            // If story is still on front page, calculate duration until now
            if (story.rank <= 30) {
              const durationMs = now - enteredTimestamp;
              totalMs += durationMs;
              storiesWithDuration++;
            }
          }
        }

        if (storiesWithDuration > 0) {
          const avgDurationMs = Math.round(totalMs / storiesWithDuration);
          avgFrontpageTimeEl.textContent = formatDuration(avgDurationMs);
        }
      }
    }
  }

  // Start live counter updates
  function startLiveCounters() {
    // Clear any existing timers
    if (liveCounterTimer) {
      clearInterval(liveCounterTimer);
    }

    // Update immediately first
    updateLiveCounters();

    // Then set interval for regular updates
    liveCounterTimer = setInterval(() => {
      requestAnimationFrame(updateLiveCounters); // Use requestAnimationFrame for smoother updates
    }, LIVE_COUNTER_INTERVAL);

    console.log("Live counters started - durations will update every second");
  }

  // Track last refresh time
  window.lastRefreshTime = Date.now();

  // No need to replace the function

  // Initial data fetch
  fetchStories();

  // Set up auto-refresh
  startAutoRefreshTimer();

  // Start live counters
  startLiveCounters();

  // We'll initialize the chart on demand rather than empty
});
