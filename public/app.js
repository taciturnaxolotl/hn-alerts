document.addEventListener("DOMContentLoaded", () => {
  // Elements
  const storyList = document.getElementById("story-list");
  const totalAlertsEl = document.getElementById("total-alerts");
  const uniqueStoriesEl = document.getElementById("unique-stories");
  const highestRankEl = document.getElementById("highest-rank");
  const refreshButton = document.getElementById("refresh-data");
  const noGraph = document.getElementById("no-graph");
  const rankChart = document.getElementById("rank-chart");

  // Chart instance
  let chart = null;
  let activeStoryId = null;

  // Fetch stories data
  function fetchStories() {
    storyList.innerHTML = '<div class="loading">Loading stories...</div>';

    fetch("/api/alerts")
      .then((response) => {
        if (!response.ok) {
          throw new Error("Network response was not ok");
        }
        return response.json();
      })
      .then((data) => {
        // Remove duplicate stories (keep the one with best rank)
        const uniqueStories = removeDuplicateStories(data);
        displayStories(uniqueStories);
        updateStats(uniqueStories);
      })
      .catch((error) => {
        storyList.innerHTML = `<div class="loading">Error loading data: ${error.message}</div>`;
        console.error("Error fetching stories:", error);
      });
  }

  // Remove duplicate stories based on URL
  function removeDuplicateStories(stories) {
    const urlMap = new Map();

    for (const story of stories) {
      const existingStory = urlMap.get(story.url);

      if (!existingStory || story.rank < existingStory.rank) {
        urlMap.set(story.url, story);
      }
    }

    return Array.from(urlMap.values());
  }

  // Display stories in the UI
  function displayStories(stories) {
    if (!stories || stories.length === 0) {
      storyList.innerHTML = '<div class="loading">No stories found.</div>';
      return;
    }

    // Sort stories by rank (lowest/best rank first)
    stories.sort((a, b) => a.rank - b.rank);

    let html = "";
    for (const story of stories) {
      const date = new Date(story.timestamp).toLocaleString();
      html += `
        <div class="story-item" data-id="${story.id}" data-url="${story.url}">
            <h3>${story.title}</h3>
            <p>Best Rank: #${story.rank}</p>
            <div class="story-meta">
                <span>Points: ${story.points}</span>
                <span>Comments: ${story.comments}</span>
                <span>By: ${story.by}</span>
            </div>
            <div class="story-meta">
                <span>Detected: ${date}</span>
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

  // Update statistics
  function updateStats(stories) {
    if (!stories || stories.length === 0) {
      totalAlertsEl.textContent = "0";
      uniqueStoriesEl.textContent = "0";
      highestRankEl.textContent = "N/A";
      return;
    }

    // Total stories
    totalAlertsEl.textContent = stories.length;

    // Unique stories (should be same as total since we've already de-duped)
    uniqueStoriesEl.textContent = stories.length;

    // Best (lowest) rank
    const bestRank = Math.min(...stories.map((s) => s.rank));
    highestRankEl.textContent = bestRank;
  }

  // Event listeners
  refreshButton.addEventListener("click", fetchStories);

  // Initial data fetch
  fetchStories();
});
