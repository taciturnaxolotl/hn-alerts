import { CronJob } from "cron";
import * as Sentry from "@sentry/bun";
import { db, environment, invalidateAllCaches } from "../../index";
import {
  users as usersTable,
  stories as storiesTable,
  leaderboardSnapshots,
} from "../../libs/schema";
import {
  eq,
  and,
  isNull,
  lt,
  gte,
  notInArray,
  not,
  count,
  inArray,
} from "drizzle-orm";
import {
  getNewStories,
  getItems,
  type Story,
  getTopStories,
} from "../../libs/hackernews";
import { addDays } from "../../libs/time";
import type { AnyMessageBlock } from "slack-edge";
import { sqlite } from "../../libs/db";

// Constants
const TOP_STORIES_LIMIT = 30; // Front page is considered the top 30 stories
const RETENTION_DAYS = 5; // Keep non-verified user stories for 5 days
const CHECK_INTERVAL = "*/5 * * * *"; // Check every 5 minutes

/**
 * Calculate the expiration timestamp for a story
 * @returns timestamp in seconds (null for verified user stories)
 */
function calculateExpirationTime(isFromVerifiedUser: boolean): number | null {
  if (isFromVerifiedUser) {
    return null; // Stories from verified users are kept indefinitely
  }

  // Add RETENTION_DAYS to current timestamp (in seconds)
  return Math.floor(addDays(new Date(), RETENTION_DAYS).getTime() / 1000);
}

/**
 * Process stories from HackerNews - handles both new and top stories
 * Uses a single API call to get stories and determines position based on array index
 */
async function processStories() {
  try {
    console.log("==== STARTING STORY PROCESSING ====");
    console.log("Fetching HackerNews stories with a single API call...");

    // Get all verified users from our database
    const verifiedUsers = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.verified, true));

    // Create a map of verified HN usernames for quick lookup (case insensitive)
    const verifiedUserMap = new Map<string, (typeof verifiedUsers)[0]>(
      verifiedUsers
        .map((user) =>
          user.hackernewsUsername
            ? ([user.hackernewsUsername.toLowerCase(), user] as [
                string,
                typeof user,
              ])
            : null,
        )
        .filter(
          (entry): entry is [string, (typeof verifiedUsers)[0]] =>
            entry !== null,
        ),
    );

    // Fetch the latest stories - position in array determines leaderboard position
    // Only one API call to get new stories instead of separate calls for new and top stories
    console.log("Making API call to get story IDs...");
    const storyIds = await getTopStories();
    if (!storyIds.length) {
      console.log("No stories found from API");
      return;
    }

    console.log(`Retrieved ${storyIds.length} story IDs from HackerNews API`);

    // We'll use this to track non-job stories for front page consideration
    const nonJobStoryIds: number[] = [];

    // Batch fetch story details - limit to first 500 to avoid overloading
    console.log(
      "Fetching details for up to 500 stories (in parallel batches)...",
    );
    const stories = await getItems<Story>(storyIds.slice(0, 500));
    console.log(
      `Successfully retrieved ${stories.length} stories with details`,
    );

    // Get current timestamp in seconds
    const currentTime = Math.floor(Date.now() / 1000);

    // Pre-fetch all existing stories in one query for efficiency
    console.log("Fetching existing stories from database...");
    const storyIdsToProcess = stories.map((story) => story.id);
    const existingStories = await db
      .select()
      .from(storiesTable)
      .where(
        and(
          storyIdsToProcess.length > 0
            ? inArray(storiesTable.id, storyIdsToProcess)
            : undefined,
        ),
      )
      .then((results) => {
        // Create a map for quick lookups
        return new Map(results.map((story) => [story.id, story]));
      });
    console.log(`Found ${existingStories.size} existing stories in database`);

    // Prepare batch operations
    const newStories: (typeof storiesTable.$inferInsert)[] = [];
    const storyUpdates: Array<{
      id: number;
      updates: Partial<typeof storiesTable.$inferSelect>;
      shouldNotify: boolean;
      notificationType?:
        | "new_story_by_verified_user"
        | "front_page_story"
        | "number_one_story";
    }> = [];
    // Collection for leaderboard snapshots
    const snapshotsToInsert: Array<{
      story_id: number;
      timestamp: number;
      position: number;
      score: number;
      expires_at: number;
    }> = [];

    console.log("Starting to process stories with detailed debugging...");

    // First, filter out job stories and create a map of adjusted positions
    const positionMap = new Map<number, number>(); // Maps story ID to adjusted position
    let adjustedPosition = 0;

    for (let i = 0; i < stories.length; i++) {
      const story = stories[i];
      if (!story) continue;

      // Skip jobs, but include other types (mainly 'story')
      if (story.type === "job") {
        console.log(
          `[INFO] Skipping job at original position ${i + 1}, ID: ${story.id}`,
        );
        continue;
      }

      // Only increment position for non-job stories
      adjustedPosition++;
      positionMap.set(story.id, adjustedPosition);

      // Add to non-job story IDs for front page consideration
      if (adjustedPosition <= TOP_STORIES_LIMIT) {
        nonJobStoryIds.push(story.id);
      }
    }

    console.log(
      `Filtered out job stories. Have ${adjustedPosition} stories after filtering.`,
    );
    console.log(
      `Front page contains the top ${Math.min(TOP_STORIES_LIMIT, nonJobStoryIds.length)} non-job stories`,
    );

    // Now use the adjusted positions when processing stories
    const frontPageIds = nonJobStoryIds.slice(0, TOP_STORIES_LIMIT);

    // Process each story
    for (let i = 0; i < stories.length; i++) {
      const story = stories[i];
      if (!story) {
        console.log(
          `[WARNING] Null story at original position ${i + 1}, skipping`,
        );
        continue;
      }

      // Skip job stories entirely
      if (story.type === "job") {
        continue;
      }

      // Use the adjusted position for non-job stories
      const position = positionMap.get(story.id) || i + 1;
      const isOnFrontPage = position <= TOP_STORIES_LIMIT;
      const isNumberOne = position === 1;

      if (!story.by) {
        console.log(
          `[WARNING] Invalid story at adjusted position ${position}, ID: ${story.id}, type: ${story.type}, by: ${story.by}, skipping`,
        );
        continue;
      }

      const storyAuthor = story.by.toLowerCase();
      const isFromVerifiedUser = verifiedUserMap.has(storyAuthor);
      const isOnLeaderboard = isOnFrontPage;

      console.log(
        `Processing story ID ${story.id}: "${story.title?.substring(0, 30)}${story.title && story.title.length > 30 ? "..." : ""}" by ${story.by} (position: ${position}, leaderboard: ${isOnLeaderboard ? "Yes" : "No"})`,
      );

      // Check if story already exists in our database using our pre-fetched map
      const existingStory = existingStories.get(story.id);

      if (!existingStory) {
        // New story - prepare to add to database
        const expiresAt = calculateExpirationTime(isFromVerifiedUser);

        // Create notification tracking fields
        const notifiedFrontPage =
          isOnLeaderboard && (isFromVerifiedUser || isNumberOne);
        const notifiedNumberOne = isNumberOne && isFromVerifiedUser;
        const notifiedNewStory = isFromVerifiedUser;

        console.log(
          `Creating new story record for ID ${story.id} (position: ${position}, verified user: ${isFromVerifiedUser ? "Yes" : "No"})`,
        );

        // Add to batch insert array
        newStories.push({
          id: story.id,
          by: story.by,
          title: story.title,
          url: story.url,
          text: story.text,
          time: story.time,
          score: story.score,
          descendants: story.descendants,
          firstSeenAt: currentTime,
          lastUpdatedAt: currentTime,
          // Track when first notification was sent (if any)
          notifiedAt:
            notifiedFrontPage || notifiedNumberOne || notifiedNewStory
              ? currentTime
              : null,
          // Track specific notification types
          notifiedNewStory: notifiedNewStory,
          notifiedFrontPage: notifiedFrontPage,
          notifiedNumberOne: notifiedNumberOne,
          isOnLeaderboard: isOnLeaderboard,
          enteredLeaderboardAt: isOnLeaderboard ? currentTime : null,
          position: position,
          peakPosition: isOnLeaderboard ? position : null,
          peakPositionAt: isOnLeaderboard ? currentTime : null,
          peakScore: story.score,
          peakScoreAt: currentTime,
          isFromMonitoredUser: isFromVerifiedUser,
          expiresAt: expiresAt,
        });

        // Add leaderboard snapshot if on leaderboard
        if (isOnLeaderboard) {
          // Calculate TTL for the snapshot
          const snapshotExpiresAt =
            expiresAt ||
            Math.floor(addDays(new Date(), RETENTION_DAYS).getTime() / 1000);

          // Add a leaderboard snapshot directly with SQL query
          if (story.id) {
            console.log(
              `Adding leaderboard snapshot for new story ID ${story.id} at position ${position}`,
            );
            try {
              // Use direct SQL to avoid Drizzle ORM issues
              sqlite.run(
                `
                INSERT INTO leaderboard_snapshots (story_id, timestamp, position, score, expires_at)
                VALUES (?, ?, ?, ?, ?)
              `,
                [
                  story.id,
                  currentTime,
                  position,
                  story.score,
                  snapshotExpiresAt,
                ],
              );
            } catch (error) {
              console.error(
                `Failed to insert leaderboard snapshot for story ${story.id}:`,
                error,
              );
            }
          } else {
            console.error(
              `[ERROR] Cannot add leaderboard snapshot: story.id is missing or invalid (${story.id})`,
            );
          }
        }

        // Queue notifications for later sending (after DB operations)
        if (isFromVerifiedUser) {
          if (isNumberOne) {
            console.log(
              `Queuing #1 story notification for "${story.title?.substring(0, 30)}..." by ${story.by}`,
            );
            storyUpdates.push({
              id: story.id,
              updates: {},
              shouldNotify: true,
              notificationType: "number_one_story",
            });
          } else if (isOnLeaderboard) {
            console.log(
              `Queuing front page notification for "${story.title?.substring(0, 30)}..." by ${story.by}`,
            );
            storyUpdates.push({
              id: story.id,
              updates: {},
              shouldNotify: true,
              notificationType: "front_page_story",
            });
          } else {
            console.log(
              `Queuing new story notification for "${story.title?.substring(0, 30)}..." by ${story.by}`,
            );
            storyUpdates.push({
              id: story.id,
              updates: {},
              shouldNotify: true,
              notificationType: "new_story_by_verified_user",
            });
          }
        }
      } else {
        // Existing story - prepare update
        console.log(
          `Updating story ID ${story.id} (position: ${position}, leaderboard: ${isOnLeaderboard ? "Yes" : "No"})`,
        );
        const storyUpdate: Partial<typeof storiesTable.$inferSelect> = {
          score: story.score,
          descendants: story.descendants,
          position: position,
          lastUpdatedAt: currentTime,
          isFromMonitoredUser:
            isFromVerifiedUser || existingStory.isFromMonitoredUser,
        };

        // Add leaderboard snapshot if on leaderboard
        if (isOnLeaderboard) {
          // Calculate TTL for the snapshot
          const snapshotExpiresAt =
            calculateExpirationTime(isFromVerifiedUser) ||
            Math.floor(addDays(new Date(), RETENTION_DAYS).getTime() / 1000);

          // Add a leaderboard snapshot directly with SQL query
          if (story.id) {
            console.log(
              `Adding leaderboard snapshot for existing story ID ${story.id} at position ${position}`,
            );
            try {
              // Use direct SQL to avoid Drizzle ORM issues
              sqlite.run(
                `
                INSERT INTO leaderboard_snapshots (story_id, timestamp, position, score, expires_at)
                VALUES (?, ?, ?, ?, ?)
              `,
                [
                  story.id,
                  currentTime,
                  position,
                  story.score,
                  snapshotExpiresAt,
                ],
              );
            } catch (error) {
              console.error(
                `Failed to insert leaderboard snapshot for story ${story.id}:`,
                error,
              );
            }
          } else {
            console.error(
              `[ERROR] Cannot add leaderboard snapshot for existing story: story.id is missing or invalid (${story.id})`,
            );
          }
        }

        let shouldSendNotification = false;
        let notificationType:
          | "new_story_by_verified_user"
          | "front_page_story"
          | "number_one_story" = "new_story_by_verified_user";

        // Handle leaderboard status changes
        if (isOnLeaderboard) {
          if (!existingStory.isOnLeaderboard) {
            // Just entered leaderboard
            storyUpdate.isOnLeaderboard = true;
            storyUpdate.enteredLeaderboardAt = currentTime;
            storyUpdate.peakPosition = position;
            storyUpdate.peakPositionAt = currentTime;
            storyUpdate.peakScore = story.score;
            storyUpdate.peakScoreAt = currentTime;

            // Notify if from verified user and no front page notification yet
            if (isFromVerifiedUser && !existingStory.notifiedFrontPage) {
              storyUpdate.notifiedFrontPage = true;
              storyUpdate.notifiedAt = existingStory.notifiedAt || currentTime;
              shouldSendNotification = true;
              notificationType = "front_page_story";
              console.log(
                `Story ID ${story.id} just entered leaderboard - will send notification`,
              );
            }
          } else {
            // Already on leaderboard - update peak stats if better
            if (
              position <
              (existingStory.peakPosition || Number.POSITIVE_INFINITY)
            ) {
              storyUpdate.peakPosition = position;
              storyUpdate.peakPositionAt = currentTime;

              // Special case: if it just became #1 and we haven't sent a #1 notification
              if (
                isNumberOne &&
                !existingStory.notifiedNumberOne &&
                isFromVerifiedUser
              ) {
                storyUpdate.notifiedNumberOne = true;
                storyUpdate.notifiedAt =
                  existingStory.notifiedAt || currentTime;
                shouldSendNotification = true;
                notificationType = "number_one_story";
                console.log(
                  `Story ID ${story.id} just reached #1 position - will send notification`,
                );
              }
            }

            if (story.score > (existingStory.peakScore || 0)) {
              storyUpdate.peakScore = story.score;
              storyUpdate.peakScoreAt = currentTime;
            }
          }
        } else if (!existingStory.isOnLeaderboard) {
          // Not on leaderboard but we should update the position anyway
          storyUpdate.position = position;
        }

        // Add to batch updates
        storyUpdates.push({
          id: story.id,
          updates: storyUpdate,
          shouldNotify: shouldSendNotification,
          notificationType: notificationType,
        });
      }
    }

    // Execute batch operations
    console.log(
      `Executing batch database operations: ${newStories.length} inserts, ${storyUpdates.length} updates, ${snapshotsToInsert.length} snapshots`,
    );

    // First insert new stories, then handle snapshots (which might reference those stories)
    // Avoid Promise.all to ensure proper sequence

    // Insert new stories first
    if (newStories.length > 0) {
      console.log(`Inserting ${newStories.length} new stories...`);
      await db.insert(storiesTable).values(newStories);
      console.log(`Completed inserting ${newStories.length} new stories`);
    }

    // Batch insert leaderboard snapshots
    // TEMPORARILY DISABLED: Leaderboard snapshots insertion
    (async () => {
      if (snapshotsToInsert.length > 0) {
        console.log(
          `Skipping insertion of ${snapshotsToInsert.length} leaderboard snapshots (feature temporarily disabled)`,
        );
      }
    })();
    // Updates need to be done after inserts in case we're updating a newly inserted story
    if (storyUpdates.length > 0) {
      console.log(`Processing ${storyUpdates.length} story updates...`);
      // Group updates by ID for efficiency
      const updatesByID = new Map<
        number,
        Partial<typeof storiesTable.$inferSelect>
      >();
      for (const update of storyUpdates) {
        if (Object.keys(update.updates).length > 0) {
          updatesByID.set(update.id, {
            ...(updatesByID.get(update.id) || {}),
            ...update.updates,
          });
        }
      }

      // Process all updates
      let updateCount = 0;
      for (const [id, updates] of updatesByID.entries()) {
        await db
          .update(storiesTable)
          .set(updates)
          .where(eq(storiesTable.id, id));
        updateCount++;

        if (updateCount % 50 === 0) {
          console.log(
            `Processed ${updateCount}/${updatesByID.size} story updates`,
          );
        }
      }
      console.log("Completed processing all story updates");
    }

    // Mark stories that have exited the leaderboard
    console.log("Checking for stories that have exited the leaderboard...");
    await db
      .update(storiesTable)
      .set({
        isOnLeaderboard: false,
        exitedLeaderboardAt: currentTime,
      })
      .where(
        and(
          eq(storiesTable.isOnLeaderboard, true),
          // Not in the current front page
          notInArray(storiesTable.id, frontPageIds),
        ),
      );

    // Process notifications after all DB operations are complete
    const notificationsToSend = storyUpdates.filter(
      (u) => u.shouldNotify && u.notificationType,
    );
    console.log(`Processing ${notificationsToSend.length} notifications...`);

    for (const update of notificationsToSend) {
      const story = stories.find((s) => s.id === update.id);
      if (story && update.notificationType) {
        console.log(
          `Sending ${update.notificationType} notification for story ID ${story.id}: "${story.title?.substring(0, 30)}${story.title && story.title.length > 30 ? "..." : ""}"`,
        );
        await sendNotification(story, update.notificationType);
      }
    }
  } catch (error) {
    console.error("Error processing stories:", error);
    console.error(
      "Error details:",
      error instanceof Error ? error.message : String(error),
    );
    console.error(
      "Error stack:",
      error instanceof Error ? error.stack : "No stack trace available",
    );
    Sentry.captureException(error);
  } finally {
    console.log("==== COMPLETED STORY PROCESSING ====");
  }
}

/**
 * Check if a user is verified in our system
 */
async function isVerifiedUser(username: string): Promise<boolean> {
  if (!username) return false;

  const user = await db
    .select()
    .from(usersTable)
    .where(
      and(
        eq(usersTable.verified, true),
        eq(usersTable.hackernewsUsername, username.toLowerCase()),
      ),
    )
    .then((a) => a[0]);

  return !!user;
}

/**
 * Clean up expired stories
 */
/**
 * Record a snapshot of a story's position on the leaderboard
 * This data can be used to generate graphs showing position over time
 *
 * TEMPORARILY DISABLED to unblock the system
 */
async function recordLeaderboardSnapshot({
  storyId,
  position,
  score,
  timestamp,
  isFromVerifiedUser,
  expiresAt,
}: {
  storyId: number;
  position: number;
  score: number;
  timestamp: number;
  isFromVerifiedUser: boolean;
  expiresAt: number | null;
}) {
  try {
    // Calculate TTL for the snapshot - either match story TTL or use default
    const snapshotExpiresAt =
      expiresAt ||
      Math.floor(addDays(new Date(), RETENTION_DAYS).getTime() / 1000);

    // Only insert if we have a valid story ID
    if (storyId && !Number.isNaN(Number(storyId))) {
      try {
        // Use direct SQL to avoid Drizzle ORM issues
        sqlite.run(
          `
          INSERT INTO leaderboard_snapshots (story_id, timestamp, position, score, expires_at)
          VALUES (?, ?, ?, ?, ?)
        `,
          [Number(storyId), timestamp, position, score, snapshotExpiresAt],
        );
      } catch (error) {
        console.error(
          `Error inserting leaderboard snapshot for story ${storyId}:`,
          error,
        );
        Sentry.captureException(error);
      }
    } else {
      console.error(
        `Skipped recording leaderboard snapshot: invalid story ID (${storyId})`,
      );
    }
  } catch (error) {
    console.error("Error recording leaderboard snapshot:", error);
    Sentry.captureException(error);
  }
}

async function cleanupExpiredStories() {
  try {
    console.log("Starting cleanup of expired stories...");
    const currentTime = Math.floor(Date.now() / 1000);

    // Get count of stories to delete
    const expiredCount = await db
      .select({ count: count() })
      .from(storiesTable)
      .where(
        and(
          // Only delete stories with expiration set (not null)
          // and expired (expiration time less than current time)
          not(isNull(storiesTable.expiresAt)),
          lt(storiesTable.expiresAt, currentTime),
        ),
      )
      .then((a) => a[0]);

    if (expiredCount && Number(expiredCount.count) > 0) {
      console.log(`Found ${expiredCount.count} expired stories to clean up`);

      // Delete expired stories
      await db
        .delete(storiesTable)
        .where(
          and(
            not(isNull(storiesTable.expiresAt)),
            lt(storiesTable.expiresAt, currentTime),
          ),
        );
    }

    // Also clean up expired leaderboard snapshots
    const expiredSnapshotsCount = await db
      .select({ count: count() })
      .from(leaderboardSnapshots)
      .where(lt(leaderboardSnapshots.expiresAt, currentTime))
      .then((a) => a[0]);

    if (expiredSnapshotsCount && Number(expiredSnapshotsCount.count) > 0) {
      console.log(
        `Cleaning up ${expiredSnapshotsCount.count} expired leaderboard snapshots`,
      );

      await db
        .delete(leaderboardSnapshots)
        .where(lt(leaderboardSnapshots.expiresAt, currentTime));
    }
  } catch (error) {
    console.error("Error cleaning up expired data:", error);
    Sentry.captureException(error);
  }
}

/**
 * Send notification for a story
 */
async function sendNotification(
  story: Story,
  notificationType:
    | "new_story_by_verified_user"
    | "front_page_story"
    | "number_one_story",
) {
  try {
    console.log(
      `Sending ${notificationType} notification for story ${story.id} by ${story.by}`,
    );

    // Import the Slack app
    const { slackApp } = await import("../../index");

    // Get the Slack user ID for the HN username
    const user = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.hackernewsUsername, story.by))
      .then((a) => a[0]);

    const slackUserId = user?.id;
    const slackMention = slackUserId ? `<@${slackUserId}>` : "";

    // Create the notification message with story details
    let headerText = "";
    if (notificationType === "new_story_by_verified_user") {
      headerText = `*New story from verified user <https://news.ycombinator.com/user?id=${story.by}|${story.by}>* ${slackMention}`;
    } else if (notificationType === "number_one_story") {
      headerText = `*🏆 Story has reached #1 on Hacker News! By <https://news.ycombinator.com/user?id=${story.by}|${story.by}>* ${slackMention}`;
    } else {
      headerText = `*Story by <https://news.ycombinator.com/user?id=${story.by}|${story.by}> made it to the front page!* ${slackMention}`;
    }

    // Customize blocks based on notification type
    const blocks: AnyMessageBlock[] = [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: headerText,
        },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*<${story.url || `https://news.ycombinator.com/item?id=${story.id}`}|${story.title}>*\n${story.text || ""}`,
        },
      },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: `<https://news.ycombinator.com/item?id=${story.id}|View on Hacker News> • ${story.score || 0} points • ${story.descendants || 0} comments`,
          },
        ],
      },
    ];

    // Add extra emphasis for #1 ranked story
    if (notificationType === "number_one_story") {
      blocks.splice(1, 0, {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "🔥 *This story has reached the #1 position on Hacker News!* 🔥",
        },
      });
    }

    // Send the message
    await slackApp.client.chat.postMessage({
      channel: process.env.SLACK_CHANNEL as string,
      text: headerText,
      blocks: blocks,
    });
  } catch (error) {
    console.error("Error sending notification:", error);
    Sentry.captureException(error);
  }
}

/**
 * The main function to check HackerNews and process updates
 */
async function checkHackerNews() {
  try {
    console.log("===== STARTING HACKER NEWS CHECK =====");
    console.log("Starting unified story processing...");
    // Process stories - unified processing with one API call
    await processStories();
    console.log("Story processing completed");

    // Invalidate all caches and reload them after data update
    invalidateAllCaches();
    console.log("All query caches invalidated and refreshed");

    console.log("Starting cleanup of expired stories...");
    // Clean up expired stories
    await cleanupExpiredStories();
    console.log("Cleanup completed");

    // Invalidate caches again after cleanup and reload them
    invalidateAllCaches();
  } catch (error) {
    console.error("Error in checkHackerNews:", error);
    Sentry.captureException(error);
  } finally {
    console.log("===== COMPLETED HACKER NEWS CHECK =====");
  }
}

// Create the cron job with Sentry monitoring
const CronJobWithCheckIn = Sentry.cron.instrumentCron(
  CronJob,
  "hn-monitor-job",
);

/**
 * Set up HackerNews monitoring service
 */
export function setupHackerNewsMonitoring() {
  // Create and start the scheduled job
  if (environment === "production") {
    const job = CronJobWithCheckIn.from({
      cronTime: CHECK_INTERVAL, // Check every 5 minutes (configurable)
      onTick: checkHackerNews,
      start: true,
      timeZone: "UTC",
    });
  }

  // Run a few seconds after startup to give server time to initialize
  setTimeout(() => {
    console.log("Running initial data check...");
    checkHackerNews();
  }, 3000);

  // Initialize query cache
  console.log("Query cache initialized");

  console.log("HackerNews monitoring service started");
}
