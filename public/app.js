document.addEventListener("DOMContentLoaded", () => {
  // Elements
  const storyList = document.getElementById("story-list");
  const totalAlertsEl = document.getElementById("total-alerts");
  const avgPeakPointsEl = document.getElementById("avg-peak-points");
  const verifiedCountEl = document.getElementById("verified-count");
  const refreshButton = document.getElementById("refresh-data");
  const noGraph = document.getElementById("no-graph");
  const rankChart = document.getElementById("rank-chart");
  const verifiedOnlyToggle = document.getElementById("verified-only-toggle");

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

  // Initialize stats
  updatePerformanceMetrics([]);

  // For calculating durations
  const now = Date.now();

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

    if (hours >= 24) {
      return "duration-long"; // Long-lasting story (24+ hours)
    }
    if (hours >= 12) {
      return "duration-medium"; // Medium-lasting story (12-24 hours)
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

  // Fetch stories data
  function fetchStories() {
    storyList.innerHTML = '<div class="loading">Loading stories...</div>';

    // Fetch total stories count first
    fetch("/api/stats/total-stories")
      .then((response) => response.json())
      .then((data) => {
        if (data && typeof data.count !== "undefined") {
          totalStoriesCount = data.count;
          currentFrontpageCountEl.textContent = totalStoriesCount;
        }
      })
      .catch((error) => {
        console.error("Error fetching total stories count:", error);
      });

    // Fetch verified user stats for the top row
    fetch("/api/stats/verified-users")
      .then((response) => response.json())
      .then((data) => {
        verifiedUserStats = data;
      })
      .catch((error) => {
        console.error("Error fetching verified user stats:", error);
      });

    fetch("/api/stories")
      .then((response) => {
        if (!response.ok) {
          throw new Error("Network response was not ok");
        }
        return response.json();
      })
      .then((data) => {
        // Store all stories for filtering
        allStories = data;

        // Apply filters and update UI
        applyFiltersAndUpdateUI();
      })
      .catch((error) => {
        storyList.innerHTML = `<div class="loading">Error loading data: ${error.message}</div>`;
        console.error("Error fetching stories:", error);
      });
  }

  // Apply filters and update UI
  function applyFiltersAndUpdateUI() {
    if (!allStories || allStories.length === 0) return;

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
    updatePerformanceMetrics(allStories); // Always use all stories for this analysis
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
        <div class="story-item${isCurrentTop ? " top-story" : ""}${isCurrentRankOne ? " top-ranked" : ""}${isBestRankOne && !isCurrentRankOne ? " previously-top-ranked" : ""}" data-id="${story.id}" data-url="${story.url}">
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
                <span class="duration ${durationClass}" title="Time since first detection">${durationEmoji} ${durationText}</span>
                <span><a href="${story.url}" target="_blank" class="external-link">View Story ↗</a></span>
            </div>
        </div>
      `;
    }

    storyList.innerHTML = html;

    // Add event listeners to story items
    const storyItems = document.querySelectorAll(".story-item");

    for (const item of storyItems) {
      item.addEventListener("click", (e) => {
        // Prevent triggering when clicking links
        if (
          e.target.classList.contains("external-link") ||
          e.target.closest(".external-link")
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
  function loadStoryGraph(storyId) {
    if (activeStoryId === storyId) return;
    activeStoryId = storyId;

    noGraph.style.display = "flex";
    rankChart.style.display = "none";
    noGraph.innerHTML = '<div class="loading">Loading graph data...</div>';

    fetch(`/api/story/${storyId}/snapshots`)
      .then((response) => {
        if (!response.ok) {
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
      // Only set these, total count is fetched separately
      topTenCountEl.textContent = "0";
      mostActiveTimeEl.textContent = "N/A";
      avgFrontpageTimeEl.textContent = "N/A";
      return;
    }

    // Get total stories from the API
    fetch("/api/stats/total-stories")
      .then((response) => response.json())
      .then((data) => {
        currentFrontpageCountEl.textContent =
          data.count !== undefined ? data.count : allStories.length;
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
  refreshButton.addEventListener("click", fetchStories);

  // Toggle verified users only
  verifiedOnlyToggle.addEventListener("change", (e) => {
    showVerifiedOnly = e.target.checked;
    applyFiltersAndUpdateUI();
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

  // Initial data fetch
  fetchStories();

  // We'll initialize the chart on demand rather than empty
});
